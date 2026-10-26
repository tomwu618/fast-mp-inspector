/**
 * Shared Security, Redaction, Evidence & Envelope Utilities for fast-mp-inspector (src/common.mjs)
 * Implements Section 3 (Shared Contract) of MCP Integration Spec v1.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = '1.0.0';
export const TOOL_VERSION = '1.1.0';

const DEFAULT_SENSITIVE_KEYS = new Set([
  'password',
  'passwd',
  'pwd',
  'token',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'id_token',
  'uni_id_token',
  'authorization',
  'cookie',
  'set-cookie',
  'secret',
  'client_secret',
  'apikey',
  'api_key',
  'sessionid',
  'jsessionid',
  'openid',
  'session_key',
]);

export function formatIsoWithTz(date = new Date()) {
  const tzOffsetMin = -date.getTimezoneOffset();
  const sign = tzOffsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(tzOffsetMin);
  const pad = (n, len = 2) => String(Math.floor(Math.abs(n))).padStart(len, '0');
  const hours = pad(absMin / 60);
  const minutes = pad(absMin % 60);

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${hours}:${minutes}`
  );
}

export function generateRunId(prefix = 'mp_run') {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${ts}_${rand}`;
}

export function createStructuredError({
  code = 'INTERNAL_ERROR',
  category = 'internal',
  stage = 'execution',
  message = 'An unexpected error occurred',
  recoveryHint = 'Check stderr diagnostic logs or run mp_diagnose first.',
}) {
  return {
    code,
    category,
    stage,
    message: redactStringSecrets(String(message)),
    recoveryHint,
  };
}

export function redactStringSecrets(input) {
  if (!input || typeof input !== 'string') return input;
  return input
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED_JWT]')
    .replace(/((?:password|token|secret|authorization|cookie)\s*[:=]\s*)(["']?)[^"'\s,&]+(\2)/gi, '$1$2[REDACTED]$3');
}

export function redactSensitiveData(value, extraFields = [], depth = 0) {
  if (depth > 12) return '[TRUNCATED_DEPTH]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactStringSecrets(value);
  if (typeof value !== 'object') return value;

  const extraSet = new Set(extraFields.map((f) => String(f).toLowerCase()));
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item, extraFields, depth + 1));
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const lowerKey = k.toLowerCase();
    if (
      DEFAULT_SENSITIVE_KEYS.has(lowerKey) ||
      extraSet.has(lowerKey) ||
      /(password|passwd|secret|token|authorization|cookie|session_key)/i.test(lowerKey)
    ) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redactSensitiveData(v, extraFields, depth + 1);
    }
  }
  return out;
}

export function getAllowedRoots(explicitRoots = [], envPrefix = 'FAST_MP') {
  const roots = new Set();
  const envProject = process.env[`${envPrefix}_PROJECT_ROOT`];
  const envEvidence = process.env[`${envPrefix}_EVIDENCE_DIR`];
  const envExtra = process.env[`${envPrefix}_ALLOWED_ROOTS`];

  for (const r of [process.cwd(), ...explicitRoots, envProject, envEvidence]) {
    if (r && typeof r === 'string' && r.trim()) {
      roots.add(path.resolve(r.trim()));
    }
  }
  if (envExtra) {
    for (const part of envExtra.split(path.delimiter)) {
      if (part.trim()) roots.add(path.resolve(part.trim()));
    }
  }
  return Array.from(roots);
}

export function validateSafePath(inputPath, allowedRoots = [], stage = 'validation') {
  if (!inputPath || typeof inputPath !== 'string') {
    throw createStructuredError({
      code: 'INVALID_PATH',
      category: 'permission',
      stage,
      message: 'File path must be a non-empty string.',
      recoveryHint: 'Provide a valid path within configured projectPath or evidenceDir.',
    });
  }

  const rawNormalized = inputPath.replace(/\\/g, '/');
  if (rawNormalized.split('/').includes('..')) {
    throw createStructuredError({
      code: 'PATH_TRAVERSAL_DENIED',
      category: 'permission',
      stage,
      message: `Path traversal ("..") is forbidden: ${inputPath}`,
      recoveryHint: 'Use a canonical path inside the allowed project or evidence root.',
    });
  }

  const resolved = path.resolve(inputPath);
  const roots = getAllowedRoots(allowedRoots);

  const isInsideRoot = (candidatePath, rootPath) => {
    const normCand = process.platform === 'win32' ? candidatePath.toLowerCase() : candidatePath;
    const normRoot = process.platform === 'win32' ? rootPath.toLowerCase() : rootPath;
    return normCand === normRoot || normCand.startsWith(normRoot + path.sep);
  };

  if (!roots.some((r) => isInsideRoot(resolved, r))) {
    throw createStructuredError({
      code: 'PATH_OUTSIDE_ALLOWED_ROOTS',
      category: 'permission',
      stage,
      message: `Path "${resolved}" is outside allowed roots (${roots.join(', ')}).`,
      recoveryHint: 'Set FAST_MP_PROJECT_ROOT / FAST_MP_EVIDENCE_DIR or pass a path inside the workspace.',
    });
  }

  let checkCursor = resolved;
  while (checkCursor && !fs.existsSync(checkCursor)) {
    const parent = path.dirname(checkCursor);
    if (parent === checkCursor) break;
    checkCursor = parent;
  }
  if (checkCursor && fs.existsSync(checkCursor)) {
    const realAncestor = fs.realpathSync(checkCursor);
    const realRoots = roots.map((r) => (fs.existsSync(r) ? fs.realpathSync(r) : r));
    if (!realRoots.some((r) => isInsideRoot(realAncestor, r))) {
      throw createStructuredError({
        code: 'SYMLINK_ESCAPE_DENIED',
        category: 'permission',
        stage,
        message: `Symlink target "${realAncestor}" escapes allowed roots.`,
        recoveryHint: 'Do not use symlinks pointing outside the configured project or evidence directories.',
      });
    }
  }

  return resolved;
}

export function validateSafeWsEndpoint(wsEndpoint, allowedEndpoints = [], stage = 'connection') {
  if (!wsEndpoint) return '';
  let parsed;
  try {
    parsed = new URL(wsEndpoint);
  } catch {
    throw createStructuredError({
      code: 'INVALID_WS_ENDPOINT',
      category: 'connection',
      stage,
      message: `Invalid WebSocket endpoint: "${wsEndpoint}"`,
      recoveryHint: 'Use ws://127.0.0.1:<port> or ws://localhost:<port>.',
    });
  }

  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw createStructuredError({
      code: 'UNSUPPORTED_WS_PROTOCOL',
      category: 'permission',
      stage,
      message: `Unsupported WebSocket protocol "${parsed.protocol}".`,
      recoveryHint: 'Use ws:// or wss://.',
    });
  }

  const envAllowed = (process.env.FAST_MP_ALLOWED_WS_ENDPOINTS || 'ws://127.0.0.1:*,ws://localhost:*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const whitelist = [...allowedEndpoints, ...envAllowed];

  if (!whitelist.includes('*')) {
    const matched = whitelist.some((pattern) => {
      if (pattern === wsEndpoint || pattern === parsed.origin) return true;
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1);
        return wsEndpoint.startsWith(prefix);
      }
      return false;
    });
    if (!matched) {
      throw createStructuredError({
        code: 'WS_ENDPOINT_NOT_WHITELISTED',
        category: 'permission',
        stage,
        message: `WebSocket endpoint "${wsEndpoint}" is not in FAST_MP_ALLOWED_WS_ENDPOINTS (${whitelist.join(', ')}).`,
        recoveryHint: 'Use a local 127.0.0.1 endpoint or add the endpoint to FAST_MP_ALLOWED_WS_ENDPOINTS.',
      });
    }
  }

  return wsEndpoint;
}

export function resolveMpAuthReference(authRef, allowedRoots = []) {
  if (!authRef || typeof authRef !== 'string') {
    return {
      accountAlias: 'anonymous',
      authMethod: 'none',
      isTestInjection: false,
      verificationNote: 'No test credential injection applied.',
      storageMap: {},
      globalDataMap: {},
    };
  }

  const safeAlias = authRef.replace(/[^a-zA-Z0-9_-]/g, '_');
  const envKey = `FAST_MP_AUTH_${safeAlias.toUpperCase()}`;
  const envVal = process.env[envKey];

  if (envVal) {
    try {
      const parsed = JSON.parse(envVal);
      return {
        accountAlias: safeAlias,
        authMethod: 'env-reference-injection',
        isTestInjection: true,
        verificationNote:
          'Session state was injected via test storage/globalData reference; this does NOT verify the interactive login page flow.',
        storageMap: parsed.storageMap || (parsed.token ? { token: parsed.token } : {}),
        globalDataMap: parsed.globalDataMap || {},
      };
    } catch {
      return {
        accountAlias: safeAlias,
        authMethod: 'env-token-injection',
        isTestInjection: true,
        verificationNote:
          'Token was injected via test storage reference; this does NOT verify the interactive login page flow.',
        storageMap: { token: envVal },
        globalDataMap: { token: envVal, isLogin: true },
      };
    }
  }

  const authDir = process.env.FAST_MP_AUTH_DIR || path.resolve(process.cwd(), '.auth-cache');
  const candidateFiles = [
    path.join(authDir, `${safeAlias}.state.json`),
    path.join(authDir, `${safeAlias}.json`),
  ];

  for (const file of candidateFiles) {
    if (fs.existsSync(file)) {
      validateSafePath(file, [...allowedRoots, authDir], 'auth-resolution');
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        accountAlias: raw.role || safeAlias,
        authMethod: 'state-file-injection',
        isTestInjection: true,
        verificationNote:
          'Session state was restored from .state.json snapshot; this does NOT verify a live interactive login submission in this run.',
        storageMap: raw.storageMap || {},
        globalDataMap: raw.globalDataMap || {},
      };
    }
  }

  throw createStructuredError({
    code: 'AUTH_REF_NOT_FOUND',
    category: 'permission',
    stage: 'auth-resolution',
    message: `Credential reference "${authRef}" could not be resolved from env (${envKey}) or .auth-cache/${safeAlias}.state.json.`,
    recoveryHint: `Create .auth-cache/${safeAlias}.state.json or set environment variable ${envKey}.`,
  });
}

export function createEvidenceEntry({
  filePath,
  type = 'file',
  mimeType = 'application/octet-stream',
  stepId = 'final',
  baseDir = process.cwd(),
}) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) return null;
  const buf = fs.readFileSync(absPath);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const relPath = path.relative(baseDir, absPath).replace(/\\/g, '/');

  return {
    id: `ev_${sha256.slice(0, 10)}`,
    type,
    path: absPath,
    relativePath: relPath.startsWith('..') ? absPath : relPath,
    mimeType,
    bytes: buf.length,
    sha256,
    capturedAt: formatIsoWithTz(new Date()),
    stepId,
    resourceUri: `file:///${absPath.replace(/\\/g, '/')}`,
  };
}

export function buildResponseEnvelope({
  runId = generateRunId(),
  caseId = 'adhoc',
  acIds = [],
  startedAtDate = new Date(),
  finishedAtDate = new Date(),
  engineVersion = 'unknown',
  targetRoute = '',
  actualRoute = '',
  buildId = 'unknown',
  deviceInfo = null,
  authMeta = { accountAlias: 'anonymous', authMethod: 'none', isTestInjection: false },
  steps = [],
  assertions = [],
  errors = [],
  evidence = [],
  data = {},
  requireAssertions = false,
  cancelled = false,
  unsupported = false,
  partialReason = '',
}) {
  const totalAssertions = assertions.length;
  const passedAssertions = assertions.filter((a) => a.pass === true).length;
  const failedAssertions = assertions.filter((a) => a.pass === false).length;
  const skippedSteps = steps.filter((s) => s.status === 'SKIPPED').length;
  const errorSteps = steps.filter((s) => s.status === 'ERROR').length;

  let status = 'PASS';
  if (cancelled) {
    status = 'CANCELLED';
  } else if (unsupported || errors.some((e) => e.category === 'capability')) {
    status = 'UNSUPPORTED';
  } else if (errors.some((e) => e.category !== 'assertion' && !e.nonFatalPartial) || errorSteps > 0) {
    status = 'ERROR';
  } else if (failedAssertions > 0 || steps.some((s) => s.status === 'FAIL')) {
    status = 'FAIL';
  } else if (skippedSteps > 0 || Boolean(partialReason) || (requireAssertions && totalAssertions === 0)) {
    status = 'PARTIAL';
  }

  const executionCompleted = !cancelled && status !== 'ERROR' && status !== 'UNSUPPORTED';
  const assertionsPassed = executionCompleted && failedAssertions === 0 && (!requireAssertions || totalAssertions > 0);

  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    caseId,
    acIds: Array.isArray(acIds) ? acIds : [acIds].filter(Boolean),
    status,
    startedAt: formatIsoWithTz(startedAtDate),
    finishedAt: formatIsoWithTz(finishedAtDate),
    durationMs: Math.max(0, finishedAtDate.getTime() - startedAtDate.getTime()),
    toolVersion: TOOL_VERSION,
    engineVersion,
    targetRoute,
    actualRoute,
    buildId: buildId || 'unknown',
    deviceInfo,
    authMeta: {
      accountAlias: authMeta?.accountAlias || 'anonymous',
      authMethod: authMeta?.authMethod || 'none',
      isTestInjection: Boolean(authMeta?.isTestInjection),
      verificationNote: authMeta?.verificationNote || '',
    },
    verificationSummary: {
      toolCallSucceeded: true,
      executionCompleted,
      assertionsPassed,
      totalAssertions,
      passedAssertions,
      failedAssertions,
      skippedSteps,
      partialReason: partialReason || null,
      scopeNote:
        'Single-invocation diagnostic/verification result only. Does not imply full project batch acceptance or production sign-off.',
    },
    steps,
    assertions,
    errors,
    evidence: evidence.filter(Boolean),
    data: redactSensitiveData(data),
  };
}
