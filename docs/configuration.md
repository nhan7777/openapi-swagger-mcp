# ⚙️ Configuration Guide

`openapi-swagger-mcp` reads a single YAML (`.yaml`, `.yml`) or JSON config file passed via `--config /absolute/path/config.yaml`.

For copy-ready recipes covering every feature, open [`examples/config.example.yaml`](../examples/config.example.yaml). To get editor autocomplete and inline validation, point your file at [`config.schema.json`](../config.schema.json):

```yaml
# yaml-language-server: $schema=/absolute/path/to/config.schema.json
version: 1

inspector:
  enabled: true
  port: 0

services:
  orders:
    baseUrl: https://orders.staging.example.test/api/v1
    spec: https://orders.staging.example.test/v3/api-docs
    auth:
      bearer: { token: { fromEnv: ORDERS_TOKEN } }

  catalog:
    baseUrl: http://localhost:8081
    spec: ./specs/catalog.yaml
```

*(In JSON configs, add `"$schema": "/absolute/path/to/config.schema.json"`.)*

---

## 🧭 Core rules

- **📂 Relative paths resolve from the config file's folder**, not from the working directory of your shell or MCP client.
- **🎯 `baseUrl` is the real request prefix.** Calling `GET /orders/{id}` with `baseUrl: https://host/api/v1` sends `https://host/api/v1/orders/{id}`. Any `servers`, `host`, or `basePath` inside the OpenAPI/Swagger spec is ignored. `baseUrl` must be `http(s)` with no `user:pass@`, `?query`, or `#fragment`.
- **🔀 Multiple environments use separate service IDs.** There is no `--env` flag or runtime environment toggle. Name each target clearly, such as `orders-local` and `orders-staging`, and tell the agent which one to use:
  > Use `orders-staging` for this check. Do not call `orders-local`.
  If two environments must never share credentials, cookies, or artifacts, put them in separate config files and register two MCP server entries.
- **🔄 Restart after structural config edits.** `refresh_specs` reloads OpenAPI documents and `authenticate` (with no recipe) reloads static secret sources, but adding services or changing policies requires reconnecting the MCP process.

---

## Passing secrets via environment variables

When a service or profile uses `{ fromEnv: ORDERS_TOKEN }`, the server reads `ORDERS_TOKEN` from **its own MCP process environment**, not from `.env` files or a separate terminal tab.

Pass environment variables inside your MCP client entry:

```json
{
  "mcpServers": {
    "api-dev": {
      "command": "npx",
      "args": ["-y", "@nhan7777/openapi-swagger-mcp@0.1.5", "--config", "/absolute/path/config.dev.yaml"],
      "env": {
        "ORDERS_TOKEN": "replace-with-your-api-token"
      }
    }
  }
}
```

For tokens stored in JSON files, shared profiles, login/refresh recipes, and OTP sessions, see the [🔐 Authentication Guide](authentication.md).

---

## 📄 Spec sources, protected specs & `$ref` handling

### Protected remote specs & external `$ref`s

When fetching the OpenAPI document itself requires auth or follows `$ref` links across extra hosts or local directories, use the object form of `spec`:

```yaml
services:
  privateApi:
    baseUrl: https://api.staging.example.test
    spec:
      source: { url: https://docs.staging.example.test/openapi.json }
      auth:
        bearer: { token: { fromEnv: DOCS_TOKEN } }
      allowedOrigins: [https://schemas.staging.example.test]
      roots: [./specs]
    auth:
      bearer: { token: { fromEnv: API_TOKEN } }
```

