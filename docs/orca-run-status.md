# Orca execution record

Run: `run_618807a0c602`
Coordinator: current main checkout `/Users/nhan/Desktop/project/openapi-swagger-mcp`.
Baseline: `7ff73264e821d83163474fe635caa7788a98e548`.

## Planning wave

| Package | Worktree | Task | Dispatch | State |
|---|---|---|---|---|
| 1 | `/Users/nhan/orca/workspaces/openapi-swagger-mcp/local-api-p1-boundary-trace` | `task_c57e38608f92` | `ctx_af9c90ba3ba4` | Plan submitted; imported to main; changes requested |
| 2 | `/Users/nhan/orca/workspaces/openapi-swagger-mcp/local-api-p2-search` | `task_c2513bf2d434` | `ctx_6ef90fd6a029` | Plan submitted; imported to main; changes requested |
| 3 | `/Users/nhan/orca/workspaces/openapi-swagger-mcp/local-api-p3-inspector` | `task_bdd405eb4ae2` | `ctx_d4a86e165b02` | Plan submitted; imported to main; changes requested |
| 4 | `/Users/nhan/orca/workspaces/openapi-swagger-mcp/local-api-p4-preview-onboarding` | `task_9784309274c9` | `ctx_949a1904d664` | Plan submitted; imported to main; changes requested |

All planners use Orca-managed OMP workers with the user's configured model default. No model override or setup hook was requested. Worktrees are user-requested and must be preserved for review/implementation; do not delete or automatically merge them.

## Gates

1. Each planner writes its `docs/plans/package-N-plan.md` only.
2. Coordinator reads and brings plans to main; edits and records review findings.
3. Shared trace/policy/preparation/config interfaces and ownership are resolved before approval.
4. Only approved plans receive implementation dispatches.
5. Independent implementation may run concurrently; real dependencies and shared-file integration remain ordered.
6. Main receives reviewed plans, not unreviewed implementation merges.

The roadmap and planning contract are currently local documents read by planners through absolute coordinator paths; workers were created from the clean committed source baseline. No private API configuration is copied to the worktrees.

## Revision wave

All four initial workers settled successfully with only their plan file reported modified. Main review is recorded in `docs/plans/coordinator-review.md`; none is approved for implementation yet.

| Package | Revision task | Revision dispatch |
|---|---|---|
| 1 | `task_69273b7cb3ad` | `ctx_eb15348a8c09` |
| 2 | `task_a191bb2d8738` | `ctx_6ee3c223656a` |
| 3 | `task_9ed091094066` | `ctx_795986d03ec4` |
| 4 | `task_684531fca060` | `ctx_9250ef4233b1` |

Release was requested for settled initial planning terminals. Orca returned `retained / user_takeover`, so no terminal was forcibly closed. New revision dispatches have their own fresh OMP terminals in the same four worktrees; initial dispatches are settled and do not own edits.

## Main review complete; implementation launch blocked

All four canonical plans are in main docs/plans and copied back to their matching worktrees with the approved integration contract and review findings. P1/P3/P4 revision workers succeeded; P2 revision worker ended its turn without publishing or worker_done and was stopped/released. Main completed P2 corrections in section 11.

Implementation launches failed at Orca `agent_readiness`, `lastError: timeout`, before `dispatch_input` acceptance. Retrying the same known tasks also failed. Terminal evidence shows OMP v18.12.5 at its idle prompt, no implementation prompt. No claim implementation is running or verified.

| Package | Implementation task | Latest failed dispatch | Cleanup |
|---|---|---|---|
| 1 | `task_0404e97b9e0e` | `ctx_ebb7347cf357` | released |
| 2 | `task_8486a369403a` | `ctx_9078e6ac8693` | released |
| 3 | `task_bb1341db5b25` | `ctx_7bb37bb33fd6` | released |
| 4 | `task_4a4a91d63ba3` | `ctx_36b6b77edec1` | released |

Resume only after Orca can recognize OMP readiness and inject a supervised prompt. Use worker-start --task with --retry-of the latest failed dispatch and exact existing worktree, not new task duplicates. P1/P3/P4 have two launch failures; respect Orca circuit-breaker if further retry is refused. Do not replace requested Orca orchestration with unrelated subagent tooling or restart the app without need/approval. Worktrees and plans remain preserved; no implementation merged into main.

## Resumed on existing proven planner terminals

User requested plan mode then execute. Reused original connected/writable planner terminals with `worker-start --task ... --retry-of ... --terminal ...` rather than launching a new OMP process. All four receipts are `ready / input_accepted`; this establishes prompt acceptance, not implementation completion.

