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
          root: 'subpages/elder',
          pages: ['residence-change'],
        },
      ],
    };
    fs.writeFileSync(path.join(tmpDir, 'app.json'), JSON.stringify(appJson, null, 2));
    fs.mkdirSync(path.join(tmpDir, 'pages/index'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'pages/index/index.js'), 'Page({})');
    fs.writeFileSync(path.join(tmpDir, 'pages/index/index.wxml'), '<view class="page-container"></view>');
    fs.writeFileSync(path.join(tmpDir, 'pages/index/index.wxss'), '.page-container { width: 750rpx; }');

    fs.mkdirSync(path.join(tmpDir, 'subpages/elder'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'subpages/elder/residence-change.js'), 'Page({})');
    fs.writeFileSync(path.join(tmpDir, 'subpages/elder/residence-change.wxml'), '<view class="form-card"></view>');

    const passReport = checkMpBundle(tmpDir);
    assert.equal(passReport.ok, true, 'Valid bundle should pass checkMpBundle');
    assert.equal(passReport.totalRoutesChecked, 2);
    console.log('  [PASS] Valid main package + subpackage verified intact.');

    // Simulate mid-build missing/truncated file
    fs.writeFileSync(path.join(tmpDir, 'subpages/elder/residence-change.js'), '');
    const failReport = checkMpBundle(tmpDir);
    assert.equal(failReport.ok, false, 'Truncated 0-byte subpackage JS should fail checkMpBundle');
    assert.equal(failReport.emptyFiles.length, 1);
    console.log('  [PASS] Truncated subpackage file accurately detected.');

    console.log('=== [2/3] Testing Layer 3 & 4: Standardized UI-Password Login -> StorageState Snapshot -> Fast Replay ===');
    const mockMp = createMockMiniProgramSession();
    const shotPath = path.join(tmpDir, 'verify-shot.png');
    const stateFile = path.join(tmpDir, 'nurse.state.json');

    // Run 1: UI Username/Password login on /pages/login/index -> auto-dumps ALL custom storage keys (uni_id_token, permissions, etc.)
    const firstRun = await runInspectionWithSession(mockMp, {
      route: '/subpages/elder/residence-change?id=91',
      role: 'nurse',
      loadAuth: stateFile,
      loginRoute: '/pages/login/index',
      username: 'nurse_zhang',
      password: 'Password123!',
      parent: '.page-container',
      target: '.form-card',
      occlude: '.dropdown-menu',
      occluders: '.sticky-col',
      dataPath: 'formData',
      waitMs: '10',
      screenshot: shotPath,
    });

    assert.equal(firstRun.route, '/subpages/elder/residence-change');
    assert.equal(firstRun.auth.authMethod, 'ui-password');
    assert.equal(firstRun.auth.fromCache, false);
    assert.ok(firstRun.auth.syncedStorageKeys.includes('uni_id_token'), 'Should capture arbitrary app storage key uni_id_token');
    assert.ok(firstRun.auth.syncedStorageKeys.includes('permissions'), 'Should capture arbitrary app storage key permissions');
    assert.ok(fs.existsSync(stateFile), 'StorageState file should be saved to disk');

    // Run 2: Subsequent run with same role/stateFile skips UI login and restores full StorageState in 0ms
    const secondRun = await runInspectionWithSession(mockMp, {
      route: '/subpages/elder/residence-change?id=91',
      role: 'nurse',
      loadAuth: stateFile,
      username: 'nurse_zhang',
      password: 'Password123!',
      parent: '.page-container',
      target: '.form-card',
      occlude: '.dropdown-menu',
      occluders: '.sticky-col',
      dataPath: 'formData',
      waitMs: '10',
      screenshot: shotPath,
    });

    assert.equal(secondRun.auth.fromCache, true, 'Second run should load directly from cached StorageState');
    assert.equal(secondRun.pageData.elderId, 91);
    assert.equal(secondRun.layout.leftGapPx, 12);
    assert.equal(secondRun.layout.rightGapPx, 12);
    assert.equal(secondRun.layout.leftGapRpx, 24);
    assert.equal(secondRun.occlusion.isOccluded, true, 'Dropdown z-index 10 should be occluded by fixed header z-index 50');
    assert.equal(secondRun.screenshot.exists, true, 'Screenshot PNG file should be written to disk');
    assert.ok(secondRun.screenshot.bytes > 0, 'Screenshot PNG should be non-empty');
    console.log('  [PASS] Standardized UI-Password login + full StorageState replay + geometry/occlusion/screenshot verified.');

    console.log('=== [3/3] Testing Reusable Assertion Recipes ===');
    const page = await mockMp.currentPage();
    const widthMetrics = await assertMpFullWidthLayout(page, '.page-container', '.form-card', 16);
    assert.equal(widthMetrics.leftGapPx, 12);

    const dataCheck = await assertMpPageData(page, {
      'formData.elderId': 91,
      'formData.status': 'APPROVED',
    });
    assert.equal(dataCheck['formData.elderId'], 91);

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
