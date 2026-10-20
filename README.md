# openapi-swagger-mcp

Cho AI agent đọc Swagger/OpenAPI, tìm endpoint, xem contract và gọi API thật thông qua MCP. Hỗ trợ **Swagger 2.0, OpenAPI 3.0 và 3.1**.

Bạn khai báo API và cách xác thực trong một file YAML/JSON. Agent sử dụng **10 tool cố định**, không cần tạo một tool riêng cho từng endpoint.

> **Chỉ dùng cho dev/UAT.** Tool có thể gửi POST, PUT, PATCH, DELETE thật. Không có cơ chế tự rollback hoặc chặn thao tác ghi.
>
> **Lưu ý về dữ liệu:** tham số tool và kết quả trả về có thể được nhà cung cấp AI lưu trong lịch sử hội thoại. Response không bị che token hay dữ liệu cá nhân. Ưu tiên đọc secret từ biến môi trường/file thay vì dán vào hội thoại.

## Mục lục

1. [Chạy nhanh](#1-chạy-nhanh)
2. [Kết nối với ứng dụng AI](#2-kết-nối-với-ứng-dụng-ai)
3. [Khai báo một hoặc nhiều API](#3-khai-báo-một-hoặc-nhiều-api)
4. [Chọn cách xác thực](#4-chọn-cách-xác-thực)
5. [Đăng nhập và refresh token](#5-đăng-nhập-và-refresh-token)
6. [Nhiều tài khoản và profile dùng chung](#6-nhiều-tài-khoản-và-profile-dùng-chung)
7. [Tìm và gọi API](#7-tìm-và-gọi-api)
8. [OTP/SSO và session riêng](#8-otpsso-và-session-riêng)
9. [Response lớn, file và base64](#9-response-lớn-file-và-base64)
10. [Kiểm tra cấu hình và xử lý lỗi](#10-kiểm-tra-cấu-hình-và-xử-lý-lỗi)
11. [Cấu hình nâng cao](#11-cấu-hình-nâng-cao)
12. [Danh sách tool](#12-danh-sách-tool)
13. [Giới hạn và phát triển](#13-giới-hạn-và-phát-triển)

## 1. Chạy nhanh

### Bước 1 — Cài và build

Cần **Node.js từ 22.19** và npm. Trong thư mục source của dự án:

```bash
npm ci
npm run build
```

Có thể chạy trực tiếp bằng `node /đường/dẫn/dự/án/dist/cli.js`, không bắt buộc cài global.

Cài thành lệnh trên máy từ npm (tên package có scope `@nhan7777`; lệnh sau khi cài vẫn là `openapi-swagger-mcp`):

```bash
npm install -g @nhan7777/openapi-swagger-mcp
```

Hoặc chạy không cần cài: `npx @nhan7777/openapi-swagger-mcp --config /đường/dẫn/config.dev.yaml`.

Không dùng package `openapi-swagger-mcp` (không scope) trên npm: đó là package của người khác, không phải dự án này.

Cài từ source/package local:

```bash
npm pack
npm install -g ./nhan7777-openapi-swagger-mcp-0.1.0.tgz
```

### Bước 2 — Tạo config

Tạo `config.dev.yaml` ở vị trí bạn muốn:

```yaml
services:
  orders:
    baseUrl: http://localhost:8080/api/v1
    spec: http://localhost:8080/v3/api-docs
```

- `orders`: tên service để agent chọn khi gọi tool.
- `baseUrl`: địa chỉ API thực sự nhận request, **gồm cả prefix** như `/api/v1`.
- `spec`: URL Swagger/OpenAPI hoặc đường dẫn file như `./openapi.json`.
- Chưa khai báo `auth` nghĩa là gọi anonymous.

Ví dụ trên là địa chỉ minh họa. Thay bằng API dev/UAT của bạn.

### Bước 3 — Kiểm tra offline

```bash
node /đường/dẫn/dự/án/dist/cli.js --config /đường/dẫn/config.dev.yaml --check
```

`ok: true` nghĩa là kiểm tra tĩnh đã đạt; **không có nghĩa Swagger từ xa hay endpoint đã được kiểm tra**. Lệnh này không gọi mạng, không đăng nhập và không tạo thư mục artifact.

### Bước 4 — Thêm MCP vào ứng dụng AI

Dùng cấu hình ở phần tiếp theo. Sau khi kết nối, thử yêu cầu:

> Liệt kê các API đã cấu hình. Tìm endpoint xem chi tiết đơn hàng của service orders, đọc contract rồi đề xuất request. Chưa gửi request cho đến khi tôi cung cấp mã đơn.

## 2. Kết nối với ứng dụng AI

Với client hỗ trợ cấu hình `mcpServers`, dùng mẫu sau trong **file cấu hình MCP của client**, không phải file YAML của server:

```json
{
  "mcpServers": {
    "api-dev": {
      "command": "node",
      "args": [
        "/absolute/path/openapi-swagger-mcp/dist/cli.js",
        "--config",
        "/absolute/path/config.dev.yaml"
      ],
      "env": {
        "ORDERS_TOKEN": "replace-with-your-dev-token"
      }
    }
  }
}
```

Nếu đã cài global, có thể dùng `"command": "openapi-swagger-mcp"` với `"args": ["--config", "/absolute/path/config.dev.yaml"]`. Với npx: `"command": "npx"`, `"args": ["-y", "@nhan7777/openapi-swagger-mcp", "--config", "/absolute/path/config.dev.yaml"]`.

Tên file/vị trí cấu hình MCP tùy client. Nếu client dùng giao diện nhập command/args/env, nhập các trường tương ứng. Nên dùng đường dẫn tuyệt đối để không phụ thuộc thư mục client khởi động.

**Tách dev và UAT:** tạo hai file config và hai MCP entry, ví dụ `api-dev`, `api-uat`. Mỗi process có credential, cookie và artifact riêng. Không có cờ `--env` hay tool chuyển môi trường.

Server dùng **stdio**: client khởi chạy process và giao tiếp qua stdin/stdout. Chạy CLI thường không mở trang web hay HTTP port. stdout dành cho MCP; log ở stderr. Không thêm `--check` vào MCP entry vì chế độ đó kiểm tra xong sẽ thoát.

## 3. Khai báo một hoặc nhiều API

```yaml
# yaml-language-server: $schema=/absolute/path/openapi-swagger-mcp/config.schema.json
version: 1                 # có thể bỏ
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

YAML (`.yaml`, `.yml`) và JSON đều được hỗ trợ. Với JSON, thêm `"$schema": "/absolute/path/config.schema.json"` để editor gợi ý cấu hình.

Các đường dẫn cấu hình tương đối được tính từ **thư mục chứa config**, không phải thư mục chạy lệnh. Có thể tham khảo [config đầy đủ](examples/config.example.yaml) và [JSON Schema](config.schema.json).

**Quan trọng về URL:** operation `GET /orders/{id}` với `baseUrl: https://host/api/v1` sẽ gọi `https://host/api/v1/orders/{id}`. Server không lấy địa chỉ gọi API từ `servers`, `host` hoặc `basePath` trong spec. `baseUrl` không được chứa username/password, query hay fragment.

## 4. Chọn cách xác thực

### 4.1. Có sẵn Bearer token

```yaml
auth:
  bearer:
    token: { fromEnv: ORDERS_TOKEN }
```

Server tự thêm `Authorization: Bearer <token>`. Giá trị nguồn chỉ chứa token, không thêm sẵn chữ `Bearer `.

### 4.2. Basic authentication

```yaml
auth:
  basic:
    username: tester
    password: { fromEnv: API_PASSWORD }
```

Username/password được đọc độc lập và mã hóa Basic. Cả hai cũng có thể dùng file hoặc `fromCredential`. Chỉ literal của Basic cho phép chuỗi rỗng.

### 4.3. API key trong header, query hoặc cookie

```yaml
auth:
  apiKey:
    header: X-API-Key
    value: { fromEnv: API_KEY }
```

Thay `header` bằng `query` hoặc `cookie` nếu API yêu cầu. Mỗi entry chỉ chọn **một** đích. Có thể dùng danh sách:

```yaml
auth:
  bearer: { token: { fromEnv: ACCESS_TOKEN } }
  apiKey:
    - { header: X-CSRF-Token, value: { fromEnv: CSRF_TOKEN } }
    - { query: tenant, value: demo }
  cookies: true
```

Có thể kết hợp bearer/API key/cookie jar. Không kết hợp bearer và basic vì cùng dùng `Authorization`. Header trùng tên không phân biệt hoa/thường bị từ chối; tên query/cookie phân biệt hoa/thường.

### 4.4. Cookie jar

`auth: { cookies: true }` dùng cookie jar của auth đó, không phải một raw `Cookie` string. Thường kết hợp recipe đăng nhập có `capture.cookies: true` ở phần 5. Cookie-only không tự được coi là đã đăng nhập khi jar rỗng.

Nếu có cookie sẵn và muốn import thủ công, dùng [session](#8-otpsso-và-session-riêng).

### 4.5. Nguồn secret

Dùng cùng cú pháp tại `token`, `value`, `username`, `password` và các giá trị ban đầu trong `credentials`:

| Cú pháp | Ý nghĩa |
|---|---|
| `{ fromEnv: API_TOKEN }` | Đọc biến môi trường trong process MCP |
| `{ fromFile: ./secrets.json, pointer: /orders/token }` | Đọc trường trong file JSON |
| `{ fromFile: ./token.json }` | Đọc JSON root; file ví dụ có nội dung `"demo-token"`, không phải plain text |
| `demo-token` | Literal; có cảnh báo theo tên field, không log giá trị |
| `{ fromCredential: accessToken }` | Dùng giá trị có tên trong auth hiện tại, thường do recipe capture |

`fromCredential` không dùng trong initial `credentials`, catalog `credentialSources` hoặc auth tải spec. Giá trị env/file cho binding phải là string; không tự chuyển object/số thành token. Thiếu nguồn không tự chuyển sang anonymous. File secret được bảo vệ khỏi upload/export; tự quản lý quyền truy cập file và không commit secret.

Server không tự load `.env`. Cấp biến môi trường cho process MCP qua client hoặc môi trường khởi chạy. Thay đổi env của một process khác không cập nhật env của MCP đang chạy; khi cần, khởi động lại MCP với env mới.

## 5. Đăng nhập và refresh token

Dùng khi cần gọi API để lấy credential. Không bắt buộc username/password: body có thể là grant code, client credentials hoặc dữ liệu khác theo contract API.

Ba phần có vai trò khác nhau:

- `auth`: **gửi gì** trên request nghiệp vụ.
- `credentials`: giá trị có tên ban đầu; không tự gửi nếu không được tham chiếu.
- `authentication` / `refresh`: gọi **một operation** rồi capture kết quả.

### Ví dụ grant code + refresh token

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

Các operation phải có trong spec. JSON Pointer như `/session/accessToken` nghĩa là đọc `response.session.accessToken`. Refresh token được giữ trong credential store; ví dụ này chỉ gửi nó trong recipe refresh, không đưa vào request nghiệp vụ.

**Cách dùng tool:** tên tool đứng trước JSON; đây không phải lệnh shell.

1. `authenticate` với `{"service":"accounts"}`.
2. `get_auth_status` với `{"service":"accounts"}` cho tới khi hết `recovering`.
3. Khi `ready`, gọi API bình thường.
4. Refresh thủ công: `authenticate` với `{"service":"accounts","action":"refresh"}`.

Có thể nhờ agent: “Xác thực service accounts bằng recipe đã cấu hình, chờ hoàn tất rồi báo trạng thái; không hiển thị credential.”

### Quy tắc cần nhớ

- `authenticate` chỉ chạy `authentication`; nếu không có recipe, nó reload static sources. Không tự đăng nhập khi gọi nghiệp vụ thiếu credential.
- `action: refresh` chỉ chạy `refresh`. Không có recipe thì lỗi local `AUTH_REFRESH_UNAVAILABLE`.
- **401** có thể khởi chạy một refresh nền, nhưng **request gốc không bao giờ được gửi lại tự động**. Người gọi vẫn nhận 401 và `authRecovery`. Sau khi refresh xong, bạn/agent quyết định có gọi lại hay không.
- **403**, anonymous, session hoặc request override credential không kích hoạt refresh.
- Trong lúc chạy recipe, request nghiệp vụ mới bị `AUTH_RECOVERING`. Gọi lại cùng action tham gia lần đang chạy; action khác bị `AUTH_BUSY`.
- Refresh thất bại không tự lặp liên tục; cần yêu cầu retry rõ ràng bằng `authenticate` và action phù hợp.
- Capture credential/cookie và cập nhật binding diễn ra cùng nhau. Thiếu một capture bắt buộc thì không áp dụng kết quả từng phần. Credential không có tên trong capture giữ giá trị cũ; muốn rotate refresh token thì phải capture lại nó.
- Capture header của managed recipe giữ nguyên nội dung, không bỏ `Bearer `. Capture scalar chấp nhận string không rỗng hoặc số hữu hạn; số được đổi thành string.
- Recipe mặc định nhận HTTP 200–299; có thể đặt `successStatuses: [200, 201]`. Không follow redirect, không replay, không tự chạy recipe tiền đề.

### Request và body trong recipe

`request` hỗ trợ `service`, `operation`, `path`, `query`, `headers`, `cookies`, `body`, `auth`.

- `service` mặc định là service chứa recipe. Recipe trong named profile phải ghi rõ service.
- `request.auth` mặc định anonymous, **không kế thừa** bearer/cookie của owner. Muốn gửi thì khai báo auth methods rõ ràng; `cookies: true` dùng jar hiện tại.
- Template được thay trong payload: `{fromEnv}`, `{fromFile,pointer?}`, `{fromCredential}`. Bọc `{literal: {fromEnv: "text"}}` để gửi object đó nguyên trạng.
- Tên `fromCredential` phải được khai báo trong initial credentials hoặc capture. Authentication chỉ dùng được credential có initial definition, không dựa vào capture tương lai của chính nó. Refresh có thể dùng capture của authentication.
- Capture cần credentials không rỗng hoặc `cookies: true`. Capture cookie cần owner `auth.cookies: true`.
- Authentication capture cookie bắt đầu jar mới; refresh giữ và cập nhật jar hiện có.

Body recipe có **một** trong các dạng dưới đây:

```yaml
# JSON; có thể thêm contentType cạnh json
body: { json: { name: demo } }

# application/x-www-form-urlencoded; ví dụ client credentials
body:
  form:
    grant_type: client_credentials
    client_id: { fromEnv: CLIENT_ID }
    client_secret: { fromEnv: CLIENT_SECRET }

# Multipart; file phải qua uploadRoots
body:
  multipart:
    fields: { note: demo }
    files: [{ field: document, path: ./fixtures/demo.pdf }]

# Binary
body: { binary: { file: ./fixtures/demo.bin, contentType: application/octet-stream } }
```

Các block trên là **những lựa chọn thay thế**, không dán cả bốn `body` vào một recipe. Đường dẫn file recipe là cấu hình cố định, không lấy từ credential substitutions.

## 6. Nhiều tài khoản và profile dùng chung

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

- Gọi orders không chọn auth sẽ dùng qa. Chọn admin bằng `"auth":{"mode":"profile","profileId":"admin"}` trong `invoke_operation`.
- Nếu dùng `profiles` mà bỏ `defaultProfile`, request mặc định anonymous; không tự chọn profile đầu tiên. Tool auth target service sẽ yêu cầu chọn profile cụ thể.
- Điều khiển profile trực tiếp: `authenticate` / `get_auth_status` với `{"profile":"qa"}`. Không truyền cả `service` và `profile`.
- Profile chỉ dùng được trên service có tham chiếu đến nó. Hai service dùng qa chia sẻ credential, jar và task của qa; cookie vẫn theo domain/path.
- Named profile cũng có `credentials`, `authentication`, `refresh`. Với recipe, ghi `request.service` rõ ràng, có thể trỏ identity service riêng. Việc này chỉ cho phép recipe gọi operation đó, không cấp toàn bộ credential nghiệp vụ cho identity service.
- Service dùng profile reference không được có sibling `credentials`/`authentication`/`refresh`; đặt chúng trong profile.

## 7. Tìm và gọi API

### 7.1. Luồng thông thường

| Bước | Tool | Tham số ví dụ |
|---|---|---|
| Xem service và revision | `list_apis` | `{}` |
| Tìm operation | `search_operations` | `{"service":"orders","query":"order detail","limit":5}` |
| Đọc contract | `get_operation_schema` | `{"service":"orders","operation":"GET /orders/{id}","revision":"<revision-vừa-nhận>"}` |
| Gọi API | `invoke_operation` | Ví dụ dưới |

```json
{
  "service": "orders",
  "operation": "GET /orders/{id}",
  "revision": "<revision-vừa-nhận>",
  "input": {
    "path": { "id": "demo-123" },
    "query": { "includeItems": true },
    "headers": { "X-Request-ID": "demo-request" }
  }
}
```

`operation` là key trả về từ search, thường là `METHOD /path`, không phải `operationId`. `revision` là revision spec để tránh gọi dựa trên contract cũ. Khi spec đổi, dùng `refresh_specs` với `{"service":"orders"}`, rồi tìm/đọc lại contract để lấy revision mới.

Search hỗ trợ `service`, `method`, `tag`, `includeDeprecated`, `limit`, `cursor`. Dùng `nextCursor` với cùng truy vấn để xem trang sau; thay query hoặc revision làm cursor cũ mất hiệu lực.

### 7.2. Gửi body

**Khác recipe:** `invoke_operation.input.body` dùng các wrapper `json.value` và `form.fields`.

```json
{ "body": { "json": { "value": { "name": "demo", "quantity": 2 } } } }
```

```json
{ "body": { "form": { "fields": { "name": "demo", "tags": ["a", "b"] } } } }
```

Đây là nội dung đặt trong `input`. Mỗi request chỉ có một kiểu body. Có thể chỉ định `contentType` trong `json` hoặc `form` nếu cần chọn media type được operation khai báo.

### 7.3. Upload multipart hoặc binary

Trước tiên cho phép thư mục trong config:

```yaml
files:
  uploadRoots: [./fixtures]
  exportRoots: [./exports]
```

Tạo sẵn hai thư mục. Sau đó truyền đường dẫn tuyệt đối khi gọi tool:

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

Hoặc:

```json
{ "body": { "binary": { "file": "/absolute/path/fixtures/demo.bin", "contentType": "application/octet-stream" } } }
```

Mảng multipart files cho phép lặp cùng `field`. File ngoài `uploadRoots`, symlink thoát root hoặc file được bảo vệ không được upload. Media type phải phù hợp operation; đọc contract trước khi gửi.

### 7.4. Chọn auth và negative testing

`invoke_operation.auth` có bốn mode:

| Mode | Cách dùng |
|---|---|
| `{"mode":"default"}` hoặc bỏ `auth` | Dùng auth mặc định của service, nếu không có thì anonymous |
| `{"mode":"profile","profileId":"qa"}` | Named profile service cho phép |
| `{"mode":"session","sessionId":"<id>"}` | Session riêng của đúng service |
| `{"mode":"anonymous"}` | Không kế thừa credential/cookie; dữ liệu bạn truyền rõ trong input vẫn được gửi |

Để kiểm thử token sai, có thể truyền `input.headers.Authorization` riêng. Nó override credential tương ứng, không sửa managed credential và không kích hoạt auto-refresh cho request đó.

Server **serialize, không sửa dữ liệu giúp bạn**: không chèn defaults, không ép kiểu, không xóa field lạ hoặc `null`. Bỏ body khác với gửi `{"json":{"value":null}}` (gửi bytes `null`). HTTP 4xx/5xx vẫn là kết quả thật, không bị đổi thành “tool thất bại vì validation”.

Các lỗi không thể gửi an toàn như thiếu path parameter, path escape, CR/LF trong header, media type không được khai báo hoặc sửa header framing do transport quản lý bị chặn local.

### 7.5. Đọc kết quả

- `sent: false`: chưa gửi request. Xem `error.code`/`error.message`.
- `http.status` và `http.headers`: kết quả HTTP thực tế.
- `bodyView`: phần response dành cho agent đọc.
- `diagnostics.request` / `diagnostics.response`: kiểm tra theo spec, chỉ mang tính chẩn đoán; không thay thế HTTP outcome. State: `valid`, `invalid`, `not_available`, `error`.
- `bodyComplete: false`: body bị thiếu do giới hạn hoặc stream lỗi; không được kết luận toàn bộ response hợp lệ.
- `authRecovery`: trạng thái refresh nền sau 401; không có nghĩa request đã được replay.
- Lỗi mạng/TLS/timeout không tạo HTTP status giả. `error.mayHaveBeenSent` cho biết request có thể đã ra mạng; đặc biệt thận trọng khi retry thao tác ghi.

Mặc định không follow redirect. `followRedirects: true` chỉ theo redirect cùng origin, trong giới hạn: 303 và POST sau 301/302 đổi sang GET; 307/308 giữ method/body. Không chuyển credential sang origin khác.

## 8. OTP/SSO và session riêng

Session phù hợp khi agent/người dùng phải tương tác nhiều bước: xin OTP, nhập OTP, lấy token/cookie rồi gọi API. Server không tự xin OTP, polling, mở browser hay giải CAPTCHA.

### 8.1. Capture từ response

1. Gọi operation xin OTP **một lần theo yêu cầu rõ ràng**, với `auth: {mode: anonymous}`.
2. Người dùng cung cấp OTP. Gọi operation xác minh bằng `invoke_operation`:

```json
{
  "service": "accounts",
  "operation": "POST /otp/verify",
  "revision": "<revision>",
  "auth": { "mode": "anonymous" },
  "input": { "body": { "json": { "value": { "code": "<OTP-người-dùng-cung-cấp>" } } } },
  "capture": {
    "tokens": [
      { "id": "access", "type": "bearer", "from": "body", "pointer": "/token" }
    ],
    "cookies": true
  }
}
```

3. Lấy `capture.sessionId` khi `capture.state` là `captured`.
4. Gọi nghiệp vụ bằng `auth: {mode: session, sessionId: ...}`.

Chỉ bật `capture.cookies` khi response thực sự có Set-Cookie. Có thể capture token từ header bằng `{"id":"access","type":"bearer","from":"header","header":"Authorization"}`; riêng session bearer-header capture bỏ prefix `Bearer `, khác managed recipe. API-key capture dùng `type: apiKey`, thêm `in: header|query|cookie` và `name`.

Capture mặc định chỉ áp dụng 200–299, có thể đặt `successStatuses`. Capture thất bại không cập nhật một phần session. Để cập nhật session hiện có, thêm `capture.sessionId`.

### 8.2. Import credential có sẵn

Ưu tiên khai báo catalog trong config:

```yaml
credentialSources:
  qaToken: { fromEnv: QA_SESSION_TOKEN }
```

Gọi `manage_session`:

```json
{
  "action": "create",
  "service": "accounts",
  "credentialSourceIds": [{ "sourceId": "qaToken", "type": "bearer" }]
}
```

Chỉ id khai báo ở top-level `credentialSources` được import. Secret inline của service/profile hoặc captured refresh token không tự xuất hiện trong catalog.

Nếu cần import trực tiếp (giá trị có thể đi vào lịch sử AI):

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

Inspect bằng `{"action":"inspect","sessionId":"<id>"}` hoặc bỏ sessionId để liệt kê; delete bằng `{"action":"delete","sessionId":"<id>"}`. Inspect chỉ trả metadata, không trả secret.

Session bị ràng buộc vào một service, không tự refresh, không thay đổi managed profile và không tự được promote thành profile. Khi process kết thúc, session trong bộ nhớ mất theo.

## 9. Response lớn, file và base64

Server lưu response thành artifact và trả view có giới hạn, tránh nhét cả file/base64 dài vào hội thoại.

- `bodyTransformed: true`: view đã được rút gọn; không phải nguyên response.
- `omissions`: các trường bị rút gọn, lý do, JSON Pointer và artifact id.
- `rawBodyArtifact`: bản bytes response entity sau HTTP content-decoding; có metadata và SHA-256.

### Đọc một phần

Gọi `read_artifact`:

```json
{ "artifactId": "<id>", "pointer": "/data/status" }
```

Hoặc đọc theo trang:

```json
{ "artifactId": "<id>", "offset": 0, "limit": 4096 }
```

Dùng `nextOffset` của kết quả để đọc tiếp. Pointer vào string trả text; pointer vào object/array trả JSON. Đọc binary trả metadata; dùng export để lấy file. Pointer JSON sử dụng giá trị đã parse (có giới hạn độ chính xác số); export original giữ bytes.

### Xuất file

Thư mục đích phải nằm dưới `files.exportRoots`. Gọi `export_artifact`:

```json
{
  "artifactId": "<id>",
  "pointer": "/data/imageBase64",
  "destination": "/absolute/path/exports/image.png",
  "representation": "decoded"
}
```

| Representation | Kết quả |
|---|---|
| `original` | Bytes artifact nguyên bản |
| `text` | Text của artifact hoặc field tại pointer |
| `decoded` | Giải mã base64 nghiêm ngặt của string |

Không ghi đè file đã có, không cho symlink escape. Tên file từ response `Content-Disposition` không được tin dùng. Artifact chỉ sống trong process và được xóa khi đóng bình thường; file đã export vẫn còn.

Muốn đánh dấu field base64 rõ ràng trong config:

```yaml
encodedFields:
  - service: orders
    pointer: /data/*/thumbnail
    encoding: base64
    mediaType: image/png
```

`*` khớp một segment. Có thể thêm `operation` để giới hạn theo operation. Schema `format: byte`, `contentEncoding` và data URI cũng giúp xác nhận encoding. Chuỗi chỉ “trông giống base64” không được khẳng định chắc chắn là base64.

## 10. Kiểm tra cấu hình và xử lý lỗi

```bash
node /absolute/path/openapi-swagger-mcp/dist/cli.js --config /absolute/path/config.yaml --check
```

Report gồm `ok`, `services`, `checks`, `remoteSpecsChecked: false`, `operationsChecked: false`. Mỗi check có `field`, `state` (`ok`, `pending`, `error`) và có thể có `code`.

- `pending`: credential chờ capture khi chạy, không phải lỗi tĩnh.
- Kiểm tra nguồn env/file kể cả khi có recipe, local spec/CA file và upload/export roots.
- Không tải remote spec, không parse/validate nội dung spec, không kiểm tra operation từ xa, không chạy recipe hay tạo artifact directory.
- Config parse/schema lỗi: stderr chứa lỗi đã sanitize, stdout rỗng. Config parse được: stdout có một JSON report, không có secret value.

| Exit code | Ý nghĩa |
|---|---|
| `0` | Kiểm tra tĩnh đạt |
| `1` | Config/nguồn/file/root có lỗi |
| `2` | Sai cách dùng CLI, ví dụ thiếu `--config` hoặc cờ lạ |

### Lỗi thường gặp

| Triệu chứng / code | Cách xử lý |
|---|---|
| MCP không kết nối | Kiểm tra Node, đường dẫn tuyệt đối tới CLI/config, đã build và không thêm `--check` trong MCP entry |
| `CONFIG_INVALID` | Chạy `--check`, xem field lỗi; dùng schema gợi ý, không trộn cú pháp cũ |
| `SOURCE_UNAVAILABLE` / `CREDENTIAL_INVALID` | Kiểm tra env của process MCP, file JSON, pointer và kiểu string; không dán secret vào log |
| Service `unavailable` | Xem lỗi trong `list_apis`; kiểm tra spec, refs, CA, quyền đọc file; sửa rồi `refresh_specs`. Spec nhỏ lệch chuẩn (xem [Spec không hoàn hảo](#spec-không-hoàn-hảo-cảnh-báo-thay-vì-chặn)) không làm service `unavailable` |
| `AUTH_REQUIRED` | Kiểm tra nguồn tĩnh hoặc gọi `authenticate`; với OTP dùng session |
| `AUTH_RECOVERING` | Chờ `get_auth_status` hết `recovering`; không tự retry mutation hàng loạt |
| `AUTH_BUSY` | Đợi action hiện tại kết thúc rồi mới yêu cầu action khác |
| `AUTH_REFRESH_UNAVAILABLE` | Chưa cấu hình refresh; xác thực lại rõ ràng hoặc import session |
| `AUTH_RECIPE_INPUT` | Credential/template cần dùng chưa có giá trị; recipe không tự chạy bước tiền đề |
| `AUTH_RECIPE_INVALID` / `AUTH_RECIPE_FAILED` | Kiểm tra operation, request body, status và service của recipe |
| `AUTH_CAPTURE_FAILED` | Kiểm tra JSON Pointer/header/Set-Cookie; kết quả capture không được publish từng phần |
| `AUTH_TARGET_REQUIRED` | Service nhiều profile chưa có default; dùng `{profile: ...}` |
| `PROFILE_NOT_ALLOWED` / `SESSION_SERVICE_MISMATCH` | Chọn profile được service liệt kê hoặc session đúng service |
| `SPEC_REVISION_MISMATCH` | Lấy revision mới từ list/search/schema, đọc lại contract trước khi gọi |
| `UPLOAD_NOT_ALLOWED` / lỗi export | Kiểm tra roots, đường dẫn thật, file được bảo vệ và đích chưa tồn tại |
| HTTP 401 sau khi refresh bắt đầu | Đây vẫn là response request gốc; chờ refresh rồi quyết định có gọi request mới |

Đổi config cần khởi động lại process MCP. `refresh_specs` chỉ reload spec; `authenticate` không có recipe reload nguồn auth tĩnh, không reload toàn bộ config.

## 11. Cấu hình nâng cao

### Auth để tải spec và `$ref`

Auth tải spec tách biệt auth nghiệp vụ, chỉ dùng static secret, không chạy recipe:

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

Credential tải spec chỉ gửi tới origin của source spec, không gửi sang origin `$ref` khác. Remote spec không được tham chiếu file local. Local `$ref` phải nằm trong roots được phép; thư mục chứa local spec được dùng làm root cho spec đó. Spec fetch không follow redirect. Một ref thiếu/sai làm snapshot service bị từ chối; service khác vẫn hoạt động.

### Spec không hoàn hảo: cảnh báo thay vì chặn

Spec do framework tự sinh (ví dụ NestJS) hay có lỗi nhỏ. Ba lỗi sau **không** chặn service. Chúng hiện trong `warnings` của `list_apis`. Danh sách bị giới hạn: tối đa 20 mục, tổng không quá 4096 byte, mỗi mục tối đa 512 byte và một dòng. Thứ tự ưu tiên: operation bị loại, rồi security scheme, rồi `operationId` trùng. Số liệu chính xác nằm ở trường `warningSummary` (`total`, `shown`, `omitted`, `excludedOperations`), không phải một dòng chữ thêm vào cuối danh sách. Khi `list_apis` quá ngân sách đầu ra, text cảnh báo được rút bớt (số đếm vẫn đúng); nếu ngay cả metadata cũng quá lớn thì trả `servicesInline: false` kèm `servicesArtifact`, đọc toàn bộ bằng `read_artifact`:

| Lỗi trong spec | Cách xử lý | Ảnh hưởng |
|---|---|---|
| `operationId` trùng giữa nhiều endpoint | Chỉ cảnh báo | Không ảnh hưởng, vì operation được gọi bằng `METHOD /path`. Search theo đúng id đó ra nhiều kết quả; phân biệt bằng trường `operation` |
| `in`/`name` thừa trên security scheme `type: http` | Bỏ qua trường thừa khi kiểm tra, giữ nguyên spec gốc | Không ảnh hưởng |
| Operation khai báo path parameter không có trong đường dẫn (ví dụ `customerId` mà path thiếu `{customerId}`) | **Loại riêng operation đó** khỏi service | Operation bị loại không tìm được; gọi trực tiếp trả `OPERATION_UNKNOWN` với message `operation was excluded from this specification` và `details.reason` = `PATH_PARAMETER_NOT_IN_TEMPLATE`; các operation khác dùng bình thường |

Các lỗi khác vẫn chặn cả service với `SPEC_INVALID`, ví dụ path template `{id}` không được khai báo, `$ref` thiếu, hoặc sai cấu trúc OpenAPI.

**`$ref` kèm method hoặc `parameters` cùng cấp bị chặn.** Bất kỳ object nào trong spec mà có `$ref` dạng string cùng với `get`/`put`/`post`/`delete`/`options`/`head`/`patch`/`trace` hoặc `parameters` đều bị từ chối (`<tài liệu>: an object combines $ref with execution siblings (a method or parameters)`). Các công cụ xử lý trường hợp này khác nhau (bỏ qua, ghi đè hay gộp) và bundler gộp ngầm, nên server không tự chọn: tác giả spec phải chọn một cách. `summary`, `description` và `x-*` cùng cấp vẫn được phép.

Việc quét chạy trên từng tài liệu gốc (root và mọi file hoặc URL được phép mà `$ref` trỏ tới) ngay khi đọc, trước khi bundler gộp chúng, và chạy lại trên tài liệu sau khi bundle, vì `$ref` mở rộng trên một container (ví dụ `paths: { $ref: 'p.json', '/a': { $ref: '#/x' } }`) có thể làm bundler tự tạo ra `$ref` kèm method từ hai object riêng lẻ đều hợp lệ. Server kiểm tra hình dạng object trước và sau bundle, không tự phân giải lại đường dẫn `$ref`. Chi phí: mọi object có hình dạng này bị từ chối, không chỉ dữ liệu mẫu (`example`, `enum`, `default`, `x-*`) mà cả schema, Link và Response, kể cả hình dạng chỉ xuất hiện sau khi merge. Đây là giới hạn tương thích: khi gặp, cần điều chỉnh spec (đổi tên key hoặc bỏ `$ref` khỏi object đó) nếu việc đó không làm sai contract của spec.

**Extended `$ref` được chấp nhận.** Khi `$ref` mở rộng trên một container và kết quả merge không còn tổ hợp bị cấm, server chấp nhận merge của thư viện bundler: phía mở rộng (extender) thắng với giá trị scalar, object được gộp, array bị thay toàn bộ. Ví dụ: nếu file ngoài khai báo `parameters` có query bắt buộc `external` và phía mở rộng khai báo `parameters` có `root`, contract công bố chỉ còn `root`; parameter `external` biến mất vì array bị thay, không cộng dồn. Contract MCP công bố và dùng để serialize request là contract **sau bundle và sau validation**; không có bằng chứng server thật chấp nhận contract này. Hãy kiểm tra contract (`get_operation_schema`) và thử ở môi trường phù hợp trước khi gửi request có tác dụng phụ.

**Giới hạn đọc lặp.** Số chuỗi `$ref` khác nhau mà bundler yêu cầu đọc bị giới hạn bởi `refGraphDocuments`, và tổng số byte đọc (kể cả cùng một file đọc nhiều lần dưới những cách viết khác nhau như `.//a.json`) bị giới hạn bởi `refGraphBytes`. Vượt ngân sách đọc đã cấu hình thì dừng với `SPEC_LIMIT_EXCEEDED`. Ngân sách byte đầu vào không phải giới hạn cứng của heap/RSS.

Lỗi tải và phân tích spec bị giới hạn 2048 byte. Cảnh báo chỉ báo lỗi, không sửa spec: nên sửa ở backend khi có thể.

### TLS riêng từng service

```yaml
tls:
  caFile: ./certs/dev-ca.pem
  verify: true
```

Đây là block đặt dưới service. `verify: false` tắt xác minh TLS riêng service đó và có cảnh báo; chỉ dùng khi thực sự cần trong môi trường thử nghiệm, không phải cách sửa chứng chỉ mặc định. Không có tool đổi TLS lúc gọi API.

### File và giới hạn

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

Chỉ khai báo những giá trị cần đổi. Tất cả giới hạn là số nguyên dương có mức tối đa; xem JSON Schema để biết range.

| Key | Mặc định | Phạm vi |
|---|---:|---|
| `requestTimeoutMs` | 30000 ms | Request, gồm redirect hops; recipe cũng có timeout |
| `maxConcurrentRequests` | 8 | Request thường |
| `recipeConcurrency` | 2 | Lane riêng cho auth recipe |
| `specDocumentBytes` | 10 MiB | Một document spec |
| `refGraphDocuments` | 100 | Số document trong graph |
| `refGraphBytes` | 50 MiB | Tổng bytes graph |
| `refGraphDepth` | 64 | Độ sâu refs/template |
| `responseBytes` | 50 MiB | Một response |
| `uploadBytes` | 50 MiB | Upload |
| `sessionArtifactBytes` | 250 MiB | Tổng artifact quota |
| `inlineStringBytes` | 4096 bytes | Ngưỡng string hiển thị inline |
| `toolOutputBytes` | 32768 bytes | Budget kết quả tool |
| `artifactPageBytes` | 16384 bytes | Một trang đọc artifact |
| `maxRedirects` | 5 | Số redirect được theo khi bật |

`uploadRoots`/`exportRoots` mặc định rỗng: không cho phép upload/export cho tới khi khai báo. `artifactRoot` có thể chưa tồn tại; server tạo khi chạy. Vượt giới hạn response vẫn trả status/headers nhưng body có thể không đầy đủ.

## 12. Danh sách tool

| Tool | Dùng khi |
|---|---|
| `list_apis` | Xem service, spec readiness/revision, số operation, `warnings` của spec, auth mode/capability và lỗi tải spec |
| `search_operations` | Tìm theo path, operationId, tag, summary, description; hỗ trợ paging |
| `get_operation_schema` | Xem parameters, body, response schemas, security và refs của operation; contract lớn chuyển vào artifact |
| `invoke_operation` | Gửi request thật, nhận HTTP outcome, diagnostics và tùy chọn capture vào session |
| `refresh_specs` | Reload/validate spec; lỗi thì giữ snapshot hợp lệ trước đó |
| `authenticate` | Chạy authentication, refresh rõ ràng hoặc reload static auth sources |
| `get_auth_status` | Xem state, revision, capability, credential/binding presence, cookie names và failure; không trả credential values |
| `manage_session` | Create/inspect/delete session riêng, import credential trực tiếp hoặc từ catalog |
| `read_artifact` | Đọc response/contract đã lưu theo trang hoặc JSON Pointer |
| `export_artifact` | Xuất bytes, text hoặc base64-decoded data vào file mới dưới exportRoots |

Số tool không tăng theo số endpoint. Không tool nào nhận URL tùy ý để gọi ngoài các service đã cấu hình, tên env/file secret tùy ý, script hoặc tham số chuyển môi trường.

## 13. Giới hạn và phát triển

### Phạm vi

- Local MCP qua stdio, không phải hosted gateway hay HTTP MCP server.
- Không phải workflow engine: một recipe = một operation. Multi-step do agent/người dùng điều phối.
- Không tự động hóa OAuth/PKCE callback, OTP polling, CAPTCHA, browser login; không hỗ trợ script, HMAC signing hay mTLS client auth.
- Không có telemetry. Spec và response là dữ liệu không đáng tin, không phải chỉ dẫn cho agent; không thực thi descriptions/extensions.
- Validation phụ thuộc chất lượng spec. Unknown format được ghi nhận là chưa kiểm chứng, không coi là đã đạt. Không quảng cáo token savings hay độ chính xác semantic search; search là token scoring xác định.
- Config/tool cũ bị loại bỏ, không alias tương thích: `bearer.login`, profile `components`/`recovery`, service-level `allowedProfiles`/`defaultProfile`, `$source`/`$component`, `authenticate_profile`/`get_profile_status` không còn dùng. Dùng các dạng trong hướng dẫn này.

### Dành cho người phát triển

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

`npm run verify:package` cần `npm run build` chạy trước. Nó đóng gói thật, cài tarball vào thư mục consumer riêng, chạy `--check`, bin shim và smoke trên bản đã cài, rồi audit bản đã cài. Chỉ khi tất cả đạt, tarball mới vào `.release/<tên>.tgz` kèm file `.sha256`; nếu audit lỗi, tarball được giữ ở `.release/diagnostic/NOT-RELEASABLE-...` để làm bằng chứng. `npm pack --dry-run` không thay thế các bước này. Các cell CI (Ubuntu/macOS/Windows với Node 22.19.0, 22, 24) là một điều kiện phát hành riêng.

Build trước integration/smoke vì một số test chạy compiled CLI qua stdio. Tests dùng loopback backend, dữ liệu giả và chứng chỉ self-signed chỉ dành cho test. Không cần credential thật. `npm run gen:notices` cập nhật third-party notices khi cần.

Giấy phép MIT. Danh sách giấy phép dependency: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
