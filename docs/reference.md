# Usage, Data Boundary & Troubleshooting

This guide covers how `openapi-swagger-mcp` handles local data and privacy, how tool payloads and negative testing work, how to read or export large responses, how operation search ranks endpoints, and how to troubleshoot errors.

---

## 1. Local execution & data privacy boundary

`openapi-swagger-mcp` runs locally as a `stdio` child process of your MCP client. If your client runs inside a container or remote dev box, HTTP requests originate from that environment.

Keep two separate data flows in mind:

| Flow | Where data goes |
|---|---|
| **API flow** | The server sends HTTP requests directly to your configured `baseUrl` origins, login/refresh endpoints, and spec/`$ref` sources. There is **no author backend, no telemetry, and no external search/embedding call**. Raw responses are stored in a local per-session directory (`files.artifactRoot`). |
| **AI flow** | Tool outputs read by your assistant are returned to your MCP client. If your client uses a cloud LLM, **anything the assistant reads (including via `read_artifact`) can be sent to that model provider**. Raw responses are not scrubbed of tokens or personal data. |

### Execution trace & artifacts

- **Artifacts** hold raw HTTP response bodies, oversized OpenAPI schemas, and large tool inputs in a mode-protected per-session directory. By default, normal process exit deletes the session directory (change via `files.retention` in the [Configuration Guide](configuration.md#file-roots-and-session-retention)).
- **Execution trace** records `callId`, `requestId` (one per HTTP hop, auth call, or spec fetch), and `authRunId`, along with timing and send state (`not_sent`, `maybe_sent`, `response_received`). Configured secrets injected by the server are recorded by binding name only (`unrecordedReason: credential`). View live session traces visually in the [Local Request Inspector](inspector.md).

---

## 2. Calling tools: preview, payloads & negative testing

### Standard tool sequence

Your AI assistant handles JSON arguments automatically from natural-language prompts, following this flow:

| Step | Tool | Example arguments |
|---|---|---|
| 1. Check loaded APIs | `list_apis` | `{}` |
| 2. Search endpoints | `search_operations` | `{"service":"orders","query":"order detail","limit":5}` |
| 3. Read contract | `get_operation_schema` | `{"service":"orders","operation":"GET /orders/{id}","revision":"<rev>"}` |
| 4. Preview or call | `preview_operation` / `invoke_operation` | `{"service":"orders","operation":"GET /orders/{id}","revision":"<rev>","input":{"path":{"id":"demo-123"}}}` |

- **`operation` key:** Always the key returned by search (typically `METHOD /path`), not `operationId`.
- **`revision` guard:** Prevents calling an endpoint against an outdated spec snapshot (`SPEC_REVISION_MISMATCH`). After running `refresh_specs`, fetch the updated `revision` via list, search, or schema.

### `preview_operation` vs. `invoke_operation`

`preview_operation` runs the exact same request serializer and policy checks as `invoke_operation`, without access to the network transport:

- Returns `sent: false`, `ready`, `blockers`, target URL, method, headers, query pairs, cookies, bounded body, and request schema diagnostics.
- Configured credentials appear by binding name only; values typed directly in `input` appear as typed.
- Preview is **not** a lock or approval gate, and only reflects the initial request (redirects, 401 refreshes, `Set-Cookie` updates, DNS/TLS checks, and HTTP-library headers like `content-length` happen only on `invoke_operation`).

### Request body formats (`invoke_operation.input`)

Include at most one body type inside `input.body` (note `json.value` and `form.fields` wrappers here, which differ from YAML auth recipes):

```json
// JSON
{ "body": { "json": { "value": { "name": "demo", "quantity": 2 } } } }

// Form URL-encoded (application/x-www-form-urlencoded)
{ "body": { "form": { "fields": { "name": "demo", "tags": ["a", "b"] } } } }

// Multipart upload (file paths must be absolute and inside files.uploadRoots)
{
  "body": {
    "multipart": {
      "fields": { "description": "demo" },
      "files": [{ "field": "document", "path": "/abs/path/fixtures/demo.pdf", "contentType": "application/pdf" }]
    }
  }
}

// Binary upload (file path inside files.uploadRoots)
{ "body": { "binary": { "file": "/abs/path/fixtures/demo.bin", "contentType": "application/octet-stream" } } }
```

### Per-call auth modes & negative testing

- **Auth selection (`auth`):** Choose `{"mode":"default"}` (or omit), `{"mode":"profile","profileId":"qa"}`, `{"mode":"session","sessionId":"<id>"}`, or `{"mode":"anonymous"}`. Passing an explicit `input.headers.Authorization` overrides managed auth for that single call without triggering 401 refresh—useful for testing invalid tokens.
- **Intentional invalid inputs:** Payloads are serialized **verbatim**—no defaults injected, no type coercion, and no stripping of `null` or extra fields.
- **HTTP outcomes vs. diagnostics:** HTTP `4xx`/`5xx` responses are returned as normal results (`http.status`, `bodyView`), alongside advisory `diagnostics.request` and `diagnostics.response` (`valid`, `invalid`, `not_available`, `error`). Only unsafe transport inputs (missing path params, path traversal, CR/LF header injection, undeclared media types) are blocked locally (`sent: false`).
- **Network failures & redirects:** Timeouts or TLS resets set `error.mayHaveBeenSent` rather than inventing an HTTP status—be cautious before retrying writes. Redirects are off by default; `followRedirects: true` follows only same-origin redirects under the service's `baseUrl` path prefix and never forwards credentials cross-origin.

---

## 3. Large responses & file exports (Artifacts)

To keep long JSON payloads, binary downloads, and base64 blobs from overflowing chat context, responses are stored locally as artifacts (`rawBodyArtifact`) and shortened in `bodyView` (`bodyTransformed: true`, with details in `omissions`).

### Read slices with `read_artifact`

Query a specific JSON Pointer or page through text/JSON using `nextOffset`:

```json
{ "artifactId": "<id>", "pointer": "/data/items/0" }
```
```json
{ "artifactId": "<id>", "offset": 0, "limit": 4096 }
```

*(Binary artifacts return metadata only—export them to read the file.)*

### Save files with `export_artifact`

First declare `files.exportRoots` in your config, then export to a **new** file path inside an allowed root (existing files are never overwritten):

```json
{
  "artifactId": "<id>",
  "pointer": "/data/imageBase64",
  "destination": "/absolute/path/exports/image.png",
  "representation": "decoded"
}
```

`representation` accepts `"original"` (exact bytes), `"text"` (UTF-8 text at root or pointer), or `"decoded"` (strict base64 decode). You can also declare known base64 JSON paths in your config under `encodedFields` (`service`, `pointer` with `*` segment wildcards, `encoding: base64`, `mediaType`).

---

## 4. How `search_operations` works

Search runs locally in memory over loaded specs (lexical ranking—no external model or embedding service):

- **Indexed fields:** `METHOD /path`, `operationId`, tags, summary, description, parameter names/descriptions, nested request and response field paths (kept separate!), schema names, and response headers.
- **Text normalization:** Splits `camelCase`, `snake_case`, and `kebab-case`; folds Latin accents (`don hang` matches `đơn hàng`); preserves CJK/Kana/Southeast Asian script distinctions; and applies bounded typo tolerance when exact tokens don't match.
- **Field-scoped queries:** Restrict matches via `fields` (`identifier`, `text`, `parameter`, `requestField`, `responseField`, `schema`)—for example, `{"query":"taxCode","fields":["responseField"]}` finds endpoints that *return* `taxCode`.
- **Custom business synonyms (`search.aliases`):** Lexical search does not guess undeclared synonyms. Add domain terms or multilingual aliases in your config:
  ```yaml
  search:
    aliases:
      - { terms: ["đơn hàng", "order"], services: [orders] }
  ```

---

## 5. Validation and troubleshooting

### Static check vs. network spec check

| Command | Network calls | What it verifies |
|---|---|---|
| `--config <file> --check` | None | Parses YAML/JSON against schema, verifies referenced env vars, JSON secret files/pointers, local spec/CA files, and upload/export roots. Exit `0` = ok, `1` = config/source error, `2` = CLI usage error. |
| `--config <file> --check-specs` | Spec & `$ref` URLs only | Loads every service's spec through the server's network policy and `spec.auth`, printing `ready`/`unavailable` state, `revision`, and `operationCount`. Never logs in or calls business endpoints. |

### Common error codes

| Code / symptom | How to resolve |
|---|---|
| Client fails to connect on startup | Confirm Node.js >= 22.19, verify `--config` uses an absolute path, and make sure `--check` is **not** in the client's `args`. |
| `CONFIG_INVALID` | Run `--check` to pinpoint the invalid field; validate against `config.schema.json`. |
| `SOURCE_UNAVAILABLE` / `CREDENTIAL_INVALID` | Check that the env var is set in the MCP client entry's `env` (not just your shell) or that the JSON file pointer resolves to a string. |
| Service state `unavailable` | Inspect the error in `list_apis` (or run `--check-specs`). Fix the spec URL/file, `$ref` target, `network.allow`, or CA certificate, then call `refresh_specs`. |
| `SPEC_REVISION_MISMATCH` | Spec changed since you read it—call `list_apis`, `search_operations`, or `get_operation_schema` to get the current `revision`. |
| `OPERATION_NOT_ALLOWED` | Blocked by `services.<id>.operations` (`include`/`exclude` filter). |
| `AUTH_REQUIRED` / `AUTH_TARGET_REQUIRED` | Check static secret sources, run `authenticate` first, create an OTP session, or specify a `profile` when a multi-profile service has no `defaultProfile`. |
| `AUTH_RECOVERING` / `AUTH_BUSY` | Poll `get_auth_status` until the running login/refresh finishes before sending new calls or switching auth actions. |
| `AUTH_REFRESH_UNAVAILABLE` | No `refresh` recipe is configured; re-run `authenticate` or update your session. |
| `AUTH_RECIPE_INPUT` / `AUTH_RECIPE_FAILED` / `AUTH_CAPTURE_FAILED` | Check initial `credentials`, recipe operation/status (`successStatuses`), and response JSON Pointers/headers/cookies. |
| `UPLOAD_NOT_ALLOWED` / export failure | Verify `files.uploadRoots` / `files.exportRoots`, ensure symlinks don't escape the root, and pass a non-existent destination file path on export. |
