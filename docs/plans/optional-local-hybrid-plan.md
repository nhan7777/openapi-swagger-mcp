# Search hybrid local tùy chọn: Implementation Plan

Trạng thái: HISTORICAL / WITHDRAWN. Theo yêu cầu trực tiếp của người dùng, nhánh semantic/model đã được gỡ sạch khỏi P2; sản phẩm hiện chỉ có lexical search. Nội dung dưới đây được giữ làm lịch sử thiết kế/thử nghiệm, KHÔNG phải kế hoạch đang được phê duyệt hoặc tính năng được ship. Kết quả và evidence ngoài repository được giữ nguyên; không xoá model/runtime đã tải ngoài repository.

Thiết kế gốc đã duyệt: `/Users/nhan/Desktop/project/openapi-swagger-mcp/docs/plans/optional-local-hybrid-design.md`. Plan này phải đọc cùng `approved-integration-contract.md`, `coordinator-review.md` mục 23-30 và `package-2-plan.md` mục 11.

Worktree: `/Users/nhan/orca/workspaces/openapi-swagger-mcp/local-api-p2-search`. Baseline đã đọc: lexical engine ở `src/search/` (rank params v4), `HEAD 012481a`.

## 0. Phạm vi và nguyên tắc

- Lexical vẫn là mặc định. `search.semantic.enabled: false` nghĩa là không load runtime, không đọc file model, không cấp phát index vector, không gọi mạng. Response không đổi một byte so với hiện nay (không thêm field `retrieval`).
- Chỉ model local do người dùng cấp (provision tường minh). Không endpoint cloud, không tự tải khi khởi động hay khi search, không Python service, không vector DB.
- Model là ỨNG VIÊN, chưa phải lựa chọn đã chứng minh. Chỉ pin sau khi Task 0 đạt. Nếu Task 0 fail thì dừng và báo coordinator. Không pin theo phỏng đoán.
- Không sửa rank params lexical (`RANK.version` 4 giữ nguyên). Hybrid dùng hằng số riêng `HYBRID` (mục 5.3).
- Kết quả lịch sử giữ nguyên: `bench/search/results/*`, heldout-1 đã bị dùng và không được chứng nhận candidate mới. Heldout mới phải đóng băng trước khi tuning.
- Không khẳng định embedding "giải quyết" đa ngôn ngữ hay alias. Chỉ báo số đo recall và false-positive cùng lúc.

## 1. Bằng chứng đã đọc (nguồn chính, chưa chạy)

| Điều | Nguồn | Giá trị đã đọc |
|---|---|---|
| Model | https://huggingface.co/api/models/intfloat/multilingual-e5-small?blobs=true | `sha` (revision) `614241f622f53c4eeff9890bdc4f31cfecc418b3`, lastModified 2026-04-02, license `mit`. |
| File ONNX (revision trên) | cùng API và `.../tree/<rev>/onnx` | `onnx/model.onnx` 470268510 B, sha256 `ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665`. `onnx/model_O4.onnx` 235052531 B, sha256 `4654c156f3e4171abc9c716cdb771bf9116455d15ac1aab364aeeede0e3205b0`. `onnx/model_qint8_avx512_vnni.onnx` 118346824 B (tên chỉ định x86 AVX512, không dùng cho arm64). `onnx/tokenizer.json` 17082730 B, sha256 `0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39`. `onnx/tokenizer_config.json` 443 B, sha256 `a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b` (tôi tải và băm trực tiếp, 443 B). `onnx/sentencepiece.bpe.model` 5069051 B. |
| Kiến trúc | `onnx/config.json` | BertModel, hidden 384, 12 layer, `max_position_embeddings` 512, `vocab_size` 250037. Bảng embedding từ vựng xấp xỉ 250037x384x4 = 384 MB nên model fp32 lớn chủ yếu vì từ vựng. |
| Cách dùng đúng | Model card README | Tiền tố `query: ` và `passage: ` bắt buộc ("otherwise performance degradation"). Mean pooling theo attention mask rồi L2-normalize. Cắt tối đa 512 token. Điểm cosine dồn quanh 0.7-1.0 (FAQ 3) nên KHÔNG dùng như xác suất, chỉ dùng thứ hạng và ngưỡng đo trên dev. |
| Pooling | `1_Pooling/config.json` | `pooling_mode_mean_tokens: true`, dim 384. |
| tokenizer.json | `onnx/tokenizer.json` | `"truncation": null`, `"padding": null`, normalizer `Sequence` có `Precompiled`. Vì vậy truncation và padding phải tự làm. |
| Native tokenizer | npm package `tokenizers@0.23.2` (unscoped official Hugging Face Rust/N-API binding), installed only in the external Task 0 evidence directory. The earlier scoped `@huggingface/tokenizers@0.2.0` was the JS port and is not the selected runtime. Native API: `Tokenizer.fromString(json)`, `setTruncation(512)`, async `encode()`/`encodeBatch()` returning `Encoding.getIds()`. Package metadata declares Apache-2.0; the tarball LICENSE conflicts and says MIT, so publication remains blocked pending upstream/legal confirmation. |
| Runtime ORT | https://registry.npmjs.org/onnxruntime-node/1.30.0 | Hỗ trợ os win32/darwin/linux. `postinstall: node ./script/install`. Bản unpacked 301 MB (gồm mọi nền tảng). Phụ thuộc `adm-zip`, `global-agent`, `onnxruntime-common` 1.30.0. Binary darwin/arm64 nằm sẵn trong gói (`bin/napi-v6/darwin/arm64/libonnxruntime.1.30.0.dylib` 44589928 B, `onnxruntime_binding.node`). |
| Install script | `js/node/script/install.js`, `install-metadata.js` @ tag v1.30.0 | Yêu cầu tải thêm chỉ có `linux/x64: ['cuda12']` (tải từ nuget.org). `darwin/arm64: []` không tải. Tắt bằng `--onnxruntime-node-install=skip` hoặc env `ONNXRUNTIME_NODE_INSTALL=skip`. Script nạp `global-agent` để theo proxy. |
| API ORT | `js/common/lib/inference-session.ts` @ v1.30.0 | `InferenceSession.create(path\|buffer, options)`, `run(feeds, {terminate?, logSeverityLevel?})`, `release()`, `inputNames`, `outputNames`, `SessionOptions.intraOpNumThreads/interOpNumThreads/graphOptimizationLevel/executionProviders`. |
| Transformers.js | https://registry.npmjs.org/@huggingface/transformers/latest, docs `api/env`, `api/pipelines`, `api/utils/hub` | v4.3.1, phụ thuộc `sharp ^0.35.4`, `onnxruntime-web 1.31.0-dev...`, `onnxruntime-node 1.30.0`, `@huggingface/jinja`, `@huggingface/tokenizers ^0.2.0`. Cờ local-only: `env.allowRemoteModels=false`, `env.allowLocalModels=true`, `env.localModelPath`, tuỳ chọn `local_files_only`, `subfolder`, `model_file_name`, `dtype`, `revision`, `session_options`. `pipeline('feature-extraction', ...)(text, {pooling:'mean', normalize:true})`. Cấu hình là `env` toàn cục có thể thay đổi trong process. |
| Competitor | Mục Evidence của design (Stacklok `2b68d6338b...`, baryhuang `ed452acd...`, FastMCP tool-search) | Chỉ dùng làm ý tưởng: truy hồi song song, dedup, ngưỡng khoảng cách. Không suy ra chất lượng trên corpus này. |

