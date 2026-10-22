# Agent end-to-end protocol

Status: **not run.** This file is a protocol, not evidence. No agent run has been observed for this package, so no
claim about task success, contract reads or tokens is made. Retrieval metrics (`run.mjs`) are separate and do not stand
in for it.

## Tasks

The 20 queries of `queries.jsonl` with `split: "test"` that are labelled with exactly one expected operation, taken in
file order. Each is given to the agent as a goal ("find and describe the operation that ..."), not as the query string,
using the label's `lang`. The agent may use only the MCP server under test.

## Fixed inputs to record per run

MCP client and version, model and version, the server commit/package version, `manifest.json` hash, the config file
(corpus specs served as in `run.mjs`), prompt text, temperature/sampling settings if the client exposes them.

## Measurements

| Metric | Source |
|---|---|
| Chose the labelled operation | The `service` + `operation` the agent finally names or passes to `get_operation_schema`/`invoke_operation`, compared with the label |
| `get_operation_schema` calls before the final choice | MCP tool-call log |
| `search_operations` calls | MCP tool-call log |
| Tool-result bytes | Sum of result sizes in the tool-call log |
| Tokens for the whole task | Only if the client reports usage; otherwise "not measured" |

Run each system (the baseline 0.1.2 server and the candidate build) on the same tasks, same client and model, in
separate sessions with no shared memory. Report every task, including the ones the candidate loses. The run needs a
person or harness with an MCP client and model access; those prerequisites were not available while this protocol was
written.
