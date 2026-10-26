# fast-mp-inspector

**4-Layer Zero-Click E2E, MVVM Data, WXSS Layout/Occlusion & In-Page `wx.request` Verification Skill + Standard MCP Server for WeChat Mini Programs**

`fast-mp-inspector` provides both:
1. **Skill + CLI (`scripts/inspect-mp.mjs`, `scripts/check-mp-bundle.mjs`)**: Drop-in CLI workflow for Claude Code, Cursor, Antigravity, and terminal agents.
2. **Standard MCP Server (`mcp/server.mjs`)**: JSON-RPC 2.0 `stdio` Model Context Protocol server designed for **OpenMausBot** and MCP hosts, sharing the same core execution engine (`src/mp-core.mjs`).

---

## 1. Runtime Requirements & Reproducible Installation

- **Node.js**: `>= 18.18.0` (tested on Node 20/22 LTS)
- **WeChat DevTools**: Required for real simulator execution (`connect` / `launch`), with **Settings -> Security Settings -> Service Port** enabled. (Bundled fixture mode `connectionMode: "fixture"` runs offline in CI without DevTools).

```bash
git clone git@github.com:tomwu618/fast-mp-inspector.git
cd fast-mp-inspector
npm ci
```

### Uninstall

```bash
# Remove MCP configuration entry from your host config, then remove the directory:
rm -rf /path/to/fast-mp-inspector
```

---

## 2. OpenMausBot / MCP Host Configuration (`stdio`)

`mcp/server.mjs` strictly uses `stdout` for JSON-RPC 2.0 protocol frames and `stderr` for diagnostic logs. **Initializing the server and listing tools (`initialize`, `tools/list`) never launches WeChat DevTools or opens any ports.**

```json
{
  "mcpServers": {
    "fast-mp-inspector": {
      "command": "node",
      "args": [
        "/abs/path/to/fast-mp-inspector/mcp/server.mjs"
      ],
      "env": {
        "FAST_MP_PROJECT_ROOT": "/abs/path/to/miniprogram-project",
        "FAST_MP_EVIDENCE_DIR": "/abs/path/to/evidence-output",
        "FAST_MP_DEFAULT_WS_ENDPOINT": "ws://127.0.0.1:9420",
        "FAST_MP_ALLOWED_WS_HOSTS": "127.0.0.1,localhost",
        "FAST_MP_ALLOWED_API_ORIGINS": "https://api.example.local",
        "FAST_MP_DEFAULT_TIMEOUT_MS": "60000"
      }
    }
  }
}
```

---

## 3. MCP Tools & Capabilities

| Tool Name | Side Effects | Purpose |
|---|---|---|
| `mp_diagnose` | None by default (`probeConnection: false`) | Returns Node, `miniprogram-automator`, WeChat CLI binary status, project `app.json` / `project.config.json` checks, and remediation steps. |
| `mp_check_bundle` | Read-only static scan | Validates `app.json` routes, `mainPackage` / `subPackages` size limits (`limits` configurable), `ruleSource`, and `.wxss` syntax (supports `allowEmptyStyles: true` for 0-byte `.wxss`). |
| `mp_inspect` | Connects to simulator, writes evidence files | Runs 4-layer Mini Program inspection (Runtime errors, MVVM `page.data`, WXML/WXSS bounding boxes & occlusion, in-page `wx.request` capture, simulator PNG screenshot). |
| `mp_run_case` | Connects to simulator, executes steps & assertions (`allowWriteSideEffects` required for write steps) | Runs structured test cases with `caseId`, `acIds`, steps (`tap`, `input`, `call_method`, `set_data`, `relaunch`, `navigate_to`), and per-assertion verdicts (`route_matches`, `page_data_equals`, `wxml_text_contains`, `element_exists`, `not_occluded`, `wx_request_captured`). |
| `mp_job_status` | Read-only | Queries status or final report of an active/completed `jobId`. |
| `mp_cancel_job` | Cancels running job | Aborts an active `jobId`, restores `wx.request` hooks, and disconnects cleanly without killing user's WeChat DevTools. |

### Connection Modes (`connectionMode`)
- **`connect`** (Default): Connects to an already-running WeChat DevTools Automation WebSocket (`wsEndpoint`, e.g. `ws://127.0.0.1:9420`). Never closes the user's DevTools window on exit.
- **`launch`**: Launches/attaches via WeChat DevTools CLI (`cliPath`) and `projectPath`.
- **`fixture`**: Runs against the deterministic built-in Mini Program runtime simulator (`fixtures/sample-mp`) for CI and MCP protocol self-verification.

### Authentication & Privacy (`authRef`)
- Supports `storage_seed` (injecting storage keys via `wx.setStorageSync` + `reLaunch`), `password_login` (automated input/tap on login page), or `reuse_session` (verifying existing session and auto-falling back when redirected to login or receiving HTTP `401`).
- Credentials are passed by **environment variable reference** (`authRef`: e.g. `storageEnvVar`, `accountEnvVar`, `passwordEnvVar`) and are automatically redacted (`***REDACTED***`) from all `stdout` responses, logs, and JSON evidence reports.
- In-page `wx.request` interception captures real requests triggered by the Mini Program page (`requestId`, `url`, `method`, `statusCode`, redacted `responseBody`) and **guarantees restoration of the original `wx.request`** in a `finally` block.

---

## 4. CLI Usage (Preserved for Skill Workflows)

```bash
# Layer 1 Static Bundle & WXSS Check
node ./scripts/check-mp-bundle.mjs /path/to/mp-project

# Layer 2-4 Live Mini Program Inspection + Simulator Screenshot
node ./scripts/inspect-mp.mjs --connect ws://127.0.0.1:9420 --page /pages/index/index --screenshot ./mp-phone.png --report ./mp-report.json
```

---

## 5. Verification & Self-Test

Run the full verification suite (including CLI self-test, MCP `stdio` initialization, static bundle check with 0-byte `.wxss`, positive case `AC-MP-01`, and negative cases `AC-MP-02`):

```bash
npm test
```