Chưa kiểm chứng (phải do Task 0 trả lời):
- Native `tokenizers@0.23.2` parity against the selected `transformers` fast-tokenizer reference was verified in Task 0; the old scoped JS package is not a valid parity/runtime basis.
- Tên input/output thật của `onnx/model.onnx` (`input_ids`, `attention_mask`, có `token_type_ids` hay không; output `last_hidden_state`).
- onnxruntime-node 1.30.0 chạy được trên Node 22.19 (mức engines) và Node 26.8.1 (máy hiện tại, darwin arm64), kể cả trong `worker_threads`.
- RAM, thời gian khởi tạo lạnh, latency ấm, tính tất định, hành vi `terminate`.
- License của `onnxruntime-node` (metadata truncated trong lần đọc) và của repo Xenova (API trả license rỗng). Chưa dùng trước khi xác nhận.
- Chất lượng thật trên corpus dev của dự án.

## 2. Các quyết định và đề xuất (đánh dấu rõ khuyến nghị và đánh đổi)

Các mục U1-U8 là khuyến nghị, chờ coordinator chốt trước khi Task 1. Task 0 có thể làm đổi U1/U2/U3.

| Id | Vấn đề | Khuyến nghị | Đánh đổi chưa giải quyết |
|---|---|---|---|
| U1 | Gói runtime | Gọi trực tiếp `onnxruntime-node@1.30.0` và `@huggingface/tokenizers@0.2.0` (pin chính xác), tự viết pooling và normalize. Khai báo `peerDependencies` + `peerDependenciesMeta.optional` (npm không tự cài peer optional) và `devDependencies` cho bench/test. Thêm `search.semantic.runtimeDir` (thư mục có `node_modules` do người dùng cấp, nạp bằng `createRequire(runtimeDir/...)`) để dùng được với `npx`. | Phương án khác: `optionalDependencies` sẽ kéo ~300 MB cho mọi người (loại). Transformers.js kéo thêm `sharp`, `onnxruntime-web`, `jinja`, cấu hình `env` toàn cục và lớp cache hub, kiểm soát timeout/dispose kém hơn, và chính nó cũng phụ thuộc `@huggingface/tokenizers ^0.2.0` nên không giải được rủi ro tokenizer. Chỉ cân nhắc nếu Task 0 cho thấy tự viết pooling gây lệch. |
| U2 | Biến thể model | Bắt đầu bằng fp32 `onnx/model.onnx` (đúng tham chiếu, 470 MB đĩa, RAM dự kiến lớn). So sánh trong Task 0 với `onnx/model_O4.onnx` (fp16 tối ưu GPU, có thể chậm/không hỗ trợ CPU) và `Xenova/multilingual-e5-small` rev `761b726dd34fb83930e26aab4e9ac3899aa1fa78` `onnx/model_int8.onnx` (118054593 B, sha256 `4d24e2bc01a447951524466ef533e52944bf48509e6552810bcee1a2711cb02c`; license chưa rõ). | Lượng tử hoá có thể làm lệch thứ hạng. Chỉ chọn biến thể nhỏ nếu parity + MRR dev không tệ hơn. fp32 chắc đúng nhưng RAM/đĩa lớn. |
| U3 | Nơi chạy inference | `worker_threads` (`src/search/semantic/embed-worker.ts`): tokenizer.json 17 MB parse và load session không chặn event loop MCP, `worker.terminate()` cho timeout và shutdown thật. | Phức tạp hơn in-process. Nếu Task 0 cho thấy ORT addon không chạy trong worker hoặc không có lợi thì dùng in-process với `RunOptions.terminate` (ngữ nghĩa chưa kiểm chứng). |
| U4 | Khi semantic tạm không dùng được (index chưa dựng xong, timeout, bận) | Mặc định `onUnavailable: 'error'` (lỗi `SEMANTIC_UNAVAILABLE` có `details.reason`). Tuỳ chọn `'lexical'` trả kết quả lexical gắn nhãn `retrieval.mode:'lexical'` và `semantic.state:'unavailable'`, KHÔNG BAO GIỜ gắn nhãn hybrid. Model/runtime thiếu hoặc sai luôn là lỗi tường minh. | Thêm một cấu hình. Mặc định `error` an toàn hơn nhưng gây khó chịu ngay sau khi khởi động. |
| U5 | Ai sở hữu engine và dispose | Chuyển `SearchEngine` sang `App` (`readonly search`, tạo trong `App.start`, `await search.dispose()` trong `App.close`, gọi `search.warm()` sau `registry.init()`). `src/app.ts` thuộc sở hữu P1, đã sửa trong worktree này; sửa thêm theo thứ tự tích hợp. | Phương án thay thế: giữ engine trong `createServer` và bọc `server.close`. Cách này vá ngoài đường đóng chính thức (`cli.ts` gọi `Promise.allSettled([server.close(), app.close()])`) và dễ rò worker. |
| U6 | Provisioning | Script repo-only `bench/search/semantic/provision.mjs` tải đúng file đã pin từ HF theo revision, kiểm sha256, ghi vào thư mục do người dùng chỉ định NGOÀI repo; README hướng dẫn tải tay tương đương. Không ship trong package. | Người dùng `npx` không có script; có thể cần subcommand CLI về sau (ngoài phạm vi, cần quyết định riêng). |
| U7 | Sửa harness (H1-H3 ở Task 6) | Làm TRƯỚC khi đóng băng candidate mới, vì chúng đổi `sourceHash`. | Candidate v4 cũ đã freeze sẽ không còn hợp lệ; không sao vì mã nguồn đổi rồi. |
| U8 | CI trên linux/x64 | Cả `.github/workflows/ci.yml` (dòng 25) và `publish.yml` (dòng 43) chạy `npm ci`. Đặt `ONNXRUNTIME_NODE_INSTALL=skip` cho cả hai để `postinstall` của onnxruntime-node không tải binary CUDA từ nuget (chỉ áp dụng nếu runtime nằm trong `devDependencies`). `ci.yml` cũng chạy `gen:schema` rồi `git diff --exit-code -- config.schema.json`, nên `config.schema.json` phải được sinh lại và commit cùng lượt đổi schema. Semantic smoke với model thật chạy cục bộ; CI chỉ chạy test dùng embedder xác định. | Test semantic với model thật không chạy trên CI. Nếu coordinator không muốn runtime nằm trong `devDependencies`, các test dùng embedder xác định vẫn chạy được vì kiểu runtime được khai báo cục bộ (Task 2). |