- `spec.auth` supports static credentials only and sends them strictly to `spec.source`'s own origin (never to cross-origin `$ref` targets).
- Remote specs cannot `$ref` local files, and spec downloads never follow HTTP redirects.
- Local `$ref` targets must stay inside `spec.roots` (a local spec's own directory is included automatically).
- If one service's spec fails to load, only that service is marked `unavailable`; your other services stay ready.

### Imperfect specs: warnings vs. errors

Real-world generators (like NestJS or Springdoc) sometimes emit minor spec quirks. Known non-breaking quirks produce `warnings` in `list_apis` instead of taking the service offline:

| Spec quirk | How it is handled |
|---|---|
| Duplicate `operationId` across endpoints | ⚠️ Warning only. Operations are addressed by `METHOD /path`. |
| Extra `in` / `name` fields on `type: http` security schemes | ⚠️ Warning only. Ignored during validation. |
| `examples` inside a Schema Object of an OpenAPI 3.0 spec (OpenAPI 3.0 only allows `example` there) | ⚠️ Warning only (one entry with the count). Ignored during validation and kept unchanged in the stored document. Swagger 2.0 still rejects it; OpenAPI 3.1 allows it. |
| Path parameter declared without a matching `{param}` in the URL path | ✂️ **Only that operation is excluded** (`PATH_PARAMETER_NOT_IN_TEMPLATE`). Every other endpoint in the service stays available. |

Broken contracts still reject the service snapshot (`SPEC_INVALID`), including:

- Missing `$ref` targets, invalid OpenAPI schemas, or `{param}` placeholders in a URL path with no matching parameter definition.
- **Combining `$ref` with HTTP methods or `parameters` on the same object** (before or after bundling), because OpenAPI tools disagree on whether siblings override or merge. (`summary`, `description`, and `x-*` siblings are allowed.) When container `$ref`s are extended validly, bundler merges replace arrays rather than concatenating them; check merged contracts with `get_operation_schema`.

---

## 🛡️ Network & operation policies

### Origin allowlist (`network.allow`)

By default, requests can only go to each service's `baseUrl` origin, configured spec origins, and `spec.allowedOrigins`. Add a top-level `network.allow` list of exact origins to enforce a strict allowlist across the whole config (checked statically by `--check` and on every redirect hop):

```yaml
network:
  allow:
    - http://localhost:8080
    - https://orders.staging.example.test
```

> ℹ️ `network.allow` compares normalized `scheme://host:port` origin strings. It does not inspect DNS resolution, IP ranges, or system proxies. Loopback and private VPN hosts you configure remain reachable, so treat it as a guard against accidental targets rather than an SSRF firewall.

### Filtering operations (`include` / `exclude`)

Hide dangerous or noisy endpoints from search, schema lookup, preview, and execution (`exclude` always wins over `include`; calling a filtered endpoint returns `OPERATION_NOT_ALLOWED` with `sent: false`):

```yaml
services:
  orders:
    baseUrl: http://localhost:8080/api/v1
    spec: ./specs/orders.yaml
    operations:
      include:
        - { tag: orders }
        - { path: /orders/** }
      exclude:
        - { method: DELETE }
        - { operationId: purgeAll }
```

*(Configured login and refresh recipes can still call their auth endpoint even if that endpoint is excluded from agent tool calls.)*

---

## 🔐 TLS, file roots & session retention

### Custom CA or self-signed TLS per service

```yaml
services:
  internalApi:
    baseUrl: https://internal.example.test
    spec: ./specs/internal.yaml
    tls:
      caFile: ./certs/internal-ca.pem
      verify: true   # set false only for isolated test targets with untrusted certs (emits a warning)
```

### File roots and session retention

File uploads (`multipart` / `binary`) and `export_artifact` stay disabled until you declare allowed folders under `files`:

```yaml
files:
  uploadRoots: [./fixtures]
  exportRoots: [./exports]
  artifactRoot: ./runtime-artifacts
  retention:
    keepOnExit: false
    crashedSessionMaxAgeHours: 24
    maxRetainedBytes: 524288000
```

- By default, normal shutdown removes the session's trace and artifact directory, and the next startup cleans up leftover folders from crashed processes.
- Set `keepOnExit: true` when you want to inspect `trace/seg-N.jsonl` and saved artifacts on disk after a session ends (`maxRetainedBytes` prunes the oldest retained sessions first).

---

## 📏 Limits reference

Override only what you need under top-level `limits:` (see [`config.schema.json`](../config.schema.json) for min/max bounds):

| Key | Default | Controls |
|---|---:|---|
| `requestTimeoutMs` | `30000` ms | Per-request timeout (including redirects) |
| `maxConcurrentRequests` / `recipeConcurrency` | `8` / `2` | In-flight business requests / auth recipe lane |
| `specDocumentBytes` / `refGraphBytes` | `10 MiB` / `50 MiB` | Max size of one spec document / total `$ref` graph read |
| `refGraphDocuments` / `refGraphDepth` | `100` / `64` | Max `$ref` documents / nesting depth |
| `responseBytes` / `uploadBytes` | `50 MiB` / `50 MiB` | Max single HTTP response / single file upload |
| `sessionArtifactBytes` / `maxArtifacts` | `250 MiB` / `20000` | Per-session artifact disk quota and count |
| `toolOutputBytes` / `inlineStringBytes` | `32768` B / `4096` B | Max MCP tool output payload / inline string cutoff |
| `artifactPageBytes` | `16384` B | Default page size for `read_artifact` |
| `maxRedirects` | `5` | Max same-origin/base-path redirects when `followRedirects: true` |
| `traceBytes` / `traceSegmentBytes` / `traceEventBytes` | `64 MiB` / `4 MiB` / `64 KiB` | Session trace disk budget, segment size, and single event cap |
| `traceIndexBytes` / `traceQueueBytes` | `32 MiB` / `4 MiB` | In-memory trace index estimate and async write queue cap |
| `traceMaxOpenRecords` | `256` | Concurrent open calls/exchanges tracked in trace |
| `traceInputInlineBytes` / `traceFieldValueBytes` | `4096` B / `4096` B | Inline tool input cutoff / max recorded header, cookie, or query value |
| `requestBodyTraceBytes` | `1 MiB` | Max request body stored as a trace artifact |
