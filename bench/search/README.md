# Search benchmark

Retrieval benchmark for `search_operations`. Corpus, labels, aliases and targets were committed and hashed
(`manifest.json`) before any file under `src/search/` existed; `run.mjs` refuses to run if a frozen artifact changed.

## Lexical-only development evaluation

The semantic/model experiment has been removed. Historical result files and external experiment reports remain unchanged and must not be interpreted as currently shipped functionality. Do not reopen heldout-1 for tuning.

```bash
npm run build
node bench/search/run-dataset.mjs --dataset bench/search/dev2 --systems lexical,baseline-0.1.2,mcp-stdio --out /outside/repo/results
```

Current lexical parameters remain version 4. Existing dev2 limitations are no-alias paraphrase recall@5 1/8, MRR 0.041667 (below baseline 0.25), and no-result false positives 6/64. The gate enforces relative MRR; validator traversal exhaustion fails closed and future held-out runs require a fixed external commitment-keyed registry. No quality superiority or new held-out acceptance is claimed.


## Contents

| Path | Role |
|---|---|
| `corpus/specs/*.json` | Synthetic OpenAPI documents: `shop` (Vietnamese + English), `crm-a`/`crm-b` (overlapping endpoints), `cjk` (Chinese, Japanese), `erp` (1000 generated operations, noise and latency). Produced by `corpus/build-specs.mjs`. |
| `queries.jsonl` | 210 labelled queries, 15 in each of 14 categories, `split` dev/test (alternating within a category). Labels name `service` + `METHOD /path` and are written by hand in `corpus/build-queries.mjs`; none comes from search output. |
| `aliases.json` | The user-declared alias groups given to the engine (the `paraphrase_alias` category depends on them and is marked `requiresAlias`). |
| `targets.json` | Targets fixed before ranking work. False positive = any returned hit on a `no_result` query, fuzzy included. |
| `adapters/baseline-0.1.2.mjs` | Verbatim copy of `src/specs/search.ts` at `7ff7326`. |
| `metrics.mjs` | Recall@k, Success@k, MRR, nDCG@10, precision@5, false positive rate, bootstrap CI (seeded). `--self-test` checks them against hand-computed values and runs before every benchmark. |
| `run.mjs` | Runner. Systems: `current` (in-process engine), `baseline-0.1.2`, `mcp-stdio` (spawns `dist/cli.js`, real MCP client), `competitors`. |
| `competitors/` | Competitor runner format and prerequisites. No competitor is pinned or executed yet. |
| `agent-protocol.md` | End-to-end agent measurement protocol. Not yet run. |

## Running

```bash
npm run build
node bench/search/run.mjs --self-test
node bench/search/run.mjs --systems current,baseline-0.1.2,mcp-stdio --repeat 50 --warmup 5
```

Results go to `bench/search/results/<time>-<sha>.json` with Node/V8/ICU/Unicode versions, CPU, git commit and
dirtiness, `package-lock.json` hash, manifest hash, rank parameters (`src/search/params.ts`), per-category metrics with
confidence intervals for `dev`, `test` and `all`, per-query top-5, output bytes, latency (p50/p95) for in-process
systems, cold index build, and `targetEvaluation` against `targets.json` on `split=test`.

## Method notes

- `current` uses an all-visible operation policy. The corpus has no operation filters; the product always passes its
  real policy. `mcp-stdio` measures whatever the built server does: before the server integration lands it measures the
  0.1.2 handler over stdio, and its record says so (`notes`).
- Tune ranking on `dev` only; report `test` once per parameter version. A change to corpus, labels or targets is a new
  corpus version and old results stay published next to the new ones.
- Latency is recorded, never asserted. Output bytes are tool-result bytes; token counts exist only in the agent
  end-to-end protocol, where a client reports them.
- The corpus is synthetic and small. A result here does not show that the server is better than another one on real
  APIs; categories where it does not meet a target are reported as such.
- Baseline `fields` and alias settings are ignored (0.1.2 has neither); `paraphrase_alias` and field-scoped categories
  therefore measure a capability the baseline lacks, which the result notes state.

## Results so far (synthetic corpus, 210 queries, `split=test` is 7 queries per category)