## 3. File structure

Mới:
- `src/search/semantic/config.ts`: `SemanticSchema` (zod strict) và kiểu `SemanticConfig`.
- `src/search/semantic/profiles.ts`: registry hồ sơ model được duyệt, `ModelProfile`. Mỗi hồ sơ chứa danh sách file, kích thước, sha256, tiền tố, dim, pooling, phiên bản runtime pin và hằng số admission đã hiệu chuẩn (`minScore`, `window`).
- `src/search/semantic/runtime.ts`: `resolveRuntime(runtimeDir?)`, kiểm phiên bản, lỗi `SEMANTIC_RUNTIME_*`.
- `src/search/semantic/embedder.ts`: interface `Embedder`, `OnnxE5Embedder` (hàng đợi, timeout, dispose).
- `src/search/semantic/embed-worker.ts`: code worker (tokenize, run, pool, normalize).
- `src/search/semantic/chunks.ts`: sinh chunk từ `ServiceIndex` đã lọc policy.
- `src/search/semantic/index.ts`: `SemanticIndex`, build, ngân sách, coverage, cache LRU.
- `src/search/semantic/hybrid.ts`: admission và fusion.
- `src/search/hybrid-params.ts`: hằng số `HYBRID` có version.
- `tests/helpers/embedder.ts`: embedder xác định thật (băm n-gram ký tự rồi chiếu, chuẩn hoá), dùng test engine. KHÔNG khẳng định chất lượng ngữ nghĩa.
- `tests/integration/search-hybrid.test.ts`, `tests/integration/search-semantic-config.test.ts`.
- `tests/semantic-smoke.mjs` (`npm run smoke:semantic`), `tests/helpers/net-canary.mjs`.
- `bench/search/semantic/`: `provision.mjs`, `tokenizer-parity.mjs`, `probe.mjs`, `task0-result.json`, `tokenizer-parity-ids.json` (id tham chiếu sinh một lần), `README.md`.
- `bench/search/adapters/semantic-only.mjs`.

Sửa (xung đột tích hợp ở mục 9): `src/search/config.ts`, `src/search/types.ts`, `src/search/engine.ts`, `src/search/cursor.ts`, `src/search/build-index.ts` (export phần dùng chung, không đổi hành vi), `src/server.ts`, `src/app.ts`, `src/config.ts`, `src/config-schema.ts`, `src/check.ts`, `config.schema.json` (sinh bằng `scripts/gen-schema.mjs`), `examples/config.example.yaml`, `README.md`, `package.json`, `package-lock.json`, `.github/workflows/*`, `bench/search/run.mjs`, `bench/search/lib/{systems,snapshots,targets,validate,source-hash}.mjs`, `bench/search/run-dataset.mjs`, `bench/search/freeze-candidate.mjs`, `tests/integration/{search-engine,operation-policy,config-schema-parity,search-mcp}.test.ts`, `tests/smoke.mjs`.

## 4. Interfaces

### 4.1 Config (`src/search/semantic/config.ts`, tích hợp vào `SearchSchema` ở `src/search/config.ts`)

```ts
export const SemanticSchema = z.object({
  enabled: z.boolean().default(false),
  model: z.enum(MODEL_PROFILE_IDS).default(DEFAULT_PROFILE_ID),   // chỉ hồ sơ đã qua Task 0
  modelDir: z.string().min(1).optional(),     // bắt buộc khi enabled; tương đối so với thư mục config
  runtimeDir: z.string().min(1).optional(),   // thư mục có node_modules (onnxruntime-node, @huggingface/tokenizers)
  threads: posInt(DEFAULT_THREADS, 16),       // intraOpNumThreads
  maxConcurrentInference: posInt(1, 4),
  maxQueue: posInt(64, 1024),
  batchSize: posInt(16, 64),
  maxChunkTokens: posInt(128, 512),
  maxChunksPerOperation: posInt(12, 32),     // phải >= số nhóm field (7 hiện nay, dẫn xuất từ SCOPE_FIELDS); compileSemanticConfig từ chối giá trị nhỏ hơn
  maxQueryTokens: posInt(64, 512),
  candidates: posInt(50, 200),                // số operation tối đa mỗi nhánh truy hồi
  queryTimeoutMs: posInt(3000, 60000),        // gồm thời gian chờ hàng đợi
  indexBudgetBytes: posInt(64 * MiB, 1024 * MiB),
  onUnavailable: z.enum(['error', 'lexical']).default('error'),
}).strict().prefault({});
```
Giá trị mặc định cụ thể (`threads`, `batchSize`, `maxChunkTokens`, `queryTimeoutMs`) là đề xuất và phải được Task 0 đo lại trước khi cố định. Hằng số admission không để người dùng chỉnh; chúng nằm trong hồ sơ model.

`SearchSchema` thêm `semantic: SemanticSchema`. `compileSearchConfig(raw, serviceIds)` đổi chữ ký thành `compileSearchConfig(raw, serviceIds, rel: (p: string) => string)` (dùng `rel` có sẵn ở `src/config.ts:402`) và trả `SearchConfig` có thêm `semantic: CompiledSemanticConfig | undefined` (đường dẫn tuyệt đối, đã chuẩn hoá). `enabled: true` mà thiếu `modelDir` thì `CONFIG_INVALID` ở `search.semantic.modelDir`, thông báo chỉ nêu đường dẫn field, không nêu giá trị. `searchConfigHash` băm cả cấu hình semantic đã chuẩn hoá nhưng KHÔNG gồm đường dẫn tuyệt đối. Danh tính model (mục 7) vào cursor riêng.

Mở rộng `src/check.ts`: khi enabled, thêm `CheckItem` cho `search.semantic.modelDir` và `search.semantic.runtimeDir` (tồn tại, kích thước file khớp hồ sơ, sha256 stream, runtime phân giải được và đúng phiên bản). `--check` vẫn tĩnh, không mạng.

### 4.2 Kiểu và engine (`src/search/types.ts`, `engine.ts`)

