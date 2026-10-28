# openapi-swagger-mcp

A local MCP server that connects your AI assistant to the dev/UAT APIs you configure. Ask it to find an endpoint, explain its inputs, send a request and inspect the response using your Swagger 2.0 or OpenAPI 3.0/3.1 spec.

For example: **“Find the order details endpoint and explain the required parameters before calling it.”**

You configure the API addresses and authentication in a YAML or JSON file. Your MCP client starts the server, and your assistant uses its **ten fixed tools** regardless of how many endpoints you have.

**New here?** Follow [Quick start](#quick-start), then try [Everyday usage](#everyday-usage). You do not need to write tool calls yourself.

**Already connected?** Jump to [Choose your next step](#choose-your-next-step), [Troubleshooting](#troubleshooting) or [Tool reference](#tool-reference).

## Before you start

You need:

- **Node.js 22.19 or newer** and npm.
- An API you can reach, and its Swagger/OpenAPI spec (a URL or a file).
- An MCP client that can launch a local stdio server.

> **Use this only against dev/UAT services.** The tools send real POST, PUT, PATCH and DELETE requests. There is no rollback and no server-side write gate. A confirmation prompt in your MCP client is the client's feature, not something this server enforces.
>
> **Think about where your data goes.** Tool arguments and results can be stored in your AI provider's conversation history. Responses are not scrubbed of tokens or personal data. Read secrets from environment variables or files instead of pasting them into the conversation.

## Quick start

### 1. Create a config file

Save this as `config.dev.yaml`:

```yaml
services:
  orders:
    baseUrl: http://localhost:8080/api/v1
    spec: http://localhost:8080/v3/api-docs
```

- `orders` is the service name the agent uses in tool calls.
- `baseUrl` is where requests are really sent, **including any prefix** such as `/api/v1`.
- `spec` is the Swagger/OpenAPI URL, or a file path such as `./openapi.json`.
- With no `auth` block, requests are anonymous.

The URLs above are examples. They only work if your own API is running there, so replace them with your dev/UAT addresses.

**Before continuing:** replace both URLs and save the file. Note its absolute path; you will use that same path in the next two steps.

### 2. Check the config

```bash
npx -y @nhan7777/openapi-swagger-mcp@0.1.2 --config /absolute/path/config.dev.yaml --check
```

`ok: true` means the static checks passed. It does **not** mean the remote spec was fetched or any endpoint was verified: `--check` makes no network calls, does not log in, and does not create the artifact directory. See [Troubleshooting](#troubleshooting) for the report format and exit codes.

**Expected result:** the command exits with code `0` and the report contains `"ok": true`. If it does not, fix the reported field before connecting your client.

### 3. Add the server to your MCP client

For clients that use an `mcpServers` configuration, add this to the **client's MCP config file** (not to the YAML file above):

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

The file name and location depend on your client. If your client has a form for command, arguments and environment variables, enter the same values there. Not every client uses the `mcpServers` format, so adapt the snippet if yours differs. Use absolute paths so the server does not depend on the directory the client starts in.

This server uses **stdio**: the client starts the process and talks to it over stdin/stdout. There is no web UI and no HTTP port. stdout is reserved for MCP traffic and logs go to stderr. Do not add `--check` to the client entry, because that mode exits after checking.

Step-by-step setup, including the exact config file, root key and restart or reconnect steps for each client, is in the [MCP client setup guide](docs/clients.md):

| Client | Config format | Guide |
|---|---|---|
| Claude Desktop | JSON, `mcpServers` | [Claude Desktop](docs/clients.md#claude-desktop) |
| Claude Code | CLI `claude mcp add`, or JSON `mcpServers` | [Claude Code](docs/clients.md#claude-code) |
| Cursor | JSON, `mcpServers` | [Cursor](docs/clients.md#cursor) |
| VS Code / GitHub Copilot | JSON, `servers` or `mcpServers` depending on the file | [VS Code and GitHub Copilot](docs/clients.md#vs-code-and-github-copilot) |
| Windsurf | JSON, `mcpServers` | [Windsurf](docs/clients.md#windsurf) |
| Cline | JSON, `mcpServers` | [Cline](docs/clients.md#cline) |
| Codex CLI | TOML, `mcp_servers` | [Codex CLI](docs/clients.md#codex-cli) |
| OMP | JSON, `mcpServers` | [OMP (Oh My Pi)](docs/clients.md#omp-oh-my-pi) |
| Kiro | JSON, `mcpServers` | [Kiro](docs/clients.md#kiro) |

### 4. Connect and check API availability

Save the client configuration and restart or reconnect the MCP server in your client. Ask:

> List the configured APIs and report whether the orders spec loaded. If it failed, explain the error without making any business API requests.

**Expected result:** the assistant finds `orders`, its spec revision and its operation count. Unlike `--check`, this step loads the spec. If the service is unavailable, follow [Troubleshooting](#troubleshooting).

### 5. Inspect your first endpoint

Ask:

> Find the operation that returns order details in the orders service. Read its contract and explain the required inputs. Do not send the request yet.

**Expected result:** an operation such as `GET /orders/{id}` and the inputs declared by your own spec. The example path is not guaranteed to exist in your API.

You are now ready to use the server. If the endpoint requires a token, [configure authentication](#authentication) before calling it.

## Choose your next step

Read only the section that matches your task:

| I want to… | Start here |
|---|---|
| Ask the assistant to inspect or call an API | [Everyday usage](#everyday-usage) |
| Add services or dev/UAT addresses | [Configure your APIs](#configure-your-apis) |
| Use an existing token, password, API key or cookie | [Static credentials](#static-credentials) |
| Keep a token in a local JSON file | [Secret sources](#secret-sources) |
| Share credentials across services or choose an account | [Multiple accounts and shared profiles](#multiple-accounts-and-shared-profiles) |
| Log in or refresh an expired token | [Login and refresh](#login-and-refresh) |
| Work through OTP or import a session | [OTP, SSO and interactive sessions](#otp-sso-and-interactive-sessions) |
| Read a large response or save a returned file | [Large responses and files](#large-responses-and-files) |
| Fix a connection, spec or auth error | [Troubleshooting](#troubleshooting) |
| Configure protected specs, TLS or limits | [Advanced configuration and limitations](#advanced-configuration-and-limitations) |
| Copy configuration for a supported scenario | [Configuration cookbook](examples/config.example.yaml) |

## Everyday usage

Use normal language in your MCP client. Replace service names, IDs and paths in these prompts with your own. The assistant handles tool arguments; inspect [Request and response reference](#request-and-response-reference) when you need exact syntax.

### Find an endpoint without sending a request

> In orders, find the endpoint for order details. Read its contract and explain required parameters, authentication and expected responses. Do not call it.

### Send a request and understand the result

After checking the operation and providing a real test ID:

> Call the order details GET operation in orders for ID demo-123. Report the HTTP status, relevant response fields and any contract diagnostics. Do not retry automatically.

An HTTP response and a contract diagnostic answer different questions: the status tells you what the API returned; diagnostics tell you how the request or response compares with the spec. A successful status does not prove the response matches the contract.

### Prepare a write before authorizing it

> Find the create-order operation in orders. Read its contract and propose a request using the test data I provide. Show the target service and payload, then wait for my confirmation before sending.

This is an instruction to your assistant, not a server-enforced approval gate. POST, PUT, PATCH and DELETE requests can change real data.

### Choose a service or account explicitly

> Use orders-uat for this task. Inspect its order details contract first. Do not call orders-dev.

If you configured multiple profiles:

> Use the qa profile allowed by orders. Check its auth status without showing credentials, then explain whether it is ready for a request.

### Inspect more of a response

> Read the returned artifact at /data/items. If it is paginated, continue using nextOffset. Report whether the response body is complete.

For files, configure [export roots](#export-a-file) first and give the assistant a new destination path. Export never overwrites an existing file.

## Configure your APIs

A fuller example with two services:

```yaml
# yaml-language-server: $schema=/absolute/path/to/config.schema.json
version: 1                 # optional
services:
  orders:
    baseUrl: https://orders.dev.example.test/api/v1
    spec: https://orders.dev.example.test/v3/api-docs
    auth:
      bearer: { token: { fromEnv: ORDERS_TOKEN } }

  catalog:
    baseUrl: http://localhost:8081
    spec: ./specs/catalog.yaml
```

YAML (`.yaml`, `.yml`) and JSON are both supported. For JSON, add `"$schema": "/absolute/path/to/config.schema.json"` so your editor can suggest keys. The [configuration cookbook](examples/config.example.yaml) starts with an anonymous service and offers opt-in examples by scenario. Copy only the blocks you need; the [JSON Schema](config.schema.json) is the field reference.

Key rules:

- Relative paths in the config resolve from the **directory that contains the config file**, not from where you run the command.
- **The URL comes from `baseUrl`.** The operation `GET /orders/{id}` with `baseUrl: https://host/api/v1` calls `https://host/api/v1/orders/{id}`. The server ignores `servers`, `host` and `basePath` in the spec. `baseUrl` must not contain a username, password, query or fragment.
- **Environments are just services.** The server has no environment concept, no `--env` flag and no switching tool. Give each environment's service a unique id (for example `orders-dev` and `orders-uat`) and tell the agent which one to use. Services that share one identity provider can share a [profile](#multiple-accounts-and-shared-profiles), so they share one token pair and one refresh. If environments must stay isolated, use separate config files and MCP entries; each process then has its own credentials, cookies and artifacts.
- A config change needs a restart of the MCP process. `refresh_specs` only reloads specs.

### Pass a token from the environment

```yaml
services:
  orders:
    baseUrl: https://orders.dev.example.test/api/v1
    spec: https://orders.dev.example.test/v3/api-docs
    auth:
      bearer: { token: { fromEnv: ORDERS_TOKEN } }
```

The server reads `ORDERS_TOKEN` from **its own process environment**. That is not the same as the environment of the shell where you tested the command: set it in the `env` field of the client entry, or wherever your client launches the process.

```json
{
  "mcpServers": {
    "api-dev": {
      "command": "npx",
      "args": ["-y", "@nhan7777/openapi-swagger-mcp@0.1.2", "--config", "/absolute/path/config.dev.yaml"],
      "env": { "ORDERS_TOKEN": "replace-with-your-dev-token" }
    }
  }
}
```

The server does not load `.env` files. Changing the environment of another process does not change the environment of a running MCP server; restart it with the new values.

### Other ways to install

The `npx` commands above download the pinned version on first use. Alternatives:

```bash
# Global install; the command is then `openapi-swagger-mcp`
npm install -g @nhan7777/openapi-swagger-mcp@0.1.2

# From a source checkout (see Development)
npm ci && npm run build
node /absolute/path/to/openapi-swagger-mcp/dist/cli.js --config /absolute/path/config.dev.yaml
```

Do not install the unscoped npm package `openapi-swagger-mcp`. It belongs to someone else and is a different project. This package is `@nhan7777/openapi-swagger-mcp`.

## Authentication

Pick the approach that matches your API:

Start with the simplest option your API supports. A ready token needs only static auth; recipes and sessions are optional. The YAML examples in this section are configuration blocks to merge at the stated location, not commands to run. Tool examples are JSON arguments for the assistant, not shell commands.

For `authenticate` and `get_auth_status`, provide exactly one target: `{"service":"orders"}` or `{"profile":"qa"}`, never both. `authenticate` also accepts `"action":"refresh"`; omitting `action` selects authentication (or reloading static sources when there is no login recipe).

| You have... | Use |
|---|---|
| A ready bearer token, basic credentials, API key or cookies | [Static credentials](#static-credentials) |
| A login or refresh endpoint to call | [Login and refresh](#login-and-refresh) |
| Several accounts, or credentials shared by several services | [Multiple accounts and shared profiles](#multiple-accounts-and-shared-profiles) |
| OTP, SSO, or a token you receive interactively | [OTP, SSO and interactive sessions](#otp-sso-and-interactive-sessions) |

### Static credentials

Place one of these `auth` blocks inside a service, alongside `baseUrl` and `spec` (for example under `services.orders`). For a shared identity, put it inside a named [profile](#multiple-accounts-and-shared-profiles) instead.

**Bearer token**

```yaml
auth:
  bearer:
    token: { fromEnv: ORDERS_TOKEN }
```

The server adds `Authorization: Bearer <token>`. The source value holds only the token, without the `Bearer ` prefix.

**Basic authentication**

```yaml
auth:
  basic:
    username: tester
    password: { fromEnv: API_PASSWORD }
```

Username and password are read independently and Basic-encoded. Both can also come from a file or `fromCredential`. Only a Basic literal may be an empty string.

**API key in a header, query string or cookie**

```yaml
auth:
  apiKey:
    header: X-API-Key
    value: { fromEnv: API_KEY }
```

Replace `header` with `query` or `cookie` if your API needs that. Each entry picks **one** destination. You can also use a list and combine methods:

```yaml
auth:
  bearer: { token: { fromEnv: ACCESS_TOKEN } }
  apiKey:
    - { header: X-CSRF-Token, value: { fromEnv: CSRF_TOKEN } }
    - { query: tenant, value: demo }
  cookies: true
```

Bearer, API key and the cookie jar can be combined. Bearer and basic cannot, because both use `Authorization`. Header names that collide case-insensitively are rejected. Query and cookie names are case-sensitive.

**Cookie jar**

`auth: { cookies: true }` enables the auth's own cookie jar. It is not a raw `Cookie` string. It is normally paired with a login recipe that has `capture.cookies: true` (see below). A cookie-only auth is not considered logged in while the jar is empty. To import cookies you already have, use a [session](#otp-sso-and-interactive-sessions).

### Secret sources

The same syntax works for `token`, `value`, `username`, `password` and the initial values in `credentials`:

| Syntax | Meaning |
|---|---|
| `{ fromEnv: API_TOKEN }` | Read an environment variable of the MCP process |
| `{ fromFile: ./secrets.json, pointer: /orders/token }` | Read a field from a JSON file |
| `{ fromFile: ./token.json }` | Read the JSON root. The file must contain a JSON value such as `"demo-token"`, not plain text |
| `demo-token` | A literal. Produces a warning based on the field name; the value is never logged |
| `{ fromCredential: accessToken }` | Use a named value from the current auth, usually captured by a recipe |

`fromCredential` cannot be used in initial `credentials`, in catalog `credentialSources`, or in spec-fetch auth. Env and file values for a binding must be strings; objects and numbers are not silently converted. A missing source never silently falls back to anonymous. Secret files are protected from upload and export, but you are responsible for their permissions, and you should not commit them.

### Multiple accounts and shared profiles

```yaml
profiles:
  qa:
    auth: { bearer: { token: { fromEnv: QA_TOKEN } } }
  admin:
    auth: { bearer: { token: { fromEnv: ADMIN_TOKEN } } }

services:
  orders:
    baseUrl: https://orders.dev.example.test
    spec: ./orders.json
    auth:
      profiles: [qa, admin]
      defaultProfile: qa
  reports:
    baseUrl: https://reports.dev.example.test
    spec: ./reports.json
    auth: { profile: qa }
```

- A call to `orders` with no auth choice uses `qa`. To use `admin`, pass `"auth":{"mode":"profile","profileId":"admin"}` to `invoke_operation`.
- If a service lists `profiles` but has no `defaultProfile`, requests are anonymous by default. The first profile is never picked for you. Auth tools aimed at that service ask you to name a profile.
- To control a profile directly, call `authenticate` or `get_auth_status` with `{"profile":"qa"}`. Do not pass both `service` and `profile`.
- A profile is usable only on services that reference it. Two services using `qa` share the same credentials, cookie jar and refresh task. Cookies are still scoped by domain and path.
- A named profile can have its own `credentials`, `authentication` and `refresh`. For recipes, set `request.service` explicitly; it may point to a separate identity service. That only lets the recipe call that operation. It does not give the identity service your business credentials.
- A service that references a profile must not also have its own `credentials`, `authentication` or `refresh`. Put them in the profile.

### Login and refresh

Use a recipe when you must call an API to obtain credentials. A username and password are not required: the body can be a grant code, client credentials, or whatever your API's contract needs.

Three parts have different roles:

- `auth`: **what to send** on business requests.
- `credentials`: initial named values. They are not sent unless referenced.
- `authentication` / `refresh`: call **one operation**, then capture the result.

**Example: grant code plus refresh token**

```yaml
services:
  accounts:
    baseUrl: https://accounts.dev.example.test
    spec: https://accounts.dev.example.test/v3/api-docs
    auth:
      bearer: { token: { fromCredential: accessToken } }
      apiKey: { header: X-CSRF-Token, value: { fromCredential: csrf } }
      cookies: true
    credentials:
      grantCode: { fromEnv: GRANT_CODE }
    authentication:
      request:
        operation: POST /session/exchange
        body:
          json:
            grantCode: { fromCredential: grantCode }
      capture:
        credentials:
          accessToken: { bodyPointer: /session/accessToken }
          refreshToken: { bodyPointer: /session/refreshToken }
          csrf: { header: X-CSRF-Token }
        cookies: true
    refresh:
      request:
        operation: POST /session/refresh
        body:
          form:
            refresh_token: { fromCredential: refreshToken }
      capture:
        credentials:
          accessToken: { bodyPointer: /access_token }
          refreshToken: { bodyPointer: /refresh_token }
```

Both operations must exist in the spec. A JSON Pointer such as `/session/accessToken` reads `response.session.accessToken`. The refresh token stays in the credential store. In this example it is sent only by the refresh recipe, never on business requests.

**How to use it.** The tool name comes first, followed by its JSON arguments. These are not shell commands.

1. `authenticate` with `{"service":"accounts"}`.
2. `get_auth_status` with `{"service":"accounts"}` until it stops reporting `recovering`.
3. When the state is `ready`, call the API normally.
4. To refresh manually: `authenticate` with `{"service":"accounts","action":"refresh"}`.

You can also ask the agent: "Authenticate the accounts service with the configured recipe, wait until it finishes, then report the status. Do not show any credentials."

**Rules to remember**

- `authenticate` runs only `authentication`. Without a recipe it reloads static sources. It never logs in automatically when a business call lacks credentials.
- `action: refresh` runs only `refresh`. Without a refresh recipe it fails locally with `AUTH_REFRESH_UNAVAILABLE`.
- A **401** can start a background refresh, but **the original request is never replayed automatically**. The caller still receives the 401 plus `authRecovery`. After the refresh finishes, you or the agent decide whether to call again.
- A **403**, an anonymous request, a session, or a request with an `Authorization` override does not trigger a refresh.
- While a recipe runs, new business requests fail with `AUTH_RECOVERING`. Calling the same action again joins the running one; a different action fails with `AUTH_BUSY`.
- A failed refresh does not retry in a loop. Request a retry explicitly with `authenticate` and the right action.
- Captured credentials, cookies and binding updates are applied together. If a required capture is missing, nothing is applied partially. A credential not named in the capture keeps its old value, so to rotate a refresh token you must capture it again.
- Header captures in managed recipes keep the header content as-is, including `Bearer `. A scalar capture accepts a non-empty string or a finite number; numbers become strings.
- A recipe accepts HTTP 200-299 by default. Set `successStatuses: [200, 201]` to change that. Recipes do not follow redirects, do not replay, and do not run prerequisite recipes.

**Recipe requests.** `request` supports `service`, `operation`, `path`, `query`, `headers`, `cookies`, `body` and `auth`.

- `service` defaults to the service that owns the recipe. A recipe in a named profile must set it explicitly.
- `request.auth` defaults to anonymous and does **not inherit** the owner's bearer or cookies. To send them, declare the auth methods explicitly. `cookies: true` uses the current jar.
- Templates are substituted in payloads: `{fromEnv}`, `{fromFile,pointer?}`, `{fromCredential}`. Wrap a value as `{literal: {fromEnv: "text"}}` to send that object unchanged.
- A `fromCredential` name must be declared in initial credentials or in a capture. Authentication can only use credentials with an initial definition, not its own future captures. Refresh can use what authentication captured.
- A capture needs non-empty credentials or `cookies: true`. Capturing cookies requires the owner to have `auth.cookies: true`.
- An authentication capture starts a fresh cookie jar. A refresh keeps and updates the existing jar.

A recipe body takes **one** of these forms. They are alternatives, so do not paste all four into one recipe:

```yaml
# JSON; you can add contentType next to json
body: { json: { name: demo } }

# application/x-www-form-urlencoded, for example client credentials
body:
  form:
    grant_type: client_credentials
    client_id: { fromEnv: CLIENT_ID }
    client_secret: { fromEnv: CLIENT_SECRET }

# Multipart; files must be under uploadRoots
body:
  multipart:
    fields: { note: demo }
    files: [{ field: document, path: ./fixtures/demo.pdf }]

# Binary
body: { binary: { file: ./fixtures/demo.bin, contentType: application/octet-stream } }
```

File paths in recipes are fixed configuration. They cannot come from credential substitution.

### OTP, SSO and interactive sessions

Use a session when an agent and a person must work through several steps: request an OTP, enter it, receive a token or cookie, then call the API. The server never requests an OTP, polls, opens a browser or solves a CAPTCHA by itself. A session is bound to one service.

**Capture from a response**

1. Call the operation that requests the OTP **once, on explicit request**, with `auth: {mode: anonymous}`.
2. The person provides the OTP. Call the verify operation with `invoke_operation`:

```json
{
  "service": "accounts",
  "operation": "POST /otp/verify",
  "revision": "<revision>",
  "auth": { "mode": "anonymous" },
  "input": { "body": { "json": { "value": { "code": "<OTP-provided-by-the-user>" } } } },
  "capture": {
    "tokens": [
      { "id": "access", "type": "bearer", "from": "body", "pointer": "/token" }
    ],
    "cookies": true
  }
}
```

3. Read `capture.sessionId` when `capture.state` is `captured`.
4. Call business operations with `auth: {mode: session, sessionId: ...}`.

Enable `capture.cookies` only if the response really sets cookies. To capture a token from a header, use `{"id":"access","type":"bearer","from":"header","header":"Authorization"}`. Unlike managed recipes, a session's bearer-header capture strips the `Bearer ` prefix. For an API key, use `type: apiKey` with `in: header|query|cookie` and `name`.

A capture applies only to 200-299 responses by default; set `successStatuses` to change that. A failed capture never updates a session partially. To update an existing session, add `capture.sessionId`.

**Import credentials you already have**

Prefer declaring a catalog in the config:

```yaml
credentialSources:
  qaToken: { fromEnv: QA_SESSION_TOKEN }
```

Then call `manage_session`:

```json
{
  "action": "create",
  "service": "accounts",
  "credentialSourceIds": [{ "sourceId": "qaToken", "type": "bearer" }]
}
```

Only ids declared in top-level `credentialSources` can be imported. Inline secrets in a service or profile, and captured refresh tokens, do not appear in the catalog automatically.

If you must import values directly (they may end up in AI conversation history):

```json
{
  "action": "create",
  "service": "accounts",
  "credentials": {
    "components": [{ "id": "access", "type": "bearer", "value": "<token>" }],
    "cookies": [{ "name": "sid", "value": "<cookie-value>" }]
  }
}
```

Inspect with `{"action":"inspect","sessionId":"<id>"}`, or omit `sessionId` to list sessions. Delete with `{"action":"delete","sessionId":"<id>"}`. Inspect returns metadata only, never secrets.

Sessions are bound to one service, do not refresh themselves, do not change managed profiles, and are never promoted to profiles. They live in memory and disappear when the process ends.

## Large responses and files

The server stores responses as artifacts and returns a bounded view, so long files and base64 strings do not flood the conversation.

- `bodyTransformed: true`: the view was shortened and is not the full response.
- `omissions`: which fields were shortened, why, their JSON Pointer and the artifact id.
- `rawBodyArtifact`: the response entity bytes after HTTP content decoding, with metadata and a SHA-256.

### Read part of an artifact

Call `read_artifact` with a pointer:

```json
{ "artifactId": "<id>", "pointer": "/data/status" }
```

Or page through it:

```json
{ "artifactId": "<id>", "offset": 0, "limit": 4096 }
```

Use `nextOffset` from the result to continue. A pointer to a string returns text, and a pointer to an object or array returns JSON. Reading a binary artifact returns metadata only; use export to get the file. Pointers work on the parsed JSON value (number precision is limited); exporting `original` keeps the exact bytes.

### Export a file

The destination must be under `files.exportRoots`. Call `export_artifact`:

```json
{
  "artifactId": "<id>",
  "pointer": "/data/imageBase64",
  "destination": "/absolute/path/exports/image.png",
  "representation": "decoded"
}
```

| Representation | Result |
|---|---|
| `original` | The artifact's original bytes |
| `text` | The text of the artifact, or of the field at the pointer |
| `decoded` | Strict base64 decoding of the string |

Export never overwrites an existing file and never follows a symlink out of a root. File names from `Content-Disposition` are not trusted. By default artifacts exist only for the lifetime of the process and are removed on normal shutdown; exported files stay. See [Trace, policies and session lifecycle](#trace-policies-and-session-lifecycle) to keep a session on purpose.

To mark a base64 field explicitly in the config:

```yaml
encodedFields:
  - service: orders
    pointer: /data/*/thumbnail
    encoding: base64
    mediaType: image/png
```

`*` matches one path segment. Add `operation` to limit a rule to one operation. Schema hints such as `format: byte`, `contentEncoding` and data URIs also help confirm an encoding. A string that merely looks like base64 is not asserted to be base64.

If a response exceeds `responseBytes`, you still get the status and headers, but the body may be incomplete (`bodyComplete: false`). Total artifact storage is capped by `sessionArtifactBytes`, and the number of artifacts by `maxArtifacts`.

## Troubleshooting

Start with the config check:

```bash
npx -y @nhan7777/openapi-swagger-mcp@0.1.2 --config /absolute/path/config.yaml --check
```

The report contains `ok`, `services`, `checks`, `remoteSpecsChecked: false` and `operationsChecked: false`. Each check has a `field`, a `state` (`ok`, `pending` or `error`) and possibly a `code`.

- `pending` means a credential will be captured at runtime. It is not a static error.
- It checks env and file sources (even when a recipe exists), local spec and CA files, and upload/export roots.
- It does not fetch remote specs, parse spec content, check operations remotely, run recipes or create the artifact directory.
- If the config cannot be parsed or fails the schema, stderr has a sanitized error and stdout is empty. If it parses, stdout has one JSON report with no secret values.

| Exit code | Meaning |
|---|---|
| `0` | Static checks passed |
| `1` | A config, source, file or root problem |
| `2` | CLI usage error, such as a missing `--config` or an unknown flag |

### Common problems

| Symptom / code | What to do |
|---|---|
| The MCP client cannot connect | Check Node is 22.19 or newer, that the CLI and config paths are absolute, and that the entry does not contain `--check`. If you run from source, check it is built |
| `CONFIG_INVALID` | Run `--check` and read the failing field. Use the JSON Schema for suggestions, and do not mix in old syntax (see [Limitations](#limitations)) |
| `SOURCE_UNAVAILABLE` / `CREDENTIAL_INVALID` | Check the MCP process's environment, the JSON file, the pointer, and that the value is a string. Do not paste secrets into logs |
| A service shows `unavailable` | Read the error in `list_apis`. Check the spec, its refs, the CA file and file permissions, fix them, then run `refresh_specs`. Minor spec problems only produce [warnings](#imperfect-specs-warnings-instead-of-errors) and do not make a service unavailable |
| `AUTH_REQUIRED` | Check the static sources or call `authenticate`. For OTP flows, use a session |
| `AUTH_RECOVERING` | Wait until `get_auth_status` stops reporting `recovering`. Do not mass-retry write operations |
| `AUTH_BUSY` | Wait for the running action to finish before requesting a different one |
| `AUTH_REFRESH_UNAVAILABLE` | No refresh recipe is configured. Authenticate again explicitly or import a session |
| `AUTH_RECIPE_INPUT` | A credential or template the recipe needs has no value. Recipes do not run prerequisite steps |
| `AUTH_RECIPE_INVALID` / `AUTH_RECIPE_FAILED` | Check the recipe's operation, request body, status and service |
| `AUTH_CAPTURE_FAILED` | Check the JSON Pointer, header or Set-Cookie. Capture results are never published partially |
| `AUTH_TARGET_REQUIRED` | A service with several profiles has no default. Pass `{profile: ...}` |
| `PROFILE_NOT_ALLOWED` / `SESSION_SERVICE_MISMATCH` | Use a profile the service lists, or a session created for that service |
| `SPEC_REVISION_MISMATCH` | Get a fresh revision from list, search or schema, and re-read the contract before calling |
| `UPLOAD_NOT_ALLOWED` / export errors | Check the roots, the real path, protected files, and that the destination does not exist |
| HTTP 401 after a refresh started | That is still the original request's response. Wait for the refresh, then decide whether to send a new request |

**Restart or refresh?** Config changes need a restart of the MCP process. `refresh_specs` only reloads specs. `authenticate` without a recipe reloads static auth sources, not the whole config.

## Request and response reference

### The normal flow

| Step | Tool | Example arguments |
|---|---|---|
| See services and revisions | `list_apis` | `{}` |
| Find an operation | `search_operations` | `{"service":"orders","query":"order detail","limit":5}` |
| Read its contract | `get_operation_schema` | `{"service":"orders","operation":"GET /orders/{id}","revision":"<revision-you-just-received>"}` |
| Send the request | `invoke_operation` | See below |

A complete `invoke_operation` call:

```json
{
  "service": "orders",
  "operation": "GET /orders/{id}",
  "revision": "<revision-you-just-received>",
  "input": {
    "path": { "id": "demo-123" },
    "query": { "includeItems": true },
    "headers": { "X-Request-ID": "demo-request" }
  }
}
```

`operation` is the key returned by search, usually `METHOD /path`. It is not the `operationId`. `revision` is the spec revision, which stops you calling an operation based on an outdated contract. When the spec changes, call `refresh_specs` with `{"service":"orders"}`, then search or read the contract again to get the new revision. A failed refresh keeps the last valid snapshot.

`search_operations` accepts `service`, `method`, `tag`, `includeDeprecated`, `fields`, `limit` and `cursor`. See [Search](#search) for what it matches, how results are ranked and what the extra output fields mean. Pass `nextCursor` with the same query to get the next page. Changing the query, a spec revision, the search config or the operation filter invalidates an old cursor; the error says which (`details.reason`).

### Request bodies

The snippets below are **fragments** that go inside `input`. They are not complete tool calls. A request has at most one body type.

Note the difference from auth recipes: `invoke_operation.input.body` uses the `json.value` and `form.fields` wrappers, while a recipe `body` uses plain `json` and `form` (see [Login and refresh](#login-and-refresh)).

JSON:

```json
{ "body": { "json": { "value": { "name": "demo", "quantity": 2 } } } }
```

Form (`application/x-www-form-urlencoded`):

```json
{ "body": { "form": { "fields": { "name": "demo", "tags": ["a", "b"] } } } }
```

You can set `contentType` inside `json` or `form` to pick one of the media types the operation declares.

For multipart and binary uploads, first allow directories in the config and create them:

```yaml
files:
  uploadRoots: [./fixtures]
  exportRoots: [./exports]
```

Then pass absolute paths in the tool call.

Multipart:

```json
{
  "body": {
    "multipart": {
      "fields": { "description": "demo" },
      "files": [
        { "field": "document", "path": "/absolute/path/fixtures/demo.pdf", "filename": "demo.pdf", "contentType": "application/pdf" }
      ]
    }
  }
}
```

Binary:

```json
{ "body": { "binary": { "file": "/absolute/path/fixtures/demo.bin", "contentType": "application/octet-stream" } } }
```

The multipart `files` array may repeat the same `field`. Files outside `uploadRoots`, symlinks that escape a root, and protected files are refused. The media type must match what the operation declares, so read the contract before sending.

### Choosing auth, and negative testing

`invoke_operation.auth` has four modes:

| Mode | Behavior |
|---|---|
| `{"mode":"default"}` or no `auth` | Use the service's default auth, or anonymous if it has none |
| `{"mode":"profile","profileId":"qa"}` | Use a named profile the service allows |
| `{"mode":"session","sessionId":"<id>"}` | Use an interactive session bound to the same service |
| `{"mode":"anonymous"}` | Inherit no credentials or cookies. Data you pass explicitly in `input` is still sent |

To test a wrong token, pass your own `input.headers.Authorization`. It overrides the matching credential for that request only, leaves managed credentials untouched, and does not trigger an automatic refresh.

The server **serializes what you give it and does not fix your data**. It adds no defaults, does no type coercion, and does not strip unknown fields or `null`. Omitting the body is different from sending `{"json":{"value":null}}`, which sends the bytes `null`. HTTP 4xx/5xx responses are real results and are not turned into "tool failed validation" errors.

Requests that cannot be sent safely are blocked locally: a missing path parameter, a path escape, CR/LF in a header, a media type the operation does not declare, or an attempt to override headers the transport manages.

### Reading the result

- `sent: false`: the request was not sent. Look at `error.code` and `error.message`.
- `http.status` and `http.headers`: the actual HTTP outcome.
- `bodyView`: the part of the response meant for the agent to read.
- `diagnostics.request` and `diagnostics.response`: spec-based checks, for diagnosis only. They do not replace the HTTP outcome. States are `valid`, `invalid`, `not_available` and `error`.
- `bodyComplete: false`: the body is partial because of a limit or a stream error. Do not conclude the whole response was valid.
- `authRecovery`: the state of a background refresh after a 401. It does not mean the request was replayed.
- Network, TLS and timeout failures do not produce a fake HTTP status. `error.mayHaveBeenSent` says whether the request may already have left the machine. Be careful about retrying write operations.

Redirects are not followed by default. With `followRedirects: true`, only same-origin redirects that stay under the configured `baseUrl` path prefix are followed, within a limit: 303, and POST after 301/302, become GET; 307/308 keep the method and body. Credentials are never forwarded to another origin. A redirect that leaves the service origin, leaves the base path or leaves the allowed destinations is not followed: you get the 3xx response and a note.

## Advanced configuration and limitations

### Authentication for spec downloads and `$ref`s

Spec-fetch auth is separate from business auth. It only uses static secrets and never runs a recipe:

```yaml
services:
  privateApi:
    baseUrl: https://api.dev.example.test
    spec:
      source: { url: https://docs.dev.example.test/openapi.json }
      auth:
        bearer: { token: { fromEnv: DOCS_TOKEN } }
      allowedOrigins: [https://schemas.dev.example.test]
      roots: [./specs]
    auth:
      bearer: { token: { fromEnv: API_TOKEN } }
```

Spec-fetch credentials are sent only to the origin of the spec source, never to a different origin reached through a `$ref`. A remote spec cannot reference local files. A local `$ref` must stay inside the allowed roots; the directory of a local spec is used as that spec's root. Spec fetches do not follow redirects. A missing or broken ref causes that service's snapshot to be rejected, and other services keep working.

### Imperfect specs: warnings instead of errors

Framework-generated specs (NestJS, for example) often have small mistakes. These three do **not** block a service. They appear in `warnings` from `list_apis`. The list is capped at 20 entries, 4096 bytes in total, and 512 bytes and one line per entry. Priority order is excluded operations, then security schemes, then duplicate `operationId`. Exact counts are in `warningSummary` (`total`, `shown`, `omitted`, `excludedOperations`), not in an extra line at the end of the list. If `list_apis` exceeds its output budget, warning text is shortened (counts stay accurate). If even the metadata is too large, the result has `servicesInline: false` and a `servicesArtifact` you read in full with `read_artifact`.

| Spec problem | Handling | Effect |
|---|---|---|
| Duplicate `operationId` across endpoints | Warning only | No effect on calls, because operations are called by `METHOD /path`. Searching for that id returns several hits; tell them apart by the `operation` field |
| Extra `in`/`name` on a `type: http` security scheme | The extra fields are ignored during validation; the original spec is kept | No effect |
| An operation declares a path parameter that is not in the path (for example `customerId` with no `{customerId}` in the path) | **That operation alone is excluded** from the service | It cannot be found. Calling it directly returns `OPERATION_UNKNOWN` with the message `operation was excluded from this specification` and `details.reason` = `PATH_PARAMETER_NOT_IN_TEMPLATE`. Other operations work normally |

Other problems still block the whole service with `SPEC_INVALID`: for example a path template `{id}` with no matching parameter, a missing `$ref` target, or a malformed OpenAPI structure.

Warnings only report problems. They do not repair the spec, so fix it at the backend where possible.

**`$ref` combined with a method or `parameters` is rejected.** Any object in a spec that has a string `$ref` together with `get`, `put`, `post`, `delete`, `options`, `head`, `patch`, `trace` or `parameters` is refused (`<document>: an object combines $ref with execution siblings (a method or parameters)`). Tools disagree about what to do here (ignore, override or merge), and bundlers merge silently, so the server does not pick one; the spec author must choose. `summary`, `description` and `x-*` siblings are still allowed.

The scan runs on every original document (the root and every allowed file or URL a `$ref` points to) as it is read, before the bundler merges them, and again on the bundled document. This is because an extended `$ref` on a container (for example `paths: { $ref: 'p.json', '/a': { $ref: '#/x' } }`) can make the bundler produce a `$ref` with a method from two objects that were each valid on their own. The server checks object shape before and after bundling and does not re-resolve `$ref` paths itself. The cost: every object with this shape is rejected, including not only sample data (`example`, `enum`, `default`, `x-*`) but also schemas, Links and Responses, including shapes that only appear after a merge. This is a compatibility limit. When you hit it, change the spec (rename the key, or remove the `$ref` from that object) if doing so does not change what the spec means.

**Extended `$ref` is accepted.** When a `$ref` is extended on a container and the merged result no longer contains a forbidden combination, the server accepts the bundler library's merge: the extender wins for scalar values, objects are merged, and arrays are replaced entirely. For example, if an external file declares `parameters` with a required query parameter `external`, and the extender declares `parameters` with `root`, the published contract has only `root`. The `external` parameter disappears because arrays are replaced, not combined. The contract published over MCP, and used to serialize requests, is the one **after bundling and validation**. There is no evidence that the real server accepts this contract, so read it with `get_operation_schema` and try it in a suitable environment before sending requests with side effects.

**Read limits.** The number of distinct `$ref` strings the bundler asks to read is capped by `refGraphDocuments`. The total bytes read, including the same file read several times under different spellings such as `.//a.json`, is capped by `refGraphBytes`. Exceeding a configured read budget stops with `SPEC_LIMIT_EXCEEDED`. These input byte budgets are not hard limits on heap or RSS. Spec load and parse errors are capped at 2048 bytes.

### TLS per service

```yaml
tls:
  caFile: ./certs/dev-ca.pem
  verify: true
```

This block goes under a service. `verify: false` turns off TLS verification for that service only and produces a warning. Use it only when you really need it in a test environment; it is not the way to fix a default certificate problem. No tool changes TLS settings at call time.

### Files and limits

```yaml
files:
  uploadRoots: [./fixtures]
  exportRoots: [./exports]
  artifactRoot: ./runtime-artifacts
limits:
  requestTimeoutMs: 30000
  responseBytes: 52428800
  uploadBytes: 52428800
  toolOutputBytes: 32768
```

Declare only the values you want to change. Every limit is a positive integer with a maximum; check the JSON Schema for the ranges.

| Key | Default | Scope |
|---|---:|---|
| `requestTimeoutMs` | 30000 ms | A request, including redirect hops. Recipes also have a timeout |
| `maxConcurrentRequests` | 8 | Normal requests |
| `recipeConcurrency` | 2 | A separate lane for auth recipes |
| `specDocumentBytes` | 10 MiB | One spec document |
| `refGraphDocuments` | 100 | Documents in the ref graph |
| `refGraphBytes` | 50 MiB | Total bytes in the ref graph |
| `refGraphDepth` | 64 | Ref and template depth |
| `responseBytes` | 50 MiB | One response |
| `uploadBytes` | 50 MiB | One upload |
| `sessionArtifactBytes` | 250 MiB | Total artifact quota |
| `inlineStringBytes` | 4096 bytes | Threshold for showing a string inline |
| `toolOutputBytes` | 32768 bytes | Budget for one tool result |
| `artifactPageBytes` | 16384 bytes | One artifact read page |
| `maxRedirects` | 5 | Redirects followed when enabled |
| `maxArtifacts` | 20000 | Artifacts per session; more are cut like a full quota |
| `traceBytes` | 64 MiB | Disk budget of one session's trace; at least 4 × `traceSegmentBytes` |
| `traceSegmentBytes` | 4 MiB | One trace file |
| `traceEventBytes` | 64 KiB | One trace event; at most half a segment |
| `traceIndexBytes` | 32 MiB | Memory budget of the trace index, write queue included (a conservative estimate, not a heap limit) |
| `traceQueueBytes` | 4 MiB | Trace bytes waiting to be written; more events are dropped and counted |
| `traceMaxOpenRecords` | 256 | Calls, exchanges and auth runs in progress at once |
| `traceInputInlineBytes` | 4096 bytes | Agent input kept inline in the trace; larger input becomes one artifact |
| `traceFieldValueBytes` | 4096 bytes | A longer header, cookie or query value is not recorded |
| `requestBodyTraceBytes` | 1 MiB | A larger request body is not stored as an artifact |

`uploadRoots` and `exportRoots` default to empty, so upload and export are disabled until you declare them. `artifactRoot` may not exist yet; the server creates it at runtime.

### Search

`search_operations` is lexical and runs inside the server process on loaded specs. It uses no model, native inference runtime, embedding service or search network call. The optional semantic/model experiment was removed; `search.semantic` is not supported.

- **What is indexed:** path, `METHOD /path`, operationId, tags, summary, description, parameter names and descriptions, request and response field paths (nested, through `$ref`, arrays and `allOf/anyOf/oneOf`, response headers included), schema names and field descriptions. Request and response are kept apart.
- **Text:** Unicode-aware. Case, compatibility forms and accents on Latin letters are folded (`don hang` finds `đơn hàng`), marks in other scripts are kept (`が` and `か` differ). `orderId`, `order_id`, `order-id` and `OrderID` meet. Han, Kana, Thai, Lao, Khmer and Myanmar text is matched by character and character pair, not by dictionary words.
- **Ranking:** an exact path, `METHOD /path` or operationId (case-sensitive) comes first, then a concrete path that matches a template (`/orders/42` finds `/orders/{id}`), then a folded identifier match, then lexical matches weighted by field, then typo matches. Typo matching only applies to words that exist nowhere in the searched fields, within a fixed edit distance and a fixed comparison budget.
- **`fields`:** restricts where terms may match: `identifier`, `text`, `parameter`, `requestField`, `responseField`, `schema`. `{"query":"taxCode","fields":["responseField"]}` finds operations that return `taxCode` and not ones that only accept it.
- **Query:** an empty query browses (no ranking). A query without a letter or digit, such as an emoji, is an error (`QUERY_UNPROCESSABLE`), never a list of everything. `fields` needs a query.
- **Result:** each hit has `tier`, a score and up to three `matches` (field, original text, the terms that matched, `exact|token|alias|fuzzy`, and where a schema field lives). `targets` maps each service in the page to its `baseUrl`. `unavailableServices` lists configured services without a valid spec. `coverage` appears when an index is incomplete, with the reason.
- **Output budget:** the whole result is kept within `limits.toolOutputBytes`: evidence is trimmed first, then the page shrinks, and `nextCursor` always continues after the last hit returned. If one hit with its required metadata cannot fit, the call fails with `OUTPUT_TOO_LARGE`.
- **Operation filter:** operations hidden by a service's `operations` filter are never indexed, so they cannot be found or shown as evidence. The filter's identity is part of every cursor.
- **Aliases:** words your specs do not use can be declared in `search.aliases`. Nothing is treated as a synonym unless you list it, and groups do not chain.

```yaml
search:
  aliases:
    - { terms: ["đơn hàng", "order"], services: [orders] }
  limits:
    schemaDepth: 6                   # more keys: see examples/config.example.yaml
```

Index memory is bounded by `search.limits.indexBudgetBytes` (default 64 MiB, a conservative estimate and not a heap measurement), split equally between the configured services. A spec that does not fit is indexed in priority order (identifiers first) and `coverage` says what is missing. Retrieval quality is measured on a small synthetic corpus in `bench/search`; see its README for the method and for results that miss their targets.

Lexical discovery does not infer undeclared business synonyms. On the frozen synthetic dev2 dataset, no-alias paraphrase recall@5 is 1/8 and MRR is 0.041667, below the released baseline's paraphrase MRR 0.25; false positives are 6/64. These are limitations, not improved-quality claims. Prior semantic experiment reports/results are historical evidence only; they do not describe shipped functionality.

### Trace, policies and session lifecycle

The server is a local process: it calls the APIs you configured directly and keeps raw responses in local artifacts. It does not send telemetry or call embedding, reranking or model services. Content the assistant reads can still be forwarded by your MCP client to its model provider; that is outside this server. If the client runs in a container or on another machine, requests start from there.

**What is recorded.** Every tool call and every HTTP exchange this process makes gets an id: `callId`, `requestId` (one per HTTP exchange, including each redirect hop, login, refresh and spec or `$ref` fetch) and `authRunId`. `invoke_operation` returns `trace: { callId, requestIds }`. A record has the service, operation, spec revision, timing, a send state and links to artifacts (the request body, the agent's input when it is large, the response body). Raw bodies are never copied into the trace or logs; they stay in artifacts. The server only knows what it did itself: it does not infer a task from requests that happen close together.

| Send state | Meaning |
|---|---|
| `not_sent` | Nothing left the process (policy block, connection refused, DNS or TLS failure before sending) |
| `maybe_sent` | The request may have been sent but there is no response (timeout, reset) |
| `response_received` | An HTTP response arrived. 4xx and 5xx are normal outcomes, not failures |

**What is not recorded.** Header, cookie and query values are recorded as the agent sent them. Credentials the server injected from your config, a session or the cookie jar are recorded by name only (`unrecordedReason: credential`). For logins and refreshes the request is not stored (it is built from template secrets) and response header values are not recorded; the raw response body is kept as a local artifact (mode 0600) whatever the status, because it is debugging data. That artifact can contain tokens. The trace is not a packet capture: it observes the HTTP client, and `host`, `content-length` and `connection` are added by the library and not observed.

**Reading it.** The trace is read inside the process through `App.trace` (bounded queries that filter before paging). No MCP tool exposes it yet. With `files.retention.keepOnExit: true` the session directory keeps the JSON Lines trace (`trace/seg-N.jsonl`), the artifacts and `artifacts.jsonl` for manual inspection.

**Bounds.** Trace memory, disk and write queue are hard-capped (see the limits above). When a cap is reached the trace stops recording what does not fit, counts it (`droppedEvents`, `droppedRecords`) and reports `degraded` instead of failing the tool call. Writes are asynchronous: only data that was flushed is on disk after a crash. Artifacts are never evicted while the process runs.

**Destinations.** Business requests go to the service's `baseUrl` origin, a recipe to the origin of the service it names, a spec to its own origin and `$ref`s to `allowedOrigins`. Add a top-level `network.allow` list of exact origins to require that all of them are listed (the server refuses to start otherwise and `--check` reports `NETWORK_NOT_ALLOWED`). The check compares origin strings at every redirect hop. It does not look at the IP a name resolves to, proxies or CAs, and it does not block private addresses: a loopback or VPN endpoint you configure is reachable. It is not an SSRF or DNS-rebinding defence.

**Operation filter.** `services.<id>.operations` with `include` and `exclude` rules (`method`, `path` glob, `operationId`, `tag`) hides operations from search, contracts and invocation; a hidden operation answers `OPERATION_NOT_ALLOWED` and sends nothing. Your configured login and refresh recipes are not filtered; the agent cannot run them. See the `operation-filter` recipe in the example config.

**Session lifecycle.** By default a normal shutdown deletes the session directory and the next start deletes directories left by a crashed process. `files.retention` changes this: `keepOnExit` keeps the directory and marks it as ended on purpose, `crashedSessionMaxAgeHours` keeps crash leftovers for that long, and `maxRetainedBytes` trims retained sessions oldest first. Shutdown waits for captures and reads that are running and does not delete files under them.

### Local request inspector

Set `inspector.enabled: true` in the API config to enable the optional read-only browser inspector. It binds only to loopback. Open the `url` from the current artifact session's `inspector.json` locally; the descriptor is mode 0600 and its URL carries a session token. Do not paste that URL into chat or logs. The inspector is separate from the stdio MCP transport.

The unified timeline groups tool actions with their HTTP requests and updates automatically. Search, scope and service/purpose/status filters apply across all records still retained in the trace, including matches older than the first 200 records. **Load older records** follows bounded cursor pages; `inspector.timelineLimit` caps each page, not the total history you can browse. Parent actions may be included again as context and are deduplicated by the UI. Evicted records cannot be recovered by pagination.

`GET /api/feed` returns `calls`, `exchanges`, trace status and an optional `nextCursor`. Send that cursor with the same filters to continue; cursors are tied to the trace session and filter set. Calls and exchanges are ordered by sequence; context parents do not consume a primary record slot. Filtering scans bounded trace pages rather than collecting the whole index in memory. Sparse searches and deep continuation pages can therefore take longer on a large retained index.

Pause freezes timeline synchronization; Resume catches up using the active filters and loaded depth. The header includes an `Auto`/`Light`/`Dark` theme switcher, and exchange details open in a side-by-side `Request + Response` workbench with `Copy URL`, `Copy Request` and `Copy Response` actions (`Copy Request`/`Copy Response` page stored body artifacts through `nextOffset` to completion while keeping masked fields redacted and labelling derived formatted/text/hex representations and incomplete stored bodies). Selecting another row supersedes pending detail responses and live refreshes, so an older request cannot replace the current detail. Request/response bodies stay paged in the viewer, and injected credentials remain unrecorded. Explicitly revealing agent-supplied secrets or opening auth-response artifacts can expose sensitive local data.


### Limitations

- A local MCP server over stdio. It is not a hosted gateway or an HTTP MCP server.
- Not a workflow engine: one recipe is one operation. The agent or a person orchestrates multi-step flows.
- No automation of OAuth/PKCE callbacks, OTP polling, CAPTCHA or browser login. No scripting, HMAC signing or mTLS client authentication.
- No telemetry. Specs and responses are untrusted data, not instructions for the agent, and descriptions and extensions are never executed.
- Validation depends on spec quality. An unknown format is recorded as unverified, not as passed. Search is deterministic token scoring; the project makes no claims about token savings or semantic search accuracy.
- Compatibility note: older config and tool forms were removed with no aliases. `bearer.login`, profile `components`/`recovery`, service-level `allowedProfiles`/`defaultProfile`, `$source`/`$component`, `authenticate_profile` and `get_profile_status` no longer work. Use the forms in this guide.

## Tool reference

| Tool | Use it to |
|---|---|
| `list_apis` | See services, spec readiness and revision, operation counts, spec `warnings`, auth mode and capability, and spec load errors |
| `search_operations` | Search by identifier, text, parameter, request/response field or schema name, with match reasons, field scopes and paging |
| `get_operation_schema` | See an operation's parameters, body, response schemas, security and refs. Large contracts go to an artifact |
| `invoke_operation` | Send a real request and get the HTTP outcome, diagnostics and an optional capture into a session |
| `refresh_specs` | Reload and validate specs. On failure the previous valid snapshot is kept |
| `authenticate` | Run authentication, run an explicit refresh, or reload static auth sources |
| `get_auth_status` | See state, revision, capability, credential and binding presence, cookie names and failures. Never returns credential values |
| `manage_session` | Create, inspect or delete a session, importing credentials directly or from the catalog |
| `read_artifact` | Read a stored response or contract by page or JSON Pointer |
| `export_artifact` | Write bytes, text or base64-decoded data to a new file under `exportRoots` |

The tool count does not grow with the number of endpoints. No tool accepts an arbitrary URL to call outside the configured services, an arbitrary env or file secret name, a script, or a parameter that switches environments.

## Registries and marketplaces

The npm package runs **locally** in your MCP client. A catalog listing does not host it or give the catalog access to your API config. Do not upload private configs or tokens to a marketplace to make an installation work.

| Channel | Status checked on 2026-10-21 | Installation |
|---|---|---|
| [npm](https://www.npmjs.com/package/@nhan7777/openapi-swagger-mcp) | `0.1.2` published | Follow [Quick start](#quick-start) or the [client guide](docs/clients.md) |
| [Official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.nhan7777%2Fopenapi-swagger-mcp) | `0.1.2` active and latest | Metadata points at the npm stdio package; provide your local `--config` path |
| [GitHub MCP Registry](https://github.com/mcp) | Separate listing not verified | Official Registry publication does not prove immediate visibility in this gallery; manual client setup works independently |
| [Glama](https://glama.ai/mcp/servers/nhan7777/openapi-swagger-mcp) | Repository synced; README shows `0.1.2`. Tool inspection is still pending | Follow the npm instructions; Glama's hosted deploy is not configured for this server |
| [Smithery](https://smithery.ai/future) | Not submitted | Connection management, accounts and CLI are scheduled to shut down on 2026-10-31; no Smithery adapter or hosted endpoint is provided |

The repository owner can [claim the Glama listing](https://glama.ai/mcp/servers/nhan7777/openapi-swagger-mcp/admin) through GitHub login and request a repository re-sync. No separate listing is needed. Glama may build and inspect the public repository; that is not permission to supply private API credentials or network access.

## Development

Work from a source checkout:

```bash
npm ci
npm run build
npm run typecheck
npm run gen:schema
npm test
npm run test:integration
npm run smoke
npm run verify:package
npm audit --omit=dev --audit-level=high
```

Build before the integration tests and the smoke test, because some of them run the compiled CLI over stdio. Tests use a loopback backend, synthetic data and self-signed certificates meant only for tests. No real credentials are needed. Run `npm run gen:notices` to update the third-party notices when dependencies change.

`npm test` includes both unit and integration tests; `npm run test:integration` is an optional subset, not an additional gate. CI also validates the configuration cookbook with synthetic sources and rejects changes produced by `gen:schema` that were not committed. After changing the config schema, regenerate and include `config.schema.json` in your change.

For Inspector changes, regenerate embedded assets before building, then run `node tests/inspector-smoke.mjs`. Use `node tests/inspector-smoke.mjs --hold` for browser verification against the compiled CLI and a synthetic backend. The harness prints only its descriptor path, not the token URL. While held, newline-delimited JSON on stdin can generate real MCP traffic:

```jsonl
{"id":"seed","action":"seed","count":230}
{"id":"one","action":"invoke","operation":"GET /widgets/{id}","input":{"path":{"id":7}}}
{"id":"slow","action":"start","operation":"GET /widgets/{id}","input":{"path":{"id":7},"query":{"hold":"1"}}}
{"id":"release","action":"release"}
{"action":"stop"}
```

Each completed invocation emits `command_done` with trace IDs. `start` runs without blocking the command reader; `release` completes held widget responses, allowing deterministic in-flight/live-refresh checks. Stop or Ctrl-C closes the MCP process and removes the descriptor.


Tag publication calls the same nine-cell CI matrix on the tag's commit and waits for every cell to pass. Only then does the publish job build and verify its own tarball, check its SHA-256 companion and publish those exact bytes through npm trusted publishing. The tag must match the package version and its commit must belong to `main`.

After npm publication, the workflow waits up to 20 public metadata checks (15 seconds apart on HTTP 404) and verifies the published name, version, `mcpName` and tarball integrity. It then uses a checksum-pinned `mcp-publisher` and GitHub OIDC to publish `server.json` to the [Official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.nhan7777%2Fopenapi-swagger-mcp). No separate registry token is needed in CI. Registry publication is metadata distribution, not remote hosting.

**If npm succeeds but registry publication fails, npm is already released.** Do not delete the tag, reuse the version or rerun npm publication to fix the catalog. Once that npm version is visible and `server.json` matches it, recover only the registry step from the repository root:

```bash
mcp-publisher validate
mcp-publisher login github
mcp-publisher publish
```

The login opens a device authorization flow. Never commit `.mcpregistry_*` files or paste their contents into chat. See the [official automation guide](https://modelcontextprotocol.io/registry/github-actions). Client-specific marketplaces can index or review the listing separately; being in the Official Registry does not guarantee approval or immediate visibility elsewhere.

`npm run verify:package` needs `npm run build` first. It packs the package for real, installs the tarball into a separate consumer directory, runs `--check`, the bin shim and the smoke test against the installed copy, then audits that installed copy. Only if all of that passes does the tarball land in `.release/<name>.tgz` with a `.sha256` file. If the audit fails, the tarball is kept as evidence in `.release/diagnostic/NOT-RELEASABLE-...`. `npm pack --dry-run` is not a substitute. Verifying a local candidate this way is separate from publishing it. Publishing is a separate, deliberate registry action. The CI matrix (Ubuntu, macOS and Windows with Node 22.19.0, 22 and 24) is its own release condition.

Released under the MIT license. Dependency licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
