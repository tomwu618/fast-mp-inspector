#!/usr/bin/env node
/**
 * Standardized Multi-Role Auth & StorageState Manager (scripts/auth-helper.mjs)
 *
 * Inspired by Playwright's `storageState` standard, adapted for WeChat Mini Programs.
 * Zero hardcoded storage keys — works with ANY Native / uni-app / Taro Mini Program!
 *
 * Supports 3 standardized authentication strategies:
 * 1. `ui-password`: Automates username/password form input on the Mini Program's login page once,
 *    lets the app execute its own RSA/MD5 encryption & login hooks, then dumps ALL `wx.getStorageInfoSync()`
 *    keys + `getApp().globalData` into `.auth-cache/<role>.state.json` for 0ms reuse.
 *    Automatically re-runs `ui-password` login if the cached token expires (redirected back to login page).
 * 2. `snapshot` (`--dump-auth` / `--load-auth`): Captures or restores the entire live Storage + globalData state
 *    from WeChat DevTools (ideal for SMS/captcha/OAuth logins).
 * 3. `http-password`: Direct HTTP login against a REST API with configurable field mapping.
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CACHE_DIR = path.resolve(process.cwd(), '.auth-cache');

/**
 * Dump the complete live `wx` Storage and serializable `getApp().globalData` from AppService
 */
export async function captureMpStorageState(miniProgram, role = 'default') {
  const snapshot = await miniProgram.evaluate(() => {
    const storageMap = {};
    if (typeof wx !== 'undefined' && typeof wx.getStorageInfoSync === 'function') {
      const info = wx.getStorageInfoSync() || {};
      const keys = Array.isArray(info.keys) ? info.keys : [];
      for (const k of keys) {
        try {
          storageMap[k] = wx.getStorageSync(k);
        } catch {
          // Ignore unreadable key
        }
      }
    }

    let globalDataMap = {};
    if (typeof getApp === 'function') {
      try {
        const app = getApp({ allowDefault: true });
        if (app && app.globalData) {
          globalDataMap = JSON.parse(JSON.stringify(app.globalData));
        }
      } catch {
        // Ignore non-serializable globalData properties
      }
    }

    return {
      storageMap,
      globalDataMap,
    };
  });

  return {
    version: 1,
    role,
    capturedAt: new Date().toISOString(),
    timestamp: Date.now(),
    storageMap: snapshot?.storageMap || {},
    globalDataMap: snapshot?.globalDataMap || {},
  };
}

/**
 * Restore a complete `StorageState` object into both `wx.setStorageSync` and `getApp().globalData`
 */
export async function restoreMpStorageState(miniProgram, stateObj, clearExisting = false) {
  return await miniProgram.evaluate(
    ({ sMap, gMap, shouldClear }) => {
      if (typeof wx !== 'undefined') {
        if (shouldClear && typeof wx.clearStorageSync === 'function') {
          wx.clearStorageSync();
        }
        if (typeof wx.setStorageSync === 'function') {
          for (const [k, v] of Object.entries(sMap || {})) {
            wx.setStorageSync(k, v);
          }
        }
      }

      if (typeof getApp === 'function') {
        const app = getApp({ allowDefault: true });
        if (app) {
          app.globalData = Object.assign(app.globalData || {}, gMap || {});
        }
      }

      return {
        syncedStorageKeys: Object.keys(sMap || {}),
        syncedGlobalDataKeys: Object.keys(gMap || {}),
      };
    },
    {
      sMap: stateObj.storageMap || {},
      gMap: stateObj.globalDataMap || {},
      shouldClear: clearExisting,
    }
  );
}

/**
 * Standardized UI Username/Password Form Login inside Mini Program Simulator
 *
 * Works with any frontend encryption (MD5/RSA/SM2), custom headers, and multi-key storage writes!
 */
