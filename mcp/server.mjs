#!/usr/bin/env node
/**
 * MCP Stdio Server Entrypoint for fast-mp-inspector (mcp/server.mjs)
 *
 * Exposes:
 * - mp_diagnose
 * - mp_check_bundle
 * - mp_inspect
 * - mp_run_case
 * - mp_job_status
 * - mp_cancel_job
 *
 * Strictly adheres to MCP Integration Spec v1:
 * - stdout outputs ONLY JSON-RPC 2.0 messages.
 * - initialize and tools/list NEVER launch WeChat DevTools.
 */

import {
  TOOL_VERSION,
  buildResponseEnvelope,
  createStructuredError,
  generateRunId,
  validateSafePath,
} from '../src/common.mjs';
import { McpStdioServer } from '../src/mcp-stdio.mjs';
import {
  activeMpJobs,
  runMpCheckBundle,
  runMpDiagnose,
  runMpExecution,
} from '../src/mp-core.mjs';

export const MP_MCP_TOOLS = [
  {
    name: 'mp_diagnose',
    description:
      'Static diagnostic check for Node.js, miniprogram-automator, WeChat DevTools CLI executable, project app.json existence, and WebSocket automation port reachability. Default: ZERO DevTools launch side effects.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      sideEffectsNote: 'Purely static environment and TCP port check. Never launches WeChat DevTools.',
    },
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'Optional Mini Program project or compiled dist directory to validate.' },
        wsEndpoint: { type: 'string', description: 'Optional WebSocket endpoint (e.g. ws://127.0.0.1:9420) to probe.' },
        cliPath: { type: 'string', description: 'Optional path to WeChat DevTools CLI.' },
        caseId: { type: 'string', default: 'mp_diagnose' },
        acIds: { type: 'array', items: { type: 'string' }, default: [] },
      },
      additionalProperties: false,
    },
    handler: async (args) => await runMpDiagnose(args),
  },
  {
    name: 'mp_check_bundle',
    description:
      'Layer 1 static Mini Program bundle and subpackage integrity validator. Verifies app.json main/subpackage route files (.js, .wxml, .wxss, .json), distinguishes valid generator-emitted empty .wxss styles from truncated files, and checks configurable package size limits with explicit ruleSource.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      sideEffectsNote: 'Reads local compiled Mini Program directory only. Never launches WeChat DevTools.',
    },
    inputSchema: {
      type: 'object',
      required: ['bundleDir'],
      properties: {
        bundleDir: {
          type: 'string',
          description: 'Path to compiled Mini Program directory containing app.json (e.g. ./dist/dev/mp-weixin).',
        },
        limits: {
          type: 'object',
          properties: {
            maxSinglePackageKB: { type: 'number', default: 2048 },
            maxTotalPackageKB: { type: 'number', default: 20480 },
            ruleSource: {
              type: 'string',
              default: 'WeChat Mini Program Official Specification (2048 KB single package / 20480 KB total subpackages)',
            },
            allowEmptyStyles: {
              type: 'boolean',
              default: true,
              description: 'Allow 0-byte .wxss files emitted by uni-app / Taro for pages without custom styles.',
            },
          },
        },
        caseId: { type: 'string', default: 'mp_check_bundle' },
        acIds: { type: 'array', items: { type: 'string' }, default: [] },
      },
      additionalProperties: false,
    },
    handler: async (args) => await runMpCheckBundle(args),
  },
  {
    name: 'mp_inspect',
    description:
      'Inspect a WeChat Mini Program page via explicit connection mode ("connect" to existing DevTools port, "launch" controlled DevTools for an explicit project, or "fixture"). Reads AppService Page.data, WXML rendered text, SelectorQuery NodesRef.fields geometry (px & rpx), potential AABB+zIndex occlusion evidence, in-page wx.request responses (restoring hook on exit), and simulator screenshot.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      sideEffectsNote:
        'Navigates to target route inside Mini Program simulator and installs/restores temporary wx.request tap in AppService. Never closes user-owned DevTools processes.',
    },
    inputSchema: {
      type: 'object',
      required: ['connection'],
      properties: {
        connection: {
          type: 'object',
          required: ['mode'],
          properties: {
            mode: {
              type: 'string',
              enum: ['connect', 'launch', 'fixture'],
              description: '"connect" attaches to running wsEndpoint; "launch" starts controlled DevTools for projectPath; "fixture" runs against bundled local fixture.',
            },
            wsEndpoint: { type: 'string', description: 'WebSocket endpoint when mode="connect" (e.g. ws://127.0.0.1:9420).' },
            projectPath: { type: 'string', description: 'Mini Program project path when mode="launch" or "fixture".' },
            cliPath: { type: 'string', description: 'Optional WeChat DevTools CLI executable path.' },
          },
        },
        caseId: { type: 'string', default: 'mp_inspect' },
        acIds: { type: 'array', items: { type: 'string' }, default: [] },
        route: { type: 'string', description: 'Target main or subpackage route (e.g. /subpages/order/detail?id=1001).' },
        bounceRoute: {
          type: 'string',
          description: 'Optional route (e.g. /pages/index/index) to navigate to before entering target route so page onLoad network requests fire fresh.',
        },
        authRef: {
          type: 'string',
          description: 'Credential reference alias (resolves from FAST_MP_AUTH_<ALIAS> env var or .auth-cache/<alias>.state.json). Recorded as test injection.',
        },
        dataPaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'AppService Page.data dot-paths to read (e.g. ["detailData", "detailData.status"]).',
        },
        selectors: {
          type: 'object',
          properties: {
            parent: { type: 'string', default: '.page-container' },
            target: { type: 'string' },
            occlude: { type: 'string' },
            occluders: { type: 'string', default: '.fixed-bar, .custom-nav, .tab-bar, .modal-mask, .sticky-col, .fixed-footer' },
            readText: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Map of label -> WXML selector to read rendered element text.',
            },
          },
        },
        captureApiPattern: {
          type: ['string', 'array'],
          description: 'URL substring(s) to capture from live in-page wx.request calls.',
        },
        assertions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['type'],
            properties: {
              id: { type: 'string' },
              type: {
                type: 'string',
                enum: [
                  'page_data',
                  'rendered_text',
                  'element_exists',
                  'element_hidden',
                  'layout_gap',
                  'potential_occlusion',
                  'captured_request_status',
                  'captured_request_field',
                ],
              },
              selector: { type: 'string' },
              path: { type: 'string' },
              urlPattern: { type: 'string' },
              fieldPath: { type: 'string' },
              parentSelector: { type: 'string' },
              maxGapPx: { type: 'number' },
              requireExactHitTestProof: { type: 'boolean' },
              expected: {},
            },
          },
        },
        redactFields: { type: 'array', items: { type: 'string' } },
        evidenceDir: { type: 'string' },
        screenshot: { type: ['boolean', 'string'], default: true },
        returnImageBase64: { type: 'boolean', default: false },
        timeoutMs: { type: 'integer', default: 60000 },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => await runMpExecution(args, ctx),
  },
  {
    name: 'mp_run_case',
    description:
      'Execute a stateful Mini Program E2E test case with caseId/acIds, route transitions (relaunch, navigate_to), interactions (tap, input, call_method), live in-page wx.request capture & restoration, and per-assertion verification. Note: May send write requests if steps tap submit buttons or invoke submit methods; restrict write operations to authorized test accounts and environments.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
      sideEffectsNote:
        'Executes interactive WXML taps, inputs, or Page methods that may trigger backend wx.request writes. Restrict write steps to authorized test accounts and targets.',
    },
    inputSchema: {
      type: 'object',
      required: ['caseId', 'connection', 'steps'],
      properties: {
        caseId: { type: 'string' },
        acIds: { type: 'array', items: { type: 'string' }, default: [] },
        connection: {
          type: 'object',
          required: ['mode'],
          properties: {
            mode: { type: 'string', enum: ['connect', 'launch', 'fixture'] },
            wsEndpoint: { type: 'string' },
            projectPath: { type: 'string' },
            cliPath: { type: 'string' },
          },
        },
        route: { type: 'string' },
        bounceRoute: { type: 'string' },
        authRef: { type: 'string' },
        captureApiPattern: { type: ['string', 'array'] },
        dataPaths: { type: 'array', items: { type: 'string' } },
        selectors: { type: 'object' },
        steps: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['action'],
            properties: {
              stepId: { type: 'string' },
              action: {
                type: 'string',
                enum: [
                  'start_request_capture',
                  'collect_request_capture',
                  'relaunch',
                  'navigate_to',
                  'tap',
                  'input',
                  'call_method',
                  'inspect_geometry',
                  'assert',
                ],
              },
              route: { type: 'string' },
              selector: { type: 'string' },
              value: {},
              methodName: { type: 'string' },
              args: { type: 'array' },
              urlPattern: { type: ['string', 'array'] },
              parentSelector: { type: 'string' },
              targetSelector: { type: 'string' },
              occludeSelector: { type: 'string' },
              occludersSelector: { type: 'string' },
              assertion: { type: 'object' },
              id: { type: 'string' },
              type: { type: 'string' },
              path: { type: 'string' },
              fieldPath: { type: 'string' },
              expected: {},
              maxGapPx: { type: 'number' },
              requireExactHitTestProof: { type: 'boolean' },
              waitMs: { type: 'integer' },
            },
          },
        },
        assertions: { type: 'array', items: { type: 'object' } },
        redactFields: { type: 'array', items: { type: 'string' } },
        evidenceDir: { type: 'string' },
        screenshot: { type: ['boolean', 'string'], default: true },
        returnImageBase64: { type: 'boolean', default: false },
        timeoutMs: { type: 'integer', default: 60000 },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => await runMpExecution(args, ctx),
  },
  {
    name: 'mp_job_status',
    description: 'Query status and result envelope of a running or completed Mini Program run by runId.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      required: ['runId'],
      properties: { runId: { type: 'string' } },
      additionalProperties: false,
    },
    handler: async (args) => {
      const job = activeMpJobs.get(args.runId);
      if (!job) {
        return {
          envelope: buildResponseEnvelope({
            runId: args.runId,
            caseId: 'mp_job_status',
            errors: [
              createStructuredError({
                code: 'JOB_NOT_FOUND',
                category: 'internal',
                stage: 'job-lookup',
                message: `No job found with runId "${args.runId}"`,
              }),
            ],
          }),
        };
      }
      if (job.envelope) return { envelope: job.envelope };
      return {
        envelope: buildResponseEnvelope({
          runId: job.runId,
          caseId: job.caseId,
          data: { jobStatus: job.status, startedAt: job.startedAt },
        }),
      };
    },
  },
  {
    name: 'mp_cancel_job',
    description: 'Cancel an active Mini Program run by runId and clean up any owned session.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      required: ['runId'],
      properties: { runId: { type: 'string' } },
      additionalProperties: false,
    },
    handler: async (args) => {
      const job = activeMpJobs.get(args.runId);
      if (job && typeof job.cancel === 'function') {
        job.cancel();
        return {
          envelope: buildResponseEnvelope({
            runId: args.runId,
            caseId: job.caseId || 'mp_cancel_job',
            cancelled: true,
            data: { cancelled: true },
          }),
        };
      }
      return {
        envelope: buildResponseEnvelope({
          runId: generateRunId('mp_cancel'),
          caseId: 'mp_cancel_job',
          data: { cancelled: false, reason: 'Job not active or already finished' },
        }),
      };
    },
  },
];

export function createMpMcpServer() {
  return new McpStdioServer({
    name: 'fast-mp-inspector-mcp',
    version: TOOL_VERSION,
    tools: MP_MCP_TOOLS,
    resourceValidator: (filePath) => validateSafePath(filePath, [], 'resource-read'),
  });
}

const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

if (isMain) {
  const server = createMpMcpServer();
  server.start();
}
