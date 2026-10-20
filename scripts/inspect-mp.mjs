#!/usr/bin/env node
/**
 * Fast Mini-Program E2E, MVVM Data & WXSS Layout Inspector CLI (inspect-mp.mjs)
 *
 * Powered by WeChat official `miniprogram-automator`.
 *
 * Usage (Connect to running DevTools automation port - fastest, <100ms):
 *   node scripts/inspect-mp.mjs \
 *     --ws "ws://127.0.0.1:9420" \
 *     --route "/subpages/order/detail?id=1001" \
 *     --storage '{"token":"eyJhbG..."}' \
 *     --parent ".page-container" \
 *     --target ".detail-card" \
 *     --occlude ".dropdown-menu" \
 *     --occluders ".fixed-header, .sticky-table-col, .bottom-bar" \
 *     --data-path "detailData" \
 *     --screenshot "./mp-report.png"
 *
 * Usage (Auto-launch WeChat DevTools):
 *   node scripts/inspect-mp.mjs \
 *     --project-path "D:/workspace/my-miniprogram/dist/dev/mp-weixin" \
 *     --route "/pages/index/index" \
 *     --screenshot "./home.png"
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureStandardMpAuthAndNavigate } from './auth-helper.mjs';

export function parseArgs(argv) {
  const args = {
    ws: '',
    projectPath: '',
    cliPath: '',
    route: '',
    bounceRoute: '',
    captureApi: '',
    saveApiJson: '',
    readText: '',
    role: '',
    dumpAuth: '',
    loadAuth: '',
    loginRoute: '/pages/login/index',
    username: '',
    password: '',
    userSelector: '.username-input, input[type="text"], input[name="username"]',
    passSelector: '.password-input, input[password], input[type="password"], input[name="password"]',
    submitSelector: '.login-btn, button[form-type="submit"], button[type="primary"]',
    loginMethod: '',
    loginUrl: '',
    loginBody: '',
    usernameField: 'username',
    passwordField: 'password',
    tokenField: 'data.token',
    tokenStorageKey: 'token',
    storage: '',
    globalData: '',
    tapBefore: '',
    callMethod: '',
    parent: '',
    target: '',
    occlude: '',
    occluders: '.fixed-bar, .custom-nav, .tab-bar, .modal-mask, .sticky-col, .fixed-footer',
    dataPath: '',
    waitMs: '600',
    screenshot: '',
    screenshotBase64: false,
    keepOpen: true,
    mock: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === '--mock') {
      args.mock = true;
      continue;
    }
    if (raw === '--screenshot-base64') {
      args.screenshotBase64 = true;
      continue;
    }
    if (raw === '--close') {
      args.keepOpen = false;
      continue;
    }
    if (raw.startsWith('--')) {
      const camelKey = raw
        .slice(2)
        .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (camelKey in args && argv[i + 1] !== undefined) {
        args[camelKey] = argv[i + 1];
        i++;
      }
    }
  }
  return args;
}

/**
 * Pure mathematical AABB (Axis-Aligned Bounding Box) intersection calculator
 */
export function computeAabbIntersection(rectA, rectB) {
  const xOverlap = Math.max(0, Math.min(rectA.right, rectB.right) - Math.max(rectA.left, rectB.left));
  const yOverlap = Math.max(0, Math.min(rectA.bottom, rectB.bottom) - Math.max(rectA.top, rectB.top));
  const overlapArea = xOverlap * yOverlap;
  const areaA = Math.max(1, rectA.width * rectA.height);
  return {
    intersects: overlapArea > 0,
    overlapWidth: Math.round(xOverlap),
    overlapHeight: Math.round(yOverlap),
    overlapArea: Math.round(overlapArea),
    overlapRatioOfTarget: Number((overlapArea / areaA).toFixed(4)),
  };
}

/**
 * Detect default WeChat DevTools CLI path on Windows / macOS
 */
function detectDefaultCliPath() {
  const candidates =
    process.platform === 'darwin'
      ? ['/Applications/wechatwebdevtools.app/Contents/MacOS/cli']
      : [
          'C:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat',
          'C:/Program Files/Tencent/微信web开发者工具/cli.bat',
          'D:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat',
        ];
  return candidates.find((p) => fs.existsSync(p)) || '';
}

