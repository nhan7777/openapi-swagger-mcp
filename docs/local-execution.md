# Local execution, data boundary and first-request guide

This page describes what the server does on your machine, where data can go, and a short path from a config to a first request. It describes only behavior that exists in this version.

## What runs where

`openapi-swagger-mcp` is a local process started by your MCP client over stdio. It calls the APIs you configured directly from the environment it runs in. If your client runs in a container, on a remote machine or in another workstation, requests start from there, not from your laptop.

There are two separate data flows:

| Flow | What happens |
|---|---|
| API flow | The server sends HTTP requests to your configured services, to the login and refresh endpoints you configured, and to spec and `$ref` sources. Raw responses are stored as local artifacts. |
| AI flow | The server returns tool results to your MCP client. If the client uses a cloud model, **what the assistant reads can be sent to that model provider.** This server cannot prevent that. |

The server has no backend of its own, sends no telemetry and calls no embedding, reranking or model service. Installing it with `npx` needs network access to download the package; that is not an offline install.

Raw responses are not scrubbed. The assistant can read a full response through `read_artifact` when it needs to debug. If that must not reach a cloud provider, use a local model and control the client's network access.

The destination check (`network.allow`) compares exact origins, including at redirect hops. It does not look at the IP a name resolves to and does not block private addresses, so it is not an SSRF or DNS-rebinding defence. Configured loopback and VPN endpoints are reachable by design.

## Artifacts and trace lifecycle

These are two different mechanisms.

- **Artifacts** hold raw response bodies, large contracts and large tool inputs. They live in a per-process session directory under `files.artifactRoot`. By default a normal shutdown deletes that directory and the next start removes directories left by a crashed process. `files.retention` changes this (`keepOnExit`, `crashedSessionMaxAgeHours`, `maxRetainedBytes`).
- **The execution trace** records which tool calls and HTTP exchanges this process made, with timing and links to artifacts. It is bounded in memory, on disk and in its write queue, and it lives inside the same session directory, so it follows the same retention setting. See "Trace, policies and session lifecycle" in the README for what is and is not recorded.

Preview (below) is recorded as a tool call with no HTTP exchange, and what you typed into its `input` is not copied into the trace or any artifact.

## Check the config, then check the specs

Two commands, deliberately separate:

| Command | Network | What it proves |
|---|---|---|
| `--config <file> --check` | none | The config parses; env and file sources, local spec files and roots exist. It does not fetch specs, log in or create the artifact directory. |
| `--config <file> --check-specs` | spec sources only | Each spec (and the external `$ref`s the loader may fetch) can be loaded through the same network policy as the server. It never logs in, never calls a business endpoint and never creates the artifact directory. |

`--check-specs` sends the static `spec.auth` credentials you configured to the spec's own origin, exactly as the server does when it starts.

## From config to first request

1. Create a config. `init` writes a minimal one and prints the client entry; it refuses to overwrite an existing file and never edits your client's files:

   ```bash
   npx -y @nhan7777/openapi-swagger-mcp@0.1.3 init --service orders --base-url http://localhost:8080/api/v1 --spec http://localhost:8080/v3/api-docs --out config.dev.yaml
   ```

2. Run `--check`, add the printed entry to your client (see [clients.md](clients.md)) and restart or reconnect it.
3. Ask the assistant to list the APIs, then to find the operation. Search results carry the spec revision and the target base URL.
4. Ask it to **preview** the request. `preview_operation` shows the request `invoke_operation` would prepare, or the blockers that stop it, without sending anything.
5. Invoke it, or have the assistant do so. `invoke_operation` results include `trace: { callId, requestIds }` and the `target`.

### Preview: what it is and is not

`preview_operation` runs the same preparation function that `invoke_operation` runs before it sends. It has no access to the transport, so it cannot send. It returns `sent: false`, `ready`, `blockers`, the target, the method, URL, headers, cookies, query pairs, a bounded body, the request diagnostics and the auth binding in use.

- Credentials injected from your config, a session or the cookie jar are shown by binding name only. Values you or the assistant typed are shown as typed, even when one equals a secret.
- A missing credential, an unavailable spec, a stale revision or a blocked operation or destination gives `ready: false` and no request. Nothing is invented to look ready.
- Invalid data is kept and reported in diagnostics. Preview does not correct it.
- Multipart file content is never read: the files are listed by field, name and size.
- It is not an approval. `invoke_operation` prepares the request again and can differ if the input, config, spec revision or auth state changed.
- It shows the first request only. Redirects, a 401 refresh and cookies set by a response happen only on invoke. `host`, `content-length` and `connection` are added by the HTTP library and a multipart boundary is random per build, so neither is part of the preview. DNS, IP and TLS are not evaluated.

## Scenarios

**Static token.** Put the token in an environment variable and reference it. The variable must be in the environment of the MCP server process, so set it in the client entry's `env`:

```yaml
services:
  orders:
    baseUrl: http://localhost:8080/api/v1
    spec: http://localhost:8080/v3/api-docs
    auth:
      bearer: { token: { fromEnv: ORDERS_TOKEN } }
```

`init --bearer-env ORDERS_TOKEN` generates this and prints a client entry with a placeholder value to replace.

**Custom login and refresh.** Configure `authentication` and `refresh` recipes (see the README and `examples/config.example.yaml`). Nothing logs in implicitly: ask the assistant to run `authenticate` first. A 401 may start a background refresh and the failed request is never replayed. Until authentication has run, `preview_operation` reports `AUTH_REQUIRED` and shows no request.

**Large responses.** Responses over the inline budget are replaced in `bodyView`, listed in `omissions`, and kept whole in `rawBodyArtifact`. Read them with `read_artifact` (pages or a JSON Pointer) and save a file with `export_artifact` under an `exportRoots` directory.

## Open the inspector

With `inspector.enabled: true` in the config (the demo sets it), the server starts a read-only inspector on loopback. Run `openapi-swagger-mcp --config <file> --inspector-url` in another terminal to print its URL. The token in that URL is printed only by this command, to stdout; it is never written to stderr, logs or MCP tool results. The command only reads the descriptor the running server wrote in its session directory; it does not start a server or touch the artifact directory. A preview call shows in the inspector with no exchange, because nothing was sent.

When several servers share one config, add `--session <id>` to print only that server's URL. The id and a ready-made command come from `list_apis` (`session.inspector.urlCommand`); the command output contains the token, so run it locally rather than through the agent.

## Try it without your own API

`openapi-swagger-mcp demo` starts a synthetic backend on `127.0.0.1` with invented data and serves the MCP server for two demo services over stdio. It needs no credentials. The backend has no real authentication, so other local processes can reach it while it runs. See "Try the demo" in the README.
