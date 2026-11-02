# Local Request Inspector Guide

When an AI agent explores an API, authenticates, and executes requests on your behalf, chat messages only show what the model chose to summarize. The **Local Request Inspector** gives you an independent, read-only browser view of what your MCP server process actually executed.

Use it to review and verify agent behavior:

- **Confirm what was sent (and what wasn't)** — See every MCP tool call paired with the HTTP requests, redirect hops, and background auth/refresh exchanges it triggered. Offline checks like `preview_operation` appear as tool calls with zero HTTP traffic.
- **Audit real payloads and responses** — Inspect recorded URLs, query parameters, headers, cookies, request bodies, and responses side-by-side in formatted, plain-text, or raw hex views.
- **Spot contract mismatches & errors** — Filter straight to blocked calls, 4xx/5xx responses, or schema diagnostics without digging through chat logs.
- **Reproduce calls safely** — Copy payloads, URLs, or generated `curl` commands while configured credentials stay masked as placeholders.

The MCP connection itself still runs over `stdio`. When enabled, the Inspector starts a separate local HTTP server bound strictly to loopback (`127.0.0.1` or `::1`). It never sends API requests or executes copied `curl` commands.

---

## 1. Enable the Inspector

Add the top-level `inspector` block to your API configuration file:

```yaml
inspector:
  enabled: true
  port: 0

services:
  orders:
    baseUrl: http://localhost:8080/api/v1
    spec: http://localhost:8080/v3/api-docs
```

- The Inspector is disabled by default (`enabled: false`).
- `port: 0` picks an unused loopback port per MCP process so multiple sessions never collide.
- Reconnect or restart the MCP server in your client after editing the config.
- **Session cleanup:** Normal MCP shutdown removes the session's trace and artifacts (and stops its Inspector UI). To keep session files on disk after exit for manual inspection, set `files.retention.keepOnExit: true` in your config (see [Configuration Guide](configuration.md#file-roots-and-session-retention)).

---

## 2. Open the URL for your active session

Multiple MCP clients or windows can use the same config file at the same time, each running its own process and session ID (`s-...`).

### Step A — Get the session ID from your assistant

Ask the assistant connected to the MCP server:

> Call `list_apis` and show `session.sessionId`, `session.inspector.state`, and `session.inspector.urlCommand`. Do not run the command.

*(The same secret-free session metadata is also included in MCP initialization instructions and logged to `stderr` at startup.)*

### Step B — Resolve the browser URL in your local terminal

When `session.inspector.state` is `running`, run the exact command from `urlCommand`—or pass `--inspector-url --session <id>` yourself—in a **local terminal**:

```bash
npx -y @nhan7777/openapi-swagger-mcp@0.1.5 \
  --config /absolute/path/config.dev.yaml \
  --inspector-url --session <session-id>
```

Open the printed URL in a browser on the same machine (or via an explicit SSH/local port forward).

- **Keep the URL out of chat, logs, and screenshots.** Its `#t=...` URL fragment holds the session's access token (read from the mode-`0600` `inspector.json` descriptor). Never ask the AI agent to run `--inspector-url` for you.
- `--inspector-url` does not start a server or modify session files; it only looks up a live Inspector.
- Omitting `--session` lists URLs for **all** live Inspectors sharing that config. When running multiple agent windows, always pass `--session <session-id>` so you open the right window's timeline; an unknown or stopped session exits `1` with `INSPECTOR_NOT_RUNNING` rather than falling back to another session.

---

## 3. Reviewing an agent run

1. **Follow the live timeline**
   - As your agent works, tool actions appear automatically with their linked HTTP requests, redirects, and authentication runs nested underneath.
   - Use **Pause** to freeze live updates while reading a busy run, and **Resume** to catch up. Use **Auto / Light / Dark** to switch themes.
2. **Filter across session history**
   - Switch quick views between **All Activity**, **Tools Only**, **API Requests Only**, and **Errors & Blocked**.
   - Search or filter by service, purpose, send state (`not_sent`, `maybe_sent`, `response_received`), or HTTP status. Filters scan across retained session history, not just the currently visible page; click **Load older records** to page further back.
3. **Inspect tool calls vs. HTTP exchanges**
   - Click a **tool row** to inspect recorded arguments, summary status, and linked exchanges (plus **Copy Target**, **Copy Args**, and **Copy Summary**).
   - Click an **HTTP row** to open the side-by-side **Request + Response** workbench showing status, timing, headers, query parameters, cookies, and body pages.
4. **Compare body representations**
   - Switch between **Formatted (derived)**, **Text (derived)**, and **Raw (hex)** (exact stored bytes).
   - Pay attention to inline viewer banners when a body was truncated by size limits or reformatted for display.
5. **Copy data or generate cURL**
   - **Copy URL**, **Copy Path**, and **Copy Domain** (`scheme://host:port`) copy recorded target details with masked query secrets preserved as placeholders.
   - **Copy Request Body** / **Copy Response Body** copy the full stored payload across pages without viewer chrome (check incomplete-body warnings first).
   - Open the **cURL** tab to generate a command for that exchange and click **Copy cURL**. Always review credential placeholders and target URLs before running it yourself.

### What is intentionally masked or omitted

- **Configured secrets stay hidden:** Credentials injected from `auth` configs, profiles, sessions, or the cookie jar are recorded by binding name only—never by value.
- **Auth recipe requests:** Request bodies built from login/refresh secret templates and auth response header values are omitted from the trace; raw auth response bodies are stored locally (mode `0600`) to aid login debugging, so treat them carefully.
- **Agent-typed secrets:** If you or the agent explicitly type a token into normal tool `input` fields, it is recorded as user input—avoid pasting secrets into chat.

---

## 4. Troubleshooting

| Symptom | Cause & fix |
|---|---|
| `INSPECTOR_DISABLED` / state `disabled` | Add `inspector: { enabled: true, port: 0 }` to the exact config file used by the MCP client, then reconnect the server. |
| `INSPECTOR_NOT_RUNNING` | The MCP server isn't running yet, has already exited, or the `--session` ID belongs to an ended/different config. Reconnect and fetch a fresh `sessionId` via `list_apis`. |
| State `unavailable` | The loopback port failed to bind (for example, a fixed port was already in use). Check `stderr` logs and use `port: 0`. MCP tools still work even when the Inspector cannot bind. |
| Empty timeline or wrong agent activity | Compare the session ID in the Inspector header with `session.sessionId` from `list_apis` in your intended chat window, and clear active timeline filters. Check that `trace.enabled` is not set to `false`. |
| Missing body or masked header/cookie | Check the exchange's availability banner. Server-injected credentials, oversized bodies (`requestBodyTraceBytes` / `responseBytes`), and login request templates are intentionally not recorded. |
| Old UI after upgrading the package | Refreshing the browser tab still talks to the old running MCP process. Reconnect the MCP server in your client and open the new session's URL. |
