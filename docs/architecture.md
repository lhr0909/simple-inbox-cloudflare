# Architecture

Simple Inbox is a pnpm monorepo deployed as one public Cloudflare Worker named `simple-inbox-cf`.
The Worker owns the public HTTP edge, inbound email events, and the scheduled retention event. D1
stores queryable state and a private R2 bucket stores canonical raw messages.

```text
                       +-------------------------------+
browser ---- fetch() ->|                               |----> D1
Email Routing email() ->      simple-inbox-cf          |----> private R2
Compatibility cron ---->                               |----> Email Sending
                       +-------------------------------+
                          web -> API -> mail modules
                               (in process)
```

The web, API, and mail source packages preserve logical ownership, but they are not separately
deployed Workers and use no Service Bindings. The root entry in `apps/web/src/server.ts` exports
`fetch`, `email`, and `scheduled`; `apps/web/src/internal-services.server.ts` constructs the API and
mail bindings and invokes their Hono handlers directly.

## Workspace responsibilities

| Workspace            | Responsibility                                                       | May depend on                       |
| -------------------- | -------------------------------------------------------------------- | ----------------------------------- |
| `apps/web`           | Worker entry, UI/SSR, docs, setup routing, public `/api/v1` bridge   | API, mail, db, contracts, mail-core |
| `packages/api`       | Setup, HTTP contracts, auth, authorization, inbox orchestration      | contracts, db, mail-core            |
| `packages/mail`      | Inbound capture, parsing, threading, forwarding, sending, retention  | contracts, db, mail-core            |
| `packages/contracts` | Stable schemas, DTOs, IDs, errors, and API type surface              | runtime-neutral libraries           |
| `packages/db`        | Drizzle schema, migrations, installation and mailbox repositories    | contracts                           |
| `packages/mail-core` | Runtime-neutral parsing, threading, rendering, encoding, limit rules | contracts                           |

Workspace imports use package exports and `workspace:*`. Source-path imports across package
boundaries remain forbidden, and `packages/tooling/scripts/check-boundaries.mjs` checks the dependency graph
and high-value source invariants.

## Inbox selection

The inbox route loader depends only on mailbox and list filters. Thread selection stays in the URL
but loads through the authenticated thread-detail API independently. Selecting a row immediately
updates its highlight and the conversation pane's loading state; list buttons remain available.
Each detail request has an abort signal and a generation guard, so even an uncancellable late
response cannot replace a newer selection. Detail failures provide a retry without discarding the
list. Expanded unread messages persist their read state by message ID after detail arrives;
unseen messages arriving concurrently remain unread.

The initial server render supplies the mailbox and conversation list. Deep-linked conversation
content loads after hydration, using the same path as subsequent selection and browser history.

## Markdown composition

The browser and mail service share runtime-neutral `mail-core` rendering and presentation helpers.
Compose/reply use a Markdown textarea with formatting actions and Write/Preview/Plain text tabs.
Raw HTML is escaped. The preview is a scriptless sandboxed `srcdoc` frame with a restrictive CSP;
`allow-same-origin` permits local Blob image previews without enabling scripts, forms, or popups.
Object URLs are revoked when files are removed or the composer unmounts. Receiving-email previews
remain opaque-origin sandboxes with only the existing nonce-protected sizing helper.

Uploads return their future download URL only to the authenticated sender. Body references use
`attachment:<upload-id>`; delivery resolves them only against the current send's verified, owned
`linkedAttachmentIds`. Missing or non-image references fail before the send claim and provider call.
Plain text removes formatting while retaining descriptive link labels and actual download URLs.
Both body variants retain attachment download cards. Generated HTML uses a minimal inline font style.

`GET /api/v1/downloads/{token}?inline=1` streams only allowlisted raster image MIME types. It uses the
same sent/sending/unknown association and object integrity checks as ordinary downloads. Other
files, including SVG and HTML, cannot use inline mode. Inline responses include `nosniff`, a scriptless
sandbox CSP, and cross-origin resource permission so recipient email clients can display images.
Ordinary download links retain attachment disposition. No upload is published by previewing it.