/**
 * Execute inspection against a connected `miniProgram` instance (real or mock)
 */
export async function runInspectionWithSession(miniProgram, args) {
  const t0 = Date.now();
  const consoleLogs = [];
  const runtimeExceptions = [];

  if (typeof miniProgram.on === 'function') {
    miniProgram.on('console', (msg) => {
      if (msg?.type === 'error' || msg?.type === 'warn') {
        consoleLogs.push({ type: msg.type, args: msg.args });
      }
    });
    miniProgram.on('exception', (err) => {
      runtimeExceptions.push({ message: err?.message || String(err), stack: err?.stack });
    });
  }

  // 1 & 2. Standardized Multi-Role Auth (UI-Password / StorageState Snapshot / HTTP-Password)
  // Optional: If --bounce-route is set (e.g. "/pages/index/index"), leave current detail page to bounceRoute first,
  // install in-AppService wx.request live network tap, then enter the target --route so the page fires a fresh request!
  const targetRoute = args.route;
  if (args.bounceRoute && targetRoute) {
    args.route = args.bounceRoute;
  }

  const { authSummary: authReport, page: initialPage } = await ensureStandardMpAuthAndNavigate(miniProgram, args);
  args.route = targetRoute;

  // Install in-AppService wx.request live network recorder BEFORE entering target route (or before page reload)
  if (args.captureApi || args.saveApiJson) {
    await miniProgram.evaluate((urlPattern) => {
      const globalObj = typeof getApp === 'function' ? getApp({ allowDefault: true }) || {} : {};
      globalObj.__FAST_MP_CAPTURED_REQUESTS__ = [];
      if (typeof wx !== 'undefined' && typeof wx.request === 'function') {
        const rawRequest = wx.__fastMpRawRequest || wx.request.bind(wx);
        wx.__fastMpRawRequest = rawRequest;
        const wrappedRequest = function (options = {}) {
          const reqUrl = String(options.url || '');
          const origSuccess = options.success;
          const origFail = options.fail;
          const startedAt = Date.now();

          options.success = function (res) {
            if (!urlPattern || reqUrl.includes(urlPattern)) {
              globalObj.__FAST_MP_CAPTURED_REQUESTS__.push({
                url: reqUrl,
                method: options.method || 'GET',
                statusCode: res.statusCode,
                data: res.data,
                headers: res.header || {},
                durationMs: Date.now() - startedAt,
                timestamp: new Date().toISOString(),
              });
            }
            if (typeof origSuccess === 'function') origSuccess.call(this, res);
          };

          options.fail = function (err) {
            if (!urlPattern || reqUrl.includes(urlPattern)) {
              globalObj.__FAST_MP_CAPTURED_REQUESTS__.push({
                url: reqUrl,
                method: options.method || 'GET',
                statusCode: 0,
                error: err?.errMsg || String(err),
                durationMs: Date.now() - startedAt,
                timestamp: new Date().toISOString(),
              });
            }
            if (typeof origFail === 'function') origFail.call(this, err);
          };

          return rawRequest(options);
        };

        try {
          Object.defineProperty(wx, 'request', {
            configurable: true,
            enumerable: true,
            writable: true,
            value: wrappedRequest,
          });
        } catch {
          wx.request = wrappedRequest;
        }
      }
    }, args.captureApi || '');
  }

  let page = initialPage;
  if (targetRoute && (args.bounceRoute || args.captureApi || args.saveApiJson)) {
    const normalizedRoute = targetRoute.startsWith('/') ? targetRoute : `/${targetRoute}`;
    page = await miniProgram.reLaunch(normalizedRoute);
    await page.waitFor(Number(args.waitMs) || 600);
  }

  if (!page) {
    throw new Error('Unable to acquire active Mini Program page instance.');
  }

  // 3. Optional pre-inspection interaction (tap or callMethod)
  if (args.tapBefore) {
    const tapEl = await page.$(args.tapBefore);
    if (tapEl) {
      await tapEl.tap();
      await page.waitFor(250);
    }
  }
  if (args.callMethod) {
    await page.callMethod(args.callMethod);
    await page.waitFor(250);
  }

  // 4. Read MVVM Page.data directly from AppService
  const pageDataSnapshot = await page.data(args.dataPath || undefined);

  // 4b. Read rendered WXML text from selectors if --read-text is specified (comma-separated or JSON map)
  let renderedTextReport = null;
  if (args.readText) {
    renderedTextReport = {};
    const selectors = args.readText.trim().startsWith('{')
      ? Object.entries(JSON.parse(args.readText))
      : args.readText.split(',').map((s) => [s.trim(), s.trim()]);

    for (const [label, sel] of selectors) {
      const el = await page.$(sel);
      renderedTextReport[label] = el && typeof el.text === 'function' ? await el.text() : null;
    }
  }

  // 4c. Collect live in-page wx.request network responses & save raw JSON if --save-api-json is specified
  let capturedNetworkReport = null;
  if (args.captureApi || args.saveApiJson) {
    const capturedList = await miniProgram.evaluate(() => {
      const globalObj = typeof getApp === 'function' ? getApp({ allowDefault: true }) || {} : {};
      return globalObj.__FAST_MP_CAPTURED_REQUESTS__ || [];
    });
    capturedNetworkReport = capturedList;

    if (args.saveApiJson && Array.isArray(capturedList) && capturedList.length > 0) {
      const absJsonPath = path.resolve(args.saveApiJson);
      fs.mkdirSync(path.dirname(absJsonPath), { recursive: true });
      const latestMatch = capturedList[capturedList.length - 1];
      fs.writeFileSync(absJsonPath, JSON.stringify(latestMatch, null, 2));
    }
  }

  // 5. Query System Info + SelectorQuery Geometry & WXSS Computed Styles in a single AppService round-trip
  const rawQueryReport = await miniProgram.evaluate(
    ({ parentSel, targetSel, occludeSel, occludersSel }) => {
      return new Promise((resolve) => {
        const sys = wx.getSystemInfoSync ? wx.getSystemInfoSync() : { windowWidth: 375, windowHeight: 667, pixelRatio: 2 };
        const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
        const curPage = pages[pages.length - 1];
        const q =
          curPage && typeof curPage.createSelectorQuery === 'function'
            ? curPage.createSelectorQuery()
            : wx.createSelectorQuery();

        const styleFields = [
          'width',
          'height',
          'maxWidth',
          'margin',
          'padding',
          'boxSizing',
          'display',
          'position',
          'zIndex',
          'visibility',
          'opacity',
        ];

        if (parentSel) {
          q.select(parentSel).fields({ id: true, dataset: true, rect: true, size: true, computedStyle: styleFields });
        }
        if (targetSel) {
          q.select(targetSel).fields({ id: true, dataset: true, rect: true, size: true, computedStyle: styleFields });
        }
        if (occludeSel) {
          q.select(occludeSel).fields({ id: true, dataset: true, rect: true, size: true, computedStyle: styleFields });
          q.selectAll(occludersSel).fields({
            id: true,
            dataset: true,
            rect: true,
            size: true,
            computedStyle: styleFields,
          });
        }

        q.exec((res) => {
          let idx = 0;
          const parentNode = parentSel ? res?.[idx++] : null;
          const targetNode = targetSel ? res?.[idx++] : null;
          const occludeTargetNode = occludeSel ? res?.[idx++] : null;
          const occluderNodes = occludeSel ? res?.[idx++] || [] : [];

          resolve({
            systemInfo: {
              windowWidth: sys.windowWidth,
              windowHeight: sys.windowHeight,
              pixelRatio: sys.pixelRatio,
              rpxToPxRatio: Number((sys.windowWidth / 750).toFixed(4)),
              platform: sys.platform || 'devtools',
            },
            parentNode,
            targetNode,
            occludeTargetNode,
            occluderNodes,
          });
        });
      });
    },
    {
      parentSel: args.parent,
      targetSel: args.target,
      occludeSel: args.occlude,
      occludersSel: args.occluders,
    }
  );

  // 6. Compute Layout & Horizontal Fill Math
  let layoutReport = null;
  if (args.target) {
    const t = rawQueryReport.targetNode;
    const p = rawQueryReport.parentNode;
    const sys = rawQueryReport.systemInfo;

    if (!t) {
      layoutReport = { error: `Target selector "${args.target}" not found in WXML` };
    } else {
      const pLeft = p ? p.left : 0;
      const pRight = p ? p.right : sys.windowWidth;
      const pWidth = p ? p.width : sys.windowWidth;

      layoutReport = {
        parentSelector: args.parent || 'windowViewport',
        targetSelector: args.target,
        parentRect: { left: Math.round(pLeft), right: Math.round(pRight), width: Math.round(pWidth) },
        targetRect: {
          left: Math.round(t.left),
          top: Math.round(t.top),
          right: Math.round(t.right),
          bottom: Math.round(t.bottom),
          width: Math.round(t.width),
          height: Math.round(t.height),
        },
        leftGapPx: Math.round(t.left - pLeft),
        rightGapPx: Math.round(pRight - t.right),
        leftGapRpx: Math.round((t.left - pLeft) / sys.rpxToPxRatio),
        rightGapRpx: Math.round((pRight - t.right) / sys.rpxToPxRatio),
        horizontalFillRatio: Number((t.width / Math.max(pWidth, 1)).toFixed(4)),
        targetComputedWXSS: {
          width: t.width,
          maxWidth: t.maxWidth,
          margin: t.margin,
          padding: t.padding,
          boxSizing: t.boxSizing,
          display: t.display,
          position: t.position,
          zIndex: t.zIndex,
        },
      };
    }
  }

  // 7. Compute AABB + Z-Index Occlusion Math
  let occlusionReport = null;
  if (args.occlude) {
    const target = rawQueryReport.occludeTargetNode;
    const candidates = rawQueryReport.occluderNodes || [];
    if (!target) {
      occlusionReport = { error: `Occlude selector "${args.occlude}" not found in WXML` };
    } else {
      const targetZ = Number.isNaN(Number(target.zIndex)) ? 0 : Number(target.zIndex);
      const collisions = [];

      for (const cand of candidates) {
        if (!cand || cand.display === 'none' || cand.visibility === 'hidden' || Number(cand.opacity) === 0) {
          continue;
        }
        // Skip self
        if (
          cand.left === target.left &&
          cand.top === target.top &&
          cand.width === target.width &&
          cand.height === target.height &&
          cand.zIndex === target.zIndex
        ) {
          continue;
        }
        const aabb = computeAabbIntersection(target, cand);
        if (aabb.intersects) {
          const candZ = Number.isNaN(Number(cand.zIndex)) ? 0 : Number(cand.zIndex);
          const isCoveringByZIndex = candZ >= targetZ && cand.position !== 'static';
          collisions.push({
            id: cand.id || null,
            dataset: cand.dataset || {},
            rect: {
              left: Math.round(cand.left),
              top: Math.round(cand.top),
              width: Math.round(cand.width),
              height: Math.round(cand.height),
            },
            position: cand.position,
            zIndex: cand.zIndex,
            isCoveringTarget: isCoveringByZIndex,
            ...aabb,
          });
        }
      }

      occlusionReport = {
        selector: args.occlude,
        targetRect: {
          left: Math.round(target.left),
          top: Math.round(target.top),
          width: Math.round(target.width),
          height: Math.round(target.height),
        },
        targetPosition: target.position,
        targetZIndex: target.zIndex,
        isOccluded: collisions.some((c) => c.isCoveringTarget),
        collisions,
      };
    }
  }

  // 8. Capture Simulator Screenshot (file or Base64)
  let screenshotInfo = null;
  if (args.screenshot) {
    const absShotPath = path.resolve(args.screenshot);
    fs.mkdirSync(path.dirname(absShotPath), { recursive: true });
    await miniProgram.screenshot({ path: absShotPath });
    screenshotInfo = {
      savedPath: absShotPath,
      exists: fs.existsSync(absShotPath),
      bytes: fs.existsSync(absShotPath) ? fs.statSync(absShotPath).size : 0,
    };
  } else if (args.screenshotBase64) {
    const b64 = await miniProgram.screenshot();
    screenshotInfo = {
      base64Length: b64 ? b64.length : 0,
      base64Preview: b64 ? `${b64.slice(0, 64)}...` : null,
    };
  }

  return {
    elapsedMs: Date.now() - t0,
    route: page.path || args.route || '/pages/index/index',
    bouncedVia: args.bounceRoute || null,
    auth: authReport,
    systemInfo: rawQueryReport.systemInfo,
    dataPath: args.dataPath || '(root)',
    pageData: pageDataSnapshot,
    renderedText: renderedTextReport,
    capturedRequests: capturedNetworkReport,
    layout: layoutReport,
    occlusion: occlusionReport,
    screenshot: screenshotInfo,
    consoleLogs,
    runtimeExceptions,
  };
}