| Package | Current dispatch | Terminal |
|---|---|---|
| 1 | `ctx_d361bdc2a5bb` | `term_761fe35e-d5bc-4652-8645-fdadc554dd97` |
| 2 | `ctx_c848dec392e9` | `term_cce546c3-be30-41ec-ae7a-407d77c7e21e` |
| 3 | `ctx_c068207b332b` | `term_9af2711c-8a67-4ad3-bf03-9cc063c0af15` |
| 4 | `ctx_b656376db15e` | `term_85a9e601-450d-49e6-b14c-22ffdd7b4794` |

Follow-up requires plan-first checklist/status before edits, then execution of reviewed independent work. P3/P4 final integration waits on P1 real source; P4 inspector demo also waits on P3. No fake providers, no automatic merge to main. Runtime plan-mode UI toggle is not claimed; instruction is delivered through supervised task and follow-up message.

## Independent-module verification checkpoint

- P4: coordinator installed locked dependencies; build/typecheck passed; init/demo/config-check suites passed (127 tests). Preview/CLI integration remains gated on P1/P3.
- P3: coordinator installed locked dependencies; guard/bytes/descriptor suites passed (71 tests). Inspector server/UI end-to-end verification remains pending.
- P2: coordinator installed locked dependencies; build/typecheck passed. Search suites reported two failures: undeclared path parameter in an operationId fixture, and an unexpected responseField match for Widget. No claim of passing search behavior.
- P2 correction task `task_008ec4fa6eed`: readiness failed for `ctx_0564e62d93ea` and `ctx_9c0f6eae2ee1`; resumed on the same proven idle terminal as `ctx_1e77e8b6e552`, receipt `ready / input_accepted`. Await correction report before rechecking.
- P1 foundation remains in progress. Existing worktrees preserved; no implementation merge to main.

## Independent held-out evaluation (user-approved)

- P1 follow-up worker reports build/schema/typecheck, 566 tests and real CLI trace/canary smoke passed. P2 integrated P1 in its own worktree and reports 601 tests and MCP smoke passed; main remains unmerged.
- User approved fresh independent held-out evaluation rather than waiving the original false-positive failure. Batch heldout-1: 255 queries, manifest SHA256 `e2944367bf50f60d226d1044b274d0b734988ef0091596ce138881137bd66cb9`.
- Candidate v4 was frozen before evaluation. Coordinator corrected only harness count equality (JSON key order was incorrectly significant); original dataset bytes and compiled product stayed unchanged. Corrected candidate sourceHash `5e3c9eeecac4d262234e6c477f07145459b83321315d0970394d9a2391002d68`, unchanged distHash `38e092cfe3d2695b4c5618128196ed681d5f92d80a6779b9b8ea6b9647ccf040`.
- Coordinator ran actual current/baseline/MCP-stdio evaluation: all 255 calls per system completed without failed calls. Current and MCP matched: no_result 6/60 = 0.10, Wilson 95% 0.047–0.201; failed recall gates: vi 0.800, en 0.800, cjk 0.267, paraphrase_alias 0.667. Overall FAIL, not accepted as complete.
- Evidence: `/Users/nhan/orca/workspaces/openapi-swagger-mcp/p2-heldout-results/heldout-1-2026-10-22T04-59-26-573Z.summary.json`. Heldout-1 is now consumed; no tuning/retesting another candidate on this batch. Further protocol/acceptance decision required. P3/P4 integration remains pending.

## Optional local hybrid implementation outcome

- User approved hybrid local with optional model. P2 implemented native child-process semantic retrieval, strict scope chunks, model-bound cursors, explicit unavailable errors, snapshot-safe async search, old/new/temp vector reservations, schema/docs/notices and no automatic network/download/retry/fallback.
- Runtime evidence: native official tokenizer binding matched the selected HF fast reference on 4503/4503 rows; embedding parity 942/942; Node 22/26 and network-denial MCP smoke passed. `worker_threads` remains rejected because terminate-in-flight aborts the host process. fp32 model RSS is approximately 1.2–1.7 GB and is excluded from vector-index budget/documented.
- Product verification: build, typecheck, generated schema, notices, real CLI smoke, 613 full-suite tests, targeted cursor tests and Node 22/26 offline hybrid MCP smoke passed. Heldout-1 remained untouched.
- Quality gate failed honestly: dev hybrid paraphrase recall improved 1/8 to 2/8 and false positives stayed 6/64, but no-alias MRR is 0.166667 versus released baseline 0.25. No candidate freeze, heldout evaluation, main merge, commit or release claim.
- Legal blocker remains: the selected native package is unscoped `tokenizers@0.23.2`; its package metadata says Apache-2.0 while its bundled LICENSE says MIT. The earlier scoped `@huggingface/tokenizers@0.2.0` was the old JS port and is not the selected runtime. Notices preserve the conflict and require upstream/legal confirmation before publication.
- Evidence: `/Users/nhan/orca/workspaces/openapi-swagger-mcp/p2-task0-evidence/implementation-dev/IMPLEMENTATION-REPORT.md` and identity-bearing dev summaries.