Received HTML documents receive zero-specificity font, padding, line-height, image, and quote defaults
before sender CSS, preserving sender styles. Stored MIME and owner-forward HTML remain unchanged.

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
The endpoint rechecks authentication, mailbox membership, the setting (or explicit `preview=1`
for a one-off message preview), and raw retention before
reading R2. Existing retained messages work without backfilling D1. Previews are capped at 4 MB;
missing, oversized, or unavailable HTML falls back to the existing plain-text projection.

The API normalizes full HTML documents before sanitizing active markup, preserving root/body
styles, stylesheet selectors, link/button presentation, email tables, HTTPS images, and raster CID
images. Low-specificity preview defaults precede sender styles so they do not override email layouts. A response CSP and an iframe sandbox both enforce an opaque origin. Only a fixed, nonced
resize/status helper can run; email scripts, forms, embedded frames, external stylesheets, and fonts
are blocked. Links open separately with no opener or referrer. The parent accepts sizing/status
messages only from that exact iframe window and its opaque origin. The web bridge preserves this
restricted policy for the HTML endpoint; the privileged app keeps its original CSP and frame denial.
Remote images may disclose opens, and the setting explains this before opt-in.

## Sent-mail copies and external threading

`mailboxes.forward_sent` / `forwardSent` defaults true. The mailbox settings API and UI expose it
independently of HTML forwarding. Migration `0008_copy_sent_mail.sql` enables the preference on
existing mailboxes without changing forwarding destinations, visibility, or retained messages.

Compose/reply deliveries add the effective forwarding destination as Bcc when enabled, unless it
is already a recipient or equals the sending mailbox. Hidden mailboxes have no effective forwarding
destination. The private copy shares the same provider call, body, attachment links, Message-ID,
and durable delivery claim. Recipient limits include the copy. A provider exception remains
ambiguous for the whole send and is never automatically retried. D1 records the effective Bcc
recipient; canonical MIME omits Bcc headers. Reply-alias relays and authentication mail are unaffected.

Inbound forwards now carry bounded `In-Reply-To` and `References` headers. Webmail replies keep the
customer's original parent ID and include the owner's forwarded-copy ID in References when copying
is enabled, connecting both histories despite Cloudflare generating a new ID for each forward.
References are capped at Cloudflare's 2,048-byte header limit. Grouping remains the receiving email
client's decision; stored messages and already delivered copies are not rewritten.

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
recipient delivered to the Worker is captured, regardless of whether its domain matches the primary
domain chosen during setup. Newly discovered recipients get an owner-scoped mailbox with
`whitelisted = false` and no forwarding destination. They are grouped under **Other inbound** and
excluded from the daily mailbox dropdown. Forwarding failure never erases captured mail.

## Alias policy, message organization, and spam

The primary mailbox starts whitelisted. `POST /v1/mailboxes` creates or promotes an alias on the
configured domain or another already-received mailbox domain. Existing mailbox IDs and thread
relationships survive promotion. Creation accepts an explicit forwarding destination or null to disable forwarding. Enabling forwarding applies to future mail; previously suppressed
messages remain `not_applicable` and are never replayed as forwards. Hiding an inbox disables its
effective forwarding while retaining its destination preference for later reactivation.

Messages own inbox membership, `readAt`, `starredAt`, `spamAt`, `spamReason`, and `trashedAt`.
Threads aggregate these into overlapping views. Sent means at least one successfully sent outbound
message outside Spam/Trash, irrespective of the most recent direction or archive state. All Mail
includes archived mail and excludes Spam/Trash. Folder counts use the same predicates as list/search.
Opening any folder result retrieves the whole authorized conversation, including clearly marked
Spam/Trash messages. Collapsed messages do not load HTML or become read until expanded; read
mutations carry the exact displayed message IDs. Sending never marks incoming messages read.

Thread state mutations update message rows and aggregates in one D1 batch. Trash restore preserves
prior inbox/archive membership and any spam classification. New inbound replies retain existing
threading rules and get their own state; they do not restore old trashed messages. Organization is
shared mailbox state, as read state was before this change. Legacy workflow columns remain only for
migration/older-code compatibility and are absent from public DTOs and the UI.

