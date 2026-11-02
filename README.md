# openapi-swagger-mcp

**`openapi-swagger-mcp`** is a local MCP server that connects your AI coding agent or assistant to the **Swagger 2.0 and OpenAPI 3.0/3.1 APIs** you configure.

Instead of generating one tool per endpoint—which floods context windows on large APIs—it exposes **11 fixed tools** regardless of spec size. Your agent can search operations, read parameter and response contracts, preview requests offline, authenticate, and send real HTTP calls directly from your machine.

### Review how your agent runs with the built-in Inspector

When an AI agent searches endpoints, authenticates, and executes multi-step API calls, relying on chat summaries alone makes it hard to verify what actually happened over the wire.

The built-in **Local Request Inspector** opens a read-only browser UI tied to your active MCP session so you can audit the agent's execution in real time:

- **Correlated activity timeline** — See every MCP tool call alongside the exact HTTP requests, redirect hops, and login/refresh runs it triggered, and immediately distinguish offline `preview_operation` checks from real `invoke_operation` requests.
- **Side-by-side HTTP workbench** — Inspect actual URLs, query parameters, headers, cookies, request payloads, and raw or formatted responses—while keeping configured credentials masked by name.
- **Contract diagnostics & cURL replay** — Check whether requests and responses matched your OpenAPI schema, spot truncated or blocked calls, and copy a ready-to-review `curl` command to reproduce any request yourself.

---

## Try the demo in 30 seconds

Want to see the tools and Inspector in action without connecting your own API or credentials? Run `demo` as your MCP server command (Requires **Node.js 22.19+**):

```bash
npx -y @nhan7777/openapi-swagger-mcp@0.1.4 demo
```

`demo` starts a local synthetic backend on `127.0.0.1` (`demo-shop` and `demo-account`), turns the Inspector on, and serves MCP over `stdio`. Put that command in your MCP client, then run the `--inspector-url` command printed on `stderr` in another terminal to watch the agent's calls live in your browser.

---

## Quick start

### 1. Create an API config

