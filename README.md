# AFFiNE MCP Server (multi-tenant)

A Model Context Protocol (MCP) server for AFFiNE with full read/write access: create, edit, organize, and delete documents, workspaces, comments, and more. It runs over stdio or HTTP (`/mcp`) and supports self-hosted AFFiNE and AFFiNE Cloud.

This repository is a fork of [**affine-mcp-server** by DAWNCR0W](https://github.com/DAWNCR0W/affine-mcp-server) (MIT). Nearly all of the tool surface and the AFFiNE protocol work is theirs; see [Credits](#credits). What this fork adds:

- **Multi-tenant mode** — one deployment serves many AFFiNE users on many AFFiNE domains. Your application sends each user's AFFiNE URL and credentials per session; nothing is stored. See [Multi-tenant mode](#multi-tenant-mode).
- **Interactive API reference** — an OpenAPI 3.1 spec generated from the running server and a [Scalar](https://scalar.com) page. See [API reference](#api-reference).
- Deployment notes for Dokploy and multi-account setups (`deploy/multi-account/`).

[![Version](https://img.shields.io/badge/version-3.10.2-blue)](package.json)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.32.1-green)](https://github.com/modelcontextprotocol/typescript-sdk)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

## Table of Contents

- [Overview](#overview)
- [Choose Your Path](#choose-your-path)
- [Quick Start](#quick-start)
- [Multi-tenant mode](#multi-tenant-mode)
- [API reference](#api-reference)
- [Compatibility Matrix](#compatibility-matrix)
- [Tool Surface](#tool-surface)
- [Documentation Map](#documentation-map)
- [Verify Your Setup](#verify-your-setup)
- [Security and Scope](#security-and-scope)
- [Development](#development)
- [Release Notes](#release-notes)
- [License](#license)
- [Credits](#credits)
- [Support](#support)

## Overview

AFFiNE MCP Server is designed for three common scenarios:
- Run a local stdio MCP server for Claude Code, Codex CLI, Cursor, or Claude Desktop
- Expose a remote HTTP MCP endpoint for hosted or browser-connected clients
- Automate AFFiNE workspace, document, database, organization, and comment workflows through a stable MCP tool surface

Highlights:

- Supports AFFiNE Cloud and self-hosted AFFiNE instances
- Multi-tenant HTTP mode: per-session AFFiNE domain and credentials, with a mandatory host allowlist
- Supports stdio and HTTP transports
- Coordinates concurrent writes per workspace through one shared MCP server; optional document revisions reject stale edits
- Supports session-cookie and email/password authentication, plus compatible bearer tokens for older deployments
- Exposes 107 canonical MCP tools backed by AFFiNE GraphQL and WebSocket APIs
- Reads native database `created-by` (user ID) and `created-time` (timestamp) columns from row metadata; missing or invalid metadata returns `null` without backfilling it
- Sets and clears native AFFiNE Journal dates with `set_doc_journal`
- Includes semantic page composition, native template instantiation, database intent composition, capability and fidelity reporting, and workspace blueprint helpers
- Includes Docker images, health probes, and end-to-end test coverage

Scope boundaries:

- This server can access only server-backed AFFiNE workspaces
- Browser-local workspaces stored only in local storage are not available through AFFiNE server APIs
- After a content write, transient workspace timestamp failures are retried up to three times with backoff. If metadata still cannot be confirmed, inspect the saved document before any repair; do not repeat the content edit. See [document mutation recovery](docs/tool-reference.md#content-editing).
- AFFiNE 0.27+ removed the legacy personal-access-token GraphQL API; this server no longer exposes token-management tools
- AFFiNE Cloud requires browser-session authentication for this external GraphQL integration; programmatic email/password sign-in is blocked by Cloudflare
- `delete_doc` removes workspace page metadata and requests content deletion. Some AFFiNE servers retain content despite acknowledging the request; the tool returns a partial result with a warning unless content absence is verified. Use `trash_doc` for recoverable cleanup.

> New in v3.2.1: Scripted cookie login now keeps session secrets out of process arguments, validates workspace access before saving credentials, and restores document pagination for ordinary workspace members.

## Choose Your Path
| Goal | Start here |
| --- | --- |
| Set up a local stdio server with the least friction | [docs/getting-started.md](docs/getting-started.md) |
| Run the server in Docker or another OCI runtime | [docs/getting-started.md#path-c-run-from-the-docker-image](docs/getting-started.md#path-c-run-from-the-docker-image) |
| Configure Claude Code, Claude Desktop, Codex CLI, or Cursor | [docs/client-setup.md](docs/client-setup.md) |
| Let multiple agents write through one coordinated server | [Concurrent writes](docs/configuration-and-deployment.md#concurrent-writes) |
| Run the server remotely over HTTP or behind OAuth | [docs/configuration-and-deployment.md](docs/configuration-and-deployment.md) |
| Lock down tool exposure for least-privilege deployments | [docs/configuration-and-deployment.md#least-privilege-tool-exposure](docs/configuration-and-deployment.md#least-privilege-tool-exposure) |
| Learn common AFFiNE workflows and tool sequences | [docs/workflow-recipes.md](docs/workflow-recipes.md) |
| Browse the tool catalog by domain | [docs/tool-reference.md](docs/tool-reference.md) |

## Quick Start

### 1. Install the CLI

```bash
npm i -g affine-mcp-server
affine-mcp --version
```

You can also run the package ad hoc:

```bash
npx -y -p affine-mcp-server affine-mcp -- --version
```

### 2. Or run the server in Docker

> The published `ghcr.io/dawncr0w/affine-mcp-server` image is the upstream project and does not include
> multi-tenant mode. To use this fork, build the image from this repository (`docker build -t affine-mcp .`).

```bash
docker run -d \
  -p 3000:3000 \
  -e MCP_TRANSPORT=http \
  -e AFFINE_BASE_URL=https://your-affine-instance.com \
  -e AFFINE_EMAIL=you@example.com \
  -e AFFINE_PASSWORD=your-password \
  -e AFFINE_MCP_AUTH_MODE=bearer \
  -e AFFINE_MCP_HTTP_TOKEN=your-strong-secret \
  ghcr.io/dawncr0w/affine-mcp-server:3.10.1
```

Then point your client at:

```json
{
  "mcpServers": {
    "affine": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer your-strong-secret"
      }
    }
  }
}
```

For Docker, health checks, and remote deployment details, see [docs/configuration-and-deployment.md#docker](docs/configuration-and-deployment.md#docker).

HTTP deployments have two environment-only session limits:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AFFINE_MCP_HTTP_MAX_SESSIONS` | `32` | Combined Streamable HTTP and legacy SSE session capacity, including sessions being initialized |
| `AFFINE_MCP_HTTP_SESSION_IDLE_TIMEOUT_MS` | `1800000` (30 minutes) | Idle time before an inactive session is closed |

Short-lived Streamable HTTP clients, including cron jobs, should send `DELETE /mcp`
with their `Mcp-Session-Id` and authentication headers when finished. Exiting the
client process alone does not terminate its server-side session. A long idle
timeout can let abandoned sessions fill the limit and cause `503` / `-32002`
errors. Close unused sessions and choose an appropriate idle timeout before
raising the cap. See [session capacity troubleshooting](docs/configuration-and-deployment.md#runtime-limits-and-shutdown).

### 3. Save credentials with interactive login

```bash
affine-mcp login
```

This stores credentials in `$XDG_CONFIG_HOME/affine-mcp/config` when `XDG_CONFIG_HOME` is set, otherwise in `~/.config/affine-mcp/config`, with mode `600`.

The login flow reuses the configured or saved AFFiNE URL when you press Enter at
the URL prompt. After authentication, workspace discovery displays the workspace
name first and falls back to `Workspace name unavailable` when profile metadata
has no name; the full ID remains visible. An invalid numeric selection is rejected
and prompted again. Enter `q` or send end-of-file to cancel without writing a new
config. A failed discovery request is reported as a failure; it is not treated as
a completed login.

- For AFFiNE Cloud, paste the Cookie request header from a signed-in browser session
- For self-hosted AFFiNE, use email/password (recommended) or a signed-in session cookie
- `AFFINE_API_TOKEN` remains available only for deployments that still accept a compatible GraphQL bearer token

The prompt defaults to `AFFINE_BASE_URL` from the environment or the saved config file, so pressing Enter keeps an already-configured self-hosted URL instead of switching back to AFFiNE Cloud.

For a self-hosted instance reached over plain HTTP on a trusted private network, `AFFINE_ALLOW_INSECURE_HTTP=true` must be set for the login run as well as for the server. The opt-in is read from the environment first and then from the saved config file.

To avoid re-running login when a session expires, persist the account credentials instead of the session cookie:

```bash
affine-mcp login --save-credentials
```

With the email/password method, this stores `AFFINE_EMAIL` and `AFFINE_PASSWORD` so the server signs in on its own and renews the session before it expires. The password is written to the mode-`600` config file, so use a dedicated least-privilege AFFiNE account. Without this flag the CLI keeps storing only the session credential, which never renews by itself.

For scripted session-cookie setup, keep the cookie out of process arguments:

```bash
affine-mcp login --url https://app.affine.pro --cookie-stdin --workspace-id your-workspace-id --force
```

Paste the cookie at the hidden prompt, or pipe it from a trusted secret source. The CLI verifies `--workspace-id` against the authenticated account before saving it. Piped input requires `--force` when existing credentials would be replaced.

After login, inspect and switch the saved default workspace without signing in
again:

```bash
affine-mcp workspaces
affine-mcp workspaces --json
affine-mcp workspace <workspace-id>
```

`workspaces` lists names first and marks the current default. `workspace` validates
the requested ID with the active credentials and changes only the local default
(`AFFINE_WORKSPACE_ID`); it does not grant access to a workspace or change the
authenticated account. With no ID, it uses the same validated selection flow.

### 4. Register the server with your client

Claude Code project config:

```json
{
  "mcpServers": {
    "affine": {
      "command": "affine-mcp"
    }
  }
}
```

Codex CLI:

```bash
codex mcp add affine -- affine-mcp
```

More client-specific setup is in [docs/client-setup.md](docs/client-setup.md).

### 5. Verify the connection

```bash
affine-mcp status
affine-mcp doctor
affine-mcp snippet codex
```

The recommended Codex form is a command-only registration line that keeps using
the current saved login. `snippet claude` and `snippet cursor` print JSON
configuration instead. Apply the generated snippet, then restart or reconnect
the MCP client so it starts a fresh server process.

For an explicit environment snapshot, add `--env` to any snippet command. It
copies the currently resolved URL, authentication, headers, workspace, and
relevant OAuth settings; client environment variables win over saved config at
runtime. Remove or regenerate copied credentials when they expire instead of
expecting a saved login to override them.

If you want to expose the server remotely over HTTP instead of stdio, start with [docs/configuration-and-deployment.md](docs/configuration-and-deployment.md).
If an HTTP server already runs on the same host as your stdio client, use the
private [stdio HTTP bridge](docs/configuration-and-deployment.md#private-stdio-bridge-for-a-local-http-listener)
instead of starting another full server process.

## Multi-tenant mode

Use this when your own application manages many AFFiNE users or domains. Instead of one
fixed AFFiNE account per process, each MCP session carries its own destination and
credentials in the headers of the `initialize` request:

```bash
docker build -t affine-mcp .
docker run -d -p 3000:3000 \
  -e AFFINE_MCP_MULTI_TENANT=true \
  -e AFFINE_MCP_TENANT_ALLOWED_HOSTS="affine.example.com,*.team.example.com" \
  -e AFFINE_MCP_HTTP_TOKEN="$(openssl rand -hex 32)" \
  affine-mcp
```

```http
POST /mcp
Authorization: Bearer <AFFINE_MCP_HTTP_TOKEN>
X-Affine-Url: https://affine.example.com
X-Affine-Email: user@example.com
X-Affine-Password: ********
```

- `AFFINE_MCP_HTTP_TOKEN` identifies your application to the gateway. Keep it server-side.
- A session may only target hosts in `AFFINE_MCP_TENANT_ALLOWED_HOSTS`; the server will not start without it.
- Credentials live in memory for the session and are never logged or written to disk.
- Alternatives to email/password: `X-Affine-Cookie` or `X-Affine-Token`. Send exactly one method.

Full header reference, status codes, and operational notes:
[docs/configuration-and-deployment.md#multi-tenant-mode](docs/configuration-and-deployment.md#multi-tenant-mode).
For a single fixed account per deployment, see
[deploy/multi-account/README.md](deploy/multi-account/README.md).

## API reference

[docs/openapi.json](docs/openapi.json) is an OpenAPI 3.1 description of the gateway (session
lifecycle, tenant headers, status codes) and of all 106 tools exposed in multi-tenant mode, with
their input and output schemas. It is machine-readable, so it also works as context for your own AI.

[docs/index.html](docs/index.html) renders it with Scalar. Serve the `docs` folder over HTTP:

```bash
npx serve docs
```

When the HTTP server is running, the reference is served at `/docs` and the spec at `/openapi.json`
(set `AFFINE_MCP_DOCS=false` to disable). The served spec targets its own origin, so "Try it" works without CORS setup.

The spec is generated from the running server, so it cannot drift from the code:

```bash
npm run build && npm run docs:openapi
```

Tools are MCP tools, not REST endpoints. They are listed under *Webhooks* in the reference
because OpenAPI has no concept of JSON-RPC methods; each is invoked as `tools/call` on `POST /mcp`.

## Compatibility Matrix

Node.js 20.18.1 is the minimum supported runtime. CI validates the Node.js 20, 22, 24, and 26 release lines.

| Target | Transport | Recommended auth | Recommended path |
| --- | --- | --- | --- |
| Claude Code | stdio | Saved config | [docs/client-setup.md#claude-code](docs/client-setup.md#claude-code) |
| Claude Desktop | stdio | Saved config or session cookie | [docs/client-setup.md#claude-desktop](docs/client-setup.md#claude-desktop) |
| Codex CLI | stdio | Saved config or self-hosted email/password | [docs/client-setup.md#codex-cli](docs/client-setup.md#codex-cli) |
| Cursor | stdio | Saved config or session cookie | [docs/client-setup.md#cursor](docs/client-setup.md#cursor) |
| Containerized remote deployment | HTTP | Bearer token or OAuth | [docs/getting-started.md#path-c-run-from-the-docker-image](docs/getting-started.md#path-c-run-from-the-docker-image) |
| Remote MCP clients | HTTP | Bearer token or OAuth | [docs/configuration-and-deployment.md#http-mode](docs/configuration-and-deployment.md#http-mode) |
| AFFiNE Cloud | stdio or HTTP | Signed-in browser session cookie | [docs/configuration-and-deployment.md#auth-strategy-matrix](docs/configuration-and-deployment.md#auth-strategy-matrix) |
| Self-hosted AFFiNE | stdio or HTTP | Email/password or session cookie | [docs/configuration-and-deployment.md#auth-strategy-matrix](docs/configuration-and-deployment.md#auth-strategy-matrix) |

## Tool Surface

`tool-manifest.json` is the source of truth for canonical tool names. The MCP server exposes those tools through `tools/list` and `tools/call`; tool definitions returned by `tools/list` include MCP annotations that mark read-only, destructive, idempotent, and external-world behavior for client-side tool selection.

Every canonical tool also declares an MCP `outputSchema` for its `structuredContent`. Object results retain their existing top-level fields, while array and scalar results use stable `{ items }`, `{ text }`, or `{ value }` envelopes. The existing text `content` remains unchanged for compatibility with clients that do not consume structured results.

`get_capabilities` exposes the full implemented list in
`server.supportedTools` and the currently enabled surface in
`server.effective.profile` and `server.effective.enabledTools`, after profiles,
disabled groups or tools, and auth-mode policy. Inspect `tools/list` when you
need the final set of callable tools.

Advertised input and output schemas omit the SDK-generated draft-07 `$schema` marker. Schema interpretation follows the client context, allowing clients that reject an explicit draft-07 declaration to consume the tool surface.

Domains:

- Workspace: create, inspect, update, delete, and traverse workspaces
- Organization: collections, collection-rule sync, workspace blueprints, and experimental organize or folder helpers
- Documents: search, read, create, publish, move, tag, custom properties, import/export, semantic composition, template inspection and native instantiation, capability and fidelity reporting, and block-level mutation
- Databases: create columns, add rows, update rows, inspect schema, and compose database structures from intent
- Comments: list, create, update, delete, and resolve
- History: version history listing
- Users and authentication: current user, sign-in, and profile/settings
- Notifications: list and mark notifications as read
- Blob storage: upload, delete, and cleanup blobs

For new document content, use `create_doc` for an optional single plain-text
paragraph and `create_doc_from_markdown` for native headings, lists, links,
code blocks, and `$$...$$`/`$...$` math equations. Both tools accept `folderId` for immediate organize-folder placement.
New pages record the authenticated AFFiNE account in the app's **Created by**
property, including semantic pages, template instances, and workspace welcome pages.
Existing creator records are preserved; older pages are not backfilled.
New database rows also record the authenticated AFFiNE account and creation time,
including rows composed from intent or inserted as paragraph blocks. Editing or
moving existing rows preserves their creation metadata; older rows are not backfilled.

Use `AFFINE_TOOL_PROFILE=read_only`, `core`, or `authoring` when a deployment should expose a smaller surface than the complete `full` default. This is the recommended path for hosted, browser-connected, or least-privilege deployments because it reduces agent choice overload while keeping the full tool catalog available as an opt-in surface. You can also combine profiles with `AFFINE_DISABLED_GROUPS` such as `docs.database`, `destructive`, or `admin` for finer control.

Full-note replacement with `replace_doc_with_markdown` is destructive and requires `full` without disabling the `destructive` group. `core` and `authoring` retain incremental editing through `append_markdown` and `update_block`.

For the grouped catalog, notes, and operational caveats, see [docs/tool-reference.md](docs/tool-reference.md).

## Documentation Map

| Document | Purpose |
| --- | --- |
| [docs/getting-started.md](docs/getting-started.md) | First-run setup paths and verification |
| [docs/client-setup.md](docs/client-setup.md) | Client-specific configuration snippets and tips |
| [docs/configuration-and-deployment.md](docs/configuration-and-deployment.md) | Environment variables, auth modes, Docker, HTTP mode, and deployment guidance |
| [docs/workflow-recipes.md](docs/workflow-recipes.md) | End-to-end workflows and example tool sequences |
| [docs/tool-reference.md](docs/tool-reference.md) | Tool catalog grouped by domain |
| [docs/edgeless-canvas-cookbook.md](docs/edgeless-canvas-cookbook.md) | Edgeless canvas layout helpers and surface elements, worked end-to-end |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contributor workflow |
| [SECURITY.md](SECURITY.md) | Security reporting |

## Verify Your Setup

Useful CLI commands:

- `affine-mcp status` - test the effective configuration
- `affine-mcp status --json` - machine-readable status output
- `affine-mcp doctor` - diagnose config and connectivity issues
- `affine-mcp workspaces [--json]` - list accessible workspaces by name and mark the default
- `affine-mcp workspace [id]` - validate and set the local default workspace
- `affine-mcp show-config` - print the effective config with secrets redacted
- `affine-mcp config-path` - print the config file path
- `affine-mcp snippet <claude|cursor|codex|all> [--env]` - generate ready-to-paste client config
- `affine-mcp logout` - remove stored credentials

Core configuration uses `environment > saved config > defaults`. HTTP body/session
limits, proxy settings, WebSocket timeouts, and the HTTP compatibility escape
hatches are environment-only runtime flags; they are not read from the saved
`KEY=value` file. See [configuration precedence and environment scope](docs/configuration-and-deployment.md#configuration-precedence).
For a self-hosted deployment with a non-standard GraphQL route, use
`affine-mcp login --graphql-path /your/graphql/path` or set
`AFFINE_GRAPHQL_PATH`; `show-config --json` prints the exact resolved
`graphqlEndpoint` without exposing secrets. Generated workspace and document URLs
use the configured AFFiNE base URL, so a custom GraphQL path does not become part
of a browser link.

For common failures, see:

- [docs/getting-started.md#common-first-run-failures](docs/getting-started.md#common-first-run-failures)
- [docs/configuration-and-deployment.md#deployment-checklist](docs/configuration-and-deployment.md#deployment-checklist)

## Security and Scope

- Never commit passwords, session cookies, or compatible bearer tokens
- Use a dedicated least-privilege AFFiNE account for unattended deployments
- Email/password HTTP sessions share one login and never fall back to anonymous backend requests after authentication failure
- Use HTTPS for non-local deployments
- Keep remote HTTP MCP listeners authenticated; bearer mode refuses a non-loopback bind without `AFFINE_MCP_HTTP_TOKEN`
- Send MCP bearer tokens in the `Authorization` header, never in the URL
- Re-run `affine-mcp login` when a saved browser session expires
- For GUI clients, verify `command -v affine-mcp` and `command -v node`; an absolute
  script path does not fix a `#!/usr/bin/env node` shebang when the GUI process has
  no Node.js directory in `PATH`. See [GUI client PATH troubleshooting](docs/client-setup.md#gui-client-path-troubleshooting).
- Restrict exposed tools with `AFFINE_DISABLED_GROUPS` and `AFFINE_DISABLED_TOOLS` for least-privilege setups
- Treat OAuth mode as a shared AFFiNE service-account deployment: it defaults to `read_only`, and write-capable profiles require `AFFINE_OAUTH_ALLOW_SERVICE_WRITES=true`
- Use `/healthz` and `/readyz` when running the HTTP server behind a container platform or load balancer
- Set HTTP body, session, idle, and shutdown limits explicitly for high-volume deployments

## Development

Run the main quality gates before opening a PR:

```bash
npm run ci
```

Additional validation:

- `npm test` verifies tool metadata, test-suite coverage, and the fast regression suite without requiring a live AFFiNE instance
- `npm run test:comprehensive` boots a local Docker AFFiNE stack and validates the tool surface
- `npm run test:e2e` runs Docker, MCP, and Playwright together
- `npm run test:playwright` runs the Playwright suite only
- Focused runners for the new high-level tool surface include `npm run test:create-placement`, `npm run test:capabilities-fidelity`, `npm run test:native-template`, `npm run test:mutation-ack`, `node tests/test-database-intent.mjs`, `node tests/test-semantic-page-composer.mjs`, `node tests/test-structured-receipts.mjs`, `node tests/test-organize-tools.mjs`, and `node tests/test-supporting-tools.mjs`

Live tests can mutate or delete AFFiNE data. They allow loopback targets by
default and refuse non-loopback targets unless the disposable target is
explicitly enabled and confirmed as documented in `CONTRIBUTING.md`. Never run
them against production.

Local clone flow:

```bash
git clone https://github.com/febrianrz/affine_mcp.git
cd affine-mcp-server
npm install
npm run build
node dist/index.js
```

## Release Notes

- [CHANGELOG.md](CHANGELOG.md)
- [RELEASE_NOTES.md](RELEASE_NOTES.md)
- [Upstream releases (DAWNCR0W/affine-mcp-server)](https://github.com/DAWNCR0W/affine-mcp-server/releases)

## License

MIT License - see [LICENSE](LICENSE). The original copyright notice is retained as the license requires.

## Credits

This project exists because of [**DAWNCR0W**](https://github.com/DAWNCR0W) and the contributors to
[affine-mcp-server](https://github.com/DAWNCR0W/affine-mcp-server), which this repository is forked from
(imported at v3.10.2, commit `4bd2994`; see [UPSTREAM.md](UPSTREAM.md)). The tool surface, AFFiNE GraphQL/WebSocket
integration, document model handling, and test suite are their work. Please star and support the original project.

Multi-tenant mode, the OpenAPI/Scalar reference, and the deployment notes are additions in this fork.

## Support

- Fork-specific issues (multi-tenant mode, API reference): open an issue on [febrianrz/affine_mcp](https://github.com/febrianrz/affine_mcp/issues)
- Core tool behavior also exists upstream: [DAWNCR0W/affine-mcp-server issues](https://github.com/DAWNCR0W/affine-mcp-server/issues)
- Review AFFiNE product documentation at [docs.affine.pro](https://docs.affine.pro)

### Acknowledgments

- Built for the [AFFiNE](https://affine.pro) knowledge base platform
- Uses the [Model Context Protocol](https://modelcontextprotocol.io) specification
- Powered by [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
