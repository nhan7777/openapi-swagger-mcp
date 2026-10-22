# Held-out evaluation protocol (proposal, section 12 of the package 2 plan)

Status: proposal sent to the coordinator. Nothing in this file is implemented yet. No ranking change is made before the
coordinator approves it and notifies that the held-out batch is frozen.

## What stays as it is

- `queries.jsonl`, `corpus/`, `aliases.json`, `targets.json`, `manifest.json` and `results/*.json` (rank params v1 and
  v2) are not edited. Their hashes in `manifest.json` stay valid.
- Targets are unchanged: `no_result` false positive rate at most 0.10 (any returned hit, fuzzy included, and any failed
  call count as false positives; only `QUERY_UNPROCESSABLE` is a correct abstention), every positive recall/success
  target in `targets.json`, MRR not below baseline. Positive targets stay so that "always abstain" cannot pass.
- The historical result stays documented: original `test` split, `no_result` 1 of 7 = 0.143, and the post-freeze v2
  stopword correction.
- The original `test` split is renamed in reports only (`regression`). It was revealed during tuning, so it is
  regression evidence (positives must not get worse than v2) and no longer independent validation.

## Why the original test could not settle the question

Seven `no_result` queries cannot show a 0.10 ceiling: one false positive is 0.143. The queries were written by the
same person who wrote the specs and the engine. The development split had no near-miss `no_result` query that failed,
so there was nothing to tune against. Fixing this means more `no_result` queries, harder ones, and an author who has not
seen the engine, the dev queries or the results.

## Roles

