# MCP Client Setup Guide

Step-by-step instructions to connect `openapi-swagger-mcp` to nine MCP clients:

- [Claude Desktop](#claude-desktop)
- [Claude Code](#claude-code)
- [Cursor](#cursor)
- [VS Code and GitHub Copilot](#vs-code-and-github-copilot)
- [Windsurf](#windsurf)
- [Cline](#cline)
- [Codex CLI](#codex-cli)
- [OMP (Oh My Pi)](#omp-oh-my-pi)
- [Kiro](#kiro)

---

## Read this first

### Two separate config files

Do not mix up these two files:

| File | Purpose | Format |
|---|---|---|
| **API config** (e.g. `config.dev.yaml`) | Read by `openapi-swagger-mcp`. Declares your API `services` (`baseUrl`, `spec`, `auth`) and optional `inspector`. See [Configuration Guide](configuration.md). | YAML or JSON |
| **Client config** (specific to your editor/CLI) | Read by your MCP client. Tells the client how to launch `openapi-swagger-mcp` over `stdio` (`command`, `args`, optional `env`). | JSON or TOML |

### Checklist before connecting

1. **Node.js 22.19+** must be on the `PATH` seen by your MCP client (`node --version`).
2. **Validate your API config first** in a terminal:
   ```bash
   npx -y @nhan7777/openapi-swagger-mcp@0.1.4 --config /absolute/path/config.dev.yaml --check
   ```
   Wait for exit code `0` and `"ok": true` (see [Troubleshooting](reference.md#5-validation-and-troubleshooting)).
3. **Always use absolute paths** for `--config`. MCP clients launch stdio servers from unpredictable working directories.
4. **Never include `--check` in your client config.** `--check` prints a validation report and exits immediately.
5. **Select `stdio` / `command` transport**—not `HTTP` or `SSE`. The MCP protocol runs strictly over `stdin`/`stdout`.
6. **Pin the version** (`@nhan7777/openapi-swagger-mcp@0.1.4`) and always keep the `@nhan7777/` scope (the unscoped `openapi-swagger-mcp` package on npm is unrelated).

### Shared entry

Most clients use this JSON shape under `mcpServers` (exceptions like VS Code and Codex are shown in their sections below):

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

- If your client's config file already has `"mcpServers"`, add `"api-dev": { ... }` inside it rather than creating a duplicate key.
- If your API config uses `{ fromEnv: ORDERS_TOKEN }`, pass `"env": { "ORDERS_TOKEN": "..." }` inside the `"api-dev"` block (see [Environment variables](configuration.md#passing-secrets-via-environment-variables)).
- On Windows, escape backslashes in JSON strings: `"C:\\Users\\you\\config.dev.yaml"`.

### Keep tool approval prompts enabled

`invoke_operation` sends real `POST`, `PUT`, `PATCH`, and `DELETE` requests with no rollback or server-side write lock. Use non-production targets and **keep your client's confirmation prompts on**:

- Keep `autoApprove: []` empty in **Cline** and **Kiro** (never `"*"`).
- Set `default_tools_approval_mode = "prompt"` in **Codex** (never `"approve"`).
- Avoid "always allow" rules for this server's tools, and do not enable VS Code's `sandboxEnabled` on this entry (which auto-approves tool confirmations).

### Safe first prompt

After connecting, test the connection without calling any business endpoint:

> List the configured APIs and report whether the `orders` spec loaded. If it failed, explain the error without making any API requests.

Replace `orders` with a service name from your config. The assistant should call `list_apis` and report the spec revision, operation count, and session ID.

---

## Claude Desktop

Source: [Connect to local MCP servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

1. From the system menu bar, open **Claude > Settings... > Developer > Edit Config** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows).
2. Add the [shared entry](#shared-entry) under `mcpServers` and save.
3. **Quit Claude Desktop completely and reopen it** to load the updated config.
4. Click the `+` / connectors icon in the chat input (**Connectors > Manage connectors**) to confirm `api-dev` is connected, then send the [safe first prompt](#safe-first-prompt).
5. **Logs:** `~/Library/Logs/Claude/mcp*.log` (macOS) or `%APPDATA%\Claude\logs` (Windows).

---

## Claude Code

Source: [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp).

Add the server from your terminal (everything after `--` is passed directly to `npx`):

```bash
claude mcp add --transport stdio api-dev -- npx -y @nhan7777/openapi-swagger-mcp@0.1.4 --config /absolute/path/config.dev.yaml
```

- **Scope:** Default is `--scope local` (stored in `~/.claude.json` for the current project) or use `--scope user` (all projects). Avoid `--scope project` (`.mcp.json`), which would commit your machine's absolute path.
- **With environment variables:** Use `add-json` with the inner entry object:
  ```bash
  claude mcp add-json api-dev '{"command":"npx","args":["-y","@nhan7777/openapi-swagger-mcp@0.1.4","--config","/absolute/path/config.dev.yaml"],"env":{"ORDERS_TOKEN":"replace-me"}}'
  ```
- **Manage & verify:** Run `claude mcp list` or `claude mcp get api-dev` in a shell, or `/mcp` (including **Reconnect**) inside a Claude Code session.

---

## Cursor

Source: [Model Context Protocol (MCP) in Cursor](https://cursor.com/docs/mcp).

1. Open `~/.cursor/mcp.json` (global, recommended so absolute paths aren't committed) or `.cursor/mcp.json` (project).
2. Add the [shared entry](#shared-entry) under `mcpServers` (add `"type": "stdio"` if prompted by your Cursor version).
3. Open **Customize** in the Cursor sidebar and ensure the `api-dev` toggle is enabled.
4. **Logs & restart:** Toggle the server off and on in **Customize** to restart it; view logs in the Output panel (`Cmd+Shift+U` / `Ctrl+Shift+U` > **MCP Logs**).

---

## VS Code and GitHub Copilot

Sources: [Add MCP servers in VS Code](https://code.visualstudio.com/docs/agent-customization/mcp-servers), [MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

VS Code supports two different file formats—note the root key difference:

| File | Root key |
|---|---|
| User profile `mcp.json` (**MCP: Open User Configuration**) or `.vscode/mcp.json` | `servers` |
| Portable Copilot `~/.copilot/mcp-config.json` or `.mcp.json` | `mcpServers` |

**Option A — Command Palette:** Run **MCP: Add Server** > **Command (stdio)**, enter `npx -y @nhan7777/openapi-swagger-mcp@0.1.4 --config /absolute/path/config.dev.yaml`, name it `api-dev`, and choose your user/global configuration.

**Option B — VS Code `mcp.json` (`servers` root key):**

```json
{
  "servers": {
    "api-dev": {
      "type": "stdio",
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

**Manage & logs:** Run **MCP: List Servers** > select `api-dev` > **Start / Restart / Show Output**.

---

## Windsurf

Source: [Cascade MCP Configuration](https://docs.windsurf.com/windsurf/cascade/mcp) (applies to Windsurf's Cascade panel).

1. In the Cascade panel, click the `...` menu and choose **Open MCP config file** (`~/.config/devin/mcp_config.json` on macOS/Linux, `%APPDATA%\devin\mcp_config.json` on Windows, or `~/.codeium/windsurf/mcp_config.json` on older installs).
2. Add the [shared entry](#shared-entry) under `mcpServers` and save.
3. Ensure `api-dev` is toggled on in the Cascade `...` > **MCPs** list, then send the [safe first prompt](#safe-first-prompt).

---

## Cline

Source: [MCP in Cline](https://docs.cline.bot/mcp/mcp-overview).

**In the IDE extension:** Click **MCP Servers** in the Cline toolbar > **Configure > Configure MCP Servers**, and add:

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
      ],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

**With the Cline CLI:**

```bash
cline mcp add api-dev --yes -- npx -y @nhan7777/openapi-swagger-mcp@0.1.4 --config /absolute/path/config.dev.yaml
cline config mcp
```

---

## Codex CLI

Source: [Model Context Protocol in Codex](https://learn.chatgpt.com/docs/extend/mcp).

Codex uses TOML in `~/.codex/config.toml` (shared across Codex CLI, IDE extension, and desktop app) with the root table `mcp_servers`:

```toml
[mcp_servers.api-dev]
command = "npx"
args = ["-y", "@nhan7777/openapi-swagger-mcp@0.1.4", "--config", "/absolute/path/config.dev.yaml"]
startup_timeout_sec = 60
default_tools_approval_mode = "prompt"
```

- `startup_timeout_sec = 60` gives the first `npx` download enough time to finish.
- Keep `default_tools_approval_mode = "prompt"` so calls require confirmation.
- You can also register via `codex mcp add api-dev -- npx -y @nhan7777/openapi-swagger-mcp@0.1.4 --config /absolute/path/config.dev.yaml`, then add the timeout and approval lines above in `config.toml`.
- Check status with `codex mcp list` or `/mcp` inside Codex.

---

## OMP (Oh My Pi)

Source: [Oh My Pi](https://github.com/can1357/oh-my-pi) bundled `mcp-config.md`.

1. Edit `~/.omp/agent/mcp.json` (recommended user-level file; project file is `.omp/mcp.json`):
   ```json
   {
     "mcpServers": {
       "api-dev": {
         "type": "stdio",
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
2. Inside OMP, run `/mcp reload`, `/mcp list`, or `/mcp test api-dev` (and `/mcp reconnect api-dev` after config changes). OMP exposes the tools under `mcp__api_dev_<tool>`.

---

## Kiro

Source: [MCP configuration in Kiro](https://kiro.dev/docs/mcp/configuration/).

1. Open your user MCP config (`~/.kiro/settings/mcp.json`, or run **Kiro: Open user MCP config (JSON)** from the Command Palette) and ensure MCP support is enabled in Settings.
2. Add the entry with an empty `autoApprove` array:
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
         ],
         "disabled": false,
         "autoApprove": []
       }
     }
   }
   ```
3. Save—Kiro hot-reloads changed servers automatically. Check status in the Kiro MCP panel or via `/mcp` in Kiro CLI.
