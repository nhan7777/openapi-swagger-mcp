# Connect `openapi-swagger-mcp` to your MCP client

Step-by-step setup for nine MCP clients: [Claude Desktop](#claude-desktop), [Claude Code](#claude-code), [Cursor](#cursor), [VS Code and GitHub Copilot](#vs-code-and-github-copilot), [Windsurf](#windsurf), [Cline](#cline), [Codex CLI](#codex-cli), [OMP (Oh My Pi)](#omp-oh-my-pi) and [Kiro](#kiro).

The instructions below were checked against the sources listed at the end. Graphical clients were not tested live. If a client's UI differs, follow its current vendor documentation and keep the launch command and config path shown here.

## Read this first

### Two different config files

You will touch two files. Do not mix them up.

| File | What it is | Format |
|---|---|---|
| **API config** (for example `config.dev.yaml`) | Tells this server which APIs to expose: `baseUrl`, `spec`, `auth`. Read by `openapi-swagger-mcp`. See [Configure your APIs](../README.md#configure-your-apis). | YAML or JSON |
| **Client config** (a different file for every client below) | Tells your MCP client how to launch this server. It only contains `command`, `args` and, in some clients, a few client-specific switches. | JSON or TOML |

The client config points at the API config through `--config /absolute/path/config.dev.yaml`. Prefer environment or JSON-file secret sources in the API config; do not paste real tokens into chat or commit credential files. If you use `fromEnv`, the variable must exist in the MCP server process environment, which your client may need to set explicitly.

### Before you connect any client

1. Node.js 22.19 or newer must be available to the client. Check with `node --version`.
2. Create your API config and run the static check **in a terminal**:

   ```bash
   npx -y @nhan7777/openapi-swagger-mcp@0.1.2 --config /absolute/path/config.dev.yaml --check
   ```

   Expect exit code `0` and `"ok": true`. This check does not fetch your spec or call your API. See [Troubleshooting](../README.md#troubleshooting).
3. Use **absolute paths** everywhere. Clients start the server from a directory you do not control.
4. **Never put `--check` in a client entry.** That mode prints a report and exits, so the client would see a server that dies immediately.
5. The server speaks **stdio** only. There is no URL, port or web UI to enter. Always choose the client's "command" / "stdio" / "local" server type, not "HTTP" or "SSE".
6. Pin the version as shown (`@0.1.2`). Do not use `@latest`; a client restart could silently change the server. The unscoped npm package named `openapi-swagger-mcp` is a different project.

### Shared entry

Most clients use the same `mcpServers` shape. Where a client needs something different, its section says so.

```json
{
  "mcpServers": {
    "api-dev": {
      "command": "npx",
      "args": [
        "-y",
        "@nhan7777/openapi-swagger-mcp@0.1.2",
        "--config",
        "/absolute/path/config.dev.yaml"
      ]
    }
  }
}
```

- `api-dev` is the name the client shows. One server process reads one config, which may contain multiple services and environments with unique service IDs. Separate client entries and config files are optional when you want isolation.
- If the client's config file already has an `mcpServers` object, add only the `"api-dev": { ... }` entry inside it. Do not paste a second `mcpServers` key.
- On Windows, JSON needs doubled backslashes: `"C:\\Users\\you\\config.dev.yaml"`.

### Do not auto-approve tools

This server sends real POST, PUT, PATCH and DELETE requests, with no rollback and no server-side write gate. Leave every client's approval prompts on. Specifically, do **not** set any of these:

- Cline or Kiro `autoApprove` (any tool name, or `"*"` in Kiro).
- Codex `default_tools_approval_mode = "approve"` or a per-tool `approval_mode = "approve"`.
- A "run everything", "always allow" or "trust this tool" choice in a client prompt, for any of the ten tools.
- VS Code `sandboxEnabled` for this server. The VS Code docs state that with sandboxing on, tool confirmations are auto-approved.

A client-side prompt is the client's feature. This server does not enforce it.

### First prompt (safe)

After connecting, send this. It only lists configured APIs and spec status; it makes no business API request.

> List the configured APIs and report whether the orders spec loaded. If it failed, explain the error without making any business API requests.

Replace `orders` with your own service name from the API config. Expected result: the assistant calls the `list_apis` tool and reports your service, its spec revision and operation count. If the client asks you to approve the tool call, approving `list_apis` is fine. Then continue with [Everyday usage](../README.md#everyday-usage).

If it fails, run the exact command from your client entry in a terminal (without `--check`). The server should write startup logs to stderr and wait for MCP messages on stdin; press Ctrl+C to stop. This only checks process startup, not a complete client connection.

---

## Claude Desktop

Source: [Connect to local MCP servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

1. Open the Claude menu in the system menu bar (not the settings inside the chat window) and choose **Settings...**.
2. Open the **Developer** tab and click **Edit Config**. This creates the file if it does not exist.
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
3. Add the [shared entry](#shared-entry). Root key: `mcpServers`.
4. Save, then **completely quit and restart** Claude Desktop. The documented way to load a changed config is a full restart.
5. In the chat input, click the "Add files, connectors, and more /" indicator, hover **Connectors**, click **Manage connectors**, and select `api-dev` to see its tools.
6. Send the [first prompt](#first-prompt-safe). Desktop asks for approval before tool calls; keep that on.

Logs (documented):

- macOS: `~/Library/Logs/Claude`; Windows: `%APPDATA%\Claude\logs`.
- `mcp.log` holds connection events and failures. `mcp-server-api-dev.log` holds this server's stderr (the name follows your entry name).
- macOS follow command: `tail -n 20 -f ~/Library/Logs/Claude/mcp*.log`.

If the server is missing, check JSON syntax, check that every path is absolute, read the logs, and run the command in a terminal. The vendor page documents Linux only as a download target, not a config path, so this guide does not give one.

## Claude Code

Source: [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp).

Claude Code has a CLI for adding servers. Everything after `--` is passed to the server untouched, so `-y` and `--config` are not read by Claude Code.

```bash
claude mcp add --transport stdio api-dev -- npx -y @nhan7777/openapi-swagger-mcp@0.1.2 --config /absolute/path/config.dev.yaml
```

Scope (the default is `local`):

| Flag | Stored in | Who gets it |
|---|---|---|
| (none) / `--scope local` | `~/.claude.json`, under the current project | Only you, only this project |
| `--scope user` | `~/.claude.json` | Only you, all projects |
| `--scope project` | `.mcp.json` in the project root | Everyone who clones the repo |

Use `local` or `user` for this server. Avoid `--scope project`: the entry contains your machine's absolute path and would be committed.

Verify and manage:

```bash
claude mcp list          # shows Connected / Needs authentication / Failed to connect
claude mcp get api-dev   # details, including a failure reason if any
claude mcp remove api-dev
```

Inside a Claude Code session, `/mcp` shows server status and has a **Reconnect** action. If you prefer JSON, `claude mcp add-json api-dev '{"command":"npx","args":["-y","@nhan7777/openapi-swagger-mcp@0.1.2","--config","/absolute/path/config.dev.yaml"]}'` adds the same server; pass the object inside `mcpServers`, not the wrapper.

Do not add permission allow rules for this server's tools, so Claude Code keeps asking before each call. Then send the [first prompt](#first-prompt-safe).

## Cursor

Source: [Model Context Protocol (MCP) in Cursor](https://cursor.com/docs/mcp).

1. Choose the file:
   - `~/.cursor/mcp.json`: available in every project.
   - `.cursor/mcp.json` in a project: only that project. Do not commit it, because it contains an absolute path.
2. Add the [shared entry](#shared-entry). Root key: `mcpServers`. The vendor's own stdio examples use exactly this shape. The docs' field table lists `type` as `"stdio"`; if your Cursor version asks for it, add `"type": "stdio"` to the entry.
3. Open **Customize** in the sidebar. Servers can be enabled or disabled there with a toggle; make sure `api-dev` is on.
4. Send the [first prompt](#first-prompt-safe).

Cursor asks for approval before using MCP tools by default, and you can expand the arrow next to the tool name to see its arguments. MCP follows the same Run Modes as terminal commands, so do not allowlist this server's tools for automatic runs.

Logs (documented): open the Output panel (`Cmd+Shift+U` on macOS), pick **MCP Logs** in the dropdown, and look for connection errors, authentication issues and crashes. The docs do not describe a dedicated "reconnect" button; toggling the server off and on in **Customize** is the documented way to stop and start it.

## VS Code and GitHub Copilot

Sources: [Add MCP servers in VS Code](https://code.visualstudio.com/docs/agent-customization/mcp-servers), [MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration), [Manage and troubleshoot MCP servers](https://code.visualstudio.com/docs/agents/run/manage-mcp-servers).

VS Code is the client where the shared entry does **not** always apply. There are two formats:

| Format | File | Root key |
|---|---|---|
| Portable Copilot | `.mcp.json` in the workspace root, or `$COPILOT_HOME/mcp-config.json` (default `~/.copilot/mcp-config.json`) | `mcpServers` |
| VS Code | `.vscode/mcp.json` in the workspace, or `mcp.json` in your user profile | `servers` |

Do not copy a config between them without changing the root key.

### Guided setup (recommended)

1. Open the Command Palette and run **MCP: Add Server**.
2. Choose **Command (stdio)**.
3. Enter the command (this is the whole launch line, not a URL):

   ```text
   npx -y @nhan7777/openapi-swagger-mcp@0.1.2 --config /absolute/path/config.dev.yaml
   ```

4. Enter a server ID such as `api-dev`.
5. For a personal setup choose **Global**, then **Copilot Global**. Review any trust prompt before accepting.

If the **Copilot Global** option is not offered, check the vendor's Copilot harness requirements, or use one of the files below.

### Edit a file directly

Portable file (`~/.copilot/mcp-config.json`): use the [shared entry](#shared-entry) unchanged.

VS Code format (`.vscode/mcp.json`, or the profile `mcp.json` opened with **MCP: Open User Configuration**):

```json
{
  "servers": {
    "api-dev": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@nhan7777/openapi-swagger-mcp@0.1.2",
        "--config",
        "/absolute/path/config.dev.yaml"
      ]
    }
  }
}
```

Prefer a user-level file over a workspace file. A workspace file with an absolute local path should not be committed, and workspace configs inherit Workspace Trust (stdio servers can run code). Do not add `sandboxEnabled` (see [Do not auto-approve tools](#do-not-auto-approve-tools)).

### Verify

1. In the agent chat, send the [first prompt](#first-prompt-safe). It names the server's job explicitly; you can also add "Use the api-dev MCP server."
2. Expand the tool call in the conversation and check that it belongs to `api-dev` and returned output without a connection error. The vendor says an answer that merely sounds plausible is not proof.
3. To manage the server, open **Chat: Open Customizations** > **MCP Servers**, or run **MCP: List Servers** and pick it. Documented actions: **Start Server**, **Stop Server**, **Restart Server**, **Enable/Disable**, **Show Output**.

Logs (documented): **MCP: List Servers** > select the server > **Show Output**, or in Customizations open the server's `...` menu > **Show Output**. After fixing a problem, restart the server and repeat the request.

## Windsurf

Source: [Cascade MCP Configuration](https://docs.windsurf.com/windsurf/cascade/mcp) (the vendor now serves this page from [docs.devin.ai](https://docs.devin.ai/desktop/cascade/mcp)).

Check this before starting: the vendor states that this page applies to the **legacy Cascade agent only**. Its default newer agent (Devin Local) is configured through the Devin CLI config files, which are documented elsewhere and are not covered by this guide.

1. In the Cascade panel, click the `...` (Actions) menu, then the **Open MCP config file** icon in the MCPs section.
2. Add the [shared entry](#shared-entry) under `mcpServers` and save. Cascade has no one-click installer for the legacy agent; editing this file is the documented method.
3. The file lives at:
   - macOS / Linux: `~/.config/devin/mcp_config.json` (or `$XDG_CONFIG_HOME/devin/mcp_config.json`)
   - Windows: `%APPDATA%\devin\mcp_config.json`

   Older Windsurf installs documented `~/.codeium/windsurf/mcp_config.json`. This was not re-verified against the vendor's current page; the **Open MCP config file** icon is the reliable way to find the right file.
4. In the same `...` menu, the MCPs section lists your servers and how many tools each has enabled. Use the toggle next to a server to enable or disable it.
5. Send the [first prompt](#first-prompt-safe).

Enterprise users must turn MCP on in settings, and team admins may allowlist servers; once any server is allowlisted, all others are blocked. The allowlist server ID must match the key name (`api-dev`) exactly, and the command and args must match the admin's pattern.

The pages I read do not document a log location or a reload command for Cascade, so none is given here. Toggling the server off and on is the only documented control.

## Cline

Source: [MCP in Cline](https://docs.cline.bot/mcp/mcp-overview).

### IDE extension

1. In the Cline panel, click the **MCP Servers** icon in the top toolbar.
2. Open the **Configure** tab and click **Configure MCP Servers**. This opens the extension's MCP settings JSON.
3. Add this entry under `mcpServers`:

   ```json
   {
     "mcpServers": {
       "api-dev": {
         "command": "npx",
         "args": [
           "-y",
           "@nhan7777/openapi-swagger-mcp@0.1.2",
           "--config",
           "/absolute/path/config.dev.yaml"
         ],
         "disabled": false,
         "autoApprove": []
       }
     }
   }
   ```

   `autoApprove` stays an **empty array** on purpose. The vendor's security notes say to limit `autoApprove` to safe tools; for this server, that is none.
4. Save. Do not use the **Remote Servers** tab; it is for URL-based servers.

### Cline CLI

The CLI uses `~/.cline/data/settings/cline_mcp_settings.json` (override with `CLINE_MCP_SETTINGS_PATH`). Add the server without opening the file:

```bash
cline mcp add api-dev --yes -- npx -y @nhan7777/openapi-swagger-mcp@0.1.2 --config /absolute/path/config.dev.yaml
cline config mcp          # list servers (add --json for JSON)
```

Running `cline mcp` with no arguments opens a wizard to list, edit, enable/disable or delete servers.

### Verify and recover

In MCP settings you can enable or disable a server, restart an unresponsive one, set request timeouts and remove it. Confirm the tools appear, then send the [first prompt](#first-prompt-safe) and review the tool call before approving. The vendor's troubleshooting table says: if the server will not connect, verify the command and the server process; if tools are missing, confirm the server started and exposes tools. The page I read does not name a log file, so none is given here.

## Codex CLI

Source: [Model Context Protocol in Codex](https://learn.chatgpt.com/docs/extend/mcp) (previously served at developers.openai.com/codex/mcp).

Codex stores MCP servers in `config.toml`. The root table is `mcp_servers`, **not** `mcpServers`, and the file is TOML, so the shared JSON entry does not apply. The default location is `~/.codex/config.toml`; a trusted project can use `.codex/config.toml`. The Codex CLI, the ChatGPT desktop app and the IDE extension share this configuration.

### With the CLI

```bash
codex mcp add api-dev -- npx -y @nhan7777/openapi-swagger-mcp@0.1.2 --config /absolute/path/config.dev.yaml
codex mcp list
codex mcp --help
```

After adding the server, edit its entry in `config.toml` to set `startup_timeout_sec = 60` and `default_tools_approval_mode = "prompt"`, as shown below.

### With `config.toml`

```toml
[mcp_servers.api-dev]
command = "npx"
args = ["-y", "@nhan7777/openapi-swagger-mcp@0.1.2", "--config", "/absolute/path/config.dev.yaml"]
startup_timeout_sec = 60
default_tools_approval_mode = "prompt"
```

- `startup_timeout_sec` defaults to `10`. The first `npx` run downloads the package, which can take longer, so this guide raises it to 60.
- Set `default_tools_approval_mode = "prompt"` so every tool asks. Do not set `"approve"`. The documented values are `auto`, `prompt`, `writes` and `approve`; `writes` prompts only for tools not marked read-only. This server marks `invoke_operation` as non-read-only and destructive, but `prompt` also lets you review discovery and artifact reads.
- Do not add an `[mcp_servers.api-dev.tools.<tool>]` table with `approval_mode = "approve"`.

### Verify and recover

- In the `codex` TUI, type `/mcp` to list active servers.
- Outside a session, `codex mcp list` shows what is configured.
- After editing `config.toml`, restart Codex (in the desktop app and IDE extension the documented path is to save the server, then select **Restart** / **Restart extension**).
- Send the [first prompt](#first-prompt-safe).

The page I read does not document a log file location, so none is given here.

## OMP (Oh My Pi)

Source: OMP's bundled `mcp-config.md` and `mcp-runtime-lifecycle.md` (`omp://mcp-config.md` inside OMP), from the [Oh My Pi project](https://github.com/can1357/oh-my-pi). These are OMP instructions, not the similarly named OpenCode.

1. Choose the file:
   - Project: `.omp/mcp.json`
   - User: `~/.omp/agent/mcp.json` (with a named profile: `~/.omp/profiles/<name>/agent/mcp.json`)

   OMP prefers these two. Use the user file for this server because the entry has an absolute local path.
2. Add the [shared entry](#shared-entry) with an explicit `"type": "stdio"`. The OMP docs recommend explicit, schema-valid transports:

   ```json
   {
     "$schema": "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json",
     "mcpServers": {
       "api-dev": {
         "type": "stdio",
         "command": "npx",
         "args": [
           "-y",
           "@nhan7777/openapi-swagger-mcp@0.1.2",
           "--config",
           "/absolute/path/config.dev.yaml"
         ]
       }
     }
   }
   ```

   Root key: `mcpServers`. The `$schema` line is optional editor help. A server cannot set both `command` and `url`.
3. In a running OMP session, run the documented commands:

   ```text
   /mcp reload              # rediscover and reconnect everything
   /mcp list                # shows each server and which config file it came from
   /mcp test api-dev        # test one server
   /mcp reconnect api-dev   # reconnect one server
   ```

   `/mcp add` is a guided alternative to editing JSON.
4. Send the [first prompt](#first-prompt-safe).

Things specific to OMP:

- OMP also imports MCP servers from other tools' config files (Claude Code, Codex, Cursor, Windsurf, VS Code and others). If the same server appears in two places, the higher-priority one wins and duplicates are not merged. Use `/mcp list` to see which file a server came from.
- Tool names are derived from the server name, lowercased and sanitized, in the form `mcp__<server>_<tool>`. `api-dev` becomes `api_dev`.
- The default request timeout is 30 seconds and initial discovery returns after about 250 ms while slow servers keep connecting; their tools register when ready. If tools are missing right after launch, run `/mcp list`, then `/mcp reconnect api-dev`.
- OMP can run its tools with its own approval mode; keep that at a setting that prompts for MCP tools. This guide did not verify OMP's approval settings, so check `approval-mode.md` in the bundled docs.

The bundled docs describe errors reported by `/mcp test` and `/mcp list`, not a log file path, so none is given here.

## Kiro

Source: [MCP configuration in Kiro](https://kiro.dev/docs/mcp/configuration/).

1. Choose the file. Both use the root key `mcpServers`:
   - Workspace: `.kiro/settings/mcp.json`
   - User (global): `~/.kiro/settings/mcp.json`

   If both define the same server, the workspace entry wins; an active agent's `mcpServers` entry takes precedence over both. Check that the agent does not replace or disable `api-dev`. Use the **user** file for this server because it has an absolute local path. In the IDE, open the Command Palette and run **Kiro: Open user MCP config (JSON)** (or **Kiro: Open workspace MCP config (JSON)**), or use the **Open MCP Config** icon in the Kiro panel.
2. In the IDE, open Settings (`Cmd+,` / `Ctrl+,`), search for "MCP" and make sure MCP support is enabled.
3. Add this entry:

   ```json
   {
     "mcpServers": {
       "api-dev": {
         "command": "npx",
         "args": [
           "-y",
           "@nhan7777/openapi-swagger-mcp@0.1.2",
           "--config",
           "/absolute/path/config.dev.yaml"
         ],
         "disabled": false,
         "autoApprove": []
       }
     }
   }
   ```

   Keep `autoApprove` as an empty array. The vendor documents `"*"` as "auto-approve all tools"; never use it here.
4. Save the file. Kiro hot-reloads `mcp.json` on save and restarts only the servers whose entries changed, so no manual restart is needed.
5. Check status:
   - IDE: the MCP panel shows servers; if a token expires it shows a re-authenticate warning (not relevant to this stdio server).
   - Kiro CLI: type `/mcp` in a chat session. It lists active servers, connection status and tools.
6. Send the [first prompt](#first-prompt-safe).

If connection fails, validate JSON syntax, ensure the command is on `PATH`, and check which user/workspace config is active. Do not paste the whole config or environment into chat: it may contain credentials. If you write `${VAR}` references in `env`, Kiro expands only approved variables (Settings > "Mcp Approved Env Vars"). This server needs no `env` entries for the anonymous quick start; for tokens read with `fromEnv`, see [Pass a token from the environment](../README.md#pass-a-token-from-the-environment).

The page I read does not document a log file location, so none is given here.

---

## Sources

Retrieved on 2026-10-21. These are the only sources used for client paths, root keys, commands and log locations.

| Client | Primary source |
|---|---|
| Claude Desktop | <https://modelcontextprotocol.io/docs/develop/connect-local-servers> |
| Claude Code | <https://code.claude.com/docs/en/mcp> |
| Cursor | <https://cursor.com/docs/mcp> |
| VS Code / GitHub Copilot | <https://code.visualstudio.com/docs/agent-customization/mcp-servers>, <https://code.visualstudio.com/docs/agents/reference/mcp-configuration>, <https://code.visualstudio.com/docs/agents/run/manage-mcp-servers> |
| Windsurf | <https://docs.windsurf.com/windsurf/cascade/mcp>, served at <https://docs.devin.ai/desktop/cascade/mcp> |
| Cline | <https://docs.cline.bot/mcp/mcp-overview> |
| Codex CLI | <https://learn.chatgpt.com/docs/extend/mcp> |
| OMP | Bundled OMP docs `mcp-config.md`, `mcp-runtime-lifecycle.md` |
| Kiro | <https://kiro.dev/docs/mcp/configuration/> |

What is not covered, on purpose: remote (HTTP/SSE) servers, OAuth, and organization-managed policy beyond the notes above. Client UIs change often; if a menu name differs, search the vendor documentation for the same feature and keep the command, args and absolute config path from this guide.
