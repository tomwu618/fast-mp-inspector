/**
 * Core Execution Engine for fast-mp-inspector (src/mp-core.mjs)
 * Implements Section 3 & Section 5 of MCP Integration Spec v1.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { checkMpBundle } from '../scripts/check-mp-bundle.mjs';
import { computeAabbIntersection, getFreePort, isPortOpen } from '../scripts/inspect-mp.mjs';
import {
  TOOL_VERSION,
  buildResponseEnvelope,
  createEvidenceEntry,
  createStructuredError,
  generateRunId,
  redactSensitiveData,
  resolveMpAuthReference,
  validateSafePath,
  validateSafeWsEndpoint,
} from './common.mjs';

export const activeMpJobs = new Map();
const sessionLocks = new Map();

async function withSessionLock(lockKey, fn) {
  const key = lockKey || 'default_mp_session';
  const prev = sessionLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  sessionLocks.set(key, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (sessionLocks.get(key) === next) {
      sessionLocks.delete(key);
    }
  }
}

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

export async function getMpStaticEnvironment(cliPathArg = '') {
  let automatorVersion = 'not-installed';
  const pkgPath = path.resolve(process.cwd(), 'node_modules/miniprogram-automator/package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      automatorVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
    } catch {
      // ignore
    }
  } else {
    try {
      await import('miniprogram-automator');
      automatorVersion = 'installed';
    } catch {
      automatorVersion = 'not-installed';
    }
  }

  const cliPath = cliPathArg || process.env.FAST_MP_CLI_PATH || detectDefaultCliPath();
  const cliExists = Boolean(cliPath && fs.existsSync(cliPath));

  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    automatorVersion,
    cliPath: cliPath || null,
    cliExists,
  };
}

/**
 * Tool 1: `mp_diagnose` — Static environment & connection readiness probe (ZERO DevTools launch side effects)
 */
export async function runMpDiagnose(args = {}) {
  const startedAtDate = new Date();
  const runId = generateRunId('mp_diag');
  const errors = [];
  const assertions = [];

  const envStatus = await getMpStaticEnvironment(args.cliPath);

  let projectExists = false;
  let appJsonFound = false;
  let resolvedProjectPath = null;

  if (args.projectPath) {
    try {
      const safePath = validateSafePath(args.projectPath, [args.projectPath], 'diagnose');
      projectExists = fs.existsSync(safePath);
      const subCandidates = [
        safePath,
        path.join(safePath, 'dist/build/mp-weixin'),
        path.join(safePath, 'dist/dev/mp-weixin'),
        path.join(safePath, 'dist'),
      ];
      resolvedProjectPath = subCandidates.find((d) => fs.existsSync(path.join(d, 'app.json'))) || safePath;
      appJsonFound = fs.existsSync(path.join(resolvedProjectPath, 'app.json'));
    } catch (e) {
      errors.push(e);
    }
  }

  let wsPortOpen = null;
  if (args.wsEndpoint) {
    try {
      const safeWs = validateSafeWsEndpoint(args.wsEndpoint, [], 'diagnose');
      const u = new URL(safeWs);
      wsPortOpen = await isPortOpen(Number(u.port || 9420), u.hostname, 300);
      assertions.push({
        id: 'diag_ws_endpoint_reachable',
        type: 'connection',
        expected: true,
        actual: wsPortOpen,
        pass: wsPortOpen,
        message: wsPortOpen
          ? `WebSocket port ${u.hostname}:${u.port} is open`
          : `WebSocket port ${u.hostname}:${u.port} is not listening`,
      });
    } catch (e) {
      errors.push(e);
    }
  }

  if (args.projectPath) {
    assertions.push({
      id: 'diag_project_app_json_exists',
      type: 'environment',
      expected: true,
      actual: appJsonFound,
      pass: appJsonFound,
      message: appJsonFound
        ? `Found app.json in ${resolvedProjectPath}`
        : `app.json not found in ${args.projectPath}`,
    });
  }

  const envelope = buildResponseEnvelope({
    runId,
    caseId: args.caseId || 'mp_diagnose',
    acIds: args.acIds || [],
    startedAtDate,
    finishedAtDate: new Date(),
    engineVersion: `miniprogram-automator/${envStatus.automatorVersion}`,
    targetRoute: args.projectPath || args.wsEndpoint || '',
    steps: [
      {
        stepId: 'static_mp_diagnose',
        action: 'diagnose',
        verificationLayer: 'static-probe',
        status: errors.length === 0 ? 'PASS' : 'FAIL',
        durationMs: Date.now() - startedAtDate.getTime(),
        detail: 'Static check of Node.js, miniprogram-automator, DevTools CLI, project path, and WebSocket port without launching DevTools.',
      },
    ],
    assertions,
    errors,
    data: {
      ...envStatus,
      devToolsLaunched: false,
      projectExists,
      appJsonFound,
      resolvedProjectPath,
      wsPortOpen,
      supportedCapabilities: [
        'mp_diagnose',
        'mp_check_bundle',
        'mp_inspect',
        'mp_run_case',
        'page_data_mvvm_assertion',
        'selector_query_geometry',
        'potential_occlusion_aabb',
        'in_page_wx_request_capture_with_restore',
        'simulator_screenshot_validation',
      ],
    },
  });

  return { envelope };
}

/**
 * Tool 2: `mp_check_bundle` — Static Mini Program bundle & subpackage validator with configurable limits
 */
export async function runMpCheckBundle(args = {}) {
  const startedAtDate = new Date();
  const runId = generateRunId('mp_bundle');
  const errors = [];
  const assertions = [];

  let safeBundleDir;
  try {
    safeBundleDir = validateSafePath(args.bundleDir || '.', [args.bundleDir].filter(Boolean), 'check-bundle');
  } catch (err) {
    errors.push(err);
    return {
      envelope: buildResponseEnvelope({
        runId,
        caseId: args.caseId || 'mp_check_bundle',
        acIds: args.acIds || [],
        startedAtDate,
        finishedAtDate: new Date(),
        errors,
      }),
    };
  }

  const report = checkMpBundle(safeBundleDir, args.limits || {});
  if (report.error) {
    errors.push(
      createStructuredError({
        code: 'BUNDLE_APP_JSON_INVALID',
        category: 'environment',
        stage: 'check-bundle',
        message: report.error,
        recoveryHint: 'Point bundleDir to the compiled mp-weixin directory containing app.json.',
      })
    );
  } else {
    assertions.push({
      id: 'assert_no_missing_route_files',
      type: 'bundle_integrity',
      expected: 0,
      actual: report.missingFiles.length,
      pass: report.missingFiles.length === 0,
      message:
        report.missingFiles.length === 0
          ? `All ${report.totalRoutesChecked} routes have required .js and .wxml files`
          : `Missing files: ${report.missingFiles.join(', ')}`,
    });

    assertions.push({
      id: 'assert_no_truncated_files',
      type: 'bundle_integrity',
      expected: 0,
      actual: report.emptyFiles.length + report.malformedJsonFiles.length,
      pass: report.emptyFiles.length === 0 && report.malformedJsonFiles.length === 0,
      message:
        report.emptyFiles.length === 0 && report.malformedJsonFiles.length === 0
          ? `No truncated .js/.wxml/.json files (${report.validEmptyStyleFiles.length} valid empty .wxss allowed)`
          : `Truncated/malformed files: ${[...report.emptyFiles, ...report.malformedJsonFiles].join(', ')}`,
    });

    assertions.push({
      id: 'assert_single_package_limits',
      type: 'package_size',
      expected: `<= ${report.limitsApplied.maxSinglePackageKB} KB`,
      actual: report.oversizePackages.map((p) => `${p.name}:${p.kb}KB`),
      unit: 'KB',
      tolerance: report.limitsApplied.maxSinglePackageKB,
      pass: report.oversizePackages.length === 0,
      message:
        report.oversizePackages.length === 0
          ? `All packages within ${report.limitsApplied.maxSinglePackageKB} KB limit (${report.limitsApplied.ruleSource})`
          : `Oversize packages: ${report.oversizePackages.map((p) => `${p.name} (${p.kb} KB)`).join(', ')}`,
    });

    assertions.push({
      id: 'assert_total_package_limit',
      type: 'package_size',
      expected: `<= ${report.limitsApplied.maxTotalPackageKB} KB`,
      actual: report.totalBundleKB,
      unit: 'KB',
      tolerance: report.limitsApplied.maxTotalPackageKB,
      pass: !report.exceedsTotalLimit,
      message: `Total bundle size: ${report.totalBundleKB} KB / ${report.limitsApplied.maxTotalPackageKB} KB`,
    });
  }

  const envelope = buildResponseEnvelope({
    runId,
    caseId: args.caseId || 'mp_check_bundle',
    acIds: args.acIds || [],
    startedAtDate,
    finishedAtDate: new Date(),
    engineVersion: `node/${process.version}`,
    targetRoute: safeBundleDir,
    actualRoute: safeBundleDir,
    steps: [
      {
        stepId: 'static_bundle_check',
        action: 'check_mp_bundle',
        verificationLayer: 'static-probe',
        status: report.ok ? 'PASS' : errors.length > 0 ? 'ERROR' : 'FAIL',
        durationMs: Date.now() - startedAtDate.getTime(),
        detail: `Checked ${report.totalRoutesChecked || 0} routes against ${report.limitsApplied?.ruleSource}`,
      },
    ],
    assertions,
    errors,
    requireAssertions: true,
    data: report,
  });

  return { envelope };
}