```ts
export type HitTier = 'exact' | 'template' | 'identifier' | 'lexical' | 'fuzzy' | 'semantic';
export type HitSource = 'lexical' | 'semantic' | 'both';
export interface SemanticEvidence { score: number; chunk: ChunkGroup; rank: number }   // ChunkGroup: mục 5.2
// SearchHit thêm:
//   source?: HitSource            // chỉ khi semantic.enabled
//   semantic?: SemanticEvidence   // chỉ khi nhánh semantic đưa operation vào, score làm tròn 4 chữ số
export interface RetrievalInfo {
  mode: 'lexical' | 'hybrid';
  semantic?: { model: string; state: 'used' | 'skipped' | 'unavailable'; reason?: string };
}
// SearchResponse thêm: retrieval?: RetrievalInfo     // chỉ khi semantic.enabled
// SearchConfig thêm: semantic?: CompiledSemanticConfig
// CoverageReason thêm: 'SEMANTIC_BUDGET' | 'SEMANTIC_CHUNKS' | 'SEMANTIC_TOKENS'
```
`model` trong `RetrievalInfo` là `profileId@revision7` (ví dụ `multilingual-e5-small@614241f`). Không bao giờ chứa đường dẫn model hay runtime.

```ts
export interface SearchEngineOptions {
  config: SearchConfig;
  baseUrls: ReadonlyMap<string, string>;
  policy: SearchPolicy;
  /** Có mặt khi và chỉ khi config.semantic.enabled. App tạo OnnxE5Embedder; test truyền embedder xác định. */
  embedder?: Embedder;
}
export class SearchEngine {
  constructor(opts: SearchEngineOptions);
  /** ĐỔI: trước đây đồng bộ. Mọi caller phải await. Snapshot caller đã `peek()` được dùng xuyên suốt, không bao giờ đọc lại registry. */
  search(snapshots: readonly Snapshot[], req: SearchRequest, call: SearchCallOptions): Promise<SearchResponse>;
  /** Khởi động nền việc dựng index semantic cho snapshot hiện có. No-op khi semantic tắt. Không ném. */
  warm(snapshots: readonly Snapshot[]): void;
  dispose(): Promise<void>;   // idempotent
}
```

```ts
// src/search/semantic/embedder.ts
export interface ModelIdentity { profile: string; revision: string; fileHashes: Readonly<Record<string, string>>; dtype: string; dim: number; runtime: { onnxruntimeNode: string; tokenizers: string } }
export interface Embedder {
  readonly identity: ModelIdentity;
  /** Trả vector đã L2-normalize, Float32Array dim phần tử, theo thứ tự đầu vào. `kind` quyết định tiền tố. Ném ToolError SEMANTIC_UNAVAILABLE{reason}. */
  embed(texts: readonly string[], kind: 'query' | 'passage', opts: { signal: AbortSignal; priority: 'query' | 'build' }): Promise<Float32Array[]>;
  dispose(): Promise<void>;
}
```

### 4.3 Cursor v2 (`src/search/cursor.ts`)
Cursor đổi `v:1` thành `v:2` và thêm trường `m` (`'lexical' | 'hybrid'`). Binding `context` băm thêm `identity` của model (hash `ModelIdentity`) khi semantic bật. `CursorReason` thêm `MODE_CHANGED`. Cursor v1 bị từ chối là `MALFORMED` (cursor chỉ sống trong một phiên, việc này chấp nhận được). Thứ tự trong `search()`: quyết định mode (hybrid hay lexical-gắn-nhãn) TRƯỚC, rồi mới tạo binding và decode cursor.

### 4.4 Lỗi (`ToolError`, mã ổn định, không chứa đường dẫn hay giá trị bí mật)
`SEMANTIC_MODEL_MISSING`, `SEMANTIC_MODEL_MISMATCH` (details: tên file trong hồ sơ, không có đường dẫn), `SEMANTIC_RUNTIME_MISSING` (nêu tên và phiên bản pin cần cài), `SEMANTIC_RUNTIME_INCOMPATIBLE`, `SEMANTIC_UNAVAILABLE` (`details.reason`: `INDEX_PENDING | TIMEOUT | BUSY | INFERENCE_FAILED | DISPOSED`).

## 5. Thuật toán

### 5.1 Tiền tố, token, truncation, pooling (cố định theo model card)
- Truy vấn: `"query: " + text`. Chunk: `"passage: " + chunkText`. Chuẩn hoá NFC trước; cắt ký tự đầu vào về `4 x maxTokens` code point trước khi tokenize (chặn chi phí tokenize không giới hạn).
- `encode(text, {add_special_tokens: true})` rồi tự cắt id về `maxTokens`, giữ `<s>` (id 0) ở đầu và `</s>` (id 2) ở cuối. Padding bằng id `<pad>`=1, attention_mask=0, sắp theo độ dài để giảm padding, lô <= `batchSize`.
- Feeds `int64` (`BigInt64Array`). Đọc `session.inputNames` lúc load và so với tập kỳ vọng của hồ sơ; khác thì `SEMANTIC_MODEL_MISMATCH`. Mean pooling theo mask rồi L2-normalize bằng mã của mình.

### 5.2 Chunk: phân hoạch theo SearchField (scope chặt, không nối schema)

Quy tắc: một chunk chỉ chứa nội dung của những `SearchField` có CÙNG chữ ký scope. Scope chặt của thiết kế (design §25) là `SCOPE_FIELDS` trong `src/search/types.ts`; nhánh semantic phải lọc đúng như nhánh lexical, tức dùng đúng mảng `allowed: SearchField[]` mà `engine.ts` đã tính (dòng 85). Không có bảng scope -> loại chunk thứ hai, vì bảng đó sẽ lệch khỏi `SCOPE_FIELDS`.

Nhóm chunk được DẪN XUẤT bằng `fieldGroups(SCOPE_FIELDS)`: gom các `SearchField` có cùng tập scope chứa nó. Với `SCOPE_FIELDS` hiện tại kết quả là 7 nhóm:

| `ChunkGroup` | SearchField trong chunk | Tập scope chứa nhóm |
|---|---|---|
| `identifier` | `identifier` (operationId, từ method), `path` | identifier |
| `text` | `tag`, `summary`, `description` | text |
| `parameter` | `paramName`, `paramText` | parameter |
| `requestSchema` | `requestSchemaName`, `requestField` | requestField, schema |
| `requestText` | `requestFieldText` | requestField |
| `responseSchema` | `responseSchemaName`, `responseField` | responseField, schema |
| `responseText` | `responseFieldText` | responseField |

