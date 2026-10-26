#!/usr/bin/env node
/**
 * Layer 1: Static Mini Program Bundle & Subpackage Integrity Probe (scripts/check-mp-bundle.mjs)
 *
 * Works cross-platform (Windows / macOS / Linux) without WeChat DevTools.
 * Supports Native WeChat Mini Program, uni-app (dist/dev/mp-weixin), and Taro (dist/).
 *
 * Implements Section 5.8 of MCP Integration Spec v1:
 * - Configurable package size limits (`maxSinglePackageKB`, `maxTotalPackageKB`) with explicit `ruleSource`
 * - Distinguishes valid empty `.wxss` stylesheets allowed by generators (`allowEmptyStyles: true` by default)
 *   from missing/empty `.js` or `.wxml` route files.
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_BUNDLE_LIMITS = {
  maxSinglePackageKB: 2048,
  maxTotalPackageKB: 20480,
  ruleSource: 'WeChat Mini Program Official Specification (2048 KB single package / 20480 KB total subpackages)',
  platform: 'mp-weixin',
  allowEmptyStyles: true,
};

export function checkMpBundle(bundleDir, customLimits = {}) {
  const limits = {
    ...DEFAULT_BUNDLE_LIMITS,
    ...(customLimits || {}),
  };
  const maxSingleBytes = Number(limits.maxSinglePackageKB) * 1024;
  const maxTotalBytes = Number(limits.maxTotalPackageKB) * 1024;

  const rootDir = path.resolve(bundleDir);
  const appJsonPath = path.join(rootDir, 'app.json');

  if (!fs.existsSync(appJsonPath)) {
    return {
      ok: false,
      error: `Missing app.json in ${rootDir}. Ensure build finished or point to dist/dev/mp-weixin.`,
      limitsApplied: limits,
    };
  }

  let appConfig;
  try {
    appConfig = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      error: `Malformed app.json: ${err.message}`,
      limitsApplied: limits,
    };
  }

  const mainPages = Array.isArray(appConfig.pages) ? appConfig.pages : [];
  const rawSubs = appConfig.subPackages || appConfig.subpackages || [];
  const subPackages = rawSubs.map((sub) => ({
    root: String(sub.root || '').replace(/^\/+|\/+$/g, ''),
    name: sub.name || sub.root,
    pages: Array.isArray(sub.pages) ? sub.pages : [],
    independent: Boolean(sub.independent),
  }));

  const missingFiles = [];
  const emptyFiles = [];
  const validEmptyStyleFiles = [];
  const malformedJsonFiles = [];

  const allPageRoutes = [
    ...mainPages.map((p) => ({ pkg: 'main', route: p })),
    ...subPackages.flatMap((s) =>
      s.pages.map((p) => ({
        pkg: s.root,
        route: `${s.root}/${String(p).replace(/^\/+/, '')}`,
      }))
    ),
  ];

  for (const item of allPageRoutes) {
    const cleanRoute = item.route.replace(/^\/+/, '');
    // Required non-empty files for every page: .js and .wxml
    for (const ext of ['.js', '.wxml']) {
      const filePath = path.join(rootDir, `${cleanRoute}${ext}`);
      if (!fs.existsSync(filePath)) {
        missingFiles.push(`${cleanRoute}${ext}`);
      } else if (fs.statSync(filePath).size === 0) {
        emptyFiles.push(`${cleanRoute}${ext}`);
      }
    }

    // Optional .wxss: generators (uni-app/Taro) legitimately emit 0-byte .wxss for pages without custom styles
    const wxssPath = path.join(rootDir, `${cleanRoute}.wxss`);
    if (fs.existsSync(wxssPath) && fs.statSync(wxssPath).size === 0) {
      if (limits.allowEmptyStyles) {
        validEmptyStyleFiles.push(`${cleanRoute}.wxss`);
      } else {
        emptyFiles.push(`${cleanRoute}.wxss`);
      }
    }

    // Optional .json: if present, must be valid JSON (cannot be 0-byte truncated)
    const jsonPath = path.join(rootDir, `${cleanRoute}.json`);
    if (fs.existsSync(jsonPath)) {
      const size = fs.statSync(jsonPath).size;
      if (size === 0) {
        emptyFiles.push(`${cleanRoute}.json`);
      } else {
        try {
          JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        } catch {
          malformedJsonFiles.push(`${cleanRoute}.json`);
        }
      }
    }
  }

  const subRoots = subPackages.map((s) => path.join(rootDir, s.root));

  function getDirBytes(dirPath, excludeDirs = []) {
    if (!fs.existsSync(dirPath)) return 0;
    let total = 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dirPath, entry.name);
      if (excludeDirs.some((ex) => full === ex || full.startsWith(ex + path.sep))) {
        continue;
      }
      if (entry.isDirectory()) {
        total += getDirBytes(full, excludeDirs);
      } else if (entry.isFile()) {
        total += fs.statSync(full).size;
      }
    }
    return total;
  }

  const mainBytes = getDirBytes(rootDir, subRoots);
  const packageSizes = [
    {
      name: 'main (主包)',
      root: '/',
      bytes: mainBytes,
      kb: Number((mainBytes / 1024).toFixed(1)),
      limitKB: limits.maxSinglePackageKB,
      exceedsSingleLimit: mainBytes > maxSingleBytes,
      exceeds2MB: mainBytes > maxSingleBytes,
    },
    ...subPackages.map((s) => {
      const subDir = path.join(rootDir, s.root);
      const bytes = getDirBytes(subDir);
      return {
        name: `subpackage:${s.root}`,
        root: s.root,
        bytes,
        kb: Number((bytes / 1024).toFixed(1)),
        limitKB: limits.maxSinglePackageKB,
        exceedsSingleLimit: bytes > maxSingleBytes,
        exceeds2MB: bytes > maxSingleBytes,
      };
    }),
  ];

  const totalBytes = packageSizes.reduce((acc, p) => acc + p.bytes, 0);
  const oversizePackages = packageSizes.filter((p) => p.exceedsSingleLimit);

  const ok =
    missingFiles.length === 0 &&
    emptyFiles.length === 0 &&
    malformedJsonFiles.length === 0 &&
    oversizePackages.length === 0 &&
    totalBytes <= maxTotalBytes;

  return {
    ok,
    bundleDir: rootDir,
    limitsApplied: limits,
    registeredRoutes: allPageRoutes.map((r) => `/${r.route.replace(/^\/+/, '')}`),
    totalRoutesChecked: allPageRoutes.length,
    mainPageCount: mainPages.length,
    subPackageCount: subPackages.length,
    totalBundleKB: Number((totalBytes / 1024).toFixed(1)),
    exceedsTotalLimit: totalBytes > maxTotalBytes,
    exceeds20MBTotal: totalBytes > maxTotalBytes,
    packageSizes,
    missingFiles,
    emptyFiles,
    validEmptyStyleFiles,
    malformedJsonFiles,
    oversizePackages,
  };
}

// CLI entry point
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
) {
  const targetDir = process.argv[2] || '.';
  const asJson = process.argv.includes('--json');
  const report = checkMpBundle(targetDir);

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`=== Mini Program Bundle Integrity Report (${report.bundleDir || targetDir}) ===`);
    if (report.error) {
      console.error(`[FAIL] ${report.error}`);
      process.exit(1);
    }
    console.log(`Rule source    : ${report.limitsApplied.ruleSource}`);
    console.log(`Routes checked : ${report.totalRoutesChecked} (${report.mainPageCount} main, ${report.subPackageCount} subpackages)`);
    console.log(`Total size     : ${report.totalBundleKB} KB (Limit: ${report.limitsApplied.maxTotalPackageKB} KB)`);
    for (const pkg of report.packageSizes) {
      const status = pkg.exceedsSingleLimit ? `[OVER ${pkg.limitKB}KB LIMIT!]` : '[OK]';
      console.log(`  - ${pkg.name.padEnd(28)}: ${String(pkg.kb).padStart(8)} KB ${status}`);
    }
    if (report.missingFiles.length > 0) {
      console.error(`[MISSING FILES]:\n  ${report.missingFiles.join('\n  ')}`);
    }
    if (report.emptyFiles.length > 0) {
      console.error(`[EMPTY/TRUNCATED FILES]:\n  ${report.emptyFiles.join('\n  ')}`);
    }
    console.log(report.ok ? '[PASS] All Mini Program pages and subpackages verified intact.' : '[FAIL] Bundle verification failed.');
  }

  process.exit(report.ok ? 0 : 1);
}
