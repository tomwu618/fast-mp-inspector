#!/usr/bin/env node
/**
 * Role-Aware Auth & Token Cache Manager (scripts/auth-helper.mjs)
 *
 * Solves the "Role Token Dependency" problem in Zero-UI E2E testing:
 * 1. Fetches real JWT tokens & role profiles from your backend login API per role (e.g., admin, nurse, family)
 * 2. Caches valid tokens on disk (.auth-cache/<role>.json) and checks JWT `exp` so subsequent runs take 0ms
 * 3. Injects auth state into BOTH `wx.setStorageSync` AND `getApp().globalData` (plus uni-app/Taro stores)
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CACHE_DIR = path.resolve(process.cwd(), '.auth-cache');

/**
 * Check if a JWT token string is still valid (with 60s safety buffer)
 */
export function isJwtValid(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return true; // Non-JWT opaque token; rely on cache TTL
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload.exp) return true;
    const nowSec = Math.floor(Date.now() / 1000);
    return payload.exp > nowSec + 60;
  } catch {
    return true;
  }
}

/**
 * Resolve role credentials via cache or live HTTP login endpoint
 *
 * @param {Object} options
 * @param {string} options.role - Role name (e.g., "director", "nurse", "regulator")
 * @param {string} [options.loginUrl] - Backend login endpoint URL
 * @param {Object|string} [options.loginBody] - JSON payload for login request
 * @param {string} [options.tokenField="token"] - Dot-path in response JSON to extract token (e.g., "data.token")
 * @param {string} [options.userField="data.userInfo"] - Dot-path in response JSON to extract user/role profile
 * @param {string} [options.cacheDir] - Directory for caching role tokens
 * @param {number} [options.ttlSeconds=3600] - Fallback cache TTL in seconds
 */
export async function resolveRoleAuth({
  role = 'default',
  loginUrl = '',
  loginBody = {},
  tokenField = 'data.token',
  userField = 'data.user',
  cacheDir = DEFAULT_CACHE_DIR,
  ttlSeconds = 3600,
}) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const cacheFile = path.join(cacheDir, `${role.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);

  // 1. Check cached role session
  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const ageSec = (Date.now() - (cached.cachedAt || 0)) / 1000;
      if (ageSec < ttlSeconds && isJwtValid(cached.token)) {
        return { ...cached, fromCache: true };
      }
    } catch {
      // Ignore corrupted cache
    }
  }

  if (!loginUrl) {
    throw new Error(`No valid cached token for role "${role}" and no --login-url provided.`);
  }

  // 2. Authenticate against real backend API
  const payloadObj = typeof loginBody === 'string' ? JSON.parse(loginBody) : loginBody;
  const response = await fetch(loginUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payloadObj),
  });

  if (!response.ok) {
    throw new Error(`Role "${role}" login failed with HTTP ${response.status} from ${loginUrl}`);
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
    throw new Error(`Could not extract token from login response using path "${tokenField}"`);
  }

  const userProfile = extractPath(resJson, userField) ?? resJson.userInfo ?? resJson.data ?? {};
  const sessionData = {
    role,
    token,
    userProfile,
    storageMap: {
      token,
      userInfo: userProfile,
      currentRole: role,
    },
    globalDataMap: {
      token,
      userInfo: userProfile,
      role,
      isLogin: true,
    },
    cachedAt: Date.now(),
  };

  fs.writeFileSync(cacheFile, JSON.stringify(sessionData, null, 2));
  return { ...sessionData, fromCache: false };
}

/**
 * Inject role session into BOTH WeChat Storage AND AppService `getApp().globalData`
 * (plus optional wx.login() in-simulator code exchange)
 */
export async function injectMpRoleSession(miniProgram, { storageMap = {}, globalDataMap = {}, wxLoginExchangeUrl = '', role = '' }) {
  return await miniProgram.evaluate(
    ({ sMap, gMap, exchangeUrl, targetRole }) => {
      return new Promise((resolve) => {
        const applyState = (extraStorage = {}, extraGlobal = {}) => {
          const mergedStorage = Object.assign({}, sMap, extraStorage);
          const mergedGlobal = Object.assign({}, gMap, extraGlobal);

          // 1. Sync wx.setStorageSync
          if (typeof wx !== 'undefined' && typeof wx.setStorageSync === 'function') {
            for (const [k, v] of Object.entries(mergedStorage)) {
              wx.setStorageSync(k, v);
            }
          }

          // 2. Sync getApp().globalData (crucial when App.onLaunch has already executed!)
          if (typeof getApp === 'function') {
            const app = getApp({ allowDefault: true });
            if (app) {
              app.globalData = Object.assign(app.globalData || {}, mergedGlobal);
            }
          }

          resolve({
            syncedStorageKeys: Object.keys(mergedStorage),
            syncedGlobalDataKeys: Object.keys(mergedGlobal),
          });
        };

        // Optional: In-simulator wx.login() -> backend token exchange
        if (exchangeUrl && typeof wx !== 'undefined' && typeof wx.login === 'function') {
          wx.login({
            success(loginRes) {
              wx.request({
                url: exchangeUrl,
                method: 'POST',
                data: { code: loginRes.code, role: targetRole },
                success(resp) {
                  const data = resp.data?.data || resp.data || {};
                  applyState(
                    { token: data.token, userInfo: data.userInfo || data },
                    { token: data.token, userInfo: data.userInfo || data, role: targetRole, isLogin: true }
                  );
                },
                fail() {
                  applyState();
                },
              });
            },
            fail() {
              applyState();
            },
          });
        } else {
          applyState();
        }
      });
    },
    {
      sMap: storageMap,
      gMap: globalDataMap,
      exchangeUrl: wxLoginExchangeUrl,
      targetRole: role,
    }
  );
}