/**
 * Create a controllable deterministic Mini Program Fixture Session for `connection.mode === "fixture"`
 * Supports real route validation against `fixtures/sample-mp/app.json`, MVVM data & conditional node toggling,
 * in-page `wx.request` hook installation & restoration, SelectorQuery geometry, AABB occlusion, and valid PNG screenshots!
 */
export function createFixtureMiniProgramSession(fixtureDir) {
  const VALID_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const appJsonPath = path.join(fixtureDir, 'app.json');
  const appConfig = fs.existsSync(appJsonPath)
    ? JSON.parse(fs.readFileSync(appJsonPath, 'utf8'))
    : {
        pages: ['pages/index/index'],
        subPackages: [{ root: 'subpages/order', pages: ['detail'] }],
      };

  const validRoutes = new Set([
    ...(appConfig.pages || []).map((p) => `/${p.replace(/^\/+/, '')}`),
    ...(appConfig.subPackages || appConfig.subpackages || []).flatMap((s) =>
      (s.pages || []).map((p) => `/${String(s.root).replace(/^\/+|\/+$/g, '')}/${String(p).replace(/^\/+/, '')}`)
    ),
  ]);

  const storage = new Map();
  const appGlobalData = { isLogin: false, role: 'GUEST' };
  let currentRoute = '/pages/index/index';
  let renderBackend = 'webview';

  const getInitialPageData = (routePath) => {
    if (routePath === '/subpages/order/detail') {
      return {
        detailData: {
          id: 1001,
          orderNo: 'ORD-2026-1001',
          assigneeName: 'Alice',
          status: 'APPROVED',
          orderMode: 'STANDARD',
          showUrgentReason: false,
        },
        stickyOverlayActive: false,
      };
    }
    return { title: 'Home Workbench' };
  };

  let currentPageData = getInitialPageData(currentRoute);

  // Simulated `wx` runtime inside AppService so `miniProgram.evaluate()` executes real functions!
  const wxRuntime = {
    getSystemInfoSync() {
      return { windowWidth: 375, windowHeight: 667, pixelRatio: 2, platform: 'devtools-fixture' };
    },
    setStorageSync(k, v) {
      storage.set(k, v);
    },
    getStorageSync(k) {
      return storage.get(k);
    },
    getStorageInfoSync() {
      return { keys: Array.from(storage.keys()) };
    },
    request(options = {}) {
      const url = String(options.url || '');
      if (url.includes('/api/v1/orders/1001')) {
        const res = {
          statusCode: 200,
          header: { 'content-type': 'application/json', 'x-build-id': 'mp-build-20261026' },
          data: {
            id: 1001,
            orderNo: 'ORD-2026-1001',
            assigneeName: 'Alice',
            status: 'APPROVED',
            secretToken: 'should-be-redacted',
          },
        };
        if (typeof options.success === 'function') options.success(res);
        return;
      }
      if (typeof options.fail === 'function') {
        options.fail({ errMsg: 'request:fail url not mocked in fixture' });
      }
    },
    createSelectorQuery() {
      const queue = [];
      const computeElementMap = () => ({
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
          visibility: 'visible',
          opacity: '1',
        },
        '.detail-card': {
          id: 'detail-card',
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
          visibility: 'visible',
          opacity: '1',
        },
        '.action-dropdown': {
          id: 'action-dropdown',
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
        '.urgent-reason-box': {
          id: 'urgent-reason-box',
          left: 24,
          top: 220,
          right: 351,
          bottom: 280,
          width: currentPageData.detailData?.showUrgentReason ? 327 : 0,
          height: currentPageData.detailData?.showUrgentReason ? 60 : 0,
          display: currentPageData.detailData?.showUrgentReason ? 'block' : 'none',
          position: 'relative',
          zIndex: '1',
          visibility: 'visible',
          opacity: '1',
        },
      });

      const api = {
        select(sel) {
          return {
            fields(_spec, cb) {
              const map = computeElementMap();
              const val = map[sel] || null;
              queue.push({ val, cb });
              return api;
            },
          };
        },
        selectAll(selListStr) {
          return {
            fields(_spec, cb) {
              const list = [];
              if (currentPageData.stickyOverlayActive && selListStr.includes('.sticky-col')) {
                list.push({
                  id: 'sticky-col-overlay',
                  dataset: { role: 'fixed-col' },
                  left: 250,
                  top: 40,
                  right: 375,
                  bottom: 240,
                  width: 125,
                  height: 200,
                  display: 'block',
                  position: 'fixed',
                  zIndex: '99',
                  visibility: 'visible',
                  opacity: '1',
                });
              }
              queue.push({ val: list, cb });
              return api;
            },
          };
        },
        exec(finalCb) {
          const results = queue.map((item) => {
            if (typeof item.cb === 'function') item.cb(item.val);
            return item.val;
          });
          if (typeof finalCb === 'function') finalCb(results);
        },
      };
      return api;
    },
  };

  const pageInstance = {
    get path() {
      return currentRoute;
    },
    get renderer() {
      return renderBackend;
    },
    async waitFor() {},
    async data(dotPath) {
      if (!dotPath) return JSON.parse(JSON.stringify(currentPageData));
      return dotPath.split('.').reduce((acc, k) => acc?.[k], currentPageData);
    },
    async setData(patch) {
      Object.assign(currentPageData, patch);
    },
    async callMethod(methodName, payload = {}) {
      if (methodName === 'toggleUrgentMode') {
        if (currentPageData.detailData) {
          currentPageData.detailData.orderMode = payload.mode || 'EXPEDITED';
          currentPageData.detailData.showUrgentReason = true;
        }
      } else if (methodName === 'enableStickyOverlay') {
        currentPageData.stickyOverlayActive = true;
      } else if (methodName === 'switchSkylineMode') {
        renderBackend = 'skyline';
      }
      currentPageData.lastCalledMethod = methodName;
    },
    async $(sel) {
      if (sel === '.order-no') {
        return {
          async text() {
            return currentPageData.detailData?.orderNo || '';
          },
          async tap() {},
        };
      }
      if (sel === '.assignee-name') {
        return {
          async text() {
            return currentPageData.detailData?.assigneeName || '';
          },
          async tap() {},
        };
      }
      if (sel === '#toggle-urgent-btn') {
        return {
          async tap() {
            await pageInstance.callMethod('toggleUrgentMode', { mode: 'EXPEDITED' });
          },
          async text() {
            return 'Toggle Urgent';
          },
        };
      }
      if (sel === '#enable-occluder-btn') {
        return {
          async tap() {
            await pageInstance.callMethod('enableStickyOverlay');
          },
        };
      }
      if (sel === '.urgent-reason-box') {
        if (!currentPageData.detailData?.showUrgentReason) return null;
        return {
          async text() {
            return 'Urgent Reason Field Active';
          },
          async tap() {},
        };
      }
      if (sel === '.detail-card') {
        return {
          async text() {
            return currentPageData.detailData?.orderNo || 'ORD-2026-1001';
          },
          async tap() {},
        };
      }
      return null;
    },
  };

  const appInstance = { globalData: appGlobalData };

  const navigateInternal = async (rawRoute) => {
    const cleanPath = rawRoute.split('?')[0];
    const normPath = cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`;
    if (!validRoutes.has(normPath)) {
      const err = new Error(`reLaunch:fail page "${rawRoute}" is not found in app.json`);
      err.code = 'ROUTE_NOT_FOUND';
      throw err;
    }
    currentRoute = normPath;
    currentPageData = getInitialPageData(normPath);
    // When entering /subpages/order/detail, the page automatically fires `wx.request` for `/api/v1/orders/1001`!
    if (normPath === '/subpages/order/detail') {
      const prevWx = globalThis.wx;
      const prevGetApp = globalThis.getApp;
      try {
        globalThis.wx = wxRuntime;
        globalThis.getApp = () => appInstance;
        wxRuntime.request({
          url: 'https://api.example.com/api/v1/orders/1001',
          method: 'GET',
        });
      } finally {
        globalThis.wx = prevWx;
        globalThis.getApp = prevGetApp;
      }
    }
    return pageInstance;
  };

  return {
    __isFixture: true,
    __wxRuntime: wxRuntime,
    on() {},
    async reLaunch(route) {
      return await navigateInternal(route);
    },
    async navigateTo(route) {
      return await navigateInternal(route);
    },
    async currentPage() {
      return pageInstance;
    },
    async evaluate(fn, ...args) {
      // Execute the passed function with simulated AppService globals (`wx`, `getApp`, `getCurrentPages`)
      const prevWx = globalThis.wx;
      const prevGetApp = globalThis.getApp;
      const prevGetCurrentPages = globalThis.getCurrentPages;
      try {
        globalThis.wx = wxRuntime;
        globalThis.getApp = () => appInstance;
        globalThis.getCurrentPages = () => [
          {
            route: currentRoute.slice(1),
            renderer: renderBackend,
            createSelectorQuery: () => wxRuntime.createSelectorQuery(),
          },
        ];
        return await fn(...args);
      } finally {
        globalThis.wx = prevWx;
        globalThis.getApp = prevGetApp;
        globalThis.getCurrentPages = prevGetCurrentPages;
      }
    },
    async screenshot(opts) {
      const buf = Buffer.from(VALID_PNG_B64, 'base64');
      if (opts?.path) {
        fs.writeFileSync(opts.path, buf);
        return;
      }
      return VALID_PNG_B64;
    },
    async disconnect() {},
    async close() {},
  };
}

/**
 * Establish connection to WeChat DevTools according to explicit `connection.mode` (Section 5.1)
 */
async function connectMiniProgramExplicit(connection = {}, allowedRoots = []) {
  const mode = connection.mode || (connection.wsEndpoint ? 'connect' : connection.projectPath ? 'launch' : 'connect');

  if (mode === 'fixture') {
    const fixtureDir = connection.projectPath
      ? validateSafePath(connection.projectPath, [connection.projectPath, ...allowedRoots], 'fixture-connect')
      : path.resolve(process.cwd(), 'fixtures/sample-mp');
    return {
      miniProgram: createFixtureMiniProgramSession(fixtureDir),
      mode: 'fixture',
      ownedProcess: false,
      targetDescription: `fixture:${fixtureDir}`,
    };
  }

  const automatorModule = await import('miniprogram-automator').catch((err) => {
    throw createStructuredError({
      code: 'AUTOMATOR_DEPENDENCY_MISSING',
      category: 'environment',
      stage: 'connection',
      message: `miniprogram-automator is not installed: ${err.message}`,
      recoveryHint: 'Run `npm install miniprogram-automator`.',
    });
  });
  const automator = automatorModule.default || automatorModule;

  if (mode === 'connect') {
    const wsEndpoint = validateSafeWsEndpoint(
      connection.wsEndpoint || process.env.FAST_MP_WS_ENDPOINT || 'ws://127.0.0.1:9420',
      connection.allowedWsEndpoints || [],
      'connect'
    );
    const u = new URL(wsEndpoint);
    const open = await isPortOpen(Number(u.port || 9420), u.hostname, 400);
    if (!open) {
      throw createStructuredError({
        code: 'DEVTOOLS_WS_UNREACHABLE',
        category: 'connection',
        stage: 'connect',
        message: `Cannot connect to WeChat DevTools automation port at ${wsEndpoint} (port not listening).`,
        recoveryHint: 'Start WeChat DevTools with `--auto <project> --auto-port 9420` or check the port number.',
      });
    }
    const mp = await Promise.race([
      automator.connect({ wsEndpoint }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`automator.connect(${wsEndpoint}) timed out after 8000ms`)), 8000)
      ),
    ]).catch((err) => {
      throw createStructuredError({
        code: 'DEVTOOLS_CONNECT_FAILED',
        category: 'connection',
        stage: 'connect',
        message: `Failed to establish automator session with ${wsEndpoint}: ${err.message}`,
        recoveryHint: 'Ensure WeChat DevTools has Service Port enabled and no blocking modal dialog is open.',
      });
    });

    return {
      miniProgram: mp,
      mode: 'connect',
      ownedProcess: false,
      targetDescription: wsEndpoint,
    };
  }

  if (mode === 'launch') {
    if (!connection.projectPath) {
      throw createStructuredError({
        code: 'PROJECT_PATH_REQUIRED_FOR_LAUNCH',
        category: 'permission',
        stage: 'launch',
        message: 'connection.projectPath is required when connection.mode is "launch". Refusing to launch an unknown project.',
        recoveryHint: 'Provide connection.projectPath pointing to the compiled Mini Program directory.',
      });
    }
    const safeProject = validateSafePath(connection.projectPath, [connection.projectPath, ...allowedRoots], 'launch');
    const cliPath = connection.cliPath || process.env.FAST_MP_CLI_PATH || detectDefaultCliPath();
    if (!cliPath || !fs.existsSync(cliPath)) {
      throw createStructuredError({
        code: 'DEVTOOLS_CLI_MISSING',
        category: 'environment',
        stage: 'launch',
        message: 'WeChat DevTools CLI executable not found on this host.',
        recoveryHint: 'Install WeChat DevTools or pass connection.cliPath / FAST_MP_CLI_PATH.',
      });
    }
    const freePort = await getFreePort();
    const mp = await automator
      .launch({
        cliPath,
        projectPath: safeProject,
        port: freePort,
        timeout: 25000,
      })
      .catch((err) => {
        throw createStructuredError({
          code: 'DEVTOOLS_LAUNCH_FAILED',
          category: 'connection',
          stage: 'launch',
          message: `Failed to launch WeChat DevTools for ${safeProject}: ${err.message}`,
          recoveryHint: 'Check WeChat DevTools login state and security settings.',
        });
      });

    return {
      miniProgram: mp,
      mode: 'launch',
      ownedProcess: true,
      targetDescription: `${safeProject} (port:${freePort})`,
    };
  }

  throw createStructuredError({
    code: 'UNSUPPORTED_CONNECTION_MODE',
    category: 'capability',
    stage: 'connection',
    message: `Unsupported connection.mode: "${mode}". Must be "connect", "launch", or "fixture".`,
  });
}

/**
 * Install in-AppService `wx.request` tap with correlation `requestId`
 */
async function installWxRequestTap(miniProgram, urlPatterns = []) {
  const patterns = Array.isArray(urlPatterns) ? urlPatterns : [urlPatterns].filter(Boolean);
  await miniProgram.evaluate((pats) => {
    const app = typeof getApp === 'function' ? getApp({ allowDefault: true }) || {} : {};
    app.__FAST_MP_CAPTURED_REQUESTS__ = [];
    app.__FAST_MP_REQ_SEQ__ = 0;

    if (typeof wx !== 'undefined' && typeof wx.request === 'function') {
      if (!wx.__fastMpOriginalRequest) {
        wx.__fastMpOriginalRequest = wx.request.bind(wx);
      }
      const rawReq = wx.__fastMpOriginalRequest;
      const wrapped = function (options = {}) {
        const reqUrl = String(options.url || '');
        const matches = pats.length === 0 || pats.some((p) => reqUrl.includes(p));
        const reqId = `req_${++app.__FAST_MP_REQ_SEQ__}_${Date.now()}`;
        const startedAt = Date.now();
        const origSuccess = options.success;
        const origFail = options.fail;

        options.success = function (res) {
          if (matches) {
            app.__FAST_MP_CAPTURED_REQUESTS__.push({
              requestId: reqId,
              url: reqUrl,
              method: options.method || 'GET',
              statusCode: res.statusCode,
              headers: res.header || {},
              data: res.data,
              durationMs: Date.now() - startedAt,
              capturedAt: new Date().toISOString(),
            });
          }
          if (typeof origSuccess === 'function') origSuccess.call(this, res);
        };

        options.fail = function (err) {
          if (matches) {
            app.__FAST_MP_CAPTURED_REQUESTS__.push({
              requestId: reqId,
              url: reqUrl,
              method: options.method || 'GET',
              statusCode: 0,
              error: err?.errMsg || String(err),
              durationMs: Date.now() - startedAt,
              capturedAt: new Date().toISOString(),
            });
          }
          if (typeof origFail === 'function') origFail.call(this, err);
        };

        return rawReq(options);
      };

      try {
        Object.defineProperty(wx, 'request', {
          configurable: true,
          enumerable: true,
          writable: true,
          value: wrapped,
        });
      } catch {
        wx.request = wrapped;
      }
    }
  }, patterns);
}

/**
 * Collect captured `wx.request` records and ALWAYS restore the original `wx.request`
 */
async function collectAndRestoreWxRequestTap(miniProgram, redactFields = []) {
  const rawList = await miniProgram
    .evaluate(() => {
      const app = typeof getApp === 'function' ? getApp({ allowDefault: true }) || {} : {};
      const list = Array.isArray(app.__FAST_MP_CAPTURED_REQUESTS__) ? [...app.__FAST_MP_CAPTURED_REQUESTS__] : [];
      delete app.__FAST_MP_CAPTURED_REQUESTS__;

      if (typeof wx !== 'undefined' && wx.__fastMpOriginalRequest) {
        try {
          Object.defineProperty(wx, 'request', {
            configurable: true,
            enumerable: true,
            writable: true,
            value: wx.__fastMpOriginalRequest,
          });
        } catch {
          wx.request = wx.__fastMpOriginalRequest;
        }
        delete wx.__fastMpOriginalRequest;
      }
      return list;
    })
    .catch(() => []);

  return redactSensitiveData(rawList, redactFields);
}

/**
 * Query AppService `SelectorQuery` / `NodesRef.fields` for geometry & potential AABB occlusion (Sections 5.4 & 5.5)
 */
async function queryMpGeometryAndPotentialOcclusion(
  miniProgram,
  {
    parentSelector = '.page-container',
    targetSelector = '',
    occludeSelector = '',
    occludersSelector = '.fixed-bar, .custom-nav, .tab-bar, .modal-mask, .sticky-col, .fixed-footer',
  }
) {
  const raw = await miniProgram.evaluate(
    ({ pSel, tSel, oSel, oCandSel }) => {
      return new Promise((resolve) => {
        const sys =
          typeof wx !== 'undefined' && typeof wx.getSystemInfoSync === 'function'
            ? wx.getSystemInfoSync()
            : { windowWidth: 375, windowHeight: 667, pixelRatio: 2 };
        const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
        const curPage = pages[pages.length - 1];
        const renderBackend = curPage?.renderer || 'webview';
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

        if (pSel) q.select(pSel).fields({ id: true, dataset: true, rect: true, size: true, computedStyle: styleFields });
        if (tSel) q.select(tSel).fields({ id: true, dataset: true, rect: true, size: true, computedStyle: styleFields });
        if (oSel) {
          q.select(oSel).fields({ id: true, dataset: true, rect: true, size: true, computedStyle: styleFields });
          q.selectAll(oCandSel).fields({ id: true, dataset: true, rect: true, size: true, computedStyle: styleFields });
        }

        q.exec((res) => {
          let idx = 0;
          const parentNode = pSel ? res?.[idx++] : null;
          const targetNode = tSel ? res?.[idx++] : null;
          const occludeTargetNode = oSel ? res?.[idx++] : null;
          const occluderNodes = oSel ? res?.[idx++] || [] : [];

          resolve({
            deviceInfo: {
              windowWidth: sys.windowWidth,
              windowHeight: sys.windowHeight,
              pixelRatio: sys.pixelRatio,
              rpxToPxRatio: Number((sys.windowWidth / 750).toFixed(4)),
              unitNote: 'All rect/size coordinates are in logical px; rpx values are derived via 750rpx = windowWidth px.',
              platform: sys.platform || 'devtools',
              renderBackend,
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
      pSel: parentSelector,
      tSel: targetSelector,
      oSel: occludeSelector,
      oCandSel: occludersSelector,
    }
  );

  let layout = null;
  if (targetSelector) {
    const t = raw.targetNode;
    const p = raw.parentNode;
    const sys = raw.deviceInfo;
    if (!t || t.display === 'none' || t.width === 0 || t.height === 0) {
      layout = {
        measurable: false,
        reason: !t ? 'target-not-found' : 'zero-size-or-display-none',
        targetSelector,
      };
    } else {
      const pLeft = p ? p.left : 0;
      const pRight = p ? p.right : sys.windowWidth;
      const pWidth = p ? p.width : sys.windowWidth;
      const leftGapPx = Math.round(t.left - pLeft);
      const rightGapPx = Math.round(pRight - t.right);

      layout = {
        measurable: true,
        unit: 'px (with rpx conversion)',
        parentSelector: parentSelector || 'windowViewport',
        targetSelector,
        parentRectPx: { left: Math.round(pLeft), right: Math.round(pRight), width: Math.round(pWidth) },
        targetRectPx: {
          left: Math.round(t.left),
          top: Math.round(t.top),
          right: Math.round(t.right),
          bottom: Math.round(t.bottom),
          width: Math.round(t.width),
          height: Math.round(t.height),
        },
        leftGapPx,
        rightGapPx,
        leftGapRpx: Math.round(leftGapPx / sys.rpxToPxRatio),
        rightGapRpx: Math.round(rightGapPx / sys.rpxToPxRatio),
        horizontalFillRatio: Number((t.width / Math.max(pWidth, 1)).toFixed(4)),
        computedStyle: {
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

  let potentialOcclusionEvidence = null;
  if (occludeSelector) {
    const target = raw.occludeTargetNode;
    const candidates = raw.occluderNodes || [];
    const renderBackend = raw.deviceInfo.renderBackend;

    if (renderBackend === 'skyline') {
      potentialOcclusionEvidence = {
        supported: false,
        verificationStatus: 'UNSUPPORTED_IN_SKYLINE',
        selector: occludeSelector,
        reason:
          'Skyline render engine does not expose full WebView stacking-context z-index parity via AppService SelectorQuery; exact occlusion proof requires visual/host verification.',
      };
    } else if (!target || target.display === 'none' || target.width === 0 || target.height === 0) {
      potentialOcclusionEvidence = {
        supported: false,
        verificationStatus: 'UNMEASURABLE_TARGET',
        selector: occludeSelector,
        reason: !target ? 'element-not-found' : 'zero-size-or-hidden',
      };
    } else {
      const targetZ = Number.isNaN(Number(target.zIndex)) ? 0 : Number(target.zIndex);
      const collisions = [];

      for (const cand of candidates) {
        if (!cand || cand.display === 'none' || cand.visibility === 'hidden' || Number(cand.opacity) === 0) continue;
        if (cand.id && target.id && cand.id === target.id) continue;
        const aabb = computeAabbIntersection(target, cand);
        if (aabb.intersects) {
          const candZ = Number.isNaN(Number(cand.zIndex)) ? 0 : Number(cand.zIndex);
          const potentiallyCovers = candZ >= targetZ && cand.position !== 'static';
          collisions.push({
            id: cand.id || null,
            dataset: cand.dataset || {},
            rectPx: { left: Math.round(cand.left), top: Math.round(cand.top), width: Math.round(cand.width), height: Math.round(cand.height) },
            position: cand.position,
            zIndex: cand.zIndex,
            potentiallyCoversTarget: potentiallyCovers,
            ...aabb,
          });
        }
      }

      potentialOcclusionEvidence = {
        supported: true,
        verificationMethod: 'aabb-intersection-plus-z-index-comparison',
        selector: occludeSelector,
        targetRectPx: {
          left: Math.round(target.left),
          top: Math.round(target.top),
          width: Math.round(target.width),
          height: Math.round(target.height),
        },
        targetPosition: target.position,
        targetZIndex: target.zIndex,
        hasPotentialOcclusion: collisions.some((c) => c.potentiallyCoversTarget),
        collisions,
        limitationsNote:
          'AppService has no document.elementFromPoint(x,y). AABB + z-index comparison provides structural overlap evidence against candidate selectors, but cannot prove parent stacking-context isolation, overflow scroll clipping, native components (map/video/canvas), or Skyline compositing order.',
      };
    }
  }

  return {
    deviceInfo: raw.deviceInfo,
    layout,
    potentialOcclusionEvidence,
  };
}

/**
 * Evaluate a single declarative assertion in `mp_inspect` or `mp_run_case`
 */
async function evaluateMpAssertion({ miniProgram, page, assertion, capturedRequests, geometryCache }) {
  const id = assertion.id || `mp_assert_${assertion.type}_${Date.now()}`;
  const type = assertion.type;
  const selector = assertion.selector || assertion.path || '';
  const expected = assertion.expected;

  try {
    switch (type) {
      case 'page_data': {
        const dataPath = assertion.path || selector;
        const actualVal = await page.data(dataPath);
        const pass = JSON.stringify(actualVal) === JSON.stringify(expected);
        return {
          id,
          type,
          selector: dataPath,
          expected,
          actual: actualVal,
          pass,
          message: pass
            ? `Page.data("${dataPath}") matches ${JSON.stringify(actualVal)}`
            : `Page.data("${dataPath}") mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actualVal)}`,
        };
      }

      case 'rendered_text': {
        const el = await page.$(selector);
        if (!el) {
          return { id, type, selector, expected, actual: null, pass: false, message: `WXML selector "${selector}" not found` };
        }
        const actualText = (await el.text())?.trim() ?? '';
        const pass = actualText === String(expected).trim();
        return {
          id,
          type,
          selector,
          expected,
          actual: actualText,
          pass,
          message: pass ? `Rendered text on ${selector} is "${actualText}"` : `Expected "${expected}", got "${actualText}"`,
        };
      }

      case 'element_exists':
      case 'element_hidden': {
        const el = await page.$(selector);
        const exists = Boolean(el);
        const expectedExists = type === 'element_exists';
        const pass = exists === expectedExists;
        return {
          id,
          type,
          selector,
          expected: expectedExists,
          actual: exists,
          pass,
          message: pass
            ? `WXML element ${selector} ${expectedExists ? 'exists' : 'is hidden/absent'}`
            : `Expected ${selector} exists=${expectedExists}, got ${exists}`,
        };
      }

      case 'layout_gap': {
        const maxGapPx = Number(assertion.maxGapPx ?? expected ?? 24);
        const geo =
          geometryCache?.layout?.targetSelector === selector
            ? geometryCache
            : await queryMpGeometryAndPotentialOcclusion(miniProgram, {
                parentSelector: assertion.parentSelector || '.page-container',
                targetSelector: selector,
              });
        if (!geo.layout?.measurable) {
          return {
            id,
            type,
            selector,
            expected: `<= ${maxGapPx}px`,
            actual: geo.layout?.reason || 'unmeasurable',
            unit: 'px',
            tolerance: maxGapPx,
            pass: false,
            message: `Cannot measure layout gap for ${selector}: ${geo.layout?.reason}`,
          };
        }
        const actualMax = Math.max(Math.abs(geo.layout.leftGapPx), Math.abs(geo.layout.rightGapPx));
        const pass = actualMax <= maxGapPx;
        return {
          id,
          type,
          selector,
          expected: `<= ${maxGapPx}`,
          actual: {
            leftGapPx: geo.layout.leftGapPx,
            rightGapPx: geo.layout.rightGapPx,
            leftGapRpx: geo.layout.leftGapRpx,
            rightGapRpx: geo.layout.rightGapRpx,
          },
          tolerance: maxGapPx,
          unit: 'px',
          pass,
          message: pass
            ? `WXSS layout gaps within ${maxGapPx}px (left=${geo.layout.leftGapPx}px/${geo.layout.leftGapRpx}rpx)`
            : `WXSS layout gap exceeded ${maxGapPx}px (left=${geo.layout.leftGapPx}px, right=${geo.layout.rightGapPx}px)`,
        };
      }

      case 'potential_occlusion': {
        if (assertion.requireExactHitTestProof) {
          return {
            id,
            type,
            selector,
            expected,
            actual: 'UNSUPPORTED_IN_APPSERVICE',
            pass: false,
            unsupported: true,
            message:
              'Exact coordinate hit-test proof (document.elementFromPoint) is unsupported in Mini Program AppService; only AABB + z-index potential occlusion evidence is available.',
          };
        }
        const geo = await queryMpGeometryAndPotentialOcclusion(miniProgram, {
          occludeSelector: selector,
          occludersSelector: assertion.occludersSelector || '.fixed-bar, .custom-nav, .tab-bar, .modal-mask, .sticky-col, .fixed-footer',
        });
        const occ = geo.potentialOcclusionEvidence;
        if (!occ?.supported) {
          return {
            id,
            type,
            selector,
            expected,
            actual: occ?.verificationStatus || 'UNSUPPORTED',
            pass: false,
            unsupported: occ?.verificationStatus === 'UNSUPPORTED_IN_SKYLINE',
            message: occ?.reason || 'Cannot evaluate potential occlusion',
          };
        }
        const expectedOccluded = Boolean(expected);
        const pass = occ.hasPotentialOcclusion === expectedOccluded;
        return {
          id,
          type,
          selector,
          expected: expectedOccluded,
          actual: occ.hasPotentialOcclusion,
          pass,
          message: pass
            ? `Potential AABB+zIndex occlusion on ${selector} is ${occ.hasPotentialOcclusion} (Note: structural AABB evidence)`
            : `Expected potential occlusion=${expectedOccluded} on ${selector}, got ${occ.hasPotentialOcclusion}`,
        };
      }

      case 'captured_request_status': {
        const urlPattern = assertion.urlPattern || selector;
        const matched = (capturedRequests || []).filter((r) => !urlPattern || r.url.includes(urlPattern));
        if (matched.length === 0) {
          return {
            id,
            type,
            selector: urlPattern,
            expected,
            actual: null,
            pass: false,
            message: `No in-page wx.request matching "${urlPattern}" was captured (capturedCount: 0).`,
          };
        }
        const latest = matched[matched.length - 1];
        const pass = latest.statusCode === Number(expected);
        return {
          id,
          type,
          selector: urlPattern,
          expected: Number(expected),
          actual: latest.statusCode,
          pass,
          message: pass
            ? `Captured wx.request (${latest.requestId}) ${latest.url} returned status ${latest.statusCode}`
            : `Captured wx.request (${latest.requestId}) returned ${latest.statusCode}, expected ${expected}`,
        };
      }

      case 'captured_request_field': {
        const urlPattern = assertion.urlPattern || '';
        const fieldPath = assertion.fieldPath || selector;
        const matched = (capturedRequests || []).filter((r) => !urlPattern || r.url.includes(urlPattern));
        if (matched.length === 0) {
          return {
            id,
            type,
            selector: fieldPath,
            expected,
            actual: null,
            pass: false,
            message: `No in-page wx.request matching "${urlPattern}" was captured (capturedCount: 0).`,
          };
        }
        const latest = matched[matched.length - 1];
        const actualVal = fieldPath.split('.').reduce((acc, k) => acc?.[k], latest.data);
        const pass = JSON.stringify(actualVal) === JSON.stringify(expected);
        return {
          id,
          type,
          selector: `${urlPattern}#${fieldPath}`,
          expected,
          actual: actualVal,
          pass,
          message: pass
            ? `Captured response field "${fieldPath}" (${latest.requestId}) matches ${JSON.stringify(actualVal)}`
            : `Captured response field "${fieldPath}" (${latest.requestId}): expected ${JSON.stringify(expected)}, got ${JSON.stringify(actualVal)}`,
        };
      }

      default:
        return {
          id,
          type,
          selector,
          expected,
          actual: null,
          pass: false,
          message: `Unsupported Mini Program assertion type: "${type}"`,
        };
    }
  } catch (err) {
    return {
      id,
      type,
      selector,
      expected,
      actual: null,
      pass: false,
      message: `Assertion error: ${err.message}`,
    };
  }
}

