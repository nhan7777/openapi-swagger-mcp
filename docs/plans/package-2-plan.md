# Gói 2 — Search chính xác cho API thực tế: Implementation Plan

**Trạng thái hiện tại:** lexical-only Unicode/field-aware search, rank params v4. Nhánh semantic/model đã bị rút và gỡ theo yêu cầu người dùng; plan hybrid được giữ chỉ làm lịch sử. Không model/native inference/embedding/fusion runtime được ship. P1 foundation và các cải tiến lexical/policy/cursor/output bounds được giữ; P3/P4 vẫn cần tích hợp theo thứ tự coordinator.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thay search ASCII hiện tại bằng search lexical Unicode, field-aware, có reverse lookup qua schema/response field, ranking giải thích được, index bị chặn tài nguyên, cursor an toàn theo revision và benchmark tái lập được.

**Architecture:** Module mới `src/search/` thuần (không I/O, không network) xây inverted index cho từng `Snapshot` (cache `WeakMap<Snapshot, ServiceIndex>`, nên refresh tự loại index cũ). `search_operations` vẫn là tool duy nhất; thêm tham số `fields` và bằng chứng match. Benchmark nằm ở `bench/search/`, ngoài package publish.

**Tech Stack:** TypeScript 7 (NodeNext, strict), Node ≥ 22.19 (`String.prototype.normalize`, Unicode property escapes), zod 4, vitest 5, MCP SDK 1.32.1. Không thêm dependency runtime.

**Spec:** `/Users/nhan/Desktop/project/openapi-swagger-mcp/docs/local-api-debugging-roadmap.md` §7 (Gói 2), §2, §5, §12; `/Users/nhan/Desktop/project/openapi-swagger-mcp/docs/orca-planning-contract.md`.

## Global Constraints

- MCP local qua stdio; không hosted relay, telemetry, embedding/reranker/model cloud. Search chạy offline với local spec.
- Semantic local ngoài phạm vi; chỉ cân nhắc khi benchmark lexical cho thấy thiếu hụt rõ ràng.
- Registry (`SpecRegistry.refreshService`, `peek`, `getOperation`) và `Snapshot.revision` là authority duy nhất; không có spec store/cache spec thứ hai.
- Luồng search → `get_operation_schema` → `invoke_operation` giữ nguyên; không tạo tool riêng cho từng kỹ thuật search.
- Không tự coi khái niệm nghiệp vụ khác nhau là đồng nghĩa; alias chỉ do người dùng khai báo.
- Không âm thầm match-all cho query không xử lý được; query rỗng là browse.
- Output bị chặn theo `limits.toolOutputBytes`; đây là giới hạn kích thước, không phải redaction.
- Không thêm dependency runtime; benchmark đối thủ cài trong thư mục cô lập và chỉ khi coordinator cho phép network.
- Shared files `src/server.ts`, `src/config.ts`, `src/config-schema.ts`, `config.schema.json`, `README.md`, `examples/config.example.yaml`, `package.json`: chỉ sửa trong Task 6–7 theo thứ tự commit do coordinator chốt. Gói 2 không sửa `src/app.ts`.
- Tests: hành vi/biên/bất biến có ý nghĩa với consumer; không test wording hay cấu trúc source.

---

## 1. Hành vi hiện tại (kế thừa, đã đọc code ở baseline `7ff7326`)

| Điểm | Hiện trạng | File |
|---|---|---|
| Tokenizer | `s.toLowerCase().split(/[^a-z0-9]+/)` — mọi ký tự ngoài ASCII là separator. Query toàn chữ Hán/tiếng Việt có dấu → `tokens=[]` → `matchAll=true` → trả mọi operation (lỗi roadmap §13). | `src/specs/search.ts:29,72` |
| Field | Chỉ `key/path/operationId/method` (30), `tags+summary` (15), `description` (5); +1000 exact, +200 substring. Không index parameter, request/response schema. | `src/specs/search.ts:32-47` |
| Cursor | base64url `{h,o}`; `h` = sha256(query, service, method, tag, includeDeprecated, `service@revision` đã sort). Lệch → `CURSOR_INVALID` chung, không phân biệt lý do. | `src/specs/search.ts:49-70` |
| Snapshot | Snapshot bất biến, swap nguyên tử trong `refreshService`; single-flight. `peek()` đồng bộ. | `src/specs/registry.ts:48-108` |
| Server | `search_operations` (zod strict: `query≤500`, `service`, `method`, `tag`, `includeDeprecated`, `limit 1..50`, `cursor`); service không có snapshot bị bỏ qua im lặng khi không lọc service; `summary` cắt 200 ký tự ở server. | `src/server.ts:99-139` |
| Budget | `run()` trả `OUTPUT_TOO_LARGE` nếu JSON > `toolOutputBytes` (mặc định 32768). | `src/server.ts:55-68` |
| Tests đang khóa contract | `mcp.test.ts:100-132` (exact path, operationId, tag với `query:''` → `total 1`, keyword, 50 hit ≤ 32768 byte, không có `parameters` trong hit, cursor sai query → `CURSOR_INVALID`); `smoke.mjs:152-154` (`'widget picture'` → `GET /widgets/{id}` đầu tiên). | tests |
| Operation model | `Operation.parameters[].raw`, `requestBody.content[].schema`, `responses[status].content[].schema`, `headers[]`; schema giữ `$ref` nội bộ, `resolveRef(doc,node,ptr,onRef)` theo chuỗi ref. | `src/specs/model.ts:7-85` |

Tất cả hành vi trên trừ match-all cho query không token và tokenizer ASCII được giữ tương thích (xem §4).

## 2. Thay đổi đề xuất (tóm tắt)

1. Chuẩn hóa Unicode: NFKC, lowercase không phụ thuộc locale, fold dấu (`đ→d`…) nhưng giữ dạng có dấu để thưởng exact; tách camelCase/snake/kebab/acronym/chữ-số; chữ dày đặc (Han, Kana, Thai, Lao, Khmer, Myanmar) index unigram + bigram.
2. Index field-aware: identifier, path, tag, summary, description, tên/mô tả parameter, request field, response field (cả response header), tên schema, mô tả field; có giới hạn độ sâu, số field/operation, số posting/service.
3. Ranking: tier (exact literal > path template instance > compound identifier > lexical > fuzzy-only) rồi BM25F + coord; fuzzy Damerau giới hạn chỉ khi term không có trong vocabulary.
4. Reverse lookup: `fields: ["responseField"]` (hoặc `schema`) giới hạn match vào schema/response field.
5. Bằng chứng match ngắn (`matches[]`), `tier`, `targets` (baseUrl) cho service xuất hiện trong trang, `unavailableServices`, `coverage` khi index bị cắt.
6. Query không xử lý được → `QUERY_UNPROCESSABLE`; cursor có lý do `MALFORMED | QUERY_MISMATCH | REVISION_CHANGED`.
7. Alias nghiệp vụ trong config `search.aliases`; `search.limits`.
8. Benchmark `bench/search/` với corpus, nhãn và target đóng băng trước khi chỉnh ranking; adapter baseline v0.1.2, engine mới (in-process và stdio), đối thủ (có trạng thái `unavailable` trung thực).

## 3. File structure