export async function performMpUiPasswordLogin(
  miniProgram,
  {
    loginRoute = '/pages/login/index',
    username = '',
    password = '',
    usernameSelector = '.username-input, input[type="text"], input[name="username"]',
    passwordSelector = '.password-input, input[password], input[type="password"], input[name="password"]',
    submitSelector = '.login-btn, button[form-type="submit"], button[type="primary"]',
    callLoginMethod = '',
    postLoginWaitMs = 1000,
    role = 'default',
  }
) {
  const normLoginRoute = loginRoute.startsWith('/') ? loginRoute : `/${loginRoute}`;
  const loginPage = await miniProgram.reLaunch(normLoginRoute);
  await loginPage.waitFor(400);

  if (callLoginMethod) {
    // Option A: Directly invoke page login method if specified
    await loginPage.callMethod(callLoginMethod, { username, password });
  } else {
    // Option B: Standardized UI input filling & submit tap
    const userEl = await loginPage.$(usernameSelector);
    if (!userEl) {
      throw new Error(`Username input not found on ${normLoginRoute} using selector "${usernameSelector}"`);
    }
    await userEl.input(String(username));

    const passEl = await loginPage.$(passwordSelector);
    if (!passEl) {
      throw new Error(`Password input not found on ${normLoginRoute} using selector "${passwordSelector}"`);
    }
    await passEl.input(String(password));

    const submitEl = await loginPage.$(submitSelector);
    if (!submitEl) {
      throw new Error(`Login submit button not found on ${normLoginRoute} using selector "${submitSelector}"`);
    }
    await submitEl.tap();
  }

  await loginPage.waitFor(Number(postLoginWaitMs) || 1000);

  // Capture all storage keys & globalData populated by the Mini Program's own login logic
  const capturedState = await captureMpStorageState(miniProgram, role);
  return {
    ...capturedState,
    authMethod: 'ui-password',
  };
}

/**
 * Standardized HTTP Username/Password Login with configurable field & storage key mapping
 */
export async function performHttpPasswordLogin({
  loginUrl,
  username,
  password,
  usernameField = 'username',
  passwordField = 'password',
  extraBody = {},
  tokenField = 'data.token',
  userField = 'data.userInfo',
  tokenStorageKey = 'token',
  userStorageKey = 'userInfo',
  role = 'default',
}) {
  const reqBody = {
    ...(typeof extraBody === 'string' ? JSON.parse(extraBody) : extraBody),
    ...(username ? { [usernameField]: username } : {}),
    ...(password ? { [passwordField]: password } : {}),
  };

  const response = await fetch(loginUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reqBody),
  });

  if (!response.ok) {
    throw new Error(`HTTP login failed with status ${response.status} from ${loginUrl}`);
  }

  const resJson = await response.json();
  const extractPath = (obj, dotPath) =>
    dotPath.split('.').reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj);

  const token =
    extractPath(resJson, tokenField) ??
    resJson.token ??
    resJson.access_token ??
    resJson.data?.token ??
    resJson.data?.accessToken;

  if (!token) {
    throw new Error(`Could not extract token from HTTP login response using path "${tokenField}"`);
  }

  const userProfile = extractPath(resJson, userField) ?? resJson.userInfo ?? resJson.data ?? {};

  return {
    version: 1,
    role,
    authMethod: 'http-password',
    capturedAt: new Date().toISOString(),
    timestamp: Date.now(),
    storageMap: {
      [tokenStorageKey]: token,
      [userStorageKey]: userProfile,
    },
    globalDataMap: {
      [tokenStorageKey]: token,
      [userStorageKey]: userProfile,
      role,
      isLogin: true,
    },
  };
}

/**
 * Get the state file path for a given role or explicit file path
 */
