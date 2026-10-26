/**
 * Standard Model Context Protocol (MCP) Stdio Server Engine (src/mcp-stdio.mjs)
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export class McpStdioServer {
  constructor({ name, version, tools = [], resourceValidator = null }) {
    this.name = name;
    this.version = version;
    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.resourceValidator = resourceValidator;
    this.activeRequests = new Map();
    this.evidenceRegistry = new Map();
    this.framingMode = 'line';
  }

  registerEvidenceResources(evidenceList = []) {
    for (const ev of evidenceList) {
      if (ev && ev.resourceUri && ev.path) {
        this.evidenceRegistry.set(ev.resourceUri, {
          uri: ev.resourceUri,
          name: `${ev.stepId || 'evidence'}-${ev.id}`,
          mimeType: ev.mimeType || 'application/octet-stream',
          path: ev.path,
        });
      }
    }
  }

  logStderr(msg) {
    process.stderr.write(`[${this.name}] ${msg}\n`);
  }

  sendMessage(payload) {
    const json = JSON.stringify(payload);
    if (this.framingMode === 'content-length') {
      const byteLen = Buffer.byteLength(json, 'utf8');
      process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
    } else {
      process.stdout.write(`${json}\n`);
    }
  }

  sendResult(id, result) {
    this.sendMessage({ jsonrpc: '2.0', id, result });
  }

  sendError(id, code, message, data = undefined) {
    this.sendMessage({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    });
  }

  async handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.id === undefined || msg.id === null) {
      if (msg.method === 'notifications/cancelled') {
        const targetId = msg.params?.requestId;
        const controller = this.activeRequests.get(targetId);
        if (controller) {
          controller.abort(new Error(msg.params?.reason || 'Cancelled by MCP client'));
          this.activeRequests.delete(targetId);
        }
      }
      return;
    }

    const { id, method, params } = msg;

    try {
      switch (method) {
        case 'initialize': {
          const clientProtocol = params?.protocolVersion || '2024-11-05';
          this.sendResult(id, {
            protocolVersion: clientProtocol,
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
            },
            serverInfo: {
              name: this.name,
              version: this.version,
            },
          });
          return;
        }

        case 'ping': {
          this.sendResult(id, {});
          return;
        }

        case 'tools/list': {
          const toolDefinitions = Array.from(this.tools.values()).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: t.annotations || {},
          }));
          this.sendResult(id, { tools: toolDefinitions });
          return;
        }

        case 'tools/call': {
          const toolName = params?.name;
          const toolArgs = params?.arguments || {};
          const tool = this.tools.get(toolName);

          if (!tool) {
            this.sendError(id, -32601, `Unknown tool: "${toolName}"`);
            return;
          }

          const abortController = new AbortController();
          this.activeRequests.set(id, abortController);

          try {
            const callOutput = await tool.handler(toolArgs, {
              signal: abortController.signal,
              requestId: id,
              server: this,
            });

            if (Array.isArray(callOutput?.envelope?.evidence)) {
              this.registerEvidenceResources(callOutput.envelope.evidence);
            }

            const contentBlocks = [
              {
                type: 'text',
                text: JSON.stringify(callOutput.envelope ?? callOutput, null, 2),
              },
            ];

            if (callOutput?.imageAttachment?.base64 && callOutput?.imageAttachment?.mimeType) {
              contentBlocks.push({
                type: 'image',
                data: callOutput.imageAttachment.base64,
                mimeType: callOutput.imageAttachment.mimeType,
              });
            }

            this.sendResult(id, {
              content: contentBlocks,
              structuredContent: callOutput.envelope ?? callOutput,
              isError: callOutput?.envelope?.status === 'ERROR' || callOutput?.envelope?.status === 'UNSUPPORTED',
            });
          } finally {
            this.activeRequests.delete(id);
          }
          return;
        }

        case 'resources/list': {
          const resources = Array.from(this.evidenceRegistry.values()).map((r) => ({
            uri: r.uri,
            name: r.name,
            mimeType: r.mimeType,
          }));
          this.sendResult(id, { resources });
          return;
        }

        case 'resources/read': {
          const uri = params?.uri;
          if (!uri) {
            this.sendError(id, -32602, 'Missing resource uri parameter');
            return;
          }
          let filePath = this.evidenceRegistry.get(uri)?.path;
          let mimeType = this.evidenceRegistry.get(uri)?.mimeType || 'application/octet-stream';

          if (!filePath && uri.startsWith('file://')) {
            filePath = fileURLToPath(uri);
            if (filePath.endsWith('.png')) mimeType = 'image/png';
            else if (filePath.endsWith('.json')) mimeType = 'application/json';
            else if (filePath.endsWith('.md')) mimeType = 'text/markdown';
          }

          if (!filePath || !fs.existsSync(filePath)) {
            this.sendError(id, -32002, `Resource not found: ${uri}`);
            return;
          }

          if (this.resourceValidator) {
            this.resourceValidator(filePath);
          }

          const buf = fs.readFileSync(filePath);
          if (mimeType.startsWith('text/') || mimeType === 'application/json') {
            this.sendResult(id, {
              contents: [{ uri, mimeType, text: buf.toString('utf8') }],
            });
          } else {
            this.sendResult(id, {
              contents: [{ uri, mimeType, blob: buf.toString('base64') }],
            });
          }
          return;
        }

        default: {
          this.sendError(id, -32601, `Method not found: ${method}`);
        }
      }
    } catch (err) {
      this.sendError(id, -32603, err?.message || String(err));
    }
  }

  start() {
    console.log = (...args) => this.logStderr(args.join(' '));
    console.info = (...args) => this.logStderr(args.join(' '));
    console.warn = (...args) => this.logStderr(args.join(' '));

    let buffer = Buffer.alloc(0);

    process.stdin.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);

      while (buffer.length > 0) {
        const strPreview = buffer.toString('utf8', 0, Math.min(buffer.length, 64));
        if (strPreview.startsWith('Content-Length:')) {
          this.framingMode = 'content-length';
          const headerEnd = buffer.indexOf('\r\n\r\n');
          if (headerEnd === -1) break;
          const headerText = buffer.toString('utf8', 0, headerEnd);
          const match = headerText.match(/Content-Length:\s*(\d+)/i);
          if (!match) {
            buffer = buffer.subarray(headerEnd + 4);
            continue;
          }
          const contentLen = Number(match[1]);
          const bodyStart = headerEnd + 4;
          if (buffer.length < bodyStart + contentLen) break;
          const bodyText = buffer.toString('utf8', bodyStart, bodyStart + contentLen);
          buffer = buffer.subarray(bodyStart + contentLen);
          try {
            const parsed = JSON.parse(bodyText);
            this.handleMessage(parsed);
          } catch (e) {
            this.logStderr(`Failed to parse Content-Length JSON-RPC message: ${e.message}`);
          }
        } else {
          const newlineIdx = buffer.indexOf(0x0a);
          if (newlineIdx === -1) break;
          const line = buffer.toString('utf8', 0, newlineIdx).trim();
          buffer = buffer.subarray(newlineIdx + 1);
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            this.handleMessage(parsed);
          } catch (e) {
            this.logStderr(`Failed to parse line JSON-RPC message: ${e.message}`);
          }
        }
      }
    });

    process.stdin.on('end', () => {
      for (const controller of this.activeRequests.values()) {
        controller.abort(new Error('MCP stdio stream closed'));
      }
      this.activeRequests.clear();
    });
  }
}