`spam_rules` stores owner-scoped explicit recipient-address, sender-address, and sender-domain
blacklists. Recipient matching uses the envelope recipient; sender matching uses the parsed From
address. Domain matches include subdomains with a dot boundary. Rules apply to future messages,
and the persisted decision is part of the inbound D1 transaction before forwarding. The forwarding
path rechecks current rules before claiming delivery; the claim also requires a whitelisted mailbox,
a destination, and a message outside Spam/Trash. Issued owner reply aliases resolve before ordinary
recipient filtering. The Spam confirmation first saves an explicit sender/domain rule, then moves the conversation;
a failed second step reports that the rule was saved and allows an idempotent retry. Block mailbox in mailbox settings only saves a recipient rule; it never changes existing message state.
Mailbox summaries and settings derive `blocked` from the actor’s recipient rules. Blocked mailboxes are excluded from the dropdown and included in Other inbound listing, search, and counts, even when whitelisted. Removing a rule restores the prior visibility preference. No backfill is needed for existing rules. Manual Not spam
restores a message without deleting its blacklist rule or forwarding historical mail. General settings
owns the shared blacklist and browser theme; mailbox settings owns alias and forwarding preferences. There are no keyword rules, AI calls, or new Cloudflare resources.

Mail and attachments have no automatic expiration. Spam and Trash remain recoverable until an
owner explicitly removes stored data; moving a message there does not start a deletion timer.

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

The `scheduled()` handler is a no-op even if an old cron is invoked. Historical retention fields
and tombstones remain for compatibility but never schedule or resume deletion. Existing R2 object
expiration rules must be disabled separately by the owner; code cannot override bucket lifecycle.

## Linked attachments

Authenticated senders initiate multipart uploads in the private `simple-inbox-cf-storage`
bucket. D1 owns filenames, expected sizes, object keys, multipart IDs, completion ETags, random
256-bit download capabilities, and the outbound send association. Each part streams through a same-origin
Worker PUT endpoint into the R2 binding. Every part requires send authorization, ownership, and
same-origin checks for cookie sessions. Production and local tests share this path; no R2 S3
credentials, browser-to-R2 requests, or bucket CORS policy are needed.

The completion endpoint checks ordered parts and actual object size, then stores the immutable
completed object's ETag. Completed uploads reject further parts, and R2 closes the multipart session. A lost completion
response can be retried by inspecting the final object. Send checks owner, readiness, size, and ETag,
then appends escaped filenames, sizes, and stable application links to HTML and plain text. Linked
bytes never pass through Email Sending or become MIME attachments in canonical outbound mail.

Upload IDs participate in the existing idempotency digest. Each completed file belongs to one
outbound send; binding occurs after claiming delivery and before contacting the provider. Sent
and ambiguous deliveries retain their links. Attachment metadata appears in Sent and downloads
stream from R2, including byte ranges. The normal authenticated attachment route still enforces
ownership; the public download route checks an unguessable capability without requiring a session.
Download tokens are redacted from request logs; responses use attachment disposition, no-store,
no-referrer, and nosniff. Links have no time limit. Removing a file from a draft only detaches it;
completed orphan uploads and unfinished multipart uploads are retained for owner-controlled cleanup.
Disable all R2 lifecycle rules, including the default incomplete-multipart abort rule. No application
path automatically deletes duplicate or unprojected raw objects or aborts stored multipart sessions.

There are no product file-size/count quotas. Multipart part sizing respects R2's 10,000-part
constraint; each chunk is also subject to Cloudflare's per-request upload limit. Provider message-body and D1 projection limits still apply to generated link text.

## Deployment topology

The root `wrangler.jsonc` declares `simple-inbox-cf`, `simple-inbox-cf-db`,
`simple-inbox-cf-storage`, `EMAIL`, and `AUTH_RATE_LIMIT`; cron is disabled. Wrangler provisions
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