export function resolveStateFilePath({ role = 'default', stateFile = '', cacheDir = DEFAULT_CACHE_DIR }) {
  if (stateFile) return path.resolve(stateFile);
  fs.mkdirSync(cacheDir, { recursive: true });
  const safeRole = String(role || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(cacheDir, `${safeRole}.state.json`);
}

/**
 * High-level standardized orchestrator:
 * 1. Supports `--dump-auth <file>` to snapshot current logged-in state
 * 2. Loads cached `.auth-cache/<role>.state.json` (or `--load-auth <file>`) if present
 * 3. Otherwise runs `ui-password` or `http-password` login and saves `.state.json`
 * 4. Injects state and navigates to target route; if redirected back to login page (token expired),
 *    automatically re-authenticates via `ui-password` / `http-password` and refreshes cache!
 */
export async function ensureStandardMpAuthAndNavigate(miniProgram, args) {
  const statePath = resolveStateFilePath({
    role: args.role || 'default',
    stateFile: args.loadAuth || args.dumpAuth || '',
  });

  // Mode 1: Dump current live DevTools auth state to file
  if (args.dumpAuth) {
    const dumped = await captureMpStorageState(miniProgram, args.role || 'default');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(dumped, null, 2));
    return {
      authSummary: {
        mode: 'dump-auth',
        role: dumped.role,
        stateFile: statePath,
        syncedStorageKeys: Object.keys(dumped.storageMap),
        syncedGlobalDataKeys: Object.keys(dumped.globalDataMap),
      },
      page: await miniProgram.currentPage(),
    };
  }

  let stateObj = null;
  let fromCache = false;

  // Try loading existing state snapshot from disk
  const hasAuthCredentials = Boolean(args.loadAuth || args.username || args.loginUrl || args.storage || args.globalData);
  if ((args.loadAuth || args.role) && fs.existsSync(statePath)) {
    try {
      stateObj = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      fromCache = true;
    } catch {
      stateObj = null;
    }
  }

  // Helper to execute fresh login (UI username/password or HTTP username/password)
  const executeFreshLogin = async () => {
    if (args.loginUrl) {
      return await performHttpPasswordLogin({
        loginUrl: args.loginUrl,
        username: args.username,
        password: args.password,
        usernameField: args.usernameField || 'username',
        passwordField: args.passwordField || 'password',
        extraBody: args.loginBody || {},
        tokenField: args.tokenField || 'data.token',
        tokenStorageKey: args.tokenStorageKey || 'token',
        role: args.role || 'default',
      });
    }
    if (args.username && args.password) {
      return await performMpUiPasswordLogin(miniProgram, {
        loginRoute: args.loginRoute || '/pages/login/index',
        username: args.username,
        password: args.password,
        usernameSelector: args.userSelector || '.username-input, input[type="text"], input[name="username"]',
        passwordSelector: args.passSelector || '.password-input, input[password], input[type="password"], input[name="password"]',
        submitSelector: args.submitSelector || '.login-btn, button[form-type="submit"], button[type="primary"]',
        callLoginMethod: args.loginMethod || '',
        role: args.role || 'default',
      });
    }
    return null;
  };

  if (!stateObj && (args.username || args.loginUrl)) {
    stateObj = await executeFreshLogin();
    if (stateObj) {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(stateObj, null, 2));
    }
  }

  // Merge any explicit --storage or --global-data overrides
  const extraStorage = args.storage ? JSON.parse(args.storage) : {};
  const extraGlobal = args.globalData ? JSON.parse(args.globalData) : {};
  if (stateObj || Object.keys(extraStorage).length > 0 || Object.keys(extraGlobal).length > 0) {
    stateObj = {
      ...(stateObj || { role: args.role || 'default', authMethod: 'inline-override' }),
      storageMap: { ...(stateObj?.storageMap || {}), ...extraStorage },
      globalDataMap: { ...(stateObj?.globalDataMap || {}), ...extraGlobal },
    };
  }

  let syncResult = null;
  if (stateObj) {
    syncResult = await restoreMpStorageState(miniProgram, stateObj, false);
  }

  // Navigate to target route
  let page;
  if (args.route) {
    const normalizedRoute = args.route.startsWith('/') ? args.route : `/${args.route}`;
    page = await miniProgram.reLaunch(normalizedRoute);
  } else {
    page = await miniProgram.currentPage();
  }

  await page.waitFor(Number(args.waitMs) || 500);

  // Auto Self-Healing: If we used a cached state and the app redirected us back to the login page,
  // our cached token expired! Automatically re-login once and re-navigate.
  const loginRouteClean = String(args.loginRoute || '/pages/login/index').replace(/^\/+/, '');
  const currentPathClean = String(page?.path || '').replace(/^\/+/, '');
  const wasRedirectedToLogin =
    fromCache &&
    args.route &&
    !String(args.route).replace(/^\/+/, '').startsWith(loginRouteClean) &&
    currentPathClean.startsWith(loginRouteClean);

  if (wasRedirectedToLogin && (args.username || args.loginUrl)) {
    stateObj = await executeFreshLogin();
    if (stateObj) {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(stateObj, null, 2));
      syncResult = await restoreMpStorageState(miniProgram, stateObj, false);
      const normalizedRoute = args.route.startsWith('/') ? args.route : `/${args.route}`;
      page = await miniProgram.reLaunch(normalizedRoute);
      await page.waitFor(Number(args.waitMs) || 500);
      fromCache = false;
    }
  }

  const authSummary = hasAuthCredentials || stateObj
    ? {
        role: stateObj?.role || args.role || 'default',
        authMethod: stateObj?.authMethod || (fromCache ? 'cached-state' : 'none'),
        fromCache,
        autoReloginTriggered: wasRedirectedToLogin,
        stateFile: fs.existsSync(statePath) ? statePath : null,
        ...(syncResult || {}),
      }
    : null;

  return { authSummary, page };
}
