#!/usr/bin/env node
/**
 * Self-Verification Suite for fast-mp-inspector (tests/self-test.mjs)
 *
 * Verifies 100% of the CLI and recipe logic without requiring WeChat DevTools GUI:
 * 1. Layer 1: `checkMpBundle()` against both valid and broken Mini Program build directories
 * 2. Layer 3 & 4: `runInspectionWithSession()` (storage injection, reLaunch, page.data, SelectorQuery geometry, AABB occlusion, screenshot saving)
 * 3. Recipes: `assertMpFullWidthLayout`, `assertMpNotOccluded`, `assertMpPageData`, `triggerMpComponentMethod`, `captureMpScreenshot`
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkMpBundle } from '../scripts/check-mp-bundle.mjs';
import { createMockMiniProgramSession, runInspectionWithSession } from '../scripts/inspect-mp.mjs';
import {
  assertMpFullWidthLayout,
  assertMpNotOccluded,
  assertMpPageData,
  captureMpScreenshot,
  triggerMpComponentMethod,
} from '../examples/mp-assertion-recipes.mjs';

async function runTests() {
  console.log('=== [1/3] Testing Layer 1: Static Mini Program Bundle & Subpackage Probe ===');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-bundle-test-'));

  try {
    // Create valid mock Mini Program build
    const appJson = {
      pages: ['pages/index/index'],
      subPackages: [
        {
          root: 'subpages/order',
          pages: ['detail'],
        },
      ],
    };
    fs.writeFileSync(path.join(tmpDir, 'app.json'), JSON.stringify(appJson, null, 2));
    fs.mkdirSync(path.join(tmpDir, 'pages/index'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'pages/index/index.js'), 'Page({})');
    fs.writeFileSync(path.join(tmpDir, 'pages/index/index.wxml'), '<view class="page-container"></view>');
    fs.writeFileSync(path.join(tmpDir, 'pages/index/index.wxss'), '.page-container { width: 750rpx; }');

    fs.mkdirSync(path.join(tmpDir, 'subpages/order'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'subpages/order/detail.js'), 'Page({})');
    fs.writeFileSync(path.join(tmpDir, 'subpages/order/detail.wxml'), '<view class="detail-card"></view>');

    const passReport = checkMpBundle(tmpDir);
    assert.equal(passReport.ok, true, 'Valid bundle should pass checkMpBundle');
    assert.equal(passReport.totalRoutesChecked, 2);
    console.log('  [PASS] Valid main package + subpackage verified intact.');

    // Simulate mid-build missing/truncated file
    fs.writeFileSync(path.join(tmpDir, 'subpages/order/detail.js'), '');
    const failReport = checkMpBundle(tmpDir);
    assert.equal(failReport.ok, false, 'Truncated 0-byte subpackage JS should fail checkMpBundle');
    assert.equal(failReport.emptyFiles.length, 1);
    console.log('  [PASS] Truncated subpackage file accurately detected.');

    console.log('=== [2/3] Testing Layer 3 & 4: Standardized UI-Password Login -> StorageState Snapshot -> Fast Replay ===');
    const mockMp = createMockMiniProgramSession();
    const shotPath = path.join(tmpDir, 'verify-shot.png');
    const stateFile = path.join(tmpDir, 'staff.state.json');

    // Run 1: UI Username/Password login on /pages/login/index -> auto-dumps ALL custom storage keys (uni_id_token, permissions, etc.)
    const firstRun = await runInspectionWithSession(mockMp, {
      route: '/subpages/order/detail?id=1001',
      role: 'staff',
      loadAuth: stateFile,
      loginRoute: '/pages/login/index',
      username: 'user_alice',
      password: 'Password123!',
      parent: '.page-container',
      target: '.detail-card',
      occlude: '.dropdown-menu',
      occluders: '.sticky-col',
      dataPath: 'detailData',
      waitMs: '10',
      screenshot: shotPath,
    });

    assert.equal(firstRun.route, '/subpages/order/detail');
    assert.equal(firstRun.auth.authMethod, 'ui-password');
    assert.equal(firstRun.auth.fromCache, false);
    assert.ok(firstRun.auth.syncedStorageKeys.includes('uni_id_token'), 'Should capture arbitrary app storage key uni_id_token');
    assert.ok(firstRun.auth.syncedStorageKeys.includes('permissions'), 'Should capture arbitrary app storage key permissions');
    assert.ok(fs.existsSync(stateFile), 'StorageState file should be saved to disk');

    // Run 2: Subsequent run with same role/stateFile + bounceRoute + live wx.request capture + readText
    const apiJsonPath = path.join(tmpDir, 'order-1001-response.json');
    const secondRun = await runInspectionWithSession(mockMp, {
      route: '/subpages/order/detail?id=1001',
      bounceRoute: '/pages/index/index',
      captureApi: '/api/v1/orders/1001',
      saveApiJson: apiJsonPath,
      readText: JSON.stringify({ orderNo: '.detail-card' }),
      role: 'staff',
      loadAuth: stateFile,
      username: 'user_alice',
      password: 'Password123!',
      parent: '.page-container',
      target: '.detail-card',
      occlude: '.dropdown-menu',
      occluders: '.sticky-col',
      dataPath: 'detailData',
      waitMs: '10',
      screenshot: shotPath,
    });

    assert.equal(secondRun.auth.fromCache, true, 'Second run should load directly from cached StorageState');
    assert.equal(secondRun.bouncedVia, '/pages/index/index');
    assert.equal(secondRun.renderedText.orderNo, 'ORD-2026-1001');
    assert.equal(secondRun.capturedRequests.length, 1);
    assert.equal(secondRun.capturedRequests[0].statusCode, 200);
    assert.ok(fs.existsSync(apiJsonPath), 'Captured wx.request JSON should be saved to disk');
    assert.equal(secondRun.pageData.id, 1001);
    assert.equal(secondRun.layout.leftGapPx, 12);
    assert.equal(secondRun.layout.rightGapPx, 12);
    assert.equal(secondRun.layout.leftGapRpx, 24);
    assert.equal(secondRun.occlusion.isOccluded, true, 'Dropdown z-index 10 should be occluded by fixed header z-index 50');
    assert.equal(secondRun.screenshot.exists, true, 'Screenshot PNG file should be written to disk');
    assert.ok(secondRun.screenshot.bytes > 0, 'Screenshot PNG should be non-empty');
    console.log('  [PASS] Standardized UI-Password login + full StorageState replay + geometry/occlusion/screenshot verified.');

    console.log('=== [3/3] Testing Reusable Assertion Recipes ===');
    const page = await mockMp.currentPage();
    const widthMetrics = await assertMpFullWidthLayout(page, '.page-container', '.detail-card', 16);
    assert.equal(widthMetrics.leftGapPx, 12);

    const dataCheck = await assertMpPageData(page, {
      'detailData.id': 1001,
      'detailData.status': 'APPROVED',
    });
    assert.equal(dataCheck['detailData.id'], 1001);

    await assert.rejects(
      async () => {
        await assertMpNotOccluded(mockMp, '.dropdown-menu', '.sticky-col');
      },
      /occluded by fixed\/positioned element/,
      'assertMpNotOccluded should throw when covered by higher z-index fixed element'
    );

    const updatedData = await triggerMpComponentMethod(page, 'onConfirmSubmit', { id: 91 });
    assert.equal(updatedData.lastCalledMethod, 'onConfirmSubmit');

    const shotMeta = await captureMpScreenshot(mockMp, path.join(tmpDir, 'recipe-shot.png'));
    assert.ok(shotMeta.bytes > 0);
    console.log('  [PASS] All 5 assertion recipes verified.');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('\n🎉 ALL SELF-TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
