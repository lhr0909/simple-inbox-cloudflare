# Architecture

Simple Inbox is a pnpm monorepo deployed as one public Cloudflare Worker named `simple-inbox-cf`.
The Worker owns the public HTTP edge, inbound email events, and the scheduled retention event. D1
stores queryable state and a private R2 bucket stores canonical raw messages.

```text
                       +-------------------------------+
browser ---- fetch() ->|                               |----> D1
Email Routing email() ->      simple-inbox-cf          |----> private R2
Cloudflare Cron -------->                               |----> Email Sending
                       +-------------------------------+
                          web -> API -> mail modules
                               (in process)
```

The web, API, and mail source packages preserve logical ownership, but they are not separately
deployed Workers and use no Service Bindings. The root entry in `apps/web/src/server.ts` exports
`fetch`, `email`, and `scheduled`; `apps/web/src/internal-services.server.ts` constructs the API and
mail bindings and invokes their Hono handlers directly.

## Workspace responsibilities

| Workspace            | Responsibility                                                       | May depend on             |
| -------------------- | -------------------------------------------------------------------- | ------------------------- |
| `apps/web`           | Worker entry, UI/SSR, docs, setup routing, public `/api/v1` bridge   | API, mail, db, contracts  |
| `workers/api`        | Setup, HTTP contracts, auth, authorization, inbox orchestration      | contracts, db, mail-core  |
| `workers/mail`       | Inbound capture, parsing, threading, forwarding, sending, retention  | contracts, db, mail-core  |
| `packages/contracts` | Stable schemas, DTOs, IDs, errors, and API type surface              | runtime-neutral libraries |
| `packages/db`        | Drizzle schema, migrations, installation and mailbox repositories    | contracts                 |
| `packages/mail-core` | Runtime-neutral parsing, threading, rendering, encoding, limit rules | contracts                 |

Workspace imports use package exports and `workspace:*`. Source-path imports across package
boundaries remain forbidden, and `tooling/scripts/check-boundaries.mjs` checks the dependency graph
and high-value source invariants.

## Public and private surfaces

The root Worker's `fetch()` handler is the only HTTP entry point. TanStack Start serves pages and
the root router maps `/api/v1/*` into the API package with a narrow request-header allowlist. The API
continues to authenticate sessions or bearer tokens, enforce CSRF and scopes, validate contracts,
and scope every resource lookup.

The API's calls into mail use an in-memory `Fetcher` adapter. It accepts only the fixed
`https://mail.internal/internal/*` origin/path combination and invokes the mail Hono app with
constructed bindings. Those internal mail routes are never mapped into the root public router, so
requests such as `/internal/v1/send` return 404 at the public edge.

Sharing one physical Worker means D1, R2, and Email Sending bindings exist in one isolate. The
logical module boundaries, narrow adapters, authorization checks, and static dependency checks—not
a network hop—enforce least privilege within the application.

## First-run installation gate

The checked-in migrations create a singleton `installations` record schema. Before that record and
its exact owner/mailbox relationship exist:

- `/setup`, health, capabilities, and OpenAPI remain reachable;
- other API routes return a private `503 service_unavailable` response;
- inbound email is rejected with a setup-incomplete response;
- scheduled retention exits without changing data;
- UI navigation redirects to `/setup`.

The setup mutation requires HTTPS (except local loopback), an exact same-origin request, the
Cloudflare rate-limit binding, and `SETUP_TOKEN`. The configured secret must contain at least 32
bytes; it is compared by digest and is never persisted, returned, or logged.

One D1 batch creates the normalized owner, primary mailbox, owner membership, and singleton
installation settings. D1 batches are transactional, so the installation becomes complete as one
unit. Repeating the exact setup is idempotent; different settings or partial pre-existing ownership
state fail closed. The public request origin is stored as the application's canonical origin.

## Data ownership

- D1 stores the installation record, users, memberships, mailboxes, settings, threads, messages,
  auth/session state, attachment metadata, delivery attempts, idempotency records, and retention
  tombstones.
- R2 stores canonical `.eml` objects under opaque keys. Raw content and attachment bytes do not
  belong in logs, DTOs, or repository fixtures.
- Repositories own SQL and persistence invariants. Routes and mail services receive bindings
  explicitly even though they execute within one Worker.
- Normalized message text and generated HTML share a 1,500,000-byte UTF-8 projection budget,
  leaving headroom below D1's 2 MB row limit; canonical MIME remains in R2.

## Request and event flows

Browser reads and mutations stay same-origin: root `fetch` -> API app -> scoped repository or
private mail adapter. Request IDs are regenerated at the public-to-API boundary and carried through
safe structured application logs without message content.

Inbound email enters the root `email()` export. After the installation gate, the mail service writes
the canonical raw object to R2, parses and projects it into D1, associates it with a thread, and then
optionally forwards it. Forwarding failure never erases captured mail.

Outbound delivery is claimed durably before Email Sending is invoked. A claimed operation is never
blindly retried: interruption or an ambiguous provider result remains `unknown` for manual
confirmation. D1 batches make projections and idempotency finalization all-or-nothing; R2 writes
remain outside SQL transactions and retain their own repair and lifecycle path.

The daily `scheduled()` handler advances bounded retention work. It deletes raw R2 bytes first,
treats an already-missing object as success, then transactionally removes expired D1 projections and
repairs or deletes their threads. The retention handler never invokes Email Sending.

## Deployment topology

The root `wrangler.jsonc` declares `simple-inbox-cf`, `simple-inbox-cf-db`,
`simple-inbox-cf-raw`, `EMAIL`, `AUTH_RATE_LIMIT`, and the `17 3 * * *` cron. Wrangler provisions
the declared D1 database and R2 bucket when needed; no account-specific resource IDs are committed.

`vp run deploy` builds the TanStack Start Worker, applies checked-in remote D1 migrations, and
deploys `apps/web/dist/server/wrangler.json`. Email domain verification, R2 lifecycle configuration,
custom domains, and Email Routing activation remain manual owner actions in the Cloudflare
Dashboard.

## Clean-slate boundary

The repository neither discovers nor mutates legacy Workers, D1 databases, R2 buckets, routes,
domains, or Email Routing rules. It imports no legacy data. Any decision to direct an existing domain
or mail route to `simple-inbox-cf` is a separate, explicitly approved owner action, and rollback of
that routing remains manual.

See [ADR 0001](./adr/0001-stack-and-topology.md) for the topology decision and tradeoffs.
