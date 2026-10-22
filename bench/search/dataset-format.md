# Search benchmark dataset format (format 1)

One format for every dataset the runner accepts: the tuner's development additions (`dev2/`) and the coordinator's
held-out batch. A dataset is a directory. Nothing outside the directory is read.

```
<dir>/manifest.json     lists every other file with its sha256; its own bytes are the commitment
<dir>/config.json       the server config the dataset is run with
<dir>/queries.jsonl     one query row per line (the file name is given by manifest.queries)
<dir>/specs/<id>.json   one self-contained OpenAPI/Swagger document per service (.yaml/.yml also accepted)
```

## manifest.json

```json
{
  "format": 1,
  "batch": "heldout-1",
  "kind": "heldout",
  "corpusVersion": 1,
  "queries": "queries.jsonl",
  "config": "config.json",
  "counts": {
    "total": 255,
    "perCategory": { "exact_path": 15, "...": 15, "no_result": 60 },
    "noResultByClass": { "out-of-domain": 8, "...": 6 }
  },
  "files": {
    "config.json": "<sha256 hex of the file bytes>",
    "queries.jsonl": "<sha256 hex>",
    "specs/shop.json": "<sha256 hex>"
  }
}
```

- `kind` is `heldout` or `dev2`. `batch` is a free id and is part of the one-shot marker name.
- `files` lists every file in the directory except `manifest.json`. A file on disk that is not listed, a listed file
  that is missing or differs, a symlink, an absolute path or a path containing `..` makes the runner refuse the dataset.
- `counts` is recomputed by the runner from `queries.jsonl`; a different number is a refusal.
- **Commitment = sha256 of the bytes of `manifest.json`.** The runner takes it as `--commitment <hex>`.
- Write `manifest.json` as UTF-8, `\n` newlines, no BOM, with `node bench/search/make-manifest.mjs <dir> --batch <id>
  --kind heldout`, which lists the files, computes the hashes and the counts. Hand-edited manifests are valid if they are
  exact.

## config.json

A normal server config, restricted so that a dataset is fully described by its directory:

```json
{
  "version": 1,
  "services": {
    "shop": { "baseUrl": "http://127.0.0.1:9", "spec": { "source": { "file": "specs/shop.json" } } },
    "hr":   { "baseUrl": "http://127.0.0.1:10", "spec": { "source": { "file": "specs/hr.json" } },
              "operations": { "exclude": [{ "method": "DELETE" }] } }
  },
  "search": { "aliases": [ { "terms": ["nhân viên", "employee"], "services": ["hr"] } ] }
}
```

Allowed:

- top level: `version` (must be 1), `services`, `search`. Nothing else (no `files`, `profiles`, `network`, `trace`,
  `limits`, `credentialSources`, `encodedFields`, `$schema`).
- per service: `baseUrl` (any `http://127.0.0.1:<port>`; it is never contacted, services should have distinct ports),
  `spec` in the object form `{ "source": { "file": "specs/<id>.json" } }` with a path relative to `config.json` that
  stays inside the directory, and an optional `operations` filter (`include`/`exclude` rules: `method`, `path` glob,
  `operationId`, `tag`). A service has no `auth`; requests are never sent.
- `search.aliases`: groups of equivalent phrases, exactly as in the product config (`terms` 2-16 phrases, optional
  `services`). **`search.limits` is forbidden**: every dataset runs with the product defaults.
- The aliases are the only alias source. The in-process engine and the stdio server both read them from this file, so
  they cannot disagree.

At run time the runner writes a derived copy of this file to a temporary directory (spec paths made absolute,
`files.artifactRoot` pointed at a temporary directory). The dataset directory is never written.

Spec documents must be self-contained: internal `$ref` only, no `$ref` to another file or URL, no `roots`. Swagger 2.0
and OpenAPI 3.0.x/3.1.x are accepted. They go through the product spec loader, so they must be valid: for example every
`{param}` in a path needs a declared required `in: path` parameter, and an operation that declares a path parameter that
is not in its path is dropped by the loader. The author checks this with the validator below before delivery.

## queries.jsonl