| File | Trách nhiệm | Loại |
|---|---|---|
| `src/search/types.ts` | Kiểu public của search (request/response/hit/evidence/config) | Create |
| `src/search/text.ts` | Normalize, fold, tokenize, truncate code-point-safe | Create |
| `src/search/schema-fields.ts` | Duyệt schema của operation → field entries có giới hạn | Create |
| `src/search/build-index.ts` | `buildServiceIndex(snapshot, cfg, filter)` → `ServiceIndex` | Create |
| `src/search/fuzzy.ts` | Damerau-OSA bounded + mở rộng vocabulary | Create |
| `src/search/query.ts` | Parse query → term groups, alias, stopword, exact probes | Create |
| `src/search/rank.ts` | Tier, BM25F, coord, evidence | Create |
| `src/search/cursor.ts` | Encode/decode cursor v1, hash | Create |
| `src/search/engine.ts` | `SearchEngine` (cache index, filters, paging, fit budget) | Create |
| `src/specs/search.ts` | Thay thế hoàn toàn | Delete |
| `src/config-schema.ts` | `SearchSchema` + key `search` top-level | Modify (shared) |
| `src/config.ts` | `AppConfig.search`, kiểm tra cross-ref alias→service | Modify (shared) |
| `src/server.ts` | Handler `search_operations` dùng `SearchEngine`, thêm `fields` | Modify (shared, chỉ dòng 99-139 + import dòng 10) |
| `config.schema.json` | Regenerate | Modify (generated) |
| `README.md`, `examples/config.example.yaml` | Docs search/alias/limits | Modify (shared) |
| `package.json` | Script `bench:search` | Modify (shared, 1 dòng) |
| `tests/unit/search-text.test.ts` | Tokenizer/fold/CJK | Create |
| `tests/integration/search-engine.test.ts` | Engine trên snapshot thật từ `SpecLoader` | Create |
| `tests/integration/search-mcp.test.ts` | Qua stdio thật: refresh/cursor/Unicode/reverse/budget/alias | Create |
| `tests/integration/mcp.test.ts`, `tests/integration/config-schema-parity.test.ts`, `tests/smoke.mjs` | Cập nhật contract | Modify |
| `bench/search/**` | Corpus, nhãn, harness, adapters, kết quả | Create |

## 4. Interfaces (đề xuất, chờ coordinator duyệt)

### 4.1. `src/search/types.ts`

```ts
import type { Operation } from '../specs/model.js';

/** Field nội bộ của index; thứ tự mảng là thứ tự ưu tiên khi cắt theo budget. */
export const SEARCH_FIELDS = ['identifier', 'path', 'tag', 'summary', 'paramName', 'requestField', 'responseField', 'schemaName', 'description', 'paramText', 'fieldText'] as const;
export type SearchField = (typeof SEARCH_FIELDS)[number];

/** Phạm vi do caller chọn (tham số `fields` của tool). */
export const FIELD_SCOPES = ['identifier', 'text', 'parameter', 'requestField', 'responseField', 'schema'] as const;
export type FieldScope = (typeof FIELD_SCOPES)[number];
export const SCOPE_FIELDS: Record<FieldScope, readonly SearchField[]> = {
  identifier: ['identifier', 'path'],
  text: ['tag', 'summary', 'description'],
  parameter: ['paramName', 'paramText'],
  requestField: ['requestField', 'schemaName', 'fieldText'],
  responseField: ['responseField', 'schemaName', 'fieldText'],
  schema: ['schemaName', 'requestField', 'responseField'],
};

export interface SearchRequest {
  query: string;
  service?: string;
  method?: string;
  tag?: string;
  includeDeprecated?: boolean;
  fields?: FieldScope[];
  limit?: number;
  cursor?: string;
}

export type MatchKind = 'exact' | 'token' | 'alias' | 'fuzzy';
export interface MatchEvidence {
  field: SearchField;
  /** Text gốc (không fold), cắt ≤120 code point. Với field schema: đường dẫn field, ví dụ `data.items[].customerName`. */
  text: string;
  /** Term của query đã khớp (dạng người dùng gõ, sau NFKC). */
  terms: string[];
  kind: MatchKind;
  /** Chỉ cho field schema/parameter: `response 200 application/json via Order`, `query parameter`. */
  location?: string;
}

export type HitTier = 'exact' | 'template' | 'identifier' | 'lexical' | 'fuzzy';
export interface SearchHit {
  service: string;
  operation: string;
  method: string;
  path: string;
  operationId?: string;
  /** ≤200 code point. */
  summary?: string;
  tags: string[];
  deprecated: boolean;
  revision: string;
  score: number;
  /** Vắng ở browse mode. */
  tier?: HitTier;
  /** Vắng ở browse mode; tối đa 3. */
  matches?: MatchEvidence[];
}

export interface IndexCoverage {
  service: string;
  revision: string;
  operationsIndexed: number;
  postings: number;
  /** Field bị bỏ (một phần hoặc toàn bộ) vì `postingsPerService`. */
  truncatedFields: SearchField[];
  /** Số operation có field schema bị cắt vì `schemaDepth`/`fieldsPerOperation`. */
  operationsWithTruncatedSchema: number;
}

export interface SearchResponse {
  mode: 'browse' | 'search';
  total: number;
  results: SearchHit[];
  nextCursor?: string;
  /** Chỉ service có trong `results`; package 4 có thể mở rộng value (ví dụ nhãn environment). */
  targets: Record<string, { baseUrl: string }>;
  /** Service đã cấu hình nhưng chưa có snapshot (chỉ khi không lọc `service`). */
  unavailableServices?: string[];
  /** Chỉ khi có cắt. */
  coverage?: IndexCoverage[];
  /** Mã ngắn: `QUERY_TERMS_TRUNCATED`, `FUZZY_USED`, `PAGE_SHRUNK_FOR_OUTPUT_BUDGET`, `EVIDENCE_TRIMMED_FOR_OUTPUT_BUDGET`. */
  notes?: string[];
}

export interface SearchAlias { terms: string[]; services?: string[] }
export interface SearchLimits {
  schemaDepth: number;          // mặc định 6, max 32
  fieldsPerOperation: number;   // mặc định 400, max 5000
  postingsPerService: number;   // mặc định 1_000_000, max 20_000_000
  descriptionTokens: number;    // mặc định 256, max 4096
  fuzzyExpansions: number;      // mặc định 8, max 32
}
export interface SearchConfig { aliases: SearchAlias[]; limits: SearchLimits }

/** Bộ lọc operation do gói 1 cung cấp (nếu gói 1 không lọc ngay tại Snapshot). Áp dụng lúc build index. */
export type OperationFilter = (serviceId: string, op: Operation) => boolean;
```

### 4.2. `src/search/engine.ts`

```ts
export class SearchEngine {
  constructor(opts: { config: SearchConfig; baseUrls: ReadonlyMap<string, string>; operationFilter?: OperationFilter });
  /**
   * Đồng bộ (không await) ⇒ các snapshot đọc qua `registry.peek()` trong cùng tick không bị refresh xen giữa.
   * Throws ToolError: QUERY_UNPROCESSABLE, CURSOR_INVALID.
   */
  search(snapshots: readonly Snapshot[], req: SearchRequest, opts: { maxBytes: number; unavailableServices?: string[] }): SearchResponse;
}
```

Index cache: `private indexes = new WeakMap<Snapshot, ServiceIndex>()`. Index build lười ở lần search đầu của snapshot. Refresh tạo object `Snapshot` mới → index mới; index cũ được GC cùng snapshot cũ. Không cần hook refresh, không sửa `SpecRegistry`.

### 4.3. Lỗi

| Code | Khi | `details` |
|---|---|---|
| `QUERY_UNPROCESSABLE` (mới) | `query.trim()!==''` nhưng không có term tìm được và không exact-match path/key nào; hoặc `fields` có mà query rỗng | `{ reason: 'NO_SEARCHABLE_TERMS' \| 'FIELDS_REQUIRE_QUERY' }` |
| `CURSOR_INVALID` (giữ code) | cursor sai định dạng / khác query / revision đã đổi | `{ reason: 'MALFORMED' \| 'QUERY_MISMATCH' \| 'REVISION_CHANGED', currentRevisions?: Record<string,string> }` |
| `SERVICE_UNKNOWN`, `SERVICE_UNAVAILABLE` | Giữ nguyên ở server | — |

### 4.4. Cursor v1

