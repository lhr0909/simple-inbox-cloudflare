# Security policy

## Supported versions

Simple Inbox is pre-1.0 software. Security fixes are made only on the current `main` branch and the
currently deployed production version once one exists. Old commits, forks, previews, and abandoned
self-hosted deployments are not supported.

## Reporting a vulnerability

Do not open a public issue or discussion for a suspected vulnerability. Use GitHub's private
vulnerability reporting flow from the repository's **Security** tab. If that option is unavailable,
ask a maintainer for a private contact channel without including exploit details in the request.

Include, when safe:

- the affected commit or deployed Worker version;
- impact and prerequisites;
- minimal reproduction steps using synthetic `example.test` data;
- relevant request IDs with secrets and message content removed;
- any mitigation already attempted.

Do not access another person's mailbox, retain raw email, degrade the service, or exfiltrate data
while researching. We aim to acknowledge reports within three business days, agree on disclosure
after triage, and credit reporters who request attribution.

## Secrets and sensitive data

The repository must never contain Cloudflare tokens, private account identifiers, real owner/mailbox
addresses, setup tokens, magic-link URLs, session values, raw `.eml` files, message bodies, recipient
lists, R2 keys, or customer attachments. Use root `.dev.vars` only for local values and Cloudflare
secret bindings for deployed values. Examples and fixtures must use synthetic `example.test`
identities.

Every deployment requires two independent values of at least 32 random bytes:

- `AUTH_TOKEN_PEPPER` keys magic-link, session, and API-token digests. Rotating it invalidates all
  outstanding values protected by the old pepper.
- `SETUP_TOKEN` authorizes first-run installation. It is compared by digest and is never stored in
  D1, returned, or logged. It must never equal or derive from `AUTH_TOKEN_PEPPER`.

If either secret reaches source control, shell history, logs, evidence, or another unauthorized
location, rotate it immediately. Removing a later line from Git does not revoke an exposed value.

Pull requests run secret scanning, dependency review, and a moderate-or-higher production dependency
audit. Organization-owned repositories must configure the `GITLEAKS_LICENSE` Actions secret used by
the pinned scanner; personal repositories do not require it. Reviewed historical test/documentation
false positives are recorded in `.gitleaksignore` by exact commit, path, rule, and line; do not
exclude whole files or rules to silence findings. GitHub secret scanning and push protection are
also enabled for this public repository.

## Single-Worker trust boundaries

`simple-inbox-cf` exports public `fetch()`, Email Routing `email()`, and retention `scheduled()`
handlers in one isolate. D1, R2, Email Sending, and rate-limit bindings therefore share one physical
Worker. Security depends on explicit application boundaries:

- The root router exposes pages and `/api/v1/*`; it never maps the mail Hono app's `/internal/*`
  routes to a public URL.
- The API owns authentication, CSRF, scopes, mailbox authorization, response contracts, and all
  browser-facing data access.
- An in-process fetch adapter accepts only the fixed private mail origin/path and receives actor,
  mailbox, scope, request-ID, and idempotency context constructed by the authenticated API.
- Repositories own D1 access invariants. Raw and attachment responses authorize against D1 metadata
  before reading R2.
- `packages/tooling/scripts/check-boundaries.mjs`, unit tests, and the single-Worker integration harness check
  the static and runtime parts of these boundaries.

The lack of a Service Binding hop must not be treated as permission to bypass API authorization or
call mail services directly from browser routes.

## First-run setup boundary

Before setup completes, protected APIs return unavailable, inbound email is rejected, scheduled
retention is idle, and UI navigation goes to `/setup`. Setup status is public; setup mutation is
protected by:

- a configured `SETUP_TOKEN` of at least 32 bytes;
- digest-based constant-time comparison;
- Cloudflare rate limiting by source;
- an exact same-origin browser request;
- HTTPS, except for local loopback development;
- one atomic D1 batch that creates the owner, mailbox, sole owner membership, and installation row.

Exact replay is idempotent. Conflicting or partial pre-existing installation state fails closed and
must be recovered from a known-good D1 backup rather than repaired ad hoc.

Setup stores the verified request origin as the canonical app origin. Attach an intended custom
domain before setup, or continue using the `workers.dev` origin; silently changing origins later can
break magic links, Secure cookies, and same-origin checks.

## Mail and storage privacy

Treat all email content and metadata as hostile and sensitive:

- Keep `simple-inbox-cf-raw` private with no `r2.dev` URL or custom domain.
- Store raw RFC 822 messages under opaque keys and never put raw bytes in D1 DTOs or logs.
- Sanitize filenames and media types and serve downloads with `X-Content-Type-Options: nosniff` and
  private no-store caching.
- Keep structured application logs enabled but provider invocation logs and automatic traces
  disabled; provider metadata can include full token-bearing URLs, searches, and recipients.
- Keep HTML previews isolated from the privileged app. Both HTML preferences default off. Opted-in
  display uses sanitization, an opaque-origin iframe, and a response CSP that permits only a fixed,
  nonced resize/status helper. Sender scripts, forms, and embedded frames cannot execute.
- HTML display may load HTTPS remote images, which can disclose opens. The mailbox setting explains
  this. Full-HTML forwarding is independent and delegates display protection to the recipient's client.
- Use opaque reply aliases that reveal neither a destination address nor database identifier.

The application performs no AI inference and sends no mailbox content, MIME, metadata, or
attachments to an AI service.

## Operational safeguards

- `vp run deploy:first` and `vp run deploy` are immediately remote and state-changing. Confirm the
  Wrangler account and complete local verification before running either one.
- Wrangler automatically provisions only the declared new D1/R2 resources. Email Sending domains,
  R2 lifecycle, custom domains, and Email Routing are manual owner actions.
- Repository automation never reads or mutates legacy resources and never cuts over a route.
- Use a separate test mail domain and allowlisted owner-controlled recipients for live validation.
- Back up and test D1 restoration before destructive migrations or shorter retention policies.
- Worker rollback does not undo D1 migrations or restore deleted D1/R2 data.