Generate a starter `config.dev.yaml` and a ready-to-paste client snippet with `init` (it validates inputs and never edits your client's files):

```bash
npx -y @nhan7777/openapi-swagger-mcp@0.1.4 init \
  --service orders \
  --base-url http://localhost:8080/api/v1 \
  --spec http://localhost:8080/v3/api-docs \
  --out config.dev.yaml \
  --client claude-code
```

*(Add `--bearer-env ORDERS_TOKEN` if your API uses a Bearer token; `--client` accepts `generic`, `claude-desktop`, `claude-code`, `cursor`, `vscode`, `windsurf`, `cline`, `codex`, `omp`, or `kiro`.)*

Or create `config.dev.yaml` by hand—enable `inspector` so you can review agent runs in your browser:

```yaml
inspector:
  enabled: true
  port: 0

services:
  orders:
    baseUrl: http://localhost:8080/api/v1    # full URL prefix; overrides spec servers/basePath
    spec: http://localhost:8080/v3/api-docs  # URL or relative file path such as ./openapi.json
```

### 2. Validate the config

```bash
npx -y @nhan7777/openapi-swagger-mcp@0.1.4 --config /absolute/path/config.dev.yaml --check
```

`--check` verifies config syntax, referenced environment variables, and local file paths offline (`"ok": true`, exit `0`). To also verify that remote specs load, run `--check-specs` instead of `--check`.

### 3. Add the server to your MCP client

Add this `stdio` entry to your MCP client configuration using the **absolute path** to your YAML/JSON file (do **not** include `--check` here):

```json
{
  "mcpServers": {
    "api-dev": {
      "command": "npx",
      "args": [
        "-y",
        "@nhan7777/openapi-swagger-mcp@0.1.4",
        "--config",
        "/absolute/path/config.dev.yaml"
      ]
    }
  }
}
```

Exact file paths, root keys (`mcpServers`, `servers`, or `mcp_servers`), and CLI setup commands for **Claude Desktop, Claude Code, Cursor, VS Code / GitHub Copilot, Windsurf, Cline, Codex CLI, OMP, and Kiro** are in the [MCP Client Setup Guide](docs/clients.md).

### 4. Ask your first prompt & open the Inspector

Reconnect the MCP server in your client and start with a read-only check:

> List the configured APIs, report whether the `orders` spec loaded, and show `session.sessionId` and `session.inspector.state` without making any API requests.

Then ask the agent to explore or preview an operation:

> Find the order details endpoint in `orders`, explain its required inputs, and preview a request for ID `demo-123` without sending it.

If you enabled `inspector`, open the session's browser UI by running this in **your own local terminal** (using the `sessionId` from `list_apis`):

```bash
npx -y @nhan7777/openapi-swagger-mcp@0.1.4 \
  --config /absolute/path/config.dev.yaml \
  --inspector-url --session <session-id>
```

> Keep the printed URL private: its `#t=...` fragment carries the local session token, so open it directly in your browser rather than running `--inspector-url` through the AI chat. See the [Inspector Guide](docs/inspector.md).

---

## Core workflow & safety

A typical agent session follows five steps:

1. **Discover** — `list_apis` and `search_operations` find the right endpoint and spec `revision`.
2. **Read contract** — `get_operation_schema` inspects parameters, request payloads, auth, and expected responses.
3. **Preview** — `preview_operation` builds and validates the outgoing request locally (`sent: false`) without touching the network.
4. **Call** — `invoke_operation` sends the exact payload (preserving invalid inputs for negative testing) and returns the HTTP response plus advisory schema diagnostics.
5. **Audit** — Open the [Inspector](docs/inspector.md) to verify every tool call, HTTP exchange, auth recovery, and payload.

> **Important safety notes**
> - **Use against non-production environments** (such as local, test, or staging). `invoke_operation` sends real `POST`, `PUT`, `PATCH`, and `DELETE` requests with no rollback or server-side write lock. Keep your MCP client's tool approval prompts turned on.
> - **Know your data boundary.** This server runs locally over `stdio` with zero telemetry and no cloud backend, but tool outputs read by your assistant can be sent by your MCP client to your AI model provider. Load secrets via `fromEnv` or `fromFile` rather than pasting tokens into chat.

---

## The 11 fixed tools

| Category | Tool | Purpose |
|---|---|---|
| **Discovery** | `list_apis` | List configured services, spec readiness/revisions, warnings, and Inspector session info |
| | `search_operations` | Find endpoints by path, operationId, text, parameters, or request/response fields |
| | `get_operation_schema` | Read an operation's full contract (parameters, request body, responses, security) |
| | `refresh_specs` | Reload specs without restarting the server (keeps the last valid snapshot on failure) |
| **Execution** | `preview_operation` | Build and check a request offline (`sent: false`) without sending network traffic |
| | `invoke_operation` | Send a real HTTP request, return status/body/diagnostics, and optionally capture session auth |
| **Auth** | `authenticate` | Run a configured login/refresh recipe or reload static credential sources |
| | `get_auth_status` | Check credential readiness, active profile, cookies, and errors without exposing secret values |
| | `manage_session` | Create, inspect, or delete in-memory interactive sessions (for OTP, SSO, or imported tokens) |
| **Artifacts** | `read_artifact` | Page through or query (via JSON Pointer) large responses and contracts stored locally |
| | `export_artifact` | Save raw bytes, text, or decoded base64 fields to an allowed local directory |

---

## Documentation

| Guide | What it covers |
|---|---|
| **[Inspector Guide](docs/inspector.md)** | Enable the local UI, open the right MCP session, review agent timelines & HTTP traffic, copy payloads/cURL, and troubleshoot |
| **[MCP Client Setup](docs/clients.md)** | Exact config paths, formats, and setup commands for 9 MCP clients |
| **[Configuration Guide](docs/configuration.md)** | Multi-service & multi-environment setups, protected specs/`$ref`s, TLS, `network.allow`, operation filters, file roots, and limits |
| **[Authentication Guide](docs/authentication.md)** | Static tokens/keys/Basic auth, `fromEnv`/`fromFile` secrets, multi-account profiles, login & 401 refresh recipes, and OTP/SSO sessions |
| **[Usage, Data Boundary & Troubleshooting](docs/reference.md)** | Request body shapes, negative testing, reading/exporting large responses, search & aliases, privacy/trace details, and error codes |
| **[Configuration Cookbook](examples/config.example.yaml)** | Copy-ready YAML recipes for every supported scenario (validated against [`config.schema.json`](config.schema.json)) |
| **[Development & Release](docs/development.md)** | Building from source, running tests and the Inspector harness, verifying tarballs, and publishing |

---

## Alternative installs & package info

- **Global install:** `npm install -g @nhan7777/openapi-swagger-mcp@0.1.4` (command: `openapi-swagger-mcp`). Always include the `@nhan7777/` scope—the unscoped `openapi-swagger-mcp` package on npm is an unrelated project.
- **Registry:** Listed in the [Official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.nhan7777%2Fopenapi-swagger-mcp) (`io.github.nhan7777/openapi-swagger-mcp`). All execution happens locally on your machine; never upload private configs or tokens to third-party marketplaces.
- **License:** MIT. Third-party dependency notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