base64url(JSON `{"v":1,"q":<16 hex>,"r":<16 hex>,"o":<int>}`), tổng ≤ 512 ký tự, `0 ≤ o ≤ 1_000_000`.
- `q` = sha256(canonical `[query.normalize('NFC'), service??null, method?.toUpperCase()??null, fold(tag)??null, includeDeprecated===true, sorted fields??null]`), không gồm `limit` (đổi limit giữa các trang vẫn hợp lệ như hiện tại).
- `r` = sha256(sorted `service@revision` của snapshot được search).
- `q` khác → `QUERY_MISMATCH`; `q` khớp, `r` khác → `REVISION_CHANGED` kèm `currentRevisions`. Cursor format cũ `{h,o}` → `MALFORMED`.
- Cursor không phải cơ chế bảo mật; chỉ là offset có ràng buộc.

### 4.5. Config

```yaml
search:
  aliases:
    - terms: ["đơn hàng", "order"]
    - terms: ["khách hàng", "customer", "client"]
      services: [crm]          # tuỳ chọn; service phải tồn tại
  limits:
    schemaDepth: 6
    fieldsPerOperation: 400
    postingsPerService: 1000000
    descriptionTokens: 256
    fuzzyExpansions: 8
```

Quy tắc: `aliases` ≤ 500 nhóm; mỗi nhóm 2–16 term, mỗi term 1–100 ký tự và phải sinh ≥1 token (kiểm tra trong `loadConfig`, lỗi `CONFIG_INVALID` với path `search.aliases.N.terms.M`); `services` tham chiếu service không tồn tại → `CONFIG_INVALID`. Alias **không bắc cầu** giữa các nhóm: phrase thuộc nhóm A chỉ mở rộng thành term của A.

### 4.6. Tool `search_operations` (thay đổi tương thích ngược)

Input thêm `fields: z.array(z.enum(FIELD_SCOPES)).min(1).max(6).optional()`. Mọi field cũ giữ nguyên tên/kiểu/mặc định. Output giữ `total`, `results[]` (mọi field cũ), `nextCursor`; thêm `mode`, `targets`, `tier`, `matches`, `unavailableServices?`, `coverage?`, `notes?`.

## 5. Tích hợp server/config và xung đột

| Shared file | Gói 2 sửa | Gói khác có thể sửa | Cách tránh |
|---|---|---|---|
| `src/server.ts` | Import dòng 10; khối `search_operations` 99-139; tạo `SearchEngine` trong `createServer` sau dòng 52 | Gói 1 bọc `run()`/thêm trace cho mọi tool; gói 4 thêm tool preview | Gói 2 chỉ đổi nội dung khối handler; nếu gói 1 đổi chữ ký `run`, rebase handler lên `run` mới. Commit gói 2 nên đi **sau** commit server của gói 1. |
| `src/config-schema.ts` | Thêm `SearchSchema` (export) và key `search: SearchSchema` trong `ConfigSchema` sau `limits` | Gói 1 (policy/trace), gói 3 (inspector) thêm key top-level | Key mới riêng; merge thứ tự; regenerate `config.schema.json` một lần sau khi tất cả schema merge. |
| `src/config.ts` | `AppConfig.search: SearchConfig`; validate alias trong `loadConfig` sau parse (gần dòng 463-487) | Gói 1/3 thêm field AppConfig | Field riêng, append cuối interface và object trả về. |
| `README.md`, `examples/config.example.yaml` | Mục search (dòng ~630-651, 838) và block `search:` | Mọi gói | Sửa section riêng; coordinator gộp. |
| `tests/smoke.mjs` | Thêm assert search Unicode/response field sau dòng 154 | Gói 4 thêm tool → đổi danh sách tool dòng 143-146 | Gói 2 không đổi danh sách tool. |
| `package.json` | `"bench:search": "node bench/search/run.mjs"` | Gói 3/4 scripts | Một dòng. |

Phụ thuộc gói 1 (operation policy): roadmap yêu cầu filter có hiệu lực ở discovery. Hai phương án, gói 1 chọn:
- **A (khuyến nghị):** gói 1 lọc tại `SpecLoader`/`Snapshot.operations` (operation bị chặn vào `excludedOperations` với reason mới). Search tự đúng, gói 2 không cần wiring.
- **B:** gói 1 export predicate `(serviceId, op) => boolean`; server truyền vào `SearchEngine.operationFilter`. Filter áp lúc build index, nên predicate phải cố định trong vòng đời process (đổi policy runtime cần thêm policy revision vào khóa cache — ngoài phạm vi nếu gói 1 không có).

Cho đến khi gói 1 chốt, `operationFilter` không được truyền: đó là hành vi thật hiện tại (chưa có policy), không phải stub. Không có phụ thuộc vào gói 3. Gói 4 có thể đọc `targets` để hiển thị target/environment.

Độc lập ngay sau khi plan duyệt: Task 1–5 và Task 8 (chỉ dùng `Snapshot`/`Operation` đã tồn tại). Task 6–7 sửa shared files theo thứ tự coordinator. Task 9 cần network (cài đối thủ) và chấp thuận. Task 10 sau Task 7–9.

## 6. Thuật toán (chuẩn cho mọi task)

### 6.1. Chuẩn hóa và token

- `nfkc(s) = s.normalize('NFKC')`; `lower(s) = s.toLowerCase()` (không dùng `toLocaleLowerCase`).
- `fold(s)`: `lower(nfkc(s)).normalize('NFD').replace(/\p{M}/gu,'')` rồi bảng `{đ:'d', ð:'d', ł:'l', ø:'o', ß:'ss', æ:'ae', œ:'oe', ı:'i'}`, rồi `normalize('NFC')`.
- Chunk = chuỗi tối đa ký tự `[\p{L}\p{N}\p{M}]`; mọi ký tự khác là separator (gồm `/ { } _ - . :`).
- Chunk Latin/Cyrillic/Greek/Hangul…: tách tại `lower→Upper`, `UPPER→Upper lower` (acronym: `HTTPServer`→`HTTP`,`Server`), `letter↔digit`. Mỗi part sinh term `fold(part)`; nếu ≥2 part còn sinh thêm term compound `fold(chunk)` (để `orderId`, `order_id`, `order-id` khớp nhau qua `orderid` và qua parts).
- Chunk thuộc script dày đặc (`\p{Script=Han}|Hiragana|Katakana|Thai|Lao|Khmer|Myanmar`): sinh unigram từng ký tự và bigram liền kề. Chunk hỗn hợp: tách run theo script trước.
- Mỗi term mang `exact = lower(nfkc(part))`; nếu `exact !== folded` index thêm posting khóa `'\u0001'+exact` (không tính vào coord) để thưởng khớp đúng dấu.
- Stopword (chỉ áp cho query, field `summary/description/paramText/fieldText`): EN `a an and the of for to in on by with get list api` ; VI `cua cho va cac mot lay danh sach theo`. Danh sách cố định trong `text.ts`, đóng băng cùng benchmark.
- Truncate hiển thị: theo code point (`Array.from`), không cắt surrogate.

### 6.2. Field schema

Duyệt iterative với stack `(node, path, depth, location, via)`:
- Theo `$ref` bằng `resolveRef(snapshot.bundled, node, '', onRef)`; tên schema = token cuối của mỗi `$ref` hop (decode `~1`→`/`, `~0`→`~`), cộng `title` nếu là string.
- Theo `properties` (thêm `.name`), `items`/`prefixItems` (thêm `[]`), `additionalProperties` (thêm `.*`), `allOf/anyOf/oneOf` (cùng path). Không theo `enum/example/examples/default/const/x-*` (dữ liệu, cùng nguyên tắc `schema-walk.ts`).
- Chống vòng: tập node đang trên đường đi hiện tại (ancestor set); dừng khi `depth > schemaDepth` hoặc đã sinh `fieldsPerOperation` field; đánh dấu operation bị cắt.
- Nguồn: `parameters[].raw.schema` (param body Swagger2 → request), `requestBody.content[].schema`, `responses[s].content[].schema`, `responses[s].headers[]` (tên header là `responseField`). Media type trùng schema object chỉ duyệt một lần (cùng object reference).
- Description field: ≤ `descriptionTokens` token.