Hệ quả bắt buộc: scope `text` không bao giờ chạm chunk `identifier` (không có method, path, operationId trong chunk `text`); scope `schema` chỉ chạm `requestSchema`/`responseSchema`, không bao giờ chạm mô tả field (`requestText`/`responseText`); scope `requestField` và `responseField` thêm chunk `*Text` của đúng hướng của mình. Nếu `SCOPE_FIELDS` đổi, nhóm tự đổi theo, và test bất biến (mục 8) bắt lỗi nếu có chunk trộn.

Điều kiện truy hồi: `eligible(chunk, allowed) = chunk.fields.every(f => allowed.includes(f))`, áp dụng TRƯỚC khi chấm điểm. Query không có `fields` có `allowed` là mọi field nên mọi nhóm đều eligible.

Nguồn và giới hạn: chunk sinh từ `ServiceIndex.docs` đã lọc policy (thao tác ẩn không bao giờ được embed) và dùng lại `extractOperationSchemas` với đúng `SchemaLimits` của lexical (độ sâu, số field, số node), nên công việc duyệt schema vẫn bị chặn. Nội dung của chunk chỉ gồm văn bản của nhóm mình. Cấm prefix ngữ cảnh toàn operation (summary, path, operationId) vào chunk field, vì đó chính là đường rò scope. KHÔNG nhúng: `example/default/enum/const/x-*`, mô tả `securitySchemes`, tên và giá trị credential, nội dung phản hồi auth. Header response nằm trong nhóm response như ở lexical.

Cap: mỗi nhóm không rỗng được đúng một chunk đầu (<= `maxChunkTokens`); phần dư mở chunk kế CÙNG nhóm theo thứ tự ưu tiên ở mục 5.4, tổng <= `maxChunksPerOperation`. Chunk mất vì cap hoặc ngân sách được báo qua `coverage` (`SEMANTIC_CHUNKS`), không im lặng.

Bỏ qua semantic: `retrieval.semantic.state:'skipped'` với `reason:'SCOPE_LEXICAL_ONLY'` khi `allowed` chỉ gồm field của nhóm `identifier` (scope `["identifier"]`): định danh chính xác thuộc tier exact/identifier, tương tự cảm quan "không dùng embedding để đoán operationId". Nhóm `identifier` vẫn được nhúng để query không giới hạn scope hoặc scope kết hợp (ví dụ `["identifier","text"]`) dùng nó. Đây là khuyến nghị cần hiệu chuẩn ở Task 6 (nếu embedding identifier chỉ gây false-positive thì bỏ hẳn nhóm này khỏi index).

Phương án không chọn mặc định: chunk "ngữ cảnh" gộp nhiều nhóm (giữ ngữ cảnh operation để embedding tốt hơn). Nó vẫn đúng scope nếu dùng cùng điều kiện `eligible` (chỉ eligible khi `allowed` chứa mọi field của nó, tức query không giới hạn scope), nhưng nhân đôi vector và RAM. Chỉ thêm nếu Task 6 chứng minh phân hoạch thuần làm giảm recall đáng kể; khi đó là cờ `HYBRID.contextualChunks` có version.

### 5.3 Truy hồi, admission, fusion (hằng số trong `src/search/hybrid-params.ts`, `HYBRID.version` bắt đầu 1)
1. Chế độ browse (query rỗng) không gọi embedding. Query dạng path (`looksLikePath`) cũng bỏ qua semantic (`skipped`, `PATH_QUERY`).
2. Nhánh lexical chạy y như hiện nay, kể cả minCoord và fuzzy. Nhánh semantic: nhúng query (ưu tiên `query`), quét brute-force tích vô hướng trên ma trận `Float32Array` liền khối. Bộ lọc `keep` (service, method, tag, deprecated) và policy áp dụng TRƯỚC khi chọn top-k. Điểm operation = max cosine các chunk hợp lệ; giữ tối đa `candidates` operation bằng heap có giới hạn.
3. Admission nhánh semantic (hằng số của hồ sơ model, hiệu chuẩn ở Task 6): `cosine >= profile.minScore` và `cosine >= top1 - profile.window`. Cờ `profile.admitSemanticOnly` quyết định operation chỉ có ở nhánh semantic có được nhận vào hay không. Có thể kết quả hiệu chuẩn là `false`, và đó vẫn là kết quả hợp lệ.
4. Thứ tự cuối: các tier `exact`, `template`, `identifier` giữ nguyên vị trí đầu theo thứ tự hiện tại và không bao giờ bị hạ bởi fusion. Phần còn lại fuse bằng RRF: `score(d) = sum_list w_list / (HYBRID.rrfK + rank_list(d))`, `rrfK` khởi điểm 60, `w` khởi điểm 1/1. Cặp (rrfK, w) là tham số cần so sánh trên dev với một baseline trọng số đơn giản; điểm fusion không phải xác suất. Hoà thì sắp theo `service` rồi `operation.key`. Operation chỉ ở nhánh semantic có `tier: 'semantic'`, `source: 'semantic'`.
5. Trả về mảng rỗng vẫn được hỗ trợ. `total` là số hit đã nhận vào. Fusion không được tạo hit khi cả hai nhánh không nhận.
6. Alias vẫn là mở rộng lexical tường minh và được kiểm thử riêng. Semantic không thay thế alias.

### 5.4 Index semantic, ngân sách, đồng thời
- Khoá cache: `(serviceId, snapshot object, policyId, modelIdentityHash, semanticConfigHash)`. Giống lexical, thay snapshot hoặc policy hoặc model thì index cũ bị bỏ. Dựng theo single-flight; kết quả dựng xong cho snapshot đã bị thay thế KHÔNG được ghi đè entry mới hơn (đếm thế hệ theo service). Trạng thái `failed` được ghi âm theo snapshot, không retry vòng lặp; retry khi revision đổi.
- Bộ nhớ: vector `count x dim x 4` B + metadata; chia đều `semantic.indexBudgetBytes` cho các service như lexical; LRU toàn process loại tất định (loại entry cũ nhất, không loại service đang được hỏi). Ưu tiên chunk khi hết ngân sách (cũng là thứ tự nhận continuation): `identifier`, `text`, `responseSchema`, `requestSchema`, `responseText`, `requestText`, `parameter`. Phần không vừa được báo qua `coverage` (`SEMANTIC_BUDGET`/`SEMANTIC_CHUNKS`/`SEMANTIC_TOKENS`) kèm số operation chưa embed, tối đa `RANK.maxCoverageEntries`.
- Đồng thời: `maxConcurrentInference` lô cùng lúc; hàng đợi `maxQueue` với hai mức ưu tiên (`query` trước `build`); build nhả hàng đợi giữa các lô nên độ trễ query bị chặn bởi một lô. Tràn hàng đợi là `SEMANTIC_UNAVAILABLE{BUSY}`. Timeout `queryTimeoutMs` tính từ lúc vào hàng đợi. Cache vector query nhỏ (LRU 64 mục, giới hạn byte) để phân trang không nhúng lại; Task 0 đo tính tất định để chắc thứ hạng giữa các trang ổn định.
- Warm-up: `App.start` gọi `search.warm()` sau `registry.init()` (không chặn khởi động, không mạng). Search khi semantic bật chờ index tối đa `queryTimeoutMs`; quá hạn áp dụng `onUnavailable`.
- Snapshot bất biến: `search()` nhận `snapshots` đã `peek()` một lần, giữ nguyên qua mọi `await`; mọi hit mang revision của đúng snapshot đó. Refresh giữa chừng không trộn revision; trang kế dùng cursor sẽ nhận `CURSOR_INVALID{REVISION_CHANGED}`.
- Vòng đời: `dispose()` đặt cờ đóng, từ chối việc mới và việc đang chờ bằng `SEMANTIC_UNAVAILABLE{DISPOSED}`, huỷ build, chờ drain có hạn rồi `worker.terminate()` và `session.release()`. `App.close` gọi nó trước `transport.close`.

