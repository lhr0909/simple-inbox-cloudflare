# Architecture

Cloudflare Inbox is a pnpm monorepo deployed as three Cloudflare Workers. Queryable state lives in
D1, canonical raw messages live in R2, and browser traffic cannot reach those resources directly.

```text
browser -> web Worker -> API Worker -> mail Worker
                         |              |
                         v              v
                        D1 <----------> R2
```

Service Bindings connect web to API and API to mail. Public browser requests remain same-origin at
the web Worker. The API enforces sessions, CSRF, mailbox authorization, and response contracts. The
mail Worker handles inbound `email()` events and mail-domain operations; its Hono `fetch` handler is
private infrastructure, not another public API.

## Workspace responsibilities

| Workspace            | Responsibility                                                    | May depend on             |
| -------------------- | ----------------------------------------------------------------- | ------------------------- |
| `apps/web`           | TanStack Start UI, SSR, embedded Fumadocs, same-origin API bridge | contracts                 |
| `workers/api`        | HTTP contracts, auth, authorization, orchestration                | contracts, db, mail-core  |
| `workers/mail`       | inbound capture, parsing, threading, forwarding, sending          | contracts, db, mail-core  |
| `packages/contracts` | stable schemas, DTOs, IDs, errors, API type surface               | runtime-neutral libraries |
| `packages/db`        | Drizzle schema, migrations, repositories                          | contracts                 |
| `packages/mail-core` | parsing/threading/rendering helpers                               | contracts                 |

Workspace imports use package exports and `workspace:*`; source-path imports across packages are
forbidden. `tooling/scripts/check-boundaries.mjs` checks the dependency graph and high-value source
invariants on every pull request.

## Data ownership

- D1 stores organizations, memberships, mailboxes, settings, threads, messages, auth/session state,
  attachments metadata, delivery attempts, and idempotency records.
- R2 stores canonical raw `.eml` objects under opaque keys. Raw content and attachment bytes do not
  belong in logs, DTOs, or repository fixtures.
- Repositories own SQL and persistence invariants. HTTP routes translate validated contracts to
  repository/service calls and translate results back to responses.
- Cloudflare bindings enter at a Worker's request or event edge and are passed explicitly.
- Normalized message text and generated HTML share a 1,500,000-byte UTF-8 projection budget. This
  leaves 500,000 bytes below [D1's 2 MB row ceiling](https://developers.cloudflare.com/d1/platform/limits/)
  for identifiers, headers, state, digests, and timestamps; canonical raw MIME remains in R2.

## Request and event flows

Browser reads and mutations travel `web -> API`. Only the API mail client can invoke mail's Service
Binding. Inbound email enters the mail Worker's `email()` export, is durably recorded before optional
forwarding, and updates D1 and R2 through explicit services/repositories. Every hop carries a request
or trace ID without including message content.

Provider delivery is claimed durably before calling Email Sending. A claimed operation is never
blindly retried: interruption or an ambiguous provider result remains `unknown` for manual
confirmation. D1 batches make inbound projection/workflow and outbound
projection/workflow/idempotency finalization all-or-nothing; R2 writes deliberately remain outside
those SQL transactions and retain their own repair/retention path.

## Deployment topology

Staging and production use separate Worker names, D1 databases, R2 buckets, secrets, and Email
Routing targets. Replacement Workers stay on isolated `workers.dev` hostnames before cutover; DNS,
custom-domain routes, and Email Routing changes are not part of repository automation. The aggregate
deploy order is:

1. verify source/generated state and Cloudflare authentication;
2. apply checked-in D1 migrations once;
3. deploy mail, then API, then web;
4. verify versions and health endpoints;
5. run non-destructive smoke tests.

There is currently no GitHub deployment workflow or protected-environment automation. An operator
runs the guarded local scripts with explicit production confirmations. Worker version rollback is
script-assisted; restoring a web custom domain or Email Routing target after an approved cutover is
a separate manual action. Messages captured during the replacement's active window are not
automatically merged into the old store.

## Clean-slate boundary

This repository contains only the replacement implementation. It has no quarantined legacy root,
Waku configuration, npm lockfile, deploy artifact, resource identifier, or mailbox data. The legacy
repository and every deployed legacy Cloudflare resource remain external, read-only references; no
replacement script reads or mutates them.

See [ADR 0001](./adr/0001-stack-and-topology.md) for pinned versions, rationale, and open validation
items.
