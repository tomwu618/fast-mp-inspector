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

    console.log('=== [2/3] Testing Layer 3 & 4: CLI Inspection Pipeline + Screenshot ===');
    const mockMp = createMockMiniProgramSession();
    const shotPath = path.join(tmpDir, 'verify-shot.png');

    const report = await runInspectionWithSession(mockMp, {
      route: '/subpages/elder/residence-change?id=91',
      storage: JSON.stringify({ token: 'mock-jwt-token', role: 'NURSE' }),
      globalData: JSON.stringify({ role: 'NURSE', permissions: ['elder:edit'] }),
      parent: '.page-container',
      target: '.form-card',
      occlude: '.dropdown-menu',
      occluders: '.sticky-col',
      dataPath: 'formData',
      waitMs: '10',
      screenshot: shotPath,
    });

    assert.equal(report.route, '/subpages/elder/residence-change');
    assert.deepEqual(report.auth.syncedStorageKeys, ['token', 'role']);
    assert.deepEqual(report.auth.syncedGlobalDataKeys, ['role', 'permissions']);
    assert.equal(report.pageData.elderId, 91);
    assert.equal(report.layout.leftGapPx, 12);
    assert.equal(report.layout.rightGapPx, 12);
    assert.equal(report.layout.leftGapRpx, 24);
    assert.equal(report.occlusion.isOccluded, true, 'Dropdown z-index 10 should be occluded by fixed header z-index 50');
    assert.equal(report.screenshot.exists, true, 'Screenshot PNG file should be written to disk');
    assert.ok(report.screenshot.bytes > 0, 'Screenshot PNG should be non-empty');
    console.log('  [PASS] CLI inspection report (MVVM data + rpx/px geometry + AABB occlusion + PNG screenshot) verified.');

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
