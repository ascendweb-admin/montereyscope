# Scope X read-worker protocol

Scope never talks to X directly. Every read goes through a separate,
app-owned worker process that speaks one JSON request/response protocol. The
worker may be a bundled frozen executable (the shipping path), a pinned
twitter-cli wrapper, or the deterministic test fixture; Scope's code does not
know which.

## Transport

- Scope spawns the worker with a fixed executable and fixed argument array
  (`shell: false`), writes **one JSON request line to stdin**, then closes
  stdin and reads **one JSON envelope from stdout**.
- stdout is bounded (8 MiB by default) and the call has a hard timeout per
  operation. The process tree is killed on timeout or cancellation.
- Worker stderr is discarded by the desktop host. Untrusted diagnostics are
  never logged, shown in the UI, or stored because they may contain credentials.
- Credentials (e.g. an X cookie header supplied by the desktop broker) may
  appear only in the request's private `credentials` field. Workers must not
  require secrets in argv or the general environment.

## Request

```json
{
  "protocol": 1,
  "operation": "status",
  "params": {},
  "credentials": { "cookieHeader": "…" }
}
```

Operations and their params:

| Operation         | Params                               | Data returned                                                                  |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------------------ |
| `status`          | —                                    | `{ connected, canConnect?, sessionOnly?, user? }`                              |
| `connect`         | —                                    | same as `status`                                                               |
| `disconnect`      | —                                    | `{ ok: true }`                                                                 |
| `cancel`, `focus` | —                                    | connection status                                                              |
| `user`            | `{ handle }`                         | `{ user, pinnedTweetId? }`                                                     |
| `user_search`     | `{ query }`                          | `{ users: [{ userId, handle, displayName, avatarUrl, verified, protected }] }` |
| `user_posts`      | `{ userId, handle, cursor?, limit }` | `{ items: [{ tweet, timelineKind?, timelineAt? }], nextCursor? }`              |
| `tweet`           | `{ tweetId }`                        | `{ found: true, tweet }` or `{ found: false }`                                 |

`user` and tweet payloads follow the normalized shape Scope's mapper
(`lib/x/mapper.ts`) accepts. Ids are decimal strings; numbers are only used
for nullable metrics.

`connect`, `disconnect`, `cancel`, `focus`, and `retry-storage` belong to the
Electron broker, not the Python worker. The frozen worker only accepts
`status`, `user`, `user_search`, `user_posts`, `tweet`, and a network-free
`runtime` packaging check. `user_search` reads X's people typeahead (the x.com
search box) with one GET and returns at most 10 accounts, best match first.
Broker status also includes `phase`, `attemptId`, `restoring`, and a bounded
`storage` record (`state`, `reason`, `backend`); lifecycle calls return
that status. `retry-storage` retries decrypting or saving the desktop-stored
session without starting another X sign-in. The broker rejects credentials
supplied by its client: only Electron can add them.

## Response

Success:

```json
{ "ok": true, "schema_version": 1, "data": {} }
```

Failure:

```json
{ "ok": false, "error": { "code": "rate_limited", "retryAfterSeconds": 30 } }
```

`error.code` must be one of the typed codes Scope understands: `not_connected`,
`session_expired`, `verification_required`, `rate_limited`, `not_found`,
`protected_account`, `network`, `timeout`, `cancelled`, `unsupported_runtime`,
`invalid_response`. Unknown codes are treated as `invalid_response`.
`schema_version` must be exactly `1`; anything else is rejected.

A response that cannot be parsed, an envelope missing `ok`, a nonzero exit,
or output over the bound all surface as `invalid_response`. stdout contains
only the envelope; diagnostic output must never contain secrets.

## Connection semantics

- `status.connected: true` is **not** enough: Scope requires a resolvable
  `user` identity, otherwise the state is reported as disconnected. Cookie
  presence is never treated as a successful connection.
- `status.canConnect` tells Scope whether the worker can start its own
  sign-in. When false and no session exists, Scope reports `unavailable`
  (the desktop host is expected to manage login in that configuration).
- `status.sessionOnly: true` means the session cannot be persisted securely;
  Scope shows "sign in again after closing Scope".

## Testing

`tests/fixtures/fake-x-worker.cjs` implements the protocol deterministically
and supports fault injection through `FAKE_X_WORKER_MODE`:
`ok` (default), `bad-schema`, `garbage`, `error`, `exit-1`, `hang`.
