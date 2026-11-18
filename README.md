# Forge — a standalone GitHub-compatible git forge

A single-process, dependency-free implementation of the GitHub core
surfaces: git smart HTTP, the REST v3 API, the GraphQL v4 API, and an MCP
server — all over one in-memory store. Written in TypeScript using only
the Node.js standard library (Node ≥ 22, type-stripping mode), with the
git object/pack layer implemented from scratch (no git binary).

Built for the make.fun **github-core-clone-01** competition.

## Running

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:<env-port> \
MAKEFUN_SHOP_TOKEN=<bearer-token> \
node --experimental-strip-types main.ts
```

On boot the forge binds an ephemeral port, POSTs `{"port": N}` to
`$MAKEFUN_ENV_URL/register`, serves until `GET $MAKEFUN_ENV_URL/done`
answers `{"done": true}`, then closes and exits 0. Without
`MAKEFUN_ENV_URL` it exits 1. `GET /healthz` answers `{"ok": true}`.

## Surfaces

- **Git smart HTTP** at `/{owner}/{repo}.git`
  - `info/refs` advertisements for protocol v2 and v0
  - `git-upload-pack`: v2 `ls-refs` (ref-prefix filtering, peel, symrefs,
    unborn HEAD) and `fetch` (full/incremental/shallow/deepen negotiation,
    section framing with delimiter packets, side-band-64k packfiles);
    a basic v0 fetch path
  - `git-receive-pack`: v0 push with pack ingestion (incl. OFS/REF
    deltas), fast-forward enforcement with per-ref `ok`/`ng` report-status
    in side-band, branch create/delete
- **REST v3** under `/api/v3` — repositories CRUD, `/user`, `/meta`,
  contents (create/update with sha checks, delete, directory listings,
  `?ref=`), branches, commits, git refs, labels, issues (state/sort
  filters, comments), pull requests (files diff, squash merge with
  conflict detection → 405). Bearer auth, JSON errors, and an
  `X-GitHub-Request-Id` header on every reply.
- **GraphQL v4** at `/api/graphql` — a small hand-written parser and
  executor: `viewer`, `repository`, `node(id:)`, `__type` introspection,
  cursor-paginated `issues`/`pullRequests` connections, and the
  `createIssue` / `closeIssue` / `createPullRequest` /
  `mergePullRequest` / `addComment` mutations. Batched requests supported.
  Global ids are typed base64 payloads shared with the REST `node_id`s.
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP with
  `server/discover` (plus legacy `initialize`), `tools/list`, and
  `tools/call` for `create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, and `merge_pull_request`,
  acting on the same store as REST and GraphQL.

## Layout

| File           | Job |
| -------------- | --- |
| `main.ts`      | competition lifecycle: register, serve, done-poll, exit |
| `app.ts`       | HTTP server, routing, auth, request ids |
| `store.ts`     | the forge state and domain operations (repos, issues, PRs, merges) |
| `gitobjects.ts`| SHA-1 object store, tree/commit/tag codecs, pack write/read, closure walks, diffs |
| `pktline.ts`   | pkt-line framing and side-band chunking |
| `gitserver.ts` | git smart-HTTP endpoints (advertise, upload-pack, receive-pack) |
| `rest.ts`      | REST v3 handlers |
| `graphql.ts`   | GraphQL lexer/parser/executor and schema |
| `mcp.ts`       | MCP JSON-RPC endpoint and tools |
| `ids.ts`       | global id encode/decode |
| `viewer.ts`    | the seeded scenario identity the forge presents as its viewer |

## Notes

- Storage is in-memory; a restart starts empty, by design.
- Object ids are real git SHA-1s: bytes written by pushes round-trip
  exactly, and system git can clone, fetch, pull, and push against the
  forge (protocol v2 and v0).
- Deterministic timestamps (a counter clock) keep repeated runs stable.