## 6. Thứ tự task (Task 0 là cổng)

### Task 0: cổng runtime (trước mọi pin, không đụng mã sản phẩm)
Điều kiện: coordinator duyệt rõ ràng việc tải model một lần và cài runtime vào thư mục tạm NGOÀI repo (đây là thao tác mạng có chủ đích do người dùng khởi tạo, không phải hành vi sản phẩm).
1. Provision: `provision.mjs` tải đúng file ở revision đã pin, kiểm kích thước và sha256 ở mục 1, ghi ra thư mục ngoài repo. Lệch bất kỳ giá trị nào thì dừng.
2. Cài runtime vào thư mục riêng với `ONNXRUNTIME_NODE_INSTALL=skip`, pin chính xác `onnxruntime-node@1.30.0`, `@huggingface/tokenizers@0.2.0`. Ghi version thực tế cài được, license thực tế (ORT, và Xenova nếu xét int8), và kích thước đĩa.
3. Tokenizer parity: sinh id tham chiếu bằng `transformers` Python `AutoTokenizer` trong venv tạm (ngoài repo) cho tập >= 300 chuỗi: mọi query dev/dev2, văn bản chunk mẫu của spec dev2, tiếng Việt có/không dấu, Han, Kana, Thai, emoji, camelCase/snake/kebab, path có `{id}`, chuỗi dài vượt 512 token. Lưu `tokenizer-parity-ids.json` (chỉ id) để test sản phẩm sau này không cần Python. Tiêu chí đạt: 100% id bằng nhau (kể cả khi tự cắt 512). Nếu fail thì DỪNG: không pin, báo coordinator với danh sách chuỗi lệch.
4. Inference thật: nạp session fp32, in `inputNames/outputNames`, so embedding với tham chiếu Python (cosine từng mẫu >= 0.999 là ngưỡng đề xuất), kiểm các cặp điểm ví dụ trong model card, chạy hai lần so tính tất định bit-by-bit.
5. Đo: thời gian khởi tạo lạnh (đọc 17 MB tokenizer + load session), RSS sau load và sau dựng index dev2, latency lô 1/16 ở 32/128 token, thời gian chặn event loop khi tokenize/load trên luồng chính, `worker_threads` chạy được không và `terminate()` giải phóng không, ngữ nghĩa `RunOptions.terminate`. Ghi thông tin máy.
6. Node: lặp lại 3-5 trên Node 22.19 và 26.8.1.
7. Offline: chạy các bước 4-5 dưới `sandbox-exec` từ chối mọi `network*` (spec dùng file, không cần loopback) cộng preload canary vá `net.Socket.connect`, `dns.lookup`, `fetch`/undici để ghi và ném khi có thử kết nối; lượng canary bắt được phải bằng 0. Ghi lại cách `sandbox-exec` được xác nhận hoạt động (một lệnh chứng minh nó chặn được kết nối thử).
8. So biến thể: fp32 với O4 và int8 (parity, RSS, latency, đến MRR trên dev2 ở Task 6 nếu đạt vòng 3-5). Chọn một và pin.
Đầu ra: `bench/search/semantic/task0-result.json` (version, hash, số đo, máy, lệnh đã chạy) và quyết định U1/U2/U3. Chỉ sau đó mới điền hồ sơ model vào `profiles.ts`.

### Task 1: config, hồ sơ, kiểm tra (sau Task 0)
`semantic/config.ts`, `semantic/profiles.ts` (điền từ Task 0), tích hợp `SearchSchema`, `compileSearchConfig` ba tham số + cập nhật `src/config.ts:517`, `src/config-schema.ts`, regenerate `config.schema.json` (`npm run gen:schema`), ví dụ `examples/config.example.yaml`, `src/check.ts`, `package.json` (peer optional + dev, pin chính xác) và `package-lock.json`. Cập nhật `tests/integration/config-schema-parity.test.ts` (dòng 115 hiện coi `search: { semantic: true }` là khoá lạ cần bị từ chối; sau thay đổi `semantic` là object nên `true` vẫn bị từ chối nhưng vì lý do kiểu, kiểm lại ý nghĩa test). Cập nhật CI (U8).

### Task 2: runtime và embedder (song song với Task 3 sau Task 1)
`runtime.ts`, `embedder.ts`, `embed-worker.ts`: phân giải runtime (`runtimeDir` qua `createRequire`; không có thì phân giải từ package), kiểm phiên bản pin, hàng đợi ưu tiên, timeout, dispose. Kiểu runtime khai báo cục bộ (không phụ thuộc type của package chưa cài) để `npm run build` chạy khi không có runtime.

### Task 3: chunk và index
`chunks.ts` (gồm `fieldGroups(scopeFields)`, `ChunkGroup`, `eligible(chunk, allowed)`), `semantic/index.ts`: export các hàm dùng chung từ `build-index.ts` mà không đổi hành vi lexical. `eligible` nhận chính mảng `allowed` do `engine.ts` tính; không thêm bảng scope thứ hai.

### Task 4: fusion, engine bất đồng bộ, cursor
`hybrid.ts`, `hybrid-params.ts`, `engine.ts` async, `cursor.ts` v2, `types.ts`.

