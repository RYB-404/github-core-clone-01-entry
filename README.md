# github-core-forge

A standalone, GitHub-compatible git forge. One process, no UI, no dependencies beyond the
Node.js standard library (`node:http`, `node:crypto`, `node:zlib`). It serves everything from
its own in-memory store:

- **git smart HTTP** at `/{owner}/{repo}.git` — upload-pack speaking protocol v2 (and v0), and
  receive-pack speaking v0 with `report-status`, `side-band-64k` and `delete-refs`. Clone, fetch
  (including shallow `depth`/`deepen`), push, fast-forward enforcement, per-ref `ng` reports and
  thin negotiation all work, with packfiles written and parsed by the forge itself.
- **GitHub REST v3** under `/api/v3` — the API root (`X-OAuth-Scopes`), `meta`, the authenticated
  user, repositories (create/read/patch/delete/paginate with `Link` headers), branches, `git/refs`,
  commits, the contents API (create/update/delete with blob shas, stale-sha 409s, directory
  listings), labels, issues (filters, sorting, comments), and pull requests (list, read, files with
  real line-diff counts, squash merge with conflict detection, merge-commit tracking).
- **GitHub GraphQL v4** at `/api/graphql` — the documents `gh` and `github-mcp-server` send:
  `viewer`, `repository` (with `issues`/`pullRequests` connections, cursor pagination, ordering and
  state filters), `issue`, `pullRequest` (with `files`), `node(id:)`, `__type` introspection, and
  the `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`, `addComment` mutations.
  Operation batching, inline fragments and validation errors (HTTP 200 + `errors`) are supported.
- **Model Context Protocol** at `/mcp` — JSON-RPC 2.0 over the Streamable HTTP transport, revision
  `2026-07-28` (with a legacy `initialize` fallback): `server/discover`, `tools/list`,
  `tools/call`, and the six forge tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`, plus two list tools), acting on the
  same store the REST and git surfaces serve.

## Running

```
node main.ts
```

The process binds an ephemeral port (`listen(0)`), POSTs `{"port": N}` to `$MAKEFUN_ENV_URL/register`
when that variable is set (the trial's lifecycle), polls `GET $MAKEFUN_ENV_URL/done` until the
suite answers `{"done": true}`, and exits 0. Without `MAKEFUN_ENV_URL` it simply serves.

`GET /healthz` answers `200 {"ok": true}` with no authorization. Every other surface requires
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; a missing or wrong token is 401, and repositories
belong to the login the token names — the same name under another owner is 404.

## Design notes

- **The store is memory.** Repositories, git objects, refs, issues and pull requests live in
  maps; objects are content-addressed by SHA-1 exactly as git hashes them. Nothing touches the
  filesystem at request time, so clone and push answers are built from memory.
- **Determinism.** No wall clock, no unseeded randomness: ids come from monotonic counters,
  timestamps from a fixed base (the trial's `MAKEFUN_TRIAL_NOW` when present), request ids from a
  counter, and GraphQL node ids are content-free opaque strings. The forge's own commits (the
  contents API, squash merges) carry a fixed identity and counter-based timestamps.
- **Caching for the timed workloads.** Immutable objects cache their deflated pack bodies, so a
  fetch response is a buffer copy; complete upload-pack responses (advertisements, `ls-refs`, the
  negotiated packfile) are cached per repository state and dropped on every ref update; issue JSON
  is serialized once and reused.
- **Real diffs.** Pull-request files are computed by walking the merge-base and head trees with a
  line-multiset diff, giving genuine `added`/`modified`/`removed` statuses and
  additions/deletions/changes counts; conflicts are detected the same way, so a conflicted squash
  merge answers 405.

## Trial environment variables

| Variable | Meaning |
| --- | --- |
| `MAKEFUN_ENV_URL` | the trial environment's origin; `register`/`done` lifecycle |
| `MAKEFUN_SHOP_TOKEN` | the bearer token all API calls must present |
| `MAKEFUN_TRIAL_NOW` | the fixed "now" every served timestamp derives from |
| `MAKEFUN_TRIAL_SEED` | the trial seed (the forge is fully deterministic without randomness) |

## License

MIT — see [LICENSE](LICENSE).
