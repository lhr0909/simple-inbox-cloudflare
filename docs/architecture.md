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
| `packages/api`       | Setup, HTTP contracts, auth, authorization, inbox orchestration      | contracts, db, mail-core  |
| `packages/mail`      | Inbound capture, parsing, threading, forwarding, sending, retention  | contracts, db, mail-core  |
| `packages/contracts` | Stable schemas, DTOs, IDs, errors, and API type surface              | runtime-neutral libraries |
| `packages/db`        | Drizzle schema, migrations, installation and mailbox repositories    | contracts                 |
| `packages/mail-core` | Runtime-neutral parsing, threading, rendering, encoding, limit rules | contracts                 |

Workspace imports use package exports and `workspace:*`. Source-path imports across package
boundaries remain forbidden, and `packages/tooling/scripts/check-boundaries.mjs` checks the dependency graph
and high-value source invariants.

## Inbox selection

The inbox route loader depends only on mailbox and list filters. Thread selection stays in the URL
but loads through the authenticated thread-detail API independently. Selecting a row immediately
updates its highlight and the conversation pane's loading state; list buttons remain available.
Each detail request has an abort signal and a generation guard, so even an uncancellable late
response cannot replace a newer selection. Detail failures provide a retry without discarding the
list. Read-state updates remain optimistic and happen after the selected detail arrives.

The initial server render supplies the mailbox and conversation list. Deep-linked conversation
content loads after hydration, using the same path as subsequent selection and browser history.

## HTML preferences

Each mailbox has independent `forwardHtml` and `renderHtml` preferences. Forwarding defaults on; inbox HTML
display defaults off. Migration `0003_default_html_forwarding.sql` enables forwarding for all existing
mailboxes, including ones previously disabled, while preserving display preferences and related mail.
Owners can opt out again after upgrading.
Only a mailbox owner with settings permission can change them through the existing settings API.

Inbound parsing keeps the original HTML transiently for opted-in forwarding. D1 continues to store
bounded, inert text-based projections, and R2 retains the immutable original MIME. Forwarding uses
original HTML only when `forwardHtml` is enabled; sender identity, reply aliases, attachment handling,
and provider-size fallbacks continue to apply. Changes affect future forwarding, not copies already sent.

When `renderHtml` is enabled, visible messages load `/api/v1/messages/{messageId}/html` in lazy iframes.
The endpoint rechecks authentication, mailbox membership, the setting, and raw retention before
reading R2. Existing retained messages work without backfilling D1. Previews are capped at 4 MB;
missing, oversized, or unavailable HTML falls back to the existing plain-text projection.

The API sanitizes active markup while preserving email tables, styles, HTTPS images, and raster CID
images. A response CSP and an iframe sandbox both enforce an opaque origin. Only a fixed, nonced
resize/status helper can run; email scripts, forms, embedded frames, external stylesheets, and fonts
are blocked. Links open separately with no opener or referrer. The parent accepts sizing/status
messages only from that exact iframe window and its opaque origin. The web bridge preserves this
restricted policy for the HTML endpoint; the privileged app keeps its original CSP and frame denial.
Remote images may disclose opens, and the setting explains this before opt-in.

## Test ownership

`apps/web/tests/e2e` owns responsive Playwright flows; `apps/web/tests/integration` owns isolated
single-Worker integration tests. Both use `packages/test-harness`. Unit tests remain with their
owning packages. Package-local `vite.config.ts` files hold test settings, and the root config lists
unit-test projects without activating the web application's build/dev plugins during Node tests.
Repository policy and generated-artifact checks live in `packages/tooling/scripts`.

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
optionally forwards it. Cloudflare Email Routing is the inbound trust boundary: every valid envelope
recipient delivered to the Worker is accepted and auto-provisioned as an owner mailbox, regardless
of whether its domain matches the primary domain chosen during setup. Forwarding failure never
erases captured mail.

Each forwarded message uses the assigned mailbox as its sender and an opaque, same-domain reply
alias as `Reply-To`. A reply from the configured owner resolves that alias in D1, is sent from the
assigned mailbox with the original thread headers, and is projected back into the same D1 thread.
Catch-all routing delivers both ordinary mailbox addresses and these aliases without requiring
plus-addressing rules. The parser continues to recognize the former `reply+<token>` form so an
upgrade does not strand aliases previously issued by this application.

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
