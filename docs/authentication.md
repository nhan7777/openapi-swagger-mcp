# Authentication Guide

Start with the simplest authentication option your API supports—most non-production APIs only need a static Bearer token or API key.

| Your scenario | Where to start |
|---|---|
| You already have a Bearer token, Basic credentials, or API key | [1. Static credentials](#1-static-credentials) |
| You keep secrets in environment variables or JSON files | [2. Secret sources](#2-secret-sources) |
| Several services share one login, or you switch between test accounts | [3. Multiple accounts & shared profiles](#3-multiple-accounts-and-shared-profiles) |
| You call an API login/refresh endpoint to obtain tokens or cookies | [4. Login & refresh recipes](#4-login-and-refresh-recipes) |
| Login requires OTP, SSO, or interactively supplied session tokens | [5. Interactive sessions (OTP & SSO)](#5-interactive-sessions-otp-and-sso) |

---

## 1. Static credentials

Place an `auth` block directly under a service (or inside a shared [profile](#3-multiple-accounts-and-shared-profiles)).

### Bearer token

```yaml
services:
  orders:
    baseUrl: http://localhost:8080/api/v1
    spec: http://localhost:8080/v3/api-docs
    auth:
      bearer:
        token: { fromEnv: ORDERS_TOKEN }   # bare token without the "Bearer " prefix
```

### Basic authentication

```yaml
auth:
  basic:
    username: tester
    password: { fromEnv: API_PASSWORD }
```

### API key (header, query, or cookie)

Pick one destination (`header`, `query`, or `cookie`) per entry, or combine multiple entries with Bearer auth and a cookie jar:

```yaml
auth:
  bearer: { token: { fromEnv: ACCESS_TOKEN } }
  apiKey:
    - { header: X-CSRF-Token, value: { fromEnv: CSRF_TOKEN } }
    - { query: tenant, value: demo }
  cookies: true
```

- `bearer` and `basic` cannot be combined because both set `Authorization`.
- Duplicate header names (case-insensitive) are rejected; query and cookie names are case-sensitive.
- `cookies: true` enables a managed cookie jar (typically populated by a [login recipe](#4-login-and-refresh-recipes)). To import raw cookies you already have, use an [interactive session](#5-interactive-sessions-otp-and-sso).

---

## 2. Secret sources

Every secret field (`token`, `value`, `username`, `password`, and initial `credentials`) supports the same source syntax:

| Syntax | Reads from |
|---|---|
| `{ fromEnv: API_TOKEN }` | Environment variable of the MCP server process (set in your client entry's `env`) |
| `{ fromFile: ./secrets.json, pointer: /orders/token }` | String field inside a JSON file (RFC 6901 JSON Pointer) |
| `{ fromFile: ./token.json }` | Whole JSON file containing a JSON string such as `"my-token"` |
| `{ fromCredential: accessToken }` | Value captured at runtime by a login/refresh recipe |
| `demo-token` | Plain literal—allowed for local testing, emits a startup warning (never logs the value) |

- Missing or non-string sources fail explicitly rather than falling back to anonymous requests.
- Referenced secret files are automatically blocked from file upload and artifact export, though you should still keep them out of git and restrict file permissions.

---

## 3. Multiple accounts and shared profiles

Define reusable identities under top-level `profiles` when one service supports multiple test roles (`qa`, `admin`) or multiple services share one identity provider:

```yaml
profiles:
  qa:
    auth: { bearer: { token: { fromEnv: QA_TOKEN } } }
  admin:
    auth: { bearer: { token: { fromEnv: ADMIN_TOKEN } } }

services:
  orders:
    baseUrl: https://orders.staging.example.test
    spec: ./orders.json
    auth:
      profiles: [qa, admin]
      defaultProfile: qa
  reports:
    baseUrl: https://reports.staging.example.test
    spec: ./reports.json
    auth: { profile: qa }
```

- **Default vs. explicit profile:** `orders` uses `qa` by default; pass `"auth": { "mode": "profile", "profileId": "admin" }` in `invoke_operation` or `preview_operation` to switch accounts for a call.
- **No `defaultProfile`:** If `profiles` has no `defaultProfile`, calls default to anonymous—a profile is never guessed automatically.
- **Shared state:** Services referencing `qa` share its credentials, cookie jar (still scoped by cookie domain/path), and refresh task.
- **Auth tool targets:** Pass either `{"service":"orders"}` or `{"profile":"qa"}` (never both) to `authenticate` and `get_auth_status`.

---

## 4. Login and refresh recipes

Use `authentication` and `refresh` recipes when an operation in a loaded spec exchanges credentials (username/password, client credentials, grant code, etc.) for tokens or cookies.

Three config blocks work together:
1. `credentials` — Initial seed values (not sent unless referenced).
2. `authentication` / `refresh` — Calls **one spec operation** and captures tokens/cookies from the response.
3. `auth` — Binds those captured values (`{ fromCredential: ... }` or `cookies: true`) onto business requests.

```yaml
services:
  accounts:
    baseUrl: https://accounts.staging.example.test
    spec: https://accounts.staging.example.test/v3/api-docs
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

### How login & refresh behave at runtime

1. **Explicit login:** Business calls never log in behind the scenes. Ask the agent (or call `authenticate` with `{"service":"accounts"}`), check `get_auth_status` until state is `ready`, then call business endpoints.
2. **401 background refresh (no silent replay):** If a business request with managed auth and a `refresh` recipe gets HTTP `401`, the server starts a background refresh and returns the original `401` plus `authRecovery`—**it never replays the failed request automatically**. Wait for `get_auth_status` to leave `recovering`, then decide whether to retry.
3. **Manual refresh:** Call `authenticate` with `{"service":"accounts","action":"refresh"}`.
4. **Atomic captures:** If any declared capture pointer or header is missing from a login/refresh response (HTTP 200–299 by default, customizable via `successStatuses`), nothing is updated partially (`AUTH_CAPTURE_FAILED`).
5. **Recipe request bodies:** Choose one of `body: { json: ... }`, `body: { form: ... }`, `body: { multipart: { fields, files } }`, or `body: { binary: { file, contentType } }`. Note that recipes in a named `profile` must set `request.service` explicitly, and `request.auth` defaults to anonymous unless declared.

---

## 5. Interactive sessions (OTP and SSO)

Use an in-memory session when a human and an agent complete a multi-step login together (such as requesting an OTP code and verifying it) or when importing a temporary browser session token.

### Option A — Capture a session from an API response

1. Trigger the OTP/challenge endpoint explicitly with `auth: { "mode": "anonymous" }`.
2. Once you have the code, call the verification endpoint via `invoke_operation` with a `capture` block:
   ```json
   {
     "service": "accounts",
     "operation": "POST /otp/verify",
     "revision": "<spec-revision>",
     "auth": { "mode": "anonymous" },
     "input": { "body": { "json": { "value": { "code": "<user-supplied-otp>" } } } },
     "capture": {
       "tokens": [{ "id": "access", "type": "bearer", "from": "body", "pointer": "/token" }],
       "cookies": true
     }
   }
   ```
3. When `capture.state` is `"captured"`, pass `"auth": { "mode": "session", "sessionId": "<sessionId>" }` on subsequent `invoke_operation` calls to that service.

### Option B — Import an existing token or cookie (`manage_session`)

Prefer referencing an env/file secret declared in top-level `credentialSources` so the token never enters chat history:

```yaml
credentialSources:
  qaSessionToken: { fromEnv: QA_SESSION_TOKEN }
```

Then create the session with `manage_session`:

```json
{
  "action": "create",
  "service": "accounts",
  "credentialSourceIds": [{ "sourceId": "qaSessionToken", "type": "bearer" }]
}
```

*(You can also pass `credentials: { components: [...], cookies: [...] }` directly to `manage_session`, though literal values in tool arguments can be stored in your AI client's chat history.)*

Inspect sessions with `{"action":"inspect"}` (metadata only—never returns secret values) and remove them with `{"action":"delete","sessionId":"<id>"}`. Sessions belong to a single service, do not auto-refresh, and clear when the MCP process exits.