| Role | Does | Must not |
|---|---|---|
| Tuner (this worker) | Writes development additions (D1-D4), harness changes (R1-R8), tunes on development data, freezes a candidate | Author, request, read or infer held-out queries, specs or labels before the candidate freeze |
| Coordinator | Owns the held-out batch, its commitment hash and the evaluation run, stores the batch outside the P2 worktree | Show the batch to the tuner before the freeze |
| Held-out author (coordinator's choice) | Writes queries and labels from the spec files and the category rules below only | See `src/search`, `params.ts`, dev queries, dev specs or any result file |

## Development additions (tuner-authored, frozen before tuning, tuner may inspect)

Placed in `bench/search/dev2/` with their own `manifest.dev2.json`; the original files are not touched.

| Id | Addition | Count |
|---|---|---|
| D1 | Positive dev queries added to each of the 13 positive categories (same schema as `queries.jsonl`), split `dev` | at least 8 per category, 104 total |
| D2 | Of D1, weak-evidence positives that punish an abstain-everything fix: one-word queries, partial field names, typo plus missing accents, a query where only one of two words occurs in the spec | at least 30 |
| D3 | `no_result` dev queries | at least 64 |
| D4 | Two new dev specs (Vietnamese HR, English media with `allOf` and shared request/response field names), about 40 operations each | 2 |

D3 composition (each class at least 6 queries, near-miss classes together at least 50 percent):

1. Out-of-domain topic in en, vi, zh, ja, ko (the original kind).
2. Shares a function word or common syllable with spec text but names an absent concept.
3. Fuzzy neighbour: a typo-distance neighbour of a spec word, naming an absent concept.
4. Vietnamese with diacritics stripped that collides with other syllables.
5. CJK query sharing one character with spec text.
6. Field scope mismatch: a real field name asked in the wrong direction (`fields: ["responseField"]` for a request-only field).
7. A concept that sounds like a spec concept but is absent (for example refunds asked of a service with only payments).
8. Unprocessable input (symbols, emoji): at most 10 percent of D3, counted as correct abstention.

Absence is checked by reading the specs, not by running the engine. Each D3 row carries `absentConcept` and `class`.

## Held-out batch (coordinator-owned)

### Size

| Part | Minimum | Preferred |
|---|---|---|
| Positive queries per category, 13 categories | 15 | 20 |
| Positives total | 195 | 260 |
| `no_result` queries | 60 | 80 |
| Total | 255 | 340 |

Why these numbers: at 15 per category a 0.85 target needs 13 of 15, a 0.80 target needs 12 of 15, success@1 1.00 needs
all. At 80 `no_result` queries the ceiling allows 8 false positives. The 95 percent Wilson upper bound is about 0.20 at
6 of 60 and 0.046 at 0 of 80, so a point-estimate pass does not prove the rate is below 0.10; both numbers are
reported, and the coordinator decides whether the bound also gates.

### Categories and quotas

The 13 positive categories are the ones in `targets.json`: `exact_path`, `exact_operation_id`, `typo`, `acronym`, `vi`,
`vi_no_diacritics`, `en`, `cjk`, `paraphrase_no_alias`, `paraphrase_alias`, `response_field`, `nested_schema`,
`multi_service`, plus `no_result`.

- `multi_service`: at least 6 queries carry `service` (success@1 target), the rest do not (recall@5 across services).
- `response_field` and `nested_schema`: at least a quarter use `requestField` scope, and some ask the same name in both
  directions with different expected operations.
- `paraphrase_alias`: aliases live in the dataset's `config.json` (`search.aliases`), written by the held-out author, not by the tuner. They are the single alias source for the in-process engine and the stdio server. Exact file layout: `dataset-format.md` (normative; where this file and `dataset-format.md` differ, the format document wins).
- `no_result`: at least 40 percent near-miss (classes 2 to 7 above, written by the held-out author independently of the
  tuner's list), at most 10 percent unprocessable, at least 25 percent non-English (vi, zh, ja, ko).
- Language: at least 30 percent of all queries vi/zh/ja/ko.

### Specs

Queries run against two sets together: the existing corpus (`shop`, `crm-a`, `crm-b`, `cjk`, `erp`) and new held-out specs
the tuner has not seen: at least 3 services, at least 150 operations, one Vietnamese-heavy, one with a non-Latin script,
one with `allOf`/`oneOf` and the same field name in request and one response, one with an `operations` filter in its
config so some labelled-absent operations are hidden by the policy. A `no_result` query is absent from every searched
service.

### Row schema (superset of `queries.jsonl`)

```json
{"id":"h1-vi-007","category":"vi","lang":"vi","query":"...","service":"optional","fields":["responseField"],
 "requiresAlias":false,"relevant":[{"service":"shop","operation":"GET /orders/{orderId}","grade":2}],
 "batch":"heldout-1","corpus":"frozen-v1","class":"near-miss-fuzzy","absentConcept":"only for no_result"}
```

`relevant` names `service` and `METHOD /path` (grade 2 expected, 1 acceptable), `[]` for `no_result`. `class` and
`absentConcept` are required for `no_result`. There is no `split` field: every row is held-out.

### Commitment

Before the tuner starts tuning the coordinator sends: sha256 of each held-out file, the per-category counts, and the
batch id. Content is not sent. The runner later refuses a batch whose hashes differ from the commitment.

## Harness requirements (tuner implements after approval; none is a ranking change)

| Id | Requirement |
|---|---|
| R1 | `run-dataset.mjs --dataset <dir> --commitment <sha256 of manifest.json> --candidate <candidate.json> --out <dir outside the repo>`: validates the dataset (hashes, config, product spec loader, label resolution, absence and direction checks, quotas), then runs `current`, `baseline-0.1.2` and `mcp-stdio` on the same rows. Development datasets (`kind: dev2`) run without commitment/candidate/out. Built: `run-dataset.mjs`, `lib/*.mjs`, `make-manifest.mjs`, `validate-dataset.mjs`, `freeze-candidate.mjs` |
| R2 | Splits are never pooled: `dev` = original dev split (run.mjs) plus the dev2 dataset (run-dataset.mjs), `regression` = original test split (run.mjs, unchanged), `heldout` = the coordinator's batch (run-dataset.mjs). Each tool reports one of them; no tool merges them |
| R3 | `sourceHash` = sha256 over sorted relative path + content hash of ALL of `src/**`, `package.json`, `package-lock.json`, `tsconfig.json`, `config.schema.json` and every non-documentation file under `bench/search` except `results/` and `dev2/`; `distHash` = the same over `dist/**`. Written to the candidate file and to every dataset summary |
| R4 | `freeze-candidate.mjs --out <file outside bench/search>` writes `candidate.json` (rank params version, sourceHash, distHash) and refuses a stale `dist/`; `run-dataset.mjs` refuses a held-out run when either hash differs |
| R5 | Parity: `mcp-stdio` runs `dist/cli.js` on the dataset's derived config (same aliases and operation filters as the in-process engine); `current` uses `OperationPolicy.compile(cfg)` and `cfg.search` from the same config. Replaces the stand-in policy and the stale note in `run.mjs`, which stays frozen as the regression runner |
| R6 | Output hygiene: the console prints aggregates and target pass/fail only; per-query rows (text, top hits, failing ids) go to `<out>/<batch>-<time>.detail.json`, the aggregate to `.summary.json`; outputs are created exclusively |
| R7 | One-shot marker `<out>/<batch>.used` is created exclusively after the dataset validates and the candidate matches; any later run for that batch is refused, whatever the candidate |
| R8 | Statistics: Wilson 95 percent interval for `no_result`, per-class false positive rate, per-category n, positives answered with no hit, weak-evidence subset |

## Freezing process and notifications

1. Coordinator approves this protocol and answers the questions in the status message.
2. Tuner delivers D1-D4 and R1-R8 and sends a **data freeze** status with the sha256 of `manifest.dev2.json`.
3. Coordinator sends the held-out **commitment** (hashes, counts, batch id) before any tuning starts. This is the freeze
   notification the tuner waits for.
4. Tuner tunes on `dev` only. Guard: `regression` positives may not fall below the v2 numbers. `regression` false
   positives are not a tuning target.
5. Tuner sends a **candidate freeze** status: `sourceHash`, rank params version, build id. After that the tuner edits nothing
   under the hashed paths.
6. Coordinator runs the held-out evaluation once against that candidate, outside the tuner's worktree, and reports.
7. Pass requires every target at once on the same candidate. A fail makes the batch burned: no tuning on it. Another try
   needs a new batch (`heldout-2`) or a user decision. Either way v1, v2, the regression numbers and every held-out
   result are published together.

## Open questions for the coordinator

1. Sizes: minimum or preferred, and whether the Wilson upper bound gates as well as the point estimate.
2. One batch or two. One batch (recommended): tune first, validate once. Two batches: run the current v2 candidate on
   the first as a no-tuning diagnostic, then validate a tuned candidate on the second.
3. Approval to author D1-D4 and R1-R8 now, as harness and data only.
4. Confirm that you notify the tuner with the commitment (step 3) and that nothing in the batch is shown before step 6.