### Task 5: di chuyển mọi consumer
Callsite thật cần đổi sang `await engine.search(...)` hoặc sở hữu mới:
- `src/server.ts:133-137` (tạo engine; chuyển sang `app.search`) và `:160-171` (handler `run('search_operations', ...)` thành async).
- `src/app.ts`: `readonly search`, tạo trong `start`, `warm` sau `registry.init`, `dispose` trong `close()` (U5).
- `tests/integration/search-engine.test.ts:42-44` (helper `run`), `:235`, `:242`, `:256`; `tests/integration/operation-policy.test.ts:16-17`; `tests/integration/search-mcp.test.ts`. Các test `auth-recipes.test.ts:394` và `config-shorthand.test.ts:147` gọi `createServer(harness.app)` nên tự nhận engine từ `App` sau U5; `tests/helpers/harness.ts:91` đã gọi `app.close()` nên dispose được phủ mà không phải sửa helper.
- `bench/search/run.mjs:87-108`, `bench/search/lib/systems.mjs:26-36` (`current`: `await engine.search`), `mcp-stdio` (đã bất đồng bộ).
- `tests/smoke.mjs:172-191`: giữ nguyên các assert lexical hiện có làm bằng chứng không hồi quy.
- `README.md` mục Search (dòng 834-857), bảng công cụ, `examples/config.example.yaml` mục `search` (dòng 486-505).

### Task 6: benchmark, hiệu chuẩn, harness
- Hệ thống mới trong `bench/search/lib/systems.mjs`: `lexical` (semantic tắt), `semantic-only` (adapter harness, KHÔNG phải API sản phẩm; dùng `dist/search/semantic/*` trực tiếp), `hybrid`, giữ `baseline-0.1.2` và `mcp-stdio`. Cờ `--semantic-model-dir` và `--semantic-runtime-dir` được trộn vào config sinh tạm trong `deriveConfig` (`lib/snapshots.mjs`), không sửa file dataset.
- H1: `lib/validate.mjs` hiện dừng im lặng ở `NODE_CAP` 200000 node và `hops < 64`, và `stack.push(...array)` có thể ném với mảng lớn; chạm giới hạn phải thành lỗi validate chứ không được xem là "chưa thấy". Thêm test.
- H2: marker "dùng một lần" hiện nằm theo `--out` (`<batch>.used`), nên đổi `--out` cho phép chạy lại; chuyển sang registry cố định khoá theo `(batch, commitment)` do coordinator kiểm soát.
- H3: `gate()` trong `lib/targets.mjs` bỏ qua quy tắc MRR >= baseline (`mrrBelowBaseline` chỉ được báo). Phiên bản gate mới coi dòng MRR thấp hơn baseline là FAIL trừ ngoại lệ được ghi tường minh; kết quả cũ không bị sửa.
- Hiệu chuẩn chỉ trên dev (dev2 185 hàng, trong đó 64 `no_result`; `queries.jsonl` dev). Quy tắc chọn đăng ký trước: tối đa hoá `paraphrase_no_alias recall@5` với điều kiện `no_result` false-positive trên dev <= 0.05 (để chừa biên so với trần 0.10) và không giảm recall các nhóm khác so với lexical (nhóm exact không đổi theo cấu tạo). Ghi nguyên lưới tham số thử và kết quả mọi điểm, không chỉ điểm thắng. Báo recall và false-positive đồng thời.
- `freeze-candidate.mjs`: ghi thêm danh tính model (hash file, profile, revision) và phiên bản runtime từ lockfile vào candidate.

### Task 7: smoke thật, tài liệu
- `tests/semantic-smoke.mjs` (cần `OASM_SEMANTIC_MODEL_DIR`, `OASM_SEMANTIC_RUNTIME_DIR`; thiếu thì thoát mã 2 với hướng dẫn, giống `tests/smoke.mjs`): spawn `dist/cli.js` qua stdio dưới `sandbox-exec` từ chối mạng + preload canary, spec dạng file. Gọi: truy vấn mà lexical bỏ sót nhưng hybrid tìm thấy (lấy từ hàng `paraphrase_no_alias` của dev2), truy vấn exact path/operationId, `fields:["responseField"]`, thao tác bị ẩn bởi `operations` filter, phân trang `nextCursor`, `refresh_specs` đồng thời với search đang chạy, và cấu hình thiếu model (kỳ vọng lỗi khởi động tường minh, không lexical im lặng). Cuối cùng đóng stdin và xác nhận process cùng worker thoát trong hạn định, không còn process con. Ghi RSS (`ps`) và độ trễ.
- Smoke tắt semantic: spawn với `enabled:false` và `module.registerHooks` (resolve hook, Node >= 22.15) ghi mọi lần phân giải `onnxruntime-node`/`@huggingface/tokenizers`; kỳ vọng 0 lần, không đọc `modelDir`.
- Tài liệu cập nhật SAU khi smoke đạt: README Search, ví dụ config, cảnh báo hiển nhiên (RAM/đĩa, license của model, thiếu runtime).

### Task 8: cổng heldout độc lập (coordinator sở hữu)
Coordinator đóng băng heldout-2 (tác giả không thấy `src/search`, params, dev queries, kết quả) rồi tính commitment trước khi tuning. Worker đóng băng candidate (`freeze-candidate.mjs`, gồm model + runtime + harness). Coordinator chạy một lần với gate H3, báo recall, false-positive, MRR so baseline. Fail thì báo thật; không điều chỉnh sau khi thấy heldout.

## 7. Danh tính model
`modelIdentityHash = sha256(canonicalJson({profile, revision, fileHashes, dtype, dim, runtime}))`. Đi vào: khoá cache index, binding cursor, `retrieval.semantic.model` (rút gọn `profile@rev7`). Đổi model hoặc dtype hoặc phiên bản runtime thì index và cursor cũ không dùng được. Đường dẫn model không xuất hiện trong response, log hay lỗi.