/**
 * Validate PNG buffer header (`\x89PNG\r\n\x1a\n`) to ensure valid simulator screenshot
 */
function isValidPngBuffer(buf) {
  if (!buf || buf.length < 8) return false;
  return (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  );
}

/**
 * Tool 3 & 4 Core Runner: `mp_inspect` & `mp_run_case`
 */
export async function runMpExecution(args = {}, contextMeta = {}) {
  const startedAtDate = new Date();
  const runId = args.runId || generateRunId('mp');
  const caseId = args.caseId || (args.steps ? 'mp_run_case' : 'mp_inspect');
  const acIds = args.acIds || [];
  const totalTimeoutMs = Math.min(Number(args.timeoutMs) || 60000, 300000);

  const steps = [];
  const assertions = [];
  const errors = [];
  const evidence = [];
  let imageAttachment = null;
  let cancelled = false;
  let partialReason = '';

  const jobController = new AbortController();
  if (contextMeta.signal) {
    contextMeta.signal.addEventListener('abort', () => {
      cancelled = true;
      jobController.abort(contextMeta.signal.reason);
    });
  }

  activeMpJobs.set(runId, {
    runId,
    caseId,
    status: 'RUNNING',
    startedAt: startedAtDate.toISOString(),
    cancel: () => {
      cancelled = true;
      jobController.abort(new Error('Cancelled via mp_cancel_job'));
    },
  });

  const timeoutTimer = setTimeout(() => {
    jobController.abort(new Error(`Execution exceeded total timeout of ${totalTimeoutMs}ms`));
  }, totalTimeoutMs);

  try {
    let authInfo;
    try {
      authInfo = resolveMpAuthReference(args.authRef, [args.evidenceDir].filter(Boolean));
    } catch (authErr) {
      errors.push(authErr);
      return {
        envelope: buildResponseEnvelope({
          runId,
          caseId,
          acIds,
          startedAtDate,
          finishedAtDate: new Date(),
          errors,
        }),
      };
    }

    const evidenceDir = validateSafePath(
      args.evidenceDir || process.env.FAST_MP_EVIDENCE_DIR || path.resolve(process.cwd(), 'reports/evidence'),
      [args.evidenceDir].filter(Boolean),
      'evidence-setup'
    );
    fs.mkdirSync(evidenceDir, { recursive: true });

    const lockKey = `${args.connection?.wsEndpoint || args.connection?.projectPath || 'default'}_${authInfo.accountAlias}`;

    return await withSessionLock(lockKey, async () => {
      const envStatus = await getMpStaticEnvironment(args.connection?.cliPath);
      let connInfo;
      try {
        connInfo = await connectMiniProgramExplicit(args.connection || {}, [evidenceDir]);
      } catch (connErr) {
        errors.push(connErr);
        return {
          envelope: buildResponseEnvelope({
            runId,
            caseId,
            acIds,
            startedAtDate,
            finishedAtDate: new Date(),
            engineVersion: `miniprogram-automator/${envStatus.automatorVersion}`,
            authMeta: authInfo,
            errors,
          }),
        };
      }

      const { miniProgram, ownedProcess, mode: connectionMode, targetDescription } = connInfo;
      let requestTapInstalled = false;
      let capturedRequests = [];
      let lastGeometry = null;
      let page = null;

      try {
        // 1. Inject test auth state if provided
        if (authInfo.isTestInjection) {
          const tAuth = Date.now();
          await miniProgram.evaluate(
            ({ sMap, gMap }) => {
              if (typeof wx !== 'undefined' && typeof wx.setStorageSync === 'function') {
                for (const [k, v] of Object.entries(sMap || {})) {
                  wx.setStorageSync(k, v);
                }
              }
              if (typeof getApp === 'function') {
                const app = getApp({ allowDefault: true });
                if (app) {
                  app.globalData = Object.assign(app.globalData || {}, gMap || {});
                }
              }
            },
            { sMap: authInfo.storageMap, gMap: authInfo.globalDataMap }
          );
          steps.push({
            stepId: 'inject_test_auth',
            action: 'inject_auth_state',
            verificationLayer: 'test-storage-injection',
            status: 'PASS',
            durationMs: Date.now() - tAuth,
            detail: `Injected test session for alias "${authInfo.accountAlias}". Note: Does NOT verify interactive login page flow.`,
          });
        }

        // 2. Install in-page wx.request capture hook if requested at top level
        if (args.captureApiPattern) {
          await installWxRequestTap(miniProgram, args.captureApiPattern);
          requestTapInstalled = true;
        }

        // 3. Optional bounceRoute before entering target route
        if (args.bounceRoute && args.route) {
          const tBounce = Date.now();
          const normBounce = args.bounceRoute.startsWith('/') ? args.bounceRoute : `/${args.bounceRoute}`;
          await miniProgram.reLaunch(normBounce);
          steps.push({
            stepId: 'bounce_route',
            action: 'relaunch',
            verificationLayer: 'route-navigation',
            status: 'PASS',
            durationMs: Date.now() - tBounce,
            detail: `Left detail view to bounce route ${normBounce} before re-entering target route.`,
          });
        }

        // 4. Initial route navigation
        if (args.route) {
          const tNav = Date.now();
          const normRoute = args.route.startsWith('/') ? args.route : `/${args.route}`;
          page = await miniProgram.reLaunch(normRoute);
          await page.waitFor(Number(args.waitMs) || 300);
          steps.push({
            stepId: 'initial_relaunch',
            action: 'relaunch',
            verificationLayer: 'route-navigation',
            status: 'PASS',
            durationMs: Date.now() - tNav,
            detail: `Navigated to ${normRoute}`,
          });
        } else {
          page = await miniProgram.currentPage();
        }

        // 5. Execute step chain if `args.steps` is provided
        const stepList = Array.isArray(args.steps) ? args.steps : [];
        for (let i = 0; i < stepList.length; i++) {
          if (jobController.signal.aborted) {
            throw createStructuredError({
              code: cancelled ? 'JOB_CANCELLED' : 'TOTAL_TIMEOUT_EXCEEDED',
              category: 'timeout',
              stage: `step_${i + 1}`,
              message: String(jobController.signal.reason?.message || 'Aborted'),
            });
          }

          const step = stepList[i];
          const stepId = step.stepId || `step_${i + 1}_${step.action}`;
          const tStep = Date.now();

          try {
            switch (step.action) {
              case 'start_request_capture': {
                await installWxRequestTap(miniProgram, step.urlPattern || args.captureApiPattern || []);
                requestTapInstalled = true;
                steps.push({
                  stepId,
                  action: 'start_request_capture',
                  verificationLayer: 'in-page-network-tap',
                  status: 'PASS',
                  durationMs: Date.now() - tStep,
                  detail: `Installed wx.request hook in AppService for pattern: ${step.urlPattern || '*'}`,
                });
                break;
              }

              case 'collect_request_capture': {
                capturedRequests = await collectAndRestoreWxRequestTap(miniProgram, args.redactFields || []);
                requestTapInstalled = false;
                steps.push({
                  stepId,
                  action: 'collect_request_capture',
                  verificationLayer: 'in-page-network-tap',
                  status: 'PASS',
                  durationMs: Date.now() - tStep,
                  detail: `Collected ${capturedRequests.length} in-page wx.request records and restored original wx.request.`,
                });
                break;
              }

              case 'relaunch':
              case 'navigate_to': {
                const norm = step.route.startsWith('/') ? step.route : `/${step.route}`;
                page =
                  step.action === 'navigate_to' && typeof miniProgram.navigateTo === 'function'
                    ? await miniProgram.navigateTo(norm)
                    : await miniProgram.reLaunch(norm);
                await page.waitFor(Number(step.waitMs) || 300);
                steps.push({
                  stepId,
                  action: step.action,
                  verificationLayer: 'route-navigation',
                  status: 'PASS',
                  durationMs: Date.now() - tStep,
                  detail: `Navigated to ${norm}`,
                });
                break;
              }

              case 'tap': {
                const el = await page.$(step.selector);
                if (!el) throw new Error(`WXML selector "${step.selector}" not found for tap`);
                await el.tap();
                await page.waitFor(Number(step.waitMs) || 200);
                steps.push({
                  stepId,
                  action: 'tap',
                  verificationLayer: 'element-tap',
                  status: 'PASS',
                  durationMs: Date.now() - tStep,
                  detail: `Tapped WXML element ${step.selector}`,
                });
                break;
              }

              case 'input': {
                const el = await page.$(step.selector);
                if (!el || typeof el.input !== 'function') {
                  throw new Error(`WXML input "${step.selector}" not found`);
                }
                await el.input(String(step.value ?? ''));
                steps.push({
                  stepId,
                  action: 'input',
                  verificationLayer: 'element-input',
                  status: 'PASS',
                  durationMs: Date.now() - tStep,
                  detail: `Input value into ${step.selector}`,
                });
                break;
              }

              case 'call_method': {
                await page.callMethod(step.methodName, ...(step.args || []));
                await page.waitFor(Number(step.waitMs) || 150);
                steps.push({
                  stepId,
                  action: 'call_method',
                  verificationLayer: 'page-call-method',
                  status: 'PASS',
                  durationMs: Date.now() - tStep,
                  detail: `Invoked Page.${step.methodName}() directly in AppService (Note: does NOT verify WXML tap entry or event binding).`,
                });
                break;
              }

              case 'inspect_geometry': {
                lastGeometry = await queryMpGeometryAndPotentialOcclusion(miniProgram, {
                  parentSelector: step.parentSelector || args.selectors?.parent || '.page-container',
                  targetSelector: step.targetSelector || args.selectors?.target || '',
                  occludeSelector: step.occludeSelector || args.selectors?.occlude || '',
                  occludersSelector: step.occludersSelector || args.selectors?.occluders,
                });
                steps.push({
                  stepId,
                  action: 'inspect_geometry',
                  verificationLayer: 'selector-query-geometry',
                  status: 'PASS',
                  durationMs: Date.now() - tStep,
                  detail: 'Collected SelectorQuery NodesRef.fields geometry and potential AABB occlusion metrics.',
                });
                break;
              }

              case 'assert': {
                if (requestTapInstalled) {
                  capturedRequests = await collectAndRestoreWxRequestTap(miniProgram, args.redactFields || []);
                  requestTapInstalled = false;
                }
                const aRes = await evaluateMpAssertion({
                  miniProgram,
                  page,
                  assertion: step.assertion || step,
                  capturedRequests,
                  geometryCache: lastGeometry,
                });
                assertions.push(aRes);
                if (aRes.unsupported) {
                  errors.push(
                    createStructuredError({
                      code: 'CAPABILITY_UNSUPPORTED',
                      category: 'capability',
                      stage: stepId,
                      message: aRes.message,
                    })
                  );
                }
                steps.push({
                  stepId,
                  action: 'assert',
                  verificationLayer: 'assertion',
                  status: aRes.pass ? 'PASS' : 'FAIL',
                  durationMs: Date.now() - tStep,
                  detail: aRes.message,
                });
                break;
              }

              default:
                steps.push({
                  stepId,
                  action: step.action,
                  verificationLayer: 'unknown',
                  status: 'SKIPPED',
                  durationMs: 0,
                  detail: `Unsupported step action "${step.action}" was skipped.`,
                });
            }
          } catch (stepErr) {
            steps.push({
              stepId,
              action: step.action,
              verificationLayer: 'execution',
              status: 'ERROR',
              durationMs: Date.now() - tStep,
              detail: redactSensitiveData(stepErr.message),
            });
            errors.push(
              createStructuredError({
                code: stepErr.code || 'STEP_EXECUTION_ERROR',
                category: stepErr.code === 'ROUTE_NOT_FOUND' ? 'environment' : 'internal',
                stage: stepId,
                message: stepErr.message,
                recoveryHint: 'Check route registration in app.json and WXML selector availability.',
              })
            );
            break;
          }
        }

        // Collect & restore wx.request hook if still active
        if (requestTapInstalled) {
          capturedRequests = await collectAndRestoreWxRequestTap(miniProgram, args.redactFields || []);
          requestTapInstalled = false;
        }

        // Read MVVM data paths & rendered text if requested
        const pageDataMap = {};
        if (page) {
          const dataPaths = Array.isArray(args.dataPaths) && args.dataPaths.length > 0 ? args.dataPaths : [''];
          for (const dp of dataPaths) {
            pageDataMap[dp || '(root)'] = redactSensitiveData(await page.data(dp || undefined), args.redactFields || []);
          }
        }

        const renderedTextMap = {};
        if (page && args.selectors?.readText) {
          for (const [label, sel] of Object.entries(args.selectors.readText)) {
            const el = await page.$(sel);
            renderedTextMap[label] = el && typeof el.text === 'function' ? await el.text() : null;
          }
        }

        // Collect geometry if not already collected
        if (!lastGeometry) {
          lastGeometry = await queryMpGeometryAndPotentialOcclusion(miniProgram, {
            parentSelector: args.selectors?.parent || '.page-container',
            targetSelector: args.selectors?.target || '',
            occludeSelector: args.selectors?.occlude || '',
            occludersSelector: args.selectors?.occluders,
          });
        }

        // Evaluate top-level assertions
        if (Array.isArray(args.assertions) && page) {
          for (const a of args.assertions) {
            const aRes = await evaluateMpAssertion({
              miniProgram,
              page,
              assertion: a,
              capturedRequests,
              geometryCache: lastGeometry,
            });
            assertions.push(aRes);
            if (aRes.unsupported) {
              errors.push(
                createStructuredError({
                  code: 'CAPABILITY_UNSUPPORTED',
                  category: 'capability',
                  stage: aRes.id,
                  message: aRes.message,
                })
              );
            }
          }
        }

        // Save captured requests JSON evidence if any were captured
        if (capturedRequests.length > 0) {
          const netJsonPath = path.join(evidenceDir, `${runId}-wx-requests.json`);
          fs.writeFileSync(netJsonPath, JSON.stringify(capturedRequests, null, 2));
          const netEv = createEvidenceEntry({
            filePath: netJsonPath,
            type: 'wx-request-log',
            mimeType: 'application/json',
            stepId: 'network-capture',
            baseDir: evidenceDir,
          });
          if (netEv) evidence.push(netEv);
        }

        // Capture Simulator Screenshot via `miniProgram.screenshot` (Section 5.7)
        if (args.screenshot !== false) {
          const shotPath =
            typeof args.screenshot === 'string' && args.screenshot.endsWith('.png')
              ? validateSafePath(args.screenshot, [evidenceDir, path.dirname(path.resolve(args.screenshot))], 'screenshot')
              : path.join(evidenceDir, `${runId}-simulator.png`);
          fs.mkdirSync(path.dirname(shotPath), { recursive: true });

          try {
            await miniProgram.screenshot({ path: shotPath });
            const buf = fs.existsSync(shotPath) ? fs.readFileSync(shotPath) : null;
            if (!isValidPngBuffer(buf)) {
              throw new Error('Simulator screenshot output is missing or not a valid PNG image.');
            }
            const shotEv = createEvidenceEntry({
              filePath: shotPath,
              type: 'simulator-screenshot',
              mimeType: 'image/png',
              stepId: 'screenshot',
              baseDir: evidenceDir,
            });
            if (shotEv) evidence.push(shotEv);
            if (args.returnImageBase64) {
              imageAttachment = {
                mimeType: 'image/png',
                base64: buf.toString('base64'),
              };
            }
          } catch (shotErr) {
            partialReason = `Simulator screenshot unavailable (${shotErr.message}); MVVM data, network, and geometry evidence preserved.`;
            errors.push({
              ...createStructuredError({
                code: 'SIMULATOR_SCREENSHOT_UNAVAILABLE',
                category: 'environment',
                stage: 'screenshot',
                message: `Simulator screenshot failed: ${shotErr.message}. Never substitute Console/Network panel crops.`,
                recoveryHint: 'Ensure the Simulator (模拟器) pane is open and visible in WeChat DevTools.',
              }),
              nonFatalPartial: true,
            });
          }
        }

        const actualRoute = page?.path ? (page.path.startsWith('/') ? page.path : `/${page.path}`) : '';

        const envelope = buildResponseEnvelope({
          runId,
          caseId,
          acIds,
          startedAtDate,
          finishedAtDate: new Date(),
          engineVersion: `miniprogram-automator/${envStatus.automatorVersion} (${connectionMode})`,
          targetRoute: args.route || '',
          actualRoute,
          deviceInfo: lastGeometry?.deviceInfo || null,
          authMeta: authInfo,
          steps,
          assertions,
          errors,
          evidence,
          requireAssertions: Boolean(args.steps || (Array.isArray(args.assertions) && args.assertions.length > 0)),
          cancelled,
          partialReason,
          data: {
            connectionMode,
            targetDescription,
            pageData: pageDataMap,
            renderedText: renderedTextMap,
            capturedRequestsCount: capturedRequests.length,
            capturedRequests,
            layout: lastGeometry?.layout || null,
            potentialOcclusionEvidence: lastGeometry?.potentialOcclusionEvidence || null,
          },
        });

        const reportJsonPath = path.join(evidenceDir, `${runId}-report.json`);
        fs.writeFileSync(reportJsonPath, JSON.stringify(envelope, null, 2));
        const repEv = createEvidenceEntry({
          filePath: reportJsonPath,
          type: 'report-json',
          mimeType: 'application/json',
          stepId: 'report',
          baseDir: evidenceDir,
        });
        if (repEv) envelope.evidence.push(repEv);

        activeMpJobs.set(runId, {
          runId,
          caseId,
          status: envelope.status,
          finishedAt: envelope.finishedAt,
          envelope,
        });

        return { envelope, imageAttachment };
      } finally {
        // Always ensure wx.request hook is restored even on error!
        if (requestTapInstalled) {
          await collectAndRestoreWxRequestTap(miniProgram).catch(() => {});
        }
        // Clean up only what we own: never close user's existing WeChat DevTools!
        if (ownedProcess) {
          await miniProgram.close?.().catch(() => {});
        } else {
          await miniProgram.disconnect?.().catch(() => {});
        }
      }
    });
  } finally {
    clearTimeout(timeoutTimer);
  }
}
