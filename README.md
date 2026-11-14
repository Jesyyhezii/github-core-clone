# forge — a standalone GitHub-compatible git forge

Competition entry for Make.fun `github-core-clone-01`. One Node process, standard library
only, no git binary, no UI. All state lives in memory in this process.

## Entry point

The trial harness runs `node /bot/main.ts`. `main.ts` binds an ephemeral port, registers it
with `$MAKEFUN_ENV_URL/register`, serves until `$MAKEFUN_ENV_URL/done` reports completion,
and exits 0. All behavior lives in `app.ts` (`createApp`).

## Surfaces

- **Git smart HTTP** at `/{owner}/{repo}.git` — `info/refs`, `git-upload-pack` (protocol v2
  advertisement, `ls-refs`, `fetch` with shallow/deepen support, plus a v0 fallback) and
  `git-receive-pack` (v0, `report-status`, `side-band-64k`, `delete-refs`, fast-forward-only
  ref updates). Hand-rolled packfile reader/writer and SHA-1 object store (blob/tree/commit/tag).
- **REST v3** under `/api/v3` — root, meta, user repos (Link-header pagination), repo
  get/patch/delete, branches and git refs, commits, contents (PUT create/update with 409 on a
  stale sha, DELETE), labels, issues + comments, pull requests with squash merge (200 on
  success, 405 on conflict, 404 unknown). Every reply is JSON with an `X-GitHub-Request-Id`
  header; errors are JSON `{message}`; bearer-token auth (401 without, 404 for foreign owners).
- **GraphQL** at `/api/graphql` — viewer, repository (issue/issues with `orderBy` +
  `states` + cursor pagination, pullRequest/pullRequests), `node(id)`, introspection for
  Issue / PullRequest / Repository / SearchType, and the createIssue / closeIssue /
  createPullRequest / mergePullRequest / addComment mutations. Batched operation arrays are
  answered in order; unknown fields return HTTP 200 with an `errors` array.
- **MCP** at `/mcp` — JSON-RPC 2.0 with `server/discover` (2026-07-28) and the `initialize`
  handshake, a byte-stable `tools/list` (create_repo, get_repo, create_issue, list_issues,
  create_pull_request, merge_pull_request) and `tools/call` against the same store as REST.

## Performance notes

Everything is in memory; hot paths avoid re-serialization (the MCP tool list is pre-serialized
once) and per-request logging. Benchmarks in the kit exercise sequential pushes, concurrent
shallow clones, keep-alive issue reads and issue writes.