Two result files are kept in `results/`, produced by the same commit of the corpus (`manifest.json` unchanged):

| File | Rank params | Meaning |
|---|---|---|
| `2026-10-22T03-44-17-258Z-012481a.json` | `version: 1` | First run of the implemented engine, before any change after the corpus freeze |
| `2026-10-22T03-48-20-801Z-012481a.json` | `version: 2` | After the stopword correction below |

Change made after the freeze (`version: 2`): Vietnamese stopwords are matched on the accented form only. Version 1 folded
the stopword list, so `cửa` (shop) was dropped as the stopword `của` (of) and `hàng`-style words were treated as
filler. This is a correctness fix of the language data, not a weight change. It moved `vi` and `vi_no_diacritics`
`test` recall@5 from 0.857 to 1.00 and removed the only MRR-below-baseline line (`vi`: 0.873 vs 0.929). It was found by
looking at a `test` failure (`vi-10`), so the version 2 `test` numbers are no longer an untouched held-out measure;
the version 1 file is the untouched one.

A second change was tried and reverted before the run above: requiring non-fuzzy coverage for multi-term queries.
It would have addressed `no_result-04`, which is a `test` query with no `dev` counterpart failing, so it was not kept.

Target status for `current` on `test` (version 2): every target with a numeric threshold is met except one.

- **Not met: `no_result` false positive rate 0.143 (1 of 7), ceiling 0.10.** `no_result-04` ("dự báo thời tiết")
  returns `GET /orders/{orderId}` because `tiết` matches the description "Chi tiết đơn hàng" and `thời` matches
  "Trạng thái đơn hàng" by fuzzy distance. Any returned hit counts, fuzzy included. With 7 test queries one query is
  0.143, so this is also a statement about sample size. No ranking change was made to fix it.
- `paraphrase_no_alias` recall@5 is 0.429 (reported only, no target): without declared aliases the engine does not
  bridge differently worded descriptions. This is the input to the semantic-local decision; it is not a decision.
- `mcp-stdio` (real server over MCP) matches `current` on every category except the two alias categories, because the
  harness does not pass the alias config to the spawned server.
- Latency (this machine, in process): p50 about 0.13 ms and p95 about 1.2 ms per query on the 1000-operation `erp`
  service plus the other four; cold index build plus first search about 152 ms for all five services.

Baseline 0.1.2 on the same queries: lower recall on typo (0.57), acronym (0.71), cjk (0.43), response_field (0.04),
nested_schema (0.00), and a no_result false positive rate of 0.57. It is higher or equal on `exact_*`, `en`, `multi_service`.

## Not done

- Competitors: `competitors/competitors.json` is empty. Running a competitor needs an isolated pinned install over the
  network, which was not approved. Their results are therefore absent, not zero.
- Agent end-to-end: no run was observed (`agent-protocol.md` is a protocol only).

## Held-out preparation and tuning (rank params v3 and v4)

After the original no_result test failed (1 of 7), an independent held-out batch was approved (see `heldout-protocol.md`,
`dataset-format.md`). `dev2/` holds the tuner's development additions (185 rows, 64 `no_result`). Tuning used only the
original dev split and `dev2`; the original test split served as a regression guard (no positive may get worse than v2).

| Params | Change | dev2 no_result FP | Regression guard |
|---|---|---|---|
| v2 | stopword fix (above) | 19/64 = 0.297 | n/a |
| v3 | idf-weighted unit coverage; fuzzy distance 1 up to 8 letters, 2 from 9 | 5/64 = 0.078 | broke it: `paraphrase_no_alias-14` ("reward balance") lost; source kept in `results/params-v3-source/` |
| v4 | v3 plus: a result that leaves part of the query unmatched needs a match in a name-like field; `minCoordMulti` 0.5 -> 0.4 | 6/64 = 0.094 (Wilson 95% 0.04..0.19) | no positive lost on dev, dev2 or the regression split |

v4 is the frozen candidate. dev2 is tuner-visible, so 0.094 is a development number with a thin margin under the 0.10
ceiling; only the held-out run can validate it. The held-out batch was never read by the tuner.
Known cost: `paraphrase_no_alias` stays low (dev2 1 of 8), as before.
