import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const FIXTURE_MP_DIR = path.join(ROOT_DIR, 'fixtures', 'sample-mp');
const EVIDENCE_DIR = path.join(ROOT_DIR, '.tmp-mcp-evidence');

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

class McpClient {
  constructor(serverPath, env = {}) {
    this.proc = spawn(process.execPath, [serverPath], {
      cwd: ROOT_DIR,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.stderrLogs = [];

    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      let idx;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      }
    });

    this.proc.stderr.on('data', (chunk) => {
      this.stderrLogs.push(chunk.toString('utf8'));
    });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(payload);
    });
  }

  close() {
    this.proc.kill();
  }
}

async function main() {
  if (fs.existsSync(EVIDENCE_DIR)) {
    fs.rmSync(EVIDENCE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  const client = new McpClient(path.join(ROOT_DIR, 'mcp', 'server.mjs'), {
    FAST_MP_PROJECT_ROOT: FIXTURE_MP_DIR,
    FAST_MP_EVIDENCE_DIR: EVIDENCE_DIR
  });

  try {
    console.log('1. Testing MCP stdio initialize & tools/list (must not launch WeChat DevTools)...');
    const initRes = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'verify-mcp-mp', version: '1.0.0' }
    });
    assert(initRes.serverInfo.name === 'fast-mp-inspector-mcp', `Server name mismatch: ${initRes.serverInfo.name}`);

    const listRes = await client.request('tools/list');
    const toolNames = listRes.tools.map((t) => t.name);
    console.log('   Tools registered:', toolNames.join(', '));
    for (const expected of ['mp_diagnose', 'mp_check_bundle', 'mp_inspect', 'mp_run_case', 'mp_job_status', 'mp_cancel_job']) {
      assert(toolNames.includes(expected), `Missing tool: ${expected}`);
    }

    console.log('2. Testing mp_diagnose (static mode, zero DevTools launch)...');
    const diagCall = await client.request('tools/call', {
      name: 'mp_diagnose',
      arguments: {
        projectPath: FIXTURE_MP_DIR
      }
    });
    const diagPayload = diagCall.structuredContent;
    assert(diagPayload.data.appJsonFound === true, 'mp_diagnose should detect app.json');
    assert(diagPayload.data.devToolsLaunched === false, 'mp_diagnose must not launch DevTools');
    assert(diagPayload.data.automatorVersion !== 'not-installed', 'mp_diagnose should detect miniprogram-automator');
    console.log('   mp_diagnose status:', diagPayload.status, '| Engine:', diagPayload.engineVersion);

    console.log('3. Testing mp_check_bundle (including 0-byte .wxss tolerance and configurable limits)...');
    const indexWxssPath = path.join(FIXTURE_MP_DIR, 'pages', 'index', 'index.wxss');
    const originalWxss = fs.readFileSync(indexWxssPath, 'utf8');
    // Temporarily write 0-byte .wxss to verify allowEmptyStyles: true
    fs.writeFileSync(indexWxssPath, '');
    try {
      const bundleCall = await client.request('tools/call', {
        name: 'mp_check_bundle',
        arguments: {
          bundleDir: FIXTURE_MP_DIR,
          limits: {
            maxSinglePackageKB: 2048,
            maxTotalPackageKB: 20480,
            ruleSource: 'verify-mcp-custom-rule',
            allowEmptyStyles: true
          }
        }
      });
      const bundlePayload = bundleCall.structuredContent;
      assert(bundlePayload.status === 'PASS', `Expected bundle check PASS with 0-byte wxss, got ${bundlePayload.status}`);
      assert(bundlePayload.data.limitsApplied.ruleSource === 'verify-mcp-custom-rule', 'ruleSource should match custom value');
      assert(bundlePayload.data.validEmptyStyleFiles.length >= 1, 'Should record valid 0-byte .wxss file');
      console.log('   mp_check_bundle status:', bundlePayload.status, '| Valid empty .wxss:', bundlePayload.data.validEmptyStyleFiles.length);
    } finally {
      fs.writeFileSync(indexWxssPath, originalWxss);
    }

    console.log('4. Testing Positive Acceptance Case AC-MP-01 via mp_run_case...');
    const posCall = await client.request('tools/call', {
      name: 'mp_run_case',
      arguments: {
        caseId: 'CASE-MP-ORDER-POSITIVE',
        acIds: ['AC-MP-01'],
        connection: {
          mode: 'fixture',
          projectPath: FIXTURE_MP_DIR
        },
        route: '/subpages/order/detail?id=1001',
        bounceRoute: '/pages/index/index',
        captureApiPattern: '/api/v1/orders/1001',
        evidenceDir: EVIDENCE_DIR,
        steps: [
          {
            stepId: 'step-tap-toggle-urgent',
            action: 'tap',
            selector: '#toggle-urgent-btn'
          },
          {
            stepId: 'step-inspect-geometry',
            action: 'inspect_geometry',
            parentSelector: '.page-container',
            targetSelector: '.detail-card',
            occludeSelector: '.action-dropdown'
          }
        ],
        assertions: [
          {
            id: 'assert-page-data-order-no',
            type: 'page_data',
            path: 'detailData.orderNo',
            expected: 'ORD-2026-1001'
          },
          {
            id: 'assert-page-data-urgent-toggled',
            type: 'page_data',
            path: 'detailData.showUrgentReason',
            expected: true
          },
          {
            id: 'assert-rendered-order-no',
            type: 'rendered_text',
            selector: '.order-no',
            expected: 'ORD-2026-1001'
          },
          {
            id: 'assert-conditional-node-visible',
            type: 'element_exists',
            selector: '.urgent-reason-box',
            expected: true
          },
          {
            id: 'assert-layout-gap',
            type: 'layout_gap',
            selector: '.detail-card',
            parentSelector: '.page-container',
            maxGapPx: 24
          },
          {
            id: 'assert-no-potential-occlusion',
            type: 'potential_occlusion',
            selector: '.action-dropdown',
            expected: false
          },
          {
            id: 'assert-inpage-wx-request-status',
            type: 'captured_request_status',
            urlPattern: '/api/v1/orders/1001',
            expected: 200
          },
          {
            id: 'assert-inpage-wx-request-field',
            type: 'captured_request_field',
            urlPattern: '/api/v1/orders/1001',
            fieldPath: 'orderNo',
            expected: 'ORD-2026-1001'
          }
        ]
      }
    });
    const posResult = posCall.structuredContent;
    console.log('   AC-MP-01 status:', posResult.status, `(${posResult.verificationSummary.passedAssertions}/${posResult.verificationSummary.totalAssertions} assertions passed in ${posResult.durationMs}ms)`);
    assert(posResult.status === 'PASS', `AC-MP-01 should PASS, got ${posResult.status}: ${JSON.stringify(posResult.assertions)}`);
    assert(posResult.evidence.length >= 2, 'Expected screenshot, wx-request log, and report evidence');
    // Check secret redaction in network summary
    const serializedPos = JSON.stringify(posResult);
    assert(!serializedPos.includes('should-be-redacted'), 'Secret token must be redacted in network capture');

    console.log('5. Testing Negative Acceptance Cases AC-MP-02 (missing route, connection failure, uncaptured request, potential occlusion)...');
    // 5a: Missing route
    const negRouteCall = await client.request('tools/call', {
      name: 'mp_run_case',
      arguments: {
        caseId: 'CASE-MP-NEG-ROUTE',
        acIds: ['AC-MP-02'],
        connection: {
          mode: 'fixture',
          projectPath: FIXTURE_MP_DIR
        },
        steps: [
          {
            stepId: 'step-bad-route',
            action: 'relaunch',
            route: '/subpages/order/does-not-exist'
          }
        ],
        evidenceDir: EVIDENCE_DIR
      }
    });
    const negRouteRes = negRouteCall.structuredContent;
    console.log('   AC-MP-02 (Missing route) status:', negRouteRes.status, '| Error code:', negRouteRes.errors[0]?.code);
    assert(negRouteRes.status === 'ERROR', 'Missing route should return ERROR');
    assert(negRouteRes.errors[0]?.code === 'ROUTE_NOT_FOUND', 'Expected ROUTE_NOT_FOUND code');

    // 5b: Connection failure on invalid wsEndpoint
    const negConnCall = await client.request('tools/call', {
      name: 'mp_run_case',
      arguments: {
        caseId: 'CASE-MP-NEG-CONN',
        acIds: ['AC-MP-02'],
        connection: {
          mode: 'connect',
          wsEndpoint: 'ws://127.0.0.1:59999'
        },
        steps: [
          {
            stepId: 'step-noop',
            action: 'relaunch',
            route: '/pages/index/index'
          }
        ],
        evidenceDir: EVIDENCE_DIR,
        timeoutMs: 5000
      }
    });
    const negConnRes = negConnCall.structuredContent;
    console.log('   AC-MP-02 (Connection failure) status:', negConnRes.status, '| Category:', negConnRes.errors[0]?.category);
    assert(negConnRes.status === 'ERROR', 'Unreachable wsEndpoint should return ERROR');
    assert(negConnRes.errors[0]?.category === 'connection', 'Error category should be connection');

    // 5c: Uncaptured request + potential occlusion
    const negAssertCall = await client.request('tools/call', {
      name: 'mp_run_case',
      arguments: {
        caseId: 'CASE-MP-NEG-ASSERTIONS',
        acIds: ['AC-MP-02'],
        connection: {
          mode: 'fixture',
          projectPath: FIXTURE_MP_DIR
        },
        route: '/subpages/order/detail?id=1001',
        captureApiPattern: '/api/v1/orders/1001',
        evidenceDir: EVIDENCE_DIR,
        steps: [
          {
            stepId: 'step-enable-occluder',
            action: 'tap',
            selector: '#enable-occluder-btn'
          }
        ],
        assertions: [
          {
            id: 'assert-uncaptured-api',
            type: 'captured_request_status',
            urlPattern: '/api/v1/mp/never-sent-endpoint',
            expected: 200
          },
          {
            id: 'assert-occluded-fails',
            type: 'potential_occlusion',
            selector: '.action-dropdown',
            expected: false
          }
        ]
      }
    });
    const negAssertRes = negAssertCall.structuredContent;
    console.log('   AC-MP-02 (Uncaptured request & occlusion) status:', negAssertRes.status, `(${negAssertRes.verificationSummary.failedAssertions} expected failures)`);
    assert(negAssertRes.status === 'FAIL', 'Expected FAIL status for uncaptured request & occlusion');
    assert(negAssertRes.verificationSummary.failedAssertions === 2, 'Both negative assertions must fail');

    console.log('\nALL MCP VERIFICATION TESTS PASSED FOR fast-mp-inspector!');
  } finally {
    client.close();
    if (fs.existsSync(EVIDENCE_DIR)) {
      fs.rmSync(EVIDENCE_DIR, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