## 8. Test vĩnh viễn (hành vi quan sát được, embedder xác định)
Không chứng minh chất lượng ngữ nghĩa; chỉ chứng minh logic engine.
- Tắt semantic: response đồng nhất với lexical (không có `retrieval`), test lexical hiện có chạy sau khi đổi sang `await`.
- Cấu hình: enabled thiếu `modelDir` bị từ chối; thiếu runtime lỗi tường minh; hash file lệch -> `SEMANTIC_MODEL_MISMATCH`.
- Pre-filter: operation bị ẩn, sai service/method/tag/deprecated KHÔNG xuất hiện kể cả khi gần nhất về vector.
- Scope hướng: request-only và response-only cho cùng tên field không lẫn trong nhánh semantic.
- Bất biến phân hoạch (vét cạn): với MỌI tập con khác rỗng của `FIELD_SCOPES` (63 tập), tập chunk eligible theo `eligible(chunk, allowed)` đúng bằng tập chunk mà tất cả `SearchField` của nó nằm trong `allowed` do `SCOPE_FIELDS` sinh; `fieldGroups(SCOPE_FIELDS)` phân hoạch đúng `SEARCH_FIELDS` (không field nào thiếu hay trùng) và mọi field trong một nhóm có cùng chữ ký scope.
- text khác identifier: operation A có operationId/path trùng chính xác văn bản truy vấn nhưng summary không liên quan; operation B có summary giống truy vấn. Embedder xác định (vector từ n-gram ký tự) cho A cosine cao nhất. `fields:["text"]` không trả A qua nhánh semantic (kể cả `semantic.chunk`), trả B; query không `fields` trả A với `semantic.chunk:"identifier"`; `fields:["identifier"]` ra `skipped` và `SCOPE_LEXICAL_ONLY`.
- schema khác mô tả field: operation có response field `status` mà mô tả là cụm từ truy vấn. `fields:["schema"]` không đưa operation qua nhánh semantic; `fields:["responseField"]` đưa với `semantic.chunk:"responseText"`; `fields:["requestField"]` không đưa; query không `fields` đưa. Cặp đối xứng cho tên schema/field khớp truy vấn: `schema` đưa với `responseSchema`, `text` không.
- Cô lập nội dung nhúng: embedder xác định ghi lại văn bản đầu vào; chunk `responseText` không chứa operationId, path, tag hay summary của operation của nó, chunk `text` không chứa method, path, operationId, tên field hay tên schema.
- Precedence: hit exact path/operationId vẫn đứng đầu dù vector gần nhất là hit khác.
- Cursor: phân trang hybrid ổn định; đổi revision -> `REVISION_CHANGED`; đổi mode -> `MODE_CHANGED`; đổi danh tính model -> `CONTEXT_CHANGED`.
- Snapshot bất biến: refresh trong lúc embedding đang chờ; revision trả về là của snapshot lúc vào.
- Giới hạn: cắt ngân sách tất định và có coverage; tràn hàng đợi -> `BUSY`; timeout; không retry vòng lặp khi build lỗi.
- Dispose: việc đang chờ bị từ chối `DISPOSED`; gọi hai lần an toàn.
- Nội dung nhúng: spec có `securitySchemes` mô tả, `example` mang token giả: văn bản gửi tới embedder (embedder xác định ghi lại đầu vào) không chứa chúng.
- Harness: H1 (chạm cap -> lỗi validate), H3 (gate fail khi MRR < baseline).

## 9. Xung đột tích hợp cần coordinator chốt
- `src/app.ts` (P1 sở hữu, đã sửa trong worktree): U5 thêm field `search`, `warm`, `dispose`.
- `src/server.ts` (P1 và P2 cùng chạm): xoá khối tạo engine, đổi handler sang async. Giữ output `targets: Record<string,{baseUrl}>` đúng hợp đồng đã duyệt (P4 không ghi đè handler).
- `src/config.ts:517` và `src/config-schema.ts:297`: chữ ký `compileSearchConfig` đổi; `config.schema.json` và `examples/config.example.yaml` phải sinh lại cùng lượt.
- `package.json` và `package-lock.json`: thêm peer optional và dev dependency (pin chính xác); `scripts/gen-notices.mjs` chỉ gom gói không dev/optional nên `THIRD_PARTY_NOTICES.md` không tự gồm runtime tuỳ chọn. Cần ghi license runtime và model trong README. `scripts/verify-package.mjs` (ALLOWED list) không đổi nếu không thêm file ngoài `dist/**/*.js`.
- `.github/workflows/ci.yml` và `publish.yml`: `ONNXRUNTIME_NODE_INSTALL=skip` cho bước `npm ci` (xem U8). `vitest.config.ts` dùng `pool: 'forks'`, `include: tests/**/*.test.ts`; test mới đặt đúng mẫu này.
- `bench/search/lib/*` đổi sẽ đổi `sourceHash`; vì vậy mọi candidate đã freeze trước đó không còn dùng được.
- Không chạm: `src/policy/*`, `src/request-prep.ts`, `src/trace/*`, `src/artifacts/*`, tool surface (`search_operations` giữ nguyên tên, chỉ thêm field phản hồi tuỳ chọn).

## 10. Rủi ro
- Tokenizer lệch id so với tham chiếu làm toàn bộ điểm semantic sai thầm lặng. Task 0 bước 3 là cổng cứng.
- RAM: fp32 có thể cần hàng trăm MB đến hơn 1 GB cho session; chưa đo. Nếu vượt ngân sách chấp nhận được thì chuyển U2 hoặc dừng.
- Cold start lâu: tránh bằng warm-up nền và `onUnavailable`; chưa có số đo.
- Ngưỡng cosine dồn quanh 0.7-1.0, nên ngưỡng tuyệt đối dễ gây false-positive cho truy vấn `no_result`; vì vậy ràng buộc FP <= 0.05 trên dev trong quy tắc hiệu chuẩn. Có thể kết luận cuối là semantic chỉ re-rank hit lexical, không thêm hit mới.
- ORT trong `worker_threads` và Node 26 chưa kiểm chứng.
- Semantic có thể không cải thiện `paraphrase_no_alias` đủ để đáng chi phí. Số đo trung thực là kết quả chấp nhận được; không claim vượt trội dựa trên benchmark của vendor hoặc corpus tổng hợp.

## 11. Chưa làm trong plan này
Không code, cài, tải, build, test, commit hay chạy model. Trạng thái "đạt" của bất kỳ mục nào chỉ có nghĩa sau khi có bằng chứng chạy thật ở Task 0, 6, 7, 8.

## 12. Implementation dispatch corrections (authority: coordinator approval in ctx_ef87ed69ada6)

This appendix supersedes conflicting proposals above. Native runtime is `onnxruntime-node@1.30.0` plus official Rust `tokenizers@0.23.2`, explicitly provisioned in an external runtime directory; no optional package is installed automatically. Reference is transformers 5.20.2 AutoTokenizer; a fixed hash-guarded transform of the official tokenizer JSON matches 4503/4503 inputs including special-token text. Slow SentencePiece differs on 547 adversarial inputs and is not the selected reference. Native inference uses a child process only: terminating worker_threads during ORT aborted the whole process in Task 0. There is no onUnavailable option, fallback, background warm-up or automatic retry. Startup checks local file sizes/runtime versions; first semantic search verifies full hashes and initializes inference. App owns SearchEngine and disposes it on shutdown.

Semantic retrieval is serialized to bound generation ownership; reservations include cached old generations, replacement vectors, and per-batch tensor/IPC allowances. Model/session native RSS (measured roughly 1.2–1.7 GB fp32) is explicitly excluded from the vector budget. fp32 remains evaluation-only. Native package license metadata Apache-2.0 conflicts with its bundled MIT license; preserve both in notices and block release compliance claims pending upstream/legal confirmation. No heldout-1 access, no merge or commit. Development grid and final metrics are reported honestly even when quality gates fail.