### 6.3. Ranking

- Query terms: token hoá như 6.1 thành nhóm theo vị trí người gõ; alias phrase khớp liên tiếp → thêm term alt (weight 0.7, kind `alias`). Tối đa 32 term gốc (thêm note `QUERY_TERMS_TRUNCATED`), 64 sau alias.
- Fuzzy: chỉ cho term gốc ≥4 ký tự không có trong vocabulary service; ngưỡng OSA: len 4–5 → 1, ≥6 → 2; ứng viên lấy theo bucket độ dài ±k; giữ ≤ `fuzzyExpansions` (distance tăng, df giảm, chữ cái); weight `0.5/distance`.
- BM25F: `k1=1.2`; weight field `identifier 8, path 6, tag 4, summary 4, paramName 3, requestField 3, responseField 3, schemaName 3, description 1, paramText 1, fieldText 1`; `b` 0.75 cho text field, 0 cho identifier/path/tag/schemaName. `idf = ln(1 + (N - df + 0.5)/(df + 0.5))`.
- `coord = Σ idf(term khớp)/Σ idf(term gốc)`; loại hit `coord < 0.34` khi ≥3 term gốc không phải stopword.
- Tier (so sánh trước score):
  1. `exact`: `fold(query.trim())` bằng `fold(op.key)`, `fold(op.path)` hoặc `fold(operationId)`.
  2. `template`: query là path cụ thể (bắt đầu `/`, có ≥1 segment) khớp template (`{x}` = 1 segment bất kỳ, so fold, bỏ trailing `/`), có thể có tiền tố method.
  3. `identifier`: compound term của query bằng compound term của operationId/path segment.
  4. `lexical`: ≥1 term không fuzzy khớp.
  5. `fuzzy`: chỉ khớp qua fuzzy.
- Sắp xếp: tier, score giảm dần (làm tròn 6 chữ số), `service`, `operation` (code unit) — tất định.
- Evidence: tối đa 3 per hit, ưu tiên field weight cao; mỗi field một entry.
- Browse (`query.trim()===''`, không `fields`): thứ tự `service`, `operation`; `score: 1`, không `tier/matches` — giữ hành vi hiện tại.

### 6.4. Fit output budget

`search()` serialize response; nếu > `maxBytes·0.85`: (1) giảm evidence còn 1/hit, note `EVIDENCE_TRIMMED_FOR_OUTPUT_BUDGET`; (2) giảm số hit trang này (nhị phân, ≥1), `nextCursor` theo offset thực tế, note `PAGE_SHRUNK_FOR_OUTPUT_BUDGET`. Không bỏ dữ liệu khỏi index, không thay text bằng mask.

## 7. Tasks

### Task 1: Chuẩn hóa và tokenizer Unicode

**Files:**
- Create: `src/search/text.ts`, `src/search/types.ts` (nội dung nguyên văn §4.1; các task sau import từ đây)
- Test: `tests/unit/search-text.test.ts`

**Interfaces:**
- Produces:
  - `fold(s: string): string`
  - `interface Term { folded: string; exact: string; compound: boolean; pos: number }`
  - `tokenize(s: string, opts?: { stopwords?: boolean; maxTokens?: number }): Term[]`
  - `truncateCodePoints(s: string, max: number): string`
  - `STOPWORDS: ReadonlySet<string>`

- [ ] **Step 1: Viết test fail**

```ts
import { describe, expect, test } from 'vitest';
import { fold, tokenize, truncateCodePoints } from '../../src/search/text.js';

const folded = (s: string) => tokenize(s).map((t) => t.folded);

describe('search tokenizer', () => {
  test('identifier styles meet on parts and compound', () => {
    for (const s of ['orderId', 'order_id', 'order-id', 'OrderID']) expect(folded(s)).toEqual(expect.arrayContaining(['order', 'id', 'orderid']));
    expect(folded('HTTPServerURL')).toEqual(expect.arrayContaining(['http', 'server', 'url']));
    expect(folded('oauth2Token')).toEqual(expect.arrayContaining(['oauth', '2', 'token', 'oauth2token']));
  });
  test('Vietnamese folds diacritics and đ but keeps exact form', () => {
    expect(fold('Đơn hàng')).toBe('don hang');
    const t = tokenize('Đơn');
    expect(t[0]).toMatchObject({ folded: 'don', exact: 'đơn' });
  });
  test('dense scripts produce unigrams and bigrams', () => {
    expect(folded('订单详情')).toEqual(expect.arrayContaining(['订', '单', '订单', '单详', '详情']));
  });
  test('NFKC: fullwidth and compatibility forms', () => {
    expect(folded('ＯｒｄｅｒＩＤ')).toEqual(folded('OrderID'));
  });
  test('symbol-only input yields no terms', () => {
    expect(tokenize('🙂 -- //')).toEqual([]);
  });
  test('truncate never splits a surrogate pair', () => {
    expect(truncateCodePoints('a😀b', 2)).toBe('a😀');
  });
});
```

- [ ] **Step 2:** `npx vitest run tests/unit/search-text.test.ts` → FAIL (module không tồn tại).
- [ ] **Step 3: Implement** theo 6.1:

```ts
const FOLD_EXTRA: Record<string, string> = { đ: 'd', ð: 'd', ł: 'l', ø: 'o', ß: 'ss', æ: 'ae', œ: 'oe', ı: 'i' };
const DENSE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const CHUNK = /[\p{L}\p{N}\p{M}]+/gu;
export const fold = (s: string): string =>
  s.normalize('NFKC').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[đðłøßæœı]/g, (c) => FOLD_EXTRA[c]!).normalize('NFC');
export const truncateCodePoints = (s: string, max: number): string => { const cp = Array.from(s); return cp.length <= max ? s : cp.slice(0, max).join(''); };
/** Tách camel/acronym/chữ-số trong một run không dày đặc. */
function splitParts(run: string): string[] {
  return run.split(/(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u).filter(Boolean);
}
```
`tokenize`: với mỗi match `CHUNK` trên `s.normalize('NFKC')`, tách run theo `DENSE` (dày đặc/không); run dày đặc → unigram + bigram; run khác → `splitParts`, part → Term, thêm compound nếu ≥2 part. `pos` tăng theo part. Bỏ stopword khi `opts.stopwords` (so `folded`). Dừng ở `maxTokens`.
- [ ] **Step 4:** chạy lại → PASS.
- [ ] **Step 5:** `git add src/search/text.ts tests/unit/search-text.test.ts && git commit -m "feat(search): unicode normalization and tokenizer"`

### Task 2: Field schema có giới hạn

**Files:**
- Create: `src/search/schema-fields.ts`
- Test: thêm vào `tests/integration/search-engine.test.ts` (tạo file; helper load snapshot thật)

**Interfaces:**
- Consumes: `resolveRef` (`src/specs/model.ts`), `Operation`, `Snapshot`.
- Produces:
  - `interface FieldEntry { kind: 'requestField' | 'responseField'; name: string; path: string; description?: string; schemaNames: string[]; location: string }`
  - `extractFields(doc: unknown, op: Operation, limits: Pick<SearchLimits,'schemaDepth'|'fieldsPerOperation'>): { fields: FieldEntry[]; truncated: boolean }`

