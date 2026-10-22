# Competitor execution

`competitors.json` is intentionally empty: no competitor has been installed or executed, so none is reported.
`run.mjs --systems competitors` prints that as UNAVAILABLE with this reason; it does not invent a result.

## Entry format (read by `makeCompetitors` in `../run.mjs`)

```json
{
  "name": "swagger-openapi-mcp",
  "version": "<exact pinned version>",
  "service": "shop",
  "command": "node",
  "args": ["node_modules/<pkg>/dist/index.js", "{spec}"],
  "env": {},
  "searchTool": "<tool name copied from tools/list>",
  "queryArg": "<argument name copied from the tool inputSchema>",
  "extraArgs": {}
}
```

`{spec}` and `{baseUrl}` are replaced by the corpus spec file and base URL of `service`. The runner starts the server
over stdio, requires `searchTool` to be present in `tools/list` (otherwise the competitor is reported unavailable with
the tool names it did expose), maps JSON or text results to `METHOD /path`, and scores only queries whose labelled
operations are all in `service` (competitors serve one spec per process).

## Candidates from the roadmap (documentation only, not yet verified by running)

Public descriptions found while planning, to be confirmed against the pinned package at execution time:

- joyboy-yy/swagger-openapi-mcp: described as searching by path, method, tag, summary and reverse lookup by schema.
- ivo-toby/mcp-openapi-server: its dynamic mode is described as exposing `list-api-endpoints`, `get-api-endpoint-schema`
  and `invoke-api-endpoint`; whether it has a free-text search tool equivalent to `search_operations` is not established.
  If it has none, it is documented as unsupported for this workload, not counted as a loss.
- baryhuang/mcp-server-any-openapi: described as semantic discovery; if it needs a cloud embedding service it must not
  be run here (no cloud spec upload), and is reported as unavailable for that reason.

## Prerequisite

Installing pinned versions needs network access and an isolated install directory (`bench/search/competitors/node_modules`
is git-ignored by the repository's `node_modules` rule). That requires coordinator approval; nothing here installs anything.
