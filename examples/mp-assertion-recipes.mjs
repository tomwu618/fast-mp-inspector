/**
 * Reusable WeChat Mini Program E2E & WXSS Layout Assertion Recipes (mp-assertion-recipes.mjs)
 *
 * Designed for `miniprogram-automator` (Native WeChat / uni-app / Taro).
 * Provides 5 deterministic helpers:
 * 1. assertMpFullWidthLayout: Verifies WXSS container horizontal fill & left/right gaps (in px and rpx)
 * 2. assertMpNotOccluded: Detects fixed/sticky element occlusion using SelectorQuery + AABB intersection math
 * 3. assertMpPageData: Directly asserts AppService MVVM `page.data()` without slow UI scraping
 * 4. triggerMpComponentMethod: Invokes `page.callMethod()` or `element.trigger()` for zero-click interaction testing
 * 5. captureMpScreenshot: Captures simulator PNG screenshot to disk or returns Base64
 */

import fs from 'node:fs';
import path from 'node:path';
import { computeAabbIntersection } from '../scripts/inspect-mp.mjs';

/**
 * 1. Verify that a target WXML element fills its parent container within `maxAllowedGapPx`
 */
export async function assertMpFullWidthLayout(page, parentSelector, childSelector, maxAllowedGapPx = 24) {
  const parentEl = await page.$(parentSelector);
  const childEl = await page.$(childSelector);

  if (!childEl) {
    throw new Error(`Target WXML element "${childSelector}" not found on page ${page.path}`);
  }

  const [pSize, pOffset, cSize, cOffset, maxWidth, margin, padding] = await Promise.all([
    parentEl ? parentEl.size() : Promise.resolve({ width: 375, height: 667 }),
    parentEl ? parentEl.offset() : Promise.resolve({ left: 0, top: 0 }),
    childEl.size(),
    childEl.offset(),
    childEl.style('max-width'),
    childEl.style('margin'),
    childEl.style('padding'),
  ]);

  const leftGapPx = Math.round(cOffset.left - pOffset.left);
  const rightGapPx = Math.round(pOffset.left + pSize.width - (cOffset.left + cSize.width));
  const fillRatio = Number((cSize.width / Math.max(pSize.width, 1)).toFixed(4));

  const metrics = {
    parentWidth: pSize.width,
    childWidth: cSize.width,
    leftGapPx,
    rightGapPx,
    fillRatio,
    computedStyle: { maxWidth, margin, padding },
  };

  if (leftGapPx > maxAllowedGapPx || rightGapPx > maxAllowedGapPx) {
    throw new Error(
      `WXSS layout width regression on ${childSelector}: leftGap=${leftGapPx}px, rightGap=${rightGapPx}px (max allowed: ${maxAllowedGapPx}px), maxWidth=${maxWidth}`
    );
  }

  return metrics;
}

/**
 * 2. Verify that `targetSelector` is not occluded by any fixed/sticky overlay (`candidateOccludersSelector`)
 */
export async function assertMpNotOccluded(
  miniProgram,
  targetSelector,
  candidateOccludersSelector = '.fixed-bar, .custom-nav, .tab-bar, .modal-mask, .sticky-col, .fixed-footer'
) {
  const queryRes = await miniProgram.evaluate(
    ({ occludeSel, occludersSel }) => {
      return new Promise((resolve) => {
        const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
        const curPage = pages[pages.length - 1];
        const q =
          curPage && typeof curPage.createSelectorQuery === 'function'
            ? curPage.createSelectorQuery()
            : wx.createSelectorQuery();

        const styleFields = ['display', 'position', 'zIndex', 'visibility', 'opacity'];
        q.select(occludeSel).fields({ id: true, rect: true, size: true, computedStyle: styleFields });
        q.selectAll(occludersSel).fields({ id: true, dataset: true, rect: true, size: true, computedStyle: styleFields });
        q.exec((res) => {
          resolve({
            occludeTargetNode: res?.[0] || null,
            occluderNodes: res?.[1] || [],
          });
        });
      });
    },
    { occludeSel: targetSelector, occludersSel: candidateOccludersSelector }
  );

  const target = queryRes.occludeTargetNode;
  if (!target) {
    throw new Error(`Target WXML element "${targetSelector}" not found for occlusion check`);
  }

  const targetZ = Number.isNaN(Number(target.zIndex)) ? 0 : Number(target.zIndex);
  const coveringNodes = [];

  for (const cand of queryRes.occluderNodes || []) {
    if (!cand || cand.display === 'none' || cand.visibility === 'hidden' || Number(cand.opacity) === 0) {
      continue;
    }
    const aabb = computeAabbIntersection(target, cand);
    const candZ = Number.isNaN(Number(cand.zIndex)) ? 0 : Number(cand.zIndex);
    if (aabb.intersects && candZ >= targetZ && cand.position !== 'static') {
      coveringNodes.push({
        id: cand.id || null,
        zIndex: cand.zIndex,
        position: cand.position,
        ...aabb,
      });
    }
  }

  if (coveringNodes.length > 0) {
    const first = coveringNodes[0];
    throw new Error(
      `Element "${targetSelector}" (z-index: ${target.zIndex}) is occluded by fixed/positioned element (id="${first.id}", z-index: ${first.zIndex}, overlapRatio=${first.overlapRatioOfTarget})`
    );
  }

  return { ok: true, targetZIndex: target.zIndex, collisionsChecked: (queryRes.occluderNodes || []).length };
}

/**
 * 3. Directly assert AppService MVVM `page.data()` keys without scraping WXML text
 */
export async function assertMpPageData(page, expectedKeyValues) {
  const results = {};
  for (const [dataPath, expectedVal] of Object.entries(expectedKeyValues)) {
    const actualVal = await page.data(dataPath);
    results[dataPath] = actualVal;
    if (JSON.stringify(actualVal) !== JSON.stringify(expectedVal)) {
      throw new Error(
        `Page.data("${dataPath}") mismatch: expected ${JSON.stringify(expectedVal)}, got ${JSON.stringify(actualVal)}`
      );
    }
  }
  return results;
}

/**
 * 4. Invoke a Page method or synthesize a WXML custom event directly
 */
export async function triggerMpComponentMethod(page, methodName, mockEventPayload = {}) {
  await page.callMethod(methodName, mockEventPayload);
  await page.waitFor(150);
  return await page.data();
}

/**
 * 5. Capture a simulator screenshot to a file path (and return metadata)
 */
export async function captureMpScreenshot(miniProgram, filePath) {
  const absPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  await miniProgram.screenshot({ path: absPath });
  const stat = fs.statSync(absPath);
  return {
    path: absPath,
    bytes: stat.size,
  };
}