/**
 * Create a deterministic in-memory mock `miniProgram` session for `--mock` self-testing
 * when WeChat DevTools is not running on the host machine.
 */
export function createMockMiniProgramSession() {
  // 1x1 transparent PNG in base64
  const DUMMY_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const storage = new Map();
  let currentRoute = '/subpages/order/detail';
  const pageData = {
    detailData: { id: 1001, orderNo: 'ORD-2026-1001', assigneeName: 'Alice', status: 'APPROVED' },
    loading: false,
  };

  const mockElements = {
    '.page-container': {
      id: 'page-wrap',
      left: 0,
      top: 0,
      right: 375,
      bottom: 667,
      width: 375,
      height: 667,
      display: 'flex',
      padding: '12px',
      position: 'relative',
      zIndex: 'auto',
    },
    '.detail-card': {
      id: 'detail-card',
      text: 'ORD-2026-1001',
      left: 12,
      top: 16,
      right: 363,
      bottom: 520,
      width: 351,
      height: 504,
      maxWidth: 'none',
      margin: '0px',
      padding: '16px',
      boxSizing: 'border-box',
      display: 'block',
      position: 'relative',
      zIndex: '1',
    },
    '.dropdown-menu': {
      id: 'account-dropdown',
      left: 240,
      top: 44,
      right: 365,
      bottom: 180,
      width: 125,
      height: 136,
      display: 'block',
      position: 'absolute',
      zIndex: '10',
      visibility: 'visible',
      opacity: '1',
    },
  };

  const mockOccluders = [
    {
      id: 'sticky-table-header',
      dataset: { role: 'fixed-col' },
      left: 260,
      top: 80,
      right: 375,
      bottom: 300,
      width: 115,
      height: 220,
      display: 'block',
      position: 'fixed',
      zIndex: '50',
      visibility: 'visible',
      opacity: '1',
    },
  ];

  const mockPage = {
    get path() {
      return currentRoute;
    },
    async waitFor() {},
    async $(sel) {
      // Support login form selectors in mock mode
      if (sel.includes('username') || sel.includes('password') || sel.includes('login-btn')) {
        return {
          async input(val) {
            storage.set(sel.includes('username') ? 'lastInputUsername' : 'lastInputPassword', val);
          },
          async tap() {
            // Simulate Mini Program login writing multiple custom storage keys (e.g. uni_id_token, permissions)
            storage.set('uni_id_token', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.mock');
            storage.set('userInfo', { username: storage.get('lastInputUsername'), role: 'STAFF' });
            storage.set('permissions', ['order:view', 'order:edit']);
            currentRoute = '/pages/index/index';
          },
        };
      }
      const m = mockElements[sel];
      if (!m) return null;
      return {
        async tap() {},
        async text() {
          return m.text ?? '';
        },
        async size() {
          return { width: m.width, height: m.height };
        },
        async offset() {
          return { left: m.left, top: m.top };
        },
        async style(prop) {
          return String(m[prop] ?? '');
        },
      };
    },
    async callMethod(name) {
      pageData.lastCalledMethod = name;
    },
    async data(subPath) {
      if (!subPath) return pageData;
      return subPath.split('.').reduce((acc, k) => acc?.[k], pageData);
    },
  };

  return {
    on() {},
    async reLaunch(route) {
      currentRoute = route.split('?')[0];
      return mockPage;
    },
    async currentPage() {
      return mockPage;
    },
    async evaluate(fn, arg) {
      // Simulate wx globals in a sandboxed mock context
      if (arg && typeof arg === 'object' && ('parentSel' in arg || 'targetSel' in arg || 'occludeSel' in arg)) {
        return {
          systemInfo: {
            windowWidth: 375,
            windowHeight: 667,
            pixelRatio: 2,
            rpxToPxRatio: 0.5,
            platform: 'devtools-mock',
          },
          parentNode: arg.parentSel ? mockElements[arg.parentSel] || null : null,
          targetNode: arg.targetSel ? mockElements[arg.targetSel] || null : null,
          occludeTargetNode: arg.occludeSel ? mockElements[arg.occludeSel] || null : null,
          occluderNodes: arg.occludeSel ? mockOccluders : [],
        };
      }
      // Simulate live wx.request network capture in mock mode
      if (typeof arg === 'string') {
        return true;
      }
      if (!arg && fn.toString().includes('__FAST_MP_CAPTURED_REQUESTS__')) {
        return [
          {
            url: 'https://api.example.com/api/v1/orders/1001',
            method: 'GET',
            statusCode: 200,
            data: {
              id: 1001,
              orderNo: 'ORD-2026-1001',
              assigneeName: 'Alice',
              status: 'APPROVED',
            },
            durationMs: 42,
          },
        ];
      }
      // Storage + globalData injection or dump simulation
      if (!arg) {
        const storageMap = Object.fromEntries(storage.entries());
        return {
          storageMap,
          globalDataMap: { isLogin: true, role: storageMap.userInfo?.role || 'STAFF' },
        };
      }
      if (arg && typeof arg === 'object' && ('sMap' in arg || 'gMap' in arg)) {
        const sKeys = Object.keys(arg.sMap || {});
        const gKeys = Object.keys(arg.gMap || {});
        for (const [k, v] of Object.entries(arg.sMap || {})) {
          storage.set(k, v);
        }
        return {
          syncedStorageKeys: sKeys,
          syncedGlobalDataKeys: gKeys,
        };
      }
      if (arg && typeof arg === 'object') {
        for (const [k, v] of Object.entries(arg)) {
          storage.set(k, v);
        }
      }
      return true;
    },
    async screenshot(opts) {
      const buf = Buffer.from(DUMMY_PNG_B64, 'base64');
      if (opts?.path) {
        fs.writeFileSync(opts.path, buf);
        return;
      }
      return DUMMY_PNG_B64;
    },
    async disconnect() {},
    async close() {},
  };
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.mock && !args.ws && !args.projectPath) {
    console.error(
      'Usage:\n' +
        '  1. Attach to running DevTools : node scripts/inspect-mp.mjs --ws ws://127.0.0.1:9420 --route /pages/index/index --target .card --screenshot ./out.png\n' +
        '  2. Launch DevTools project    : node scripts/inspect-mp.mjs --project-path ./dist/dev/mp-weixin --route /pages/index/index\n' +
        '  3. Self-test mock mode        : node scripts/inspect-mp.mjs --mock --parent .page-container --target .detail-card --occlude .dropdown-menu --screenshot ./mock.png'
    );
    process.exit(1);
  }

  let miniProgram;
  if (args.mock) {
    miniProgram = createMockMiniProgramSession();
  } else {
    const automatorModule = await import('miniprogram-automator');
    const automator = automatorModule.default || automatorModule;
    if (args.ws) {
      miniProgram = await automator.connect({ wsEndpoint: args.ws });
    } else {
      const cliPath = args.cliPath || detectDefaultCliPath();
      miniProgram = await automator.launch({
        ...(cliPath ? { cliPath } : {}),
        projectPath: path.resolve(args.projectPath),
      });
    }
  }

  try {
    const report = await runInspectionWithSession(miniProgram, args);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (!args.mock && miniProgram) {
      if (args.ws || args.keepOpen) {
        await miniProgram.disconnect?.();
      } else {
        await miniProgram.close?.();
      }
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