Helper test (đầu `search-engine.test.ts`), dùng loader thật, không network vì spec là file:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { Transport } from '../../src/http/transport.js';
import { SpecLoader, type Snapshot } from '../../src/specs/loader.js';
import { tmpDir } from '../helpers/harness.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
async function snapshotOf(spec: unknown, id = 'api', extra: Record<string, unknown> = {}): Promise<Snapshot> {
  const dir = tmpDir('oasm-search-'); dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(spec));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: 1, services: { [id]: { baseUrl: 'http://127.0.0.1:9', spec: { source: { file: 'spec.json' } } } }, files: { artifactRoot: path.join(dir, 'a') }, ...extra }));
  const cfg = loadConfig(path.join(dir, 'config.json'));
  const transport = new Transport(cfg);
  try { return await new SpecLoader(cfg, transport).load(id); } finally { await transport.close(); }
}
```

- [ ] **Step 1: Test fail**

```ts
import { extractFields } from '../../src/search/schema-fields.js';
const oas = (paths: object, schemas: object = {}) => ({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths, components: { schemas } });

describe('extractFields', () => {
  test('nested response fields through $ref, arrays and allOf, with schema names', async () => {
    const snap = await snapshotOf(oas(
      { '/orders': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Page' } } } } } } } },
      { Page: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Order' } } } },
        Order: { allOf: [{ type: 'object', properties: { customerName: { type: 'string', description: 'Tên khách' } } }] } },
    ));
    const op = snap.operations.get('GET /orders')!;
    const { fields } = extractFields(snap.bundled, op, { schemaDepth: 6, fieldsPerOperation: 400 });
    expect(fields).toContainEqual(expect.objectContaining({ kind: 'responseField', name: 'customerName', path: 'data[].customerName', schemaNames: expect.arrayContaining(['Order']) }));
  });
  test('recursive schema terminates and depth/field caps report truncation', async () => {
    const snap = await snapshotOf(oas(
      { '/node': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } } } } } },
      { Node: { type: 'object', properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/components/schemas/Node' } } } } },
    ));
    const r = extractFields(snap.bundled, snap.operations.get('GET /node')!, { schemaDepth: 6, fieldsPerOperation: 400 });
    expect(r.fields.filter((f) => f.name === 'children')).toHaveLength(1);
    expect(extractFields(snap.bundled, snap.operations.get('GET /node')!, { schemaDepth: 6, fieldsPerOperation: 1 }).truncated).toBe(true);
  });
  test('example/enum/default values are not fields', async () => {
    const snap = await snapshotOf(oas({ '/x': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', example: { secretLooking: 1 }, properties: { a: { type: 'string', enum: ['zzz'] } } } } } } } } } }));
    const names = extractFields(snap.bundled, snap.operations.get('GET /x')!, { schemaDepth: 6, fieldsPerOperation: 400 }).fields.map((f) => f.name);
    expect(names).toEqual(['a']);
  });
});
```

- [ ] **Step 2:** `npm run build && npx vitest run tests/integration/search-engine.test.ts` → FAIL.
- [ ] **Step 3:** Implement theo 6.2 (iterative stack, ancestor set = `Set<object>` copy-on-push chỉ khi có `$ref`/combinator; `location` dạng `response 200 application/json`, `request application/json`, `response 200 header`).
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(search): bounded schema field extraction`.

### Task 3: Build index

**Files:**
- Create: `src/search/build-index.ts`
- Test: `tests/integration/search-engine.test.ts`

**Interfaces:**
- Consumes: `tokenize`, `extractFields`, `SearchLimits`, `OperationFilter`.
- Produces:

```ts
export interface IndexedDoc { op: Operation; fieldLen: Float32Array /* theo SEARCH_FIELDS */; display: Map<SearchField, Array<{ text: string; location?: string; terms: Set<string> }>> }
export interface ServiceIndex {
  serviceId: string; revision: string; docs: IndexedDoc[];
  /** term → field → [docIdx, tf, docIdx, tf, ...] */
  postings: Map<string, Map<SearchField, number[]>>;
  df: Map<string, number>;
  avgLen: Float32Array;
  byLength: Map<number, string[]>; // vocabulary folded theo độ dài, cho fuzzy
  identifiers: Map<string, number[]>; // fold(key|path|operationId) → docIdx
  templates: Array<{ segments: string[]; method: string; doc: number }>;
  coverage: IndexCoverage;
}
export function buildServiceIndex(snap: Snapshot, limits: SearchLimits, filter?: OperationFilter): ServiceIndex;
```

Build theo pass ưu tiên `SEARCH_FIELDS` trên **mọi** operation (thứ tự `operation` key); khi tổng posting chạm `postingsPerService`, field hiện tại và sau đó bị bỏ phần còn lại và ghi vào `coverage.truncatedFields`. Tất định, không dựa thời gian.

- [ ] **Step 1: Test fail**

```ts
import { buildServiceIndex } from '../../src/search/build-index.js';
const LIM = { schemaDepth: 6, fieldsPerOperation: 400, postingsPerService: 1_000_000, descriptionTokens: 256, fuzzyExpansions: 8 };
test('postings cap truncates lowest-priority fields deterministically', async () => {
  const paths: Record<string, unknown> = {};
  for (let i = 0; i < 50; i++) paths[`/r${i}`] = { get: { operationId: `op${i}`, summary: 'alpha beta', description: 'gamma '.repeat(50) + i, responses: { 200: { description: 'ok' } } } };
  const snap = await snapshotOf({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths });
  const a = buildServiceIndex(snap, { ...LIM, postingsPerService: 300 });
  const b = buildServiceIndex(snap, { ...LIM, postingsPerService: 300 });
  expect(a.coverage.truncatedFields).toContain('description');
  expect(a.coverage.truncatedFields).not.toContain('identifier');
  expect(a.coverage.postings).toBeLessThanOrEqual(300);
  expect([...a.postings.keys()]).toEqual([...b.postings.keys()]);
});
```

- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** commit `feat(search): bounded field-aware index`.

### Task 4: Query, fuzzy, rank

**Files:**
- Create: `src/search/query.ts`, `src/search/fuzzy.ts`, `src/search/rank.ts`
- Test: `tests/integration/search-engine.test.ts`

**Interfaces:**
- Produces:
  - `interface QueryTerm { folded: string; exact: string; raw: string; weight: number; kind: MatchKind; group: number }`
  - `parseQuery(query: string, aliases: SearchAlias[], serviceId: string): { terms: QueryTerm[]; truncated: boolean; trimmed: string }`
  - `osaWithin(a: string, b: string, k: number): number | undefined`
  - `expandFuzzy(idx: ServiceIndex, term: QueryTerm, max: number): QueryTerm[]`
  - `rankService(idx: ServiceIndex, q: ReturnType<typeof parseQuery>, allowed: ReadonlySet<SearchField>, limits: SearchLimits): Array<{ doc: number; tier: HitTier; score: number; matches: MatchEvidence[] }>`

- [ ] **Step 1: Test fail** (ranking qua index thật):

```ts
import { parseQuery } from '../../src/search/query.js';
import { rankService } from '../../src/search/rank.js';
import { SEARCH_FIELDS } from '../../src/search/types.js';
const ALL = new Set(SEARCH_FIELDS);
const top = (idx: any, q: string, aliases: any[] = []) => rankService(idx, parseQuery(q, aliases, idx.serviceId), ALL, LIM).map((h) => idx.docs[h.doc].op.key);

test('exact identifier beats fuzzy/description noise; template matches concrete path', async () => {
  const snap = await snapshotOf({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths: {
    '/orders/{id}': { get: { operationId: 'getOrder', summary: 'Order detail', responses: { 200: { description: 'ok' } } } },
    '/orderz': { get: { operationId: 'listOrderz', description: 'getOrder getOrder getOrder', responses: { 200: { description: 'ok' } } } },
  } });
  const idx = buildServiceIndex(snap, LIM);
  expect(top(idx, 'getOrder')[0]).toBe('GET /orders/{id}');
  expect(top(idx, 'GET /orders/42')[0]).toBe('GET /orders/{id}');
  expect(top(idx, 'gtOrder')[0]).toBe('GET /orders/{id}'); // fuzzy
});
test('reverse lookup by nested response field and Vietnamese without diacritics', async () => {
  const snap = await snapshotOf({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths: {
    '/a': { get: { summary: 'Danh sách đơn hàng', responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { invoice: { type: 'object', properties: { taxCode: { type: 'string' } } } } } } } } } } },
    '/b': { get: { summary: 'Other', responses: { 200: { description: 'ok' } } } },
  } });
  const idx = buildServiceIndex(snap, LIM);
  const hits = rankService(idx, parseQuery('tax_code', [], 'api'), new Set(['responseField', 'schemaName', 'fieldText'] as const), LIM);
  expect(hits.map((h) => idx.docs[h.doc].op.key)).toEqual(['GET /a']);
  expect(hits[0]!.matches[0]).toMatchObject({ field: 'responseField', text: 'invoice.taxCode' });
  expect(top(idx, 'don hang')[0]).toBe('GET /a');
});
test('aliases expand only declared groups, never transitively', async () => {
  const snap = await snapshotOf({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths: {
    '/orders': { get: { summary: 'orders', responses: { 200: { description: 'ok' } } } },
    '/clients': { get: { summary: 'clients', responses: { 200: { description: 'ok' } } } },
  } });
  const idx = buildServiceIndex(snap, LIM);
  const aliases = [{ terms: ['đơn hàng', 'orders'] }, { terms: ['orders', 'clients'], services: ['other'] }];
  expect(top(idx, 'đơn hàng', aliases)).toEqual(['GET /orders']);
  expect(rankService(idx, parseQuery('đơn hàng', aliases, 'api'), ALL, LIM)[0]!.matches[0]!.kind).toBe('alias');
});
```

- [ ] **Step 2–4:** fail → implement 6.3 → pass.
- [ ] **Step 5:** commit `feat(search): tiered BM25F ranking, bounded fuzzy, aliases`.

### Task 5: Cursor và `SearchEngine`

**Files:**
- Create: `src/search/cursor.ts`, `src/search/engine.ts`
- Test: `tests/integration/search-engine.test.ts`

**Interfaces:**
- Produces: `encodeCursor(q: string, r: string, o: number): string`; `decodeCursor(c: string): { q: string; r: string; o: number }` (throws `CURSOR_INVALID` `MALFORMED`); `SearchEngine` (§4.2).

Engine: lọc service theo `req.service`; với mỗi snapshot lấy/ build index qua `WeakMap`; filter method/tag (`fold` cả hai)/deprecated áp lên candidate; merge các service; sort tất định; paging; fit budget (6.4); `targets` từ `baseUrls`.

- [ ] **Step 1: Test fail**

```ts
import { SearchEngine } from '../../src/search/engine.js';
const CFG = { aliases: [], limits: LIM };
test('unprocessable vs browse; cursor reasons; index rebuilt per snapshot', async () => {
  const spec = (s: string) => ({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`/inv${i}`, { get: { summary: `invoice ${s}`, responses: { 200: { description: 'ok' } } } }])) });
  const s1 = await snapshotOf(spec('one'));
  const s2 = await snapshotOf(spec('two'));
  const eng = new SearchEngine({ config: CFG, baseUrls: new Map([['api', 'http://127.0.0.1:9']]) });
  expect(eng.search([s1], { query: '' }, { maxBytes: 32768 }).mode).toBe('browse');
  expect(() => eng.search([s1], { query: '🙂🙂' }, { maxBytes: 32768 })).toThrow(expect.objectContaining({ code: 'QUERY_UNPROCESSABLE' }));
  const p1 = eng.search([s1], { query: 'invoice', limit: 2 }, { maxBytes: 32768 });
  const p2 = eng.search([s1], { query: 'invoice', limit: 2, cursor: p1.nextCursor }, { maxBytes: 32768 });
  expect(p2.results.map((r) => r.operation)).not.toEqual(p1.results.map((r) => r.operation));
  expect(() => eng.search([s1], { query: 'other', cursor: p1.nextCursor }, { maxBytes: 32768 })).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'QUERY_MISMATCH' }) }));
  expect(() => eng.search([s2], { query: 'invoice', cursor: p1.nextCursor }, { maxBytes: 32768 })).toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: 'REVISION_CHANGED' }) }));
  expect(eng.search([s2], { query: 'two' }, { maxBytes: 32768 }).results[0]!.revision).toBe(s2.revision);
  expect(eng.search([s2], { query: 'one' }, { maxBytes: 32768 }).total).toBe(0);
});
test('page shrinks to fit the output budget without losing results', async () => {
  const paths = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`/x${i}`, { get: { summary: 'needle ' + 'w'.repeat(190), responses: { 200: { description: 'ok' } } } }]));
  const snap = await snapshotOf({ openapi: '3.0.3', info: { title: 't', version: '1' }, paths });
  const eng = new SearchEngine({ config: CFG, baseUrls: new Map([['api', 'http://127.0.0.1:9']]) });
  const seen = new Set<string>(); let cursor: string | undefined;
  do { const r = eng.search([snap], { query: 'needle', limit: 50, cursor }, { maxBytes: 4096 }); expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(4096); r.results.forEach((h) => seen.add(h.operation)); cursor = r.nextCursor; } while (cursor);
  expect(seen.size).toBe(60);
});
```

- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** commit `feat(search): revision-bound cursor and search engine`.

### Task 6: Config `search` (shared files, theo thứ tự coordinator)

**Files:**
- Modify: `src/config-schema.ts` (thêm `SearchSchema` trước `ConfigSchema`, key `search: SearchSchema` sau `limits` dòng 245)
- Modify: `src/config.ts` (`AppConfig.search` sau dòng 116; validate + gán gần dòng 486)
- Modify: `config.schema.json` (`npm run build && npm run gen:schema`)
- Test: `tests/integration/config-schema-parity.test.ts` (thêm case vào `positive`/`negative`)

```ts
export const SearchSchema = z.object({
  aliases: z.array(z.object({ terms: z.array(z.string().min(1).max(100)).min(2).max(16), services: z.array(nonEmpty).min(1).optional() }).strict()).max(500).default([]),
  limits: z.object({
    schemaDepth: posInt(6, 32), fieldsPerOperation: posInt(400, 5000), postingsPerService: posInt(1_000_000, 20_000_000),
    descriptionTokens: posInt(256, 4096), fuzzyExpansions: posInt(8, 32),
  }).strict().prefault({}),
}).strict().prefault({});
```

Trong `loadConfig`: mỗi term `tokenize(term).length === 0` → `fail('search.aliases.N.terms.M', 'must contain a letter or digit')`; mỗi `services[j]` không có trong `services` → `fail('search.aliases.N.services.J', 'unknown service')`.

- [ ] **Step 1:** thêm parity case: positive `['search aliases', { ...svc({}), search: { aliases: [{ terms: ['đơn hàng', 'order'] }] } }]`; negative `['alias group of one', { ...svc({}), search: { aliases: [{ terms: ['x'] }] } }]`, `['unknown search key', { ...svc({}), search: { semantic: true } }]`. Thêm test runtime-only: alias `services: ['nope']` và term `'--'` → `CONFIG_INVALID`.
- [ ] **Step 2:** `npm run build && npx vitest run tests/integration/config-schema-parity.test.ts` → FAIL.
- [ ] **Step 3:** implement, `npm run gen:schema`.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** commit `feat(config): search aliases and index limits`.

### Task 7: Tool `search_operations` cutover (shared `src/server.ts`)

**Files:**
- Modify: `src/server.ts:10,99-139`
- Delete: `src/specs/search.ts`
- Modify: `tests/integration/mcp.test.ts:100-132`, `tests/smoke.mjs:152-154`
- Create: `tests/integration/search-mcp.test.ts`
- Modify: `README.md` (~630-651, 838, bảng limits), `examples/config.example.yaml` (block `search:` cạnh `limits`)

Handler:

```ts
const search = new SearchEngine({ config: app.cfg.search, baseUrls: new Map([...app.cfg.services].map(([id, s]) => [id, s.baseUrl])) });
// trong handler, giữ nguyên SERVICE_UNKNOWN / SERVICE_UNAVAILABLE khi có a.service
const ids = a.service ? [a.service] : [...app.cfg.services.keys()];
const snaps = ids.flatMap((id) => { const s = app.registry.peek(id); return s ? [s] : []; });
const unavailable = a.service ? undefined : ids.filter((id) => !app.registry.peek(id));
return search.search(snaps, a, { maxBytes: cap, unavailableServices: unavailable?.length ? unavailable : undefined });
```

Description tool: thêm "parameter names, request/response fields and schema names; `fields` restricts where terms may match (e.g. [\"responseField\"] finds operations returning a field); an empty query browses; a query with no searchable terms is an error, not match-all; each hit lists short match evidence."

- [ ] **Step 1:** Viết `search-mcp.test.ts` (dùng `connectCli`, `writeProject` như `mcp.test.ts:22-36`):
  - Unicode: spec có summary `获取订单详情` và `Lấy hóa đơn`; query `订单` → hit đúng, `total` 1 (không phải tất cả); `hoa don` → hit tiếng Việt.
  - `query: '🙂'` → `isError`, `error.code === 'QUERY_UNPROCESSABLE'`.
  - Reverse: `{ query: 'taxCode', fields: ['responseField'] }` → đúng operation, `matches[0].field === 'responseField'`.
  - Refresh: lấy cursor, ghi spec mới, `refresh_specs`, dùng cursor cũ → `CURSOR_INVALID` với `details.reason === 'REVISION_CHANGED'`; search mới trả `revision` mới và `get_operation_schema` với revision đó thành công.
  - Alias qua config `search.aliases`.
  - Hai service cùng path: `targets` có cả hai baseUrl, mỗi hit có đúng `service`.
- [ ] **Step 2:** Cập nhật `mcp.test.ts`: giữ mọi assert cũ; assert `wrong.data.error.details.reason === 'QUERY_MISMATCH'`. Smoke: thêm query response-field cho fixture smoke (field có trong schema `GET /widgets/{id}`).
- [ ] **Step 3:** `npm run build && npx vitest run tests/integration/search-mcp.test.ts tests/integration/mcp.test.ts` → FAIL.
- [ ] **Step 4:** implement handler, xóa `src/specs/search.ts`, cập nhật docs.
- [ ] **Step 5:** `npm run typecheck && npm test && npm run smoke` → PASS.
- [ ] **Step 6:** commit `feat(search): unicode field-aware search_operations`.

### Task 8: Benchmark corpus và retrieval harness (đóng băng trước khi chỉnh ranking)

**Files (ngoài `files` của package, không vào npm tarball):**
- Create: `bench/search/README.md` — protocol, phiên bản, cách chạy, giới hạn.
- Create: `bench/search/corpus/specs/*.json` — spec tổng hợp tất định: `shop` (VI+EN, đơn hàng/hóa đơn/khách hàng, nested response), `crm-a`, `crm-b` (nhiều service có endpoint giống nhau), `big` (1000 operation, sinh bằng `bench/search/gen-specs.mjs` seed cố định), `cjk` (summary tiếng Trung/Nhật).
- Create: `bench/search/corpus/external.json` — danh sách spec công khai đề xuất (Petstore OAS3, một spec REST lớn), URL + sha256; tải bằng `bench/search/fetch-external.mjs` (network, chạy riêng khi được phép); thiếu file → kết quả ghi `unavailable`.
- Create: `bench/search/queries.jsonl` — mỗi dòng `{ "id", "category", "lang", "query", "fields"?, "relevant": [{"service","operation","grade":1|2}], "split": "dev"|"test" }`. Category bắt buộc: `exact_path`, `exact_operation_id`, `typo`, `acronym`, `vi`, `vi_no_diacritics`, `en`, `cjk`, `paraphrase_no_alias`, `paraphrase_alias`, `response_field`, `nested_schema`, `multi_service`, `no_result` (relevant `[]`). ≥15 query/category; 50/50 dev/test theo `id` hash.
- Create: `bench/search/targets.json` — target chốt trước tuning (bảng dưới).
- Create: `bench/search/metrics.mjs` — `recallAtK`, `mrr`, `ndcgAt10`, `successAt1`, `falsePositiveRate` (`no_result`: có bất kỳ hit tier ≠ `fuzzy` nào là FP), percentile.
- Create: `bench/search/run.mjs` — import `dist/search/engine.js` + `dist/specs/loader.js`; system `current` (in-process), `current-stdio` (spawn `dist/cli.js` như `tests/helpers/mcp.ts`), `baseline-0.1.2` (bản sao nguyên văn `src/specs/search.ts` ở commit `7ff7326` lưu tại `bench/search/adapters/baseline-0.1.2.mjs`, chỉ đổi import `ToolError` thành `Error`), adapter đối thủ (Task 9). Latency: 20 warmup, 200 lần đo/query, `process.hrtime.bigint()`, p50/p95; build index đo riêng (cold). Bytes output: độ dài UTF-8 của tool result. Ghi `bench/search/results/<ISO>-<gitsha>.json` gồm Node version, OS/arch, git sha, sha256 `package-lock.json`, sha256 corpus/queries, cấu hình, metric theo system × category × split, CI bootstrap 95% (1000 resample, seed 42).
- Create: `tests/unit/bench-metrics.test.ts` — giá trị tính tay cho `recallAtK`, `mrr`, `ndcgAt10` (graded), FP rate.
- Modify: `package.json` scripts `"bench:search": "node bench/search/run.mjs"`.

Target (trên split `test`, system `current`, k=5), đóng băng ở commit corpus:

| Category | Metric | Target |
|---|---|---|
| exact_path, exact_operation_id | Success@1 | 1.00 |
| typo, acronym | Recall@5 | ≥ 0.85 |
| vi, vi_no_diacritics, en, cjk | Recall@5 | ≥ 0.85 |
| response_field, nested_schema | Recall@5 | ≥ 0.80 |
| multi_service | Success@1 khi có `service`; Recall@5 cả hai service khi không | 1.00 / ≥ 0.90 |
| paraphrase_alias | Recall@5 | ≥ 0.80 |
| paraphrase_no_alias | Recall@5 | Không đặt target; báo cáo — là đầu vào quyết định semantic local |
| no_result | FP rate | ≤ 0.10 |
| mọi category | MRR không thấp hơn baseline-0.1.2 | ngoại lệ phải ghi rõ |
| latency `big`, in-process | p95 search | ≤ 20 ms (Apple M-series/ x86 hiện đại; ghi máy thực tế) |

Quy tắc: tune trọng số chỉ trên `dev`; báo cáo `test` một lần cho mỗi phiên bản tham số; mọi thay đổi corpus/nhãn sau khi đóng băng phải tạo phiên bản corpus mới và báo cả kết quả cũ.

- [ ] **Step 1:** viết `bench-metrics.test.ts` (ví dụ: relevant `{a}`, ranking `[b,a,c]` → recall@1=0, recall@5=1, MRR=0.5; nDCG với grade 2/1 tính tay) → FAIL.
- [ ] **Step 2:** implement `metrics.mjs` → PASS.
- [ ] **Step 3:** viết corpus + queries + targets; commit `bench(search): frozen corpus, labels and targets` **trước** mọi chỉnh trọng số.
- [ ] **Step 4:** implement `run.mjs`, baseline adapter; `npm run build && npm run bench:search -- --systems current,current-stdio,baseline-0.1.2` → file results.
- [ ] **Step 5:** commit `bench(search): retrieval harness and baseline`.

### Task 9: Adapter đối thủ (cần network + chấp thuận coordinator)

**Files:**
- Create: `bench/search/competitors/package.json` (dependency pin exact version; lockfile riêng), `bench/search/competitors/<name>.mjs`, `bench/search/competitors/README.md`.

Nguồn từ roadmap §11: `joyboy-yy/swagger-openapi-mcp` (fuzzy + schema reverse lookup — đối thủ trực tiếp), `baryhuang/mcp-server-any-openapi` (semantic; nếu cần model/API key cloud → `unavailable: requires external model`, không cấu hình cloud), `ivo-toby/mcp-openapi-server`, `avidianity/mcp-openapi`. Tên package npm/PyPI, tool name và schema input của từng đối thủ **chưa được kiểm chứng** trong plan này; bước đầu của task là đọc repo/README đối thủ và ghi lại.

Mỗi adapter: spawn server qua stdio với spec corpus local, gọi tool search của họ, map kết quả về `service/operation` (method + path); output `{ system, version, status: 'ok' | 'unavailable', reason?, attemptedCommand? }`. Không có tool search tương đương → `unavailable: no search tool`; không ước lượng thay.

- [ ] **Step 1:** khảo sát và ghi bảng (repo URL, version/commit, license, install command, tool search, offline được không).
- [ ] **Step 2:** cài trong `bench/search/competitors` (`npm ci` sau khi có lockfile); không sửa root lockfile.
- [ ] **Step 3:** `npm run bench:search -- --systems current,baseline-0.1.2,<competitors>`; kết quả gồm cả category thua.
- [ ] **Step 4:** commit `bench(search): competitor adapters and results`.

### Task 10: Đo agent end-to-end (tách khỏi retrieval)

**Files:**
- Create: `bench/search/agent-protocol.md`

Nội dung: 20 tác vụ (tập con của `queries.jsonl` split `test`), client + model + version ghi rõ, prompt cố định, đo: chọn đúng operation (so `invoke_operation`/`get_operation_schema` cuối với nhãn), số lần `get_operation_schema`, số tool call, tổng byte tool result; token toàn tác vụ chỉ khi client báo số liệu. Chạy thủ công bởi người có client; nếu chưa chạy, `results/agent-*.json` không tồn tại và README ghi "chưa đo". Không suy ra từ retrieval.

- [ ] **Step 1:** viết protocol; commit `docs(bench): agent end-to-end protocol`.

## 8. Acceptance (map roadmap §7)

| Yêu cầu | Bằng chứng |
|---|---|
| Unicode không suy biến thành match-all | Task 1 test, Task 7 `订单` → total 1, `🙂` → `QUERY_UNPROCESSABLE` |
| Có dấu/không dấu, giữ text gốc | Task 1, Task 4 `don hang`; evidence `text` là text gốc |
| camel/snake/kebab/acronym | Task 1 |
| Index path/operationId/tag/summary/description/parameter | Task 3/4, benchmark category |
| Schema/nested field có giới hạn | Task 2 caps, Task 3 coverage |
| Alias người dùng, không đồng nghĩa ngầm | Task 4 alias không bắc cầu, Task 6 config |
| Exact ưu tiên, fuzzy giới hạn | Task 4 tier test |
| Reverse lookup | Task 4, Task 7 `fields:['responseField']` |
| Browse ≠ unprocessable | Task 5, Task 7 |
| Lý do match, service/target, revision | `matches`, `targets`, `revision` |
| Refresh: index/cursor nhất quán | Task 5 `REVISION_CHANGED`, Task 7 qua stdio |
| search → contract → invoke | Task 7 dùng revision mới cho `get_operation_schema`; smoke |
| Benchmark so baseline + đối thủ, công bố thua | Task 8–9 |
| Offline, không AI ngoài | Không dependency mới; search không import transport; benchmark core chạy không network |

## 9. Rủi ro

- Build index đồng bộ chặn event loop với spec rất lớn (đo trong benchmark `big`, cold build). Nếu p95 cold build > 500 ms cho 1000 operation, đề xuất prewarm sau `registry.init()`/`refresh_specs` (cần sửa `app.ts`/server — xin coordinator).
- Bigram CJK tăng posting; được chặn bởi `postingsPerService`, coverage báo trung thực.
- `\p{Script=…}` phụ thuộc ICU của Node; ghi `process.versions.icu`/`unicode` vào kết quả benchmark.
- Đổi thứ tự ranking có thể làm agent cũ phụ thuộc thứ tự cũ bất ngờ; contract tool không hứa thứ tự ngoài "liên quan nhất trước".
- Thêm `details.reason` vào `CURSOR_INVALID` và mã `QUERY_UNPROCESSABLE` là thay đổi thấy được bởi client; ghi CHANGELOG/README.

## 10. Lệnh kiểm chứng

```bash
npm run build
npm run typecheck
npx vitest run tests/unit/search-text.test.ts tests/unit/bench-metrics.test.ts tests/integration/search-engine.test.ts tests/integration/search-mcp.test.ts tests/integration/mcp.test.ts tests/integration/config-schema-parity.test.ts
npm test
npm run smoke
npm run bench:search -- --systems current,current-stdio,baseline-0.1.2
```

## 11. Main revision — authoritative corrections

Revision worker ended without revised artifact. Main applies findings 23–30 here; these rules override earlier conflicting examples. Approved for independent search implementation; final server integration requires real P1 policy.

1. Direction-aware postings: use requestSchemaName/responseSchemaName/requestFieldText/responseFieldText, not shared schemaName/fieldText. requestField scope includes only request provenance, responseField only response provenance. Scope filters before document-frequency/scoring/evidence. Test identical names only in request of one operation and response of another.
2. Identifier mode splits camel/snake/kebab and creates compound within one identifier unit; path segments separate units. Prose does not concatenate arbitrary words. Query retains whitespace groups. Test retrieval orderId/order_id/order-id, not incidental token arrays.
3. Exact literal path and METHOD/path comparisons preserve case; operationId also exact before folded lexical tier. Fold diacritics for Latin only, do not strip marks from unrelated scripts. Baseline Vietnamese queries can produce noisy ASCII fragments, not universally no tokens.
4. Add deterministic bounds: schemaNodesPerOperation=10000, fuzzyCandidatesPerQuery=4096, termBytes=128, evidenceBytesPerOperation=16384, indexBudgetBytes=64MiB per process (configurable bounded maxima). Charge conservative overhead for strings/postings/maps and cap counts; do not claim exact heap bytes. Stop traversal/work at budget with explicit coverage reasons. Cache uses explicit LRU accounting, not WeakMap as memory guarantee; eviction rebuilds from snapshot when needed.
5. Filter callback is required in integrated engine: P1 OperationPolicy.visible(serviceId) and stableId(). Snapshot stays unchanged for auth recipes. Bind cursor to query, revisions, config hash and policy stableId. P2 owns targets shape Record<string,{baseUrl:string}>.
6. Freeze benchmark corpus/labels/targets before ranking tuning (Task 8 corpus precedes Task 4). Any irrelevant returned hit, including fuzzy, counts as false positive. Keep latency as measured benchmark, not machine-dependent permanent assertion. Report baseline and adverse categories honestly.
7. Bound all metadata (tags, targets, coverage, unavailableServices, evidence), not only hit count. Include omitted counts when summarizing diagnostics. If one minimal hit plus required metadata cannot fit, return OUTPUT_TOO_LARGE; never return a non-progressing cursor or silently discard coverage.
8. Competitor adapters must invoke actual supported tools on pinned versions, not permanent fake/unavailable implementations. Verify tool schema from tools/list at execution; no equivalent search is documented as unsupported, not counted as a loss. Run reachable comparisons and agent E2E; missing prerequisites are explicitly reported, not manufactured evidence. No cloud spec upload.
9. Shared-file source integration is ordered by coordinator after P1. No implementation merge into main. Source snippet tests/default/wording tests are excluded. Complete implementation first, coordinator runs consolidated behavior checks and real MCP smoke afterward.
