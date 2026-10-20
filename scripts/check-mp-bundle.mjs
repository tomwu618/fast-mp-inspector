#!/usr/bin/env node
/**
 * Layer 1: Static Mini Program Bundle & Subpackage Integrity Probe (check-mp-bundle.mjs)
 *
 * Works cross-platform (Windows / macOS / Linux) without WeChat DevTools.
 * Supports Native WeChat Mini Program, uni-app (dist/dev/mp-weixin), and Taro (dist/).
 *
 * Checks:
 * 1. app.json validity & route registration (pages + subPackages/subpackages)
 * 2. Existence and non-zero byte size of .js, .wxml, .wxss, .json for every registered route
 * 3. Main package & individual subpackage size limits (< 2MB per package, < 20MB total)
 *
 * Usage:
 *   node scripts/check-mp-bundle.mjs <mp-build-dir> [--json]
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_SINGLE_PKG_BYTES = 2 * 1024 * 1024; // 2MB WeChat limit
const MAX_TOTAL_PKG_BYTES = 20 * 1024 * 1024; // 20MB total limit

export function checkMpBundle(bundleDir) {
  const rootDir = path.resolve(bundleDir);
  const appJsonPath = path.join(rootDir, 'app.json');

  if (!fs.existsSync(appJsonPath)) {
    return {
      ok: false,
      error: `Missing app.json in ${rootDir}. Ensure build finished or point to dist/dev/mp-weixin.`,
    };
  }

  let appConfig;
  try {
    appConfig = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      error: `Malformed app.json: ${err.message}`,
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
  const requiredExts = ['.js', '.wxml'];
  const optionalExts = ['.wxss', '.json'];

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
    for (const ext of requiredExts) {
      const filePath = path.join(rootDir, `${cleanRoute}${ext}`);
      if (!fs.existsSync(filePath)) {
        missingFiles.push(`${cleanRoute}${ext}`);
      } else if (fs.statSync(filePath).size === 0) {
        emptyFiles.push(`${cleanRoute}${ext}`);
      }
    }
    for (const ext of optionalExts) {
      const filePath = path.join(rootDir, `${cleanRoute}${ext}`);
      if (fs.existsSync(filePath) && fs.statSync(filePath).size === 0) {
        emptyFiles.push(`${cleanRoute}${ext}`);
      }
    }
  }

  // Calculate directory sizes for main package vs each subpackage
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
      exceeds2MB: mainBytes > MAX_SINGLE_PKG_BYTES,
    },
    ...subPackages.map((s) => {
      const subDir = path.join(rootDir, s.root);
      const bytes = getDirBytes(subDir);
      return {
        name: `subpackage:${s.root}`,
        root: s.root,
        bytes,
        kb: Number((bytes / 1024).toFixed(1)),
        exceeds2MB: bytes > MAX_SINGLE_PKG_BYTES,
      };
    }),
  ];

  const totalBytes = packageSizes.reduce((acc, p) => acc + p.bytes, 0);
  const oversizePackages = packageSizes.filter((p) => p.exceeds2MB);

  const ok =
    missingFiles.length === 0 &&
    emptyFiles.length === 0 &&
    oversizePackages.length === 0 &&
    totalBytes <= MAX_TOTAL_PKG_BYTES;

  return {
    ok,
    bundleDir: rootDir,
    totalRoutesChecked: allPageRoutes.length,
    mainPageCount: mainPages.length,
    subPackageCount: subPackages.length,
    totalBundleKB: Number((totalBytes / 1024).toFixed(1)),
    exceeds20MBTotal: totalBytes > MAX_TOTAL_PKG_BYTES,
    packageSizes,
    missingFiles,
    emptyFiles,
    oversizePackages,
  };
}

// CLI entry point
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
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
    console.log(`Routes checked : ${report.totalRoutesChecked} (${report.mainPageCount} main, ${report.subPackageCount} subpackages)`);
    console.log(`Total size     : ${report.totalBundleKB} KB (Limit: 20,480 KB)`);
    for (const pkg of report.packageSizes) {
      const status = pkg.exceeds2MB ? '[OVER 2MB LIMIT!]' : '[OK]';
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