UTF-8, one JSON object per line, no blank lines, no BOM, at most 500 characters in `query`.

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique string, for example `h1-vi-007` |
| `batch` | yes | Equals `manifest.batch` |
| `category` | yes | One of the 14 names below |
| `lang` | yes | `en`, `vi`, `zh`, `ja`, `ko` or `mixed` |
| `query` | yes | The text the agent would send |
| `relevant` | yes | `[]` for `no_result`, otherwise entries `{ "service", "operation", "grade" }` |
| `service` | no | Restrict the search to one configured service (the tool's `service` argument) |
| `fields` | no | Subset of `identifier`, `text`, `parameter`, `requestField`, `responseField`, `schema` (the tool's `fields`) |
| `requiresAlias` | no | `true` when the row only makes sense with the aliases in `config.json` |
| `class` | no_result: yes | Why the query is hard (free label, grouped in reports) |
| `absentConcept` | no_result: yes | The word or phrase naming the concept that is absent from every searched spec |
| `scopeMismatch` | no | `true` on a `no_result` row whose query is a real field name asked with the wrong direction (the field exists in the specs, but only in the other direction) |
| `bothDirections` | no | `true` on a `response_field` or `nested_schema` row about a field name that exists in both directions, with different expected operations per direction (counts towards the request-direction quota) |
| `weak` | no | `true` on a positive row with deliberately thin evidence (one word, partial name, only one of two words occurs in the spec); reported separately |

`operation` is `METHOD /path` exactly as the document spells the path (method upper-case, path case-sensitive).
`grade` is 2 (the expected operation) or 1 (an acceptable alternative). Rules:

- Categories: `exact_path`, `exact_operation_id`, `typo`, `acronym`, `vi`, `vi_no_diacritics`, `en`, `cjk`,
  `paraphrase_no_alias`, `paraphrase_alias`, `response_field`, `nested_schema`, `multi_service`, `no_result`.
- A positive row has at least one grade-2 entry. Every `relevant` entry names a configured service and an operation that
  exists in its document and is **visible** under that service's `operations` filter.
- If `service` is set, every `relevant` entry is in that service.
- `no_result` rows have `relevant: []`, `class` and `absentConcept`. The validator checks absence mechanically: the
  accent-folded, lower-cased `absentConcept` must not occur as a substring of the folded text of any spec document of
  the dataset. Pick the concept word so that this holds; the validator reports the first spec it occurs in.
- `scopeMismatch: true` rows (a real field asked in the wrong direction) are verified differently, from the specs: the
  row needs `service` or searches all services, exactly one of `fields: ["requestField"]` / `["responseField"]`, and its
  `query` (letters and digits only, accent-folded) must equal a property name that is ABSENT from the requested
  direction and PRESENT in the opposite direction over the visible operations searched. Property names are collected
  through internal `$ref`, `properties`, `items`, `additionalProperties`, `allOf/anyOf/oneOf`; request direction also
  includes form fields and response direction includes response header names. A row that fails is rejected, never
  waived; the substring absence check above does not apply to it.
- `paraphrase_alias` rows set `requiresAlias: true` and are answerable only through `config.json` aliases;
  `paraphrase_no_alias` rows must not depend on them.
- `multi_service`: at least 6 rows set `service` (scored success@1), the others do not (scored recall@5 over all
  services).
- There is no `split` field. In a `heldout` dataset every row is held-out.

## Quotas (validator, `kind: heldout`)

At least 15 rows in each of the 13 positive categories and at least 60 `no_result` rows (255 total). Of the `no_result`
rows: at least 40 percent in near-miss classes, at most 10 percent unprocessable input (symbols, emoji), at least 25
percent non-English. At least 30 percent of all rows have `lang` in `vi`, `zh`, `ja`, `ko`. At least a quarter of the
`response_field` and `nested_schema` rows use `requestField` or `schema` scope or ask the same field name in both
directions. `kind: dev2` uses 8 per positive category and 64 `no_result`.

## Validator (author-side, prints problems only)

```
npm run build
node bench/search/validate-dataset.mjs <dir> [--kind heldout|dev2]
```

It checks the manifest and hashes, the config restrictions, loads every document through the product spec loader
(reporting invalid specs), resolves every label against the loaded operations and the operation filter, runs the absence
check and the quotas. It prints `OK` plus counts, or one line per problem (`rowId: message`). It does not run the search
engine and prints no ranking output.