## Dev-only hybrid candidate analysis outcome

- User approved analysis before further tuning. The worker inspected all 8 `paraphrase_no_alias` dev2 rows without accessing heldout-1, recording lexical presence/rank, full semantic rank/score, admission blockers, fused rank, scope/policy/cap reasons and retained chunks. Raw evidence: `/Users/nhan/orca/workspaces/openapi-swagger-mcp/p2-task0-evidence/implementation-dev/EXPERIMENT-REPORT.md` plus comparison JSON files.
- Relevant operations were visible, unrestricted and retained; HR/media had zero semantic omissions. Five relevant operations were below semantic admission; `caption GET` ranked 465/603, so widening top-50 to top-200 did not address the bottleneck.
- Current hybrid, expanded-strict and corrected lexical-protected variants all measured FP 6/64, paraphrase recall@5 0.25 and MRR 0.166667. Margin expansion either raised FP to 7–13/64 or tied current at `.86/.03`; no candidate improved MRR while satisfying gates.
- No repository files or parameters changed. Current hybrid remains preserved. Next experiment, if approved, must change representation/chunking/model quality rather than thresholds alone; heldout-1 remains untouched.

## User-requested semantic removal complete in P2

- Removed semantic runtime/model/vector/fusion, associated configuration/schema/output/cursor fields, tests and provisioning scripts (15 files); migrated lexical callers and documentation (24 files). Lexical rank params v4 and P1 foundation preserved. Canonical hybrid design marked historical/withdrawn.
- Worker verification: clean build, generated schema/notices, typecheck, 602 tests in 34 files and real MCP smoke passed. All 185 dev2 lexical rows exactly matched pre-removal lexical rankings, metrics and byte counts; real MCP matched rankings/metrics. Existing FP 6/64 and paraphrase MRR 0.041667 remain limitations, not newly passed quality gates.
- Coordinator independently ran `npm run smoke` in P2: 10 tools, 26 traced calls, 8 exchanges matching 8 backend requests, output 1164 bytes; passed.
- Historical benchmark files, heldout data and external downloaded models/runtime/evidence preserved. No main implementation merge or commit. P3/P4 integration is still pending and is not part of this removal completion.
- Evidence: `/Users/nhan/orca/workspaces/openapi-swagger-mcp/p2-task0-evidence/lexical-removal/REMOVAL-REPORT.md`.

## P1–P4 merged and verified on main

- User authorized review/completion and merge. P1/P2 verified base `ea6a8b1` includes a regression-tested Transport.send body.open concurrency-slot leak fix. P3 integrated real trace/artifact inspector; P4 completed preview/init/check-specs/inspector-url/demo integration.
- Browser verification found call Summary coerced DOM arrays to text. Fixed in `aa2a3ee`; regenerated assets and exercised corrected Summary, binary raw/text, formatted JSON, large-body paging and cURL placeholders in a real browser. Large formatted response correctly reports too_large while raw pages remain accessible.
- Main merge: `06776d0` (includes integrated P4 `2fbb909` plus UI fix). Canonical search plan add/add conflict resolved by preserving lexical-only status and coordinator evaluation history. Worktrees retained; private heldout and external model/runtime/evidence were not staged or removed.
- Verification on merged main: build, generated schema/assets, typecheck, 46 test files / 892 tests passed; real MCP smoke 11 tools / 28 traced calls / 8 exchanges matched 8 backend requests; inspector smoke passed. verify:package passed using a separate consumer install and consumer MCP smoke; production high+ audit clean.
- Verified local package SHA256 `72e14d07b2bf5df98d3b5cb413d815baa0529717b1509f568cd727c5192b897e` on darwin arm64 / Node 26.8.1. Package is local only; no publication or push performed. Lexical recall limitations remain documented and are not claimed resolved.
