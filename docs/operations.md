# Operations runbook

This runbook deploys a clean-slate replacement. The currently deployed legacy Cloudflare Inbox and
its D1/R2 data remain untouched. No command in this repository switches DNS, custom-domain routes,
or Email Routing; cutover is a separate, manual approval step.

## Safety model

The only accepted remote resource names are:

| Environment | Mail Worker                       | API Worker                       | Web Worker                       | D1                              | Private R2                       |
| ----------- | --------------------------------- | -------------------------------- | -------------------------------- | ------------------------------- | -------------------------------- |
| staging     | `simple-inbox-cf-staging-mail`    | `simple-inbox-cf-staging-api`    | `simple-inbox-cf-staging-web`    | `simple-inbox-cf-staging-db`    | `simple-inbox-cf-staging-raw`    |
| production  | `simple-inbox-cf-production-mail` | `simple-inbox-cf-production-api` | `simple-inbox-cf-production-web` | `simple-inbox-cf-production-db` | `simple-inbox-cf-production-raw` |

Operator scripts reject local placeholders, missing environment sections, ambiguous names, route
entries, mismatched Service Bindings, reused resource IDs supplied through the legacy guard
variables, committed `example.test`/zero/rate-limit placeholders, and unauthenticated accounts.
Every confirmed migration, bootstrap, aggregate deploy, and scoped Worker deploy requires all five
resource guard variables below. Record exact legacy values outside this repository and export them
before the command. If the legacy deployment used one Worker for multiple roles, repeat that exact
Worker name in each role variable; do not leave a variable empty:

```sh
export CLOUDFLARE_INBOX_LEGACY_D1_DATABASE_ID='<legacy D1 UUID>'
export CLOUDFLARE_INBOX_LEGACY_R2_BUCKET='<legacy bucket name>'
export CLOUDFLARE_INBOX_LEGACY_WEB_WORKER='<legacy Worker name>'
export CLOUDFLARE_INBOX_LEGACY_API_WORKER='<legacy Worker name; repeat web value if shared>'
export CLOUDFLARE_INBOX_LEGACY_MAIL_WORKER='<legacy Worker name; repeat web value if shared>'
```

The state-changing command first compares those guards to the replacement plan, verifies the
explicit account, lists D1 remotely and requires the configured UUID and replacement name to map to
each other exactly, resolves the private R2 bucket by its exact replacement name, and queries each
exact replacement Worker name. A Worker may be confirmed absent before its first deployment; any
other resolution or permission failure stops the command. These read-only identity checks complete
before the first remote mutation.

The origin and host guards are also used by replacement smoke and cutover checks:

```sh
export CLOUDFLARE_INBOX_LEGACY_APP_ORIGIN='<legacy HTTPS origin>'
export CLOUDFLARE_INBOX_LEGACY_HOSTS='<legacy host>,<any other legacy host>'
```

Never put API tokens, auth peppers, message bodies, raw MIME, attachment bytes, or live-smoke
evidence in the repository.

## Local and CI verification

Use the pinned Node, pnpm, and Vite+ versions from the root manifest. Deterministic verification is
local-only and uses synthetic mail:

```sh
vp install --frozen-lockfile
vp run check:generated
vp run check
vp test
vp run build
vp run test:integration
vp exec playwright install chromium
vp run test:e2e
```

The integration harness runs the production web, API, and mail builds in Wrangler's local test
harness with isolated D1/R2. Email Sending is simulated; it never calls a delivery network. The
Playwright suite uses the same web -> API -> mail Service Binding topology at desktop, tablet, and
mobile widths. CI must build before invoking either harness. `check:generated` regenerates routes,
binding types, OpenAPI, and the complete Drizzle migration tree inside an isolated temporary copy;
it never rewrites the source checkout while deciding whether generated files are stale.

## Provision a replacement environment

Prerequisites:

- a Cloudflare account with Workers, D1, R2, Email Routing, Email Sending, and Service Bindings;
- a separate test mail domain/subdomain and HTTPS hostname for staging;
- an API token or Wrangler login with only the permissions required for the target account;
- verified sender domain and allowlisted smoke destination;
- the legacy route, Email Routing target, D1 ID, R2 bucket, and Worker versions recorded separately.

Select the target account explicitly:

```sh
export CLOUDFLARE_ACCOUNT_ID='<32-character account ID>'
```

First print a non-mutating plan:

```sh
vp run provision -- --env staging
```

After checking the account and replacement names, create only missing D1/R2 resources:

```sh
vp run provision -- --env staging --apply --confirm-provision --location apac
```

The command is idempotent and does not edit Wrangler configuration. Copy the emitted D1 UUID into
the explicit `env.staging` sections for API and mail. Configure the private R2 bucket in both. Do
not enable an `r2.dev` URL or R2 custom domain.

For production, repeat with `--env production --confirm-production`. Staging and production must
have different D1 IDs and R2 bucket names.

### Dashboard-only setup

1. Onboard the replacement sending domain in Email Service and verify its SPF/DKIM records.
2. Verify only owner-controlled/allowlisted smoke destinations.
3. Bind `EMAIL` to the replacement mail Worker; keep arbitrary-recipient sending disabled until
   provider and abuse controls have been reviewed.
4. Configure the mail Worker's `email()` handler on a staging-only Email Routing rule or catch-all.
   Do not modify the legacy rule.
5. Configure `MAIL` from replacement API to replacement mail, and `API` from replacement web to
   replacement API.
6. Create a distinct rate-limit namespace for replacement API magic-link endpoints.
7. Keep the replacement web Worker's `workers.dev` hostname and TLS enabled through pre-cutover
   acceptance. Wrangler environment sections used by automated deploys must not contain route
   entries.
8. Set `APP_ORIGIN` to that exact replacement `workers.dev` origin during pre-cutover testing. Set
   `MAIL_DOMAIN`, `OWNER_EMAIL`, `ENVIRONMENT`, and retention values independently for each
   environment. Every committed `example.test`, zero ID, and `2001`/`3001` value is a deliberate
   fail-closed placeholder and must be replaced.
9. Upload the API `AUTH_TOKEN_PEPPER` secret (at least 32 random bytes) independently in staging and
   production. Never reuse the legacy secret.
10. Keep custom structured logs enabled, but keep Workers Logs invocation logs and automatic traces
    disabled. Provider-generated invocation metadata includes full Fetch URLs and Email recipients,
    which could persist magic-link query tokens, search terms, and envelope addresses even when the
    application logger is content-safe. Review any future trace configuration as a privacy change.
11. Configure a private R2 lifecycle rule on the replacement raw bucket to expire objects after the
    approved `RAW_EMAIL_RETENTION_DAYS` plus a short grace such as two days. The application cron is
    authoritative and should normally delete first; this manually configured lifecycle is only a
    delayed backstop for an orphan created if execution stops between the R2-first write and its D1
    projection. Do not let provisioning scripts silently add or alter this account-level rule.

## Migrations and bootstrap

Generate migrations during development only, review the SQL, and commit it. Never generate a
migration during a remote deploy.

For a new environment:

```sh
vp run check:generated
vp run db:migrate -- --env staging --dry-run
vp run db:migrate -- --env staging --confirm-migrate
vp run bootstrap -- --env staging --dry-run
vp run bootstrap -- --env staging
```

The migration wrapper always uses the checked-in API Wrangler source config with the explicit
environment, `--remote`, and D1 binding `DB`; it is a direct Wrangler command and cannot be skipped
by the task cache. Production also requires `--confirm-production`.

Migration order is schema first, then bootstrap, then Workers. Bootstrap inserts the normalized
owner, default `inbox@MAIL_DOMAIN` mailbox, and owner membership with deterministic UUIDv7-shaped
IDs. It is idempotent only when the normalized addresses resolve to those exact IDs and that mailbox
has exactly one owner: the intended user. A mismatched address/ID, a deterministic ID already used
for another address, an existing non-owner membership for the intended user, or any different owner
aborts the transaction without modifying the bootstrap records. Post-write verification repeats the
exact-ID and total-owner checks. Wrangler executes the uploaded D1 SQL file atomically; the file
intentionally contains no explicit `BEGIN`/`COMMIT`, which remote D1 imports reject. Override
addresses only with reviewed normalized values:

```sh
vp run bootstrap -- --env staging \
  --owner-email owner@example.com \
  --mailbox-address inbox@mail.example.com
```

Before any future destructive/contract migration, back up D1, test restoration in staging, and use
expand/backfill/contract. Apply migrations once; do not race API and mail deployment jobs.

## Retention, export, and deletion recovery

The checked-in `365` values for `RAW_EMAIL_RETENTION_DAYS` and
`APPLICATION_RECORD_RETENTION_DAYS` are deliberate pre-launch placeholders. They are not a legal,
privacy, or business retention decision. Before provisioning either environment, the owner must
approve both values, document the rationale, and confirm that raw-email retention is less than or
equal to application-record retention. Both values must be integer days from 1 through 3,650.
`RETENTION_BATCH_SIZE` must be from 1 through 100; the committed value is `100`.

The mail Worker's reviewed daily cron (`17 3 * * *`) advances a durable, bounded workflow:

1. enqueue eligible messages using trusted local creation time and snapshot both policy deadlines;
2. delete the private R2 raw object first (an already-missing object counts as success);
3. transactionally remove the message's D1 children and projection;
4. repair the thread aggregates, or delete the empty thread;
5. retain a content-free tombstone as operational evidence.

The job never calls Email Sending and is not a delivery retry mechanism. Failed work remains in
`retention_tombstones`; expired leases make it retryable, and repeated R2 deletion is safe. Inspect
only state and safe operational columns when investigating a partial run:

```sql
SELECT id, state, attempt_count, raw_delete_after, application_delete_after,
       raw_deleted_at, application_deleted_at, last_error_code, last_failed_at,
       claim_expires_at, completed_at
FROM retention_tombstones
WHERE state <> 'completed' OR last_error_code IS NOT NULL
ORDER BY updated_at DESC;
```

Do not copy `raw_r2_key`, mailbox/message/thread IDs, or message content into tickets or routine
logs. Review `mail.retention.started`, `mail.retention.item`, and `mail.retention.finished` by request
ID and safe outcome/code. Provider invocation logs and automatic traces remain disabled because
their request metadata can contain full URLs or recipients. A completed tombstone contains opaque
IDs, timestamps, the object key, and safe failure history, but no body, address, subject, recipient,
or attachment metadata.

Retention deletion is irreversible at the application layer and Worker rollback does not restore
purged D1/R2 data. Before shortening a window or manually deleting anything, pause the policy
change, create and test a replacement-environment D1 backup/restore, and export required raw
messages and attachments through the per-message owner-authorized raw and attachment endpoints to
encrypted storage with its own approved lifecycle. There is no bulk export command yet. Record
counts and digests without committing content. Restore the previous policy/configuration if
validation fails; restore data from the tested export/backup rather than expecting a code rollback
to recreate it.

Search/list/detail bodies are bounded normalized projections and may be truncated; immutable raw is
the fidelity source until its raw-retention deletion. HTML-only mail is converted to safe plain text,
with scripts, styles, and remote-image behavior removed from projections. Export the authorized raw
message when exact historical fidelity is required.

Owner forwarding occurs only after durable capture. The reconstructed forward contains sender,
mailbox recipient, subject, safe text and sanitized HTML projections, and only eligible attachments;
its `Reply-To` is an opaque alias for the source mailbox/thread. Forwarding failures never erase the
captured message. This application performs no AI inference and sends no mailbox content, raw MIME,
metadata, or attachments to an AI service.

## Bearer API tokens

Bearer tokens are optional, owner-scoped credentials for concrete non-browser clients. Grant the
smallest combination of `read`, `send`, and `settings`. Creation requires the exact deployed
`AUTH_TOKEN_PEPPER` from secure operator storage so the command can persist the same HMAC digest the
API verifies:

```sh
# Inject CLOUDFLARE_INBOX_AUTH_TOKEN_PEPPER from the secret manager without echo or shell history.

vp run api-token:create -- \
  --env staging \
  --owner-email owner@example.com \
  --name 'read-only export' \
  --scope read \
  --expires-at '2026-09-01T00:00:00Z'
```

The remote `AUTH_TOKEN_PEPPER` secret must already exist. The command writes only the digest to D1,
verifies the record, and then prints the plaintext token exactly once. Move it immediately into the
intended client's secret manager; it cannot be recovered or listed. Do not put it in shell history,
evidence, logs, issue trackers, or configuration files. Unset the local pepper after use.

List metadata (never plaintext or digests):

```sh
vp run api-token:list -- \
  --env staging \
  --owner-email owner@example.com
```

Revoke by the UUIDv7 token ID. Revocation is idempotent and cannot target another owner:

```sh
vp run api-token:revoke -- \
  --env staging \
  --owner-email owner@example.com \
  --token-id '<token UUIDv7>' \
  --confirm-revoke
```

Production token operations additionally require `--confirm-production`. Verify a new token against
the replacement origin with its narrowest allowed request, then revoke it immediately if the pepper,
owner, scopes, or environment was wrong.

## Deploy and verify replacement Workers

The aggregate deploy requires a clean generated workspace, valid replacement configuration,
account access, and the API secret. It never guesses or probes `APP_ORIGIN`. Export the exact
replacement `workers.dev` origin; its first hostname label must equal the reviewed replacement web
Worker name:

```sh
export SMOKE_BASE_URL='https://simple-inbox-cf-staging-web.<account-subdomain>.workers.dev'
```

`APP_ORIGIN` must be configured to this same origin before pre-cutover deployment so magic links,
cookie origin checks, and live smoke stay on the replacement. Declared legacy hosts are rejected. A
dry run performs no account call or mutation:

```sh
vp run deploy -- --env staging --dry-run
```

The real command runs checks, unit tests, production builds, the multi-Worker and Playwright
harnesses, D1 migrations, strict idempotent bootstrap, then deploys mail -> API -> web. For local
harness builds it explicitly clears `CLOUDFLARE_ENV`. It then runs a fresh, direct `vp build` from
each package directory with `CLOUDFLARE_ENV` set to the reviewed target. Before any mutation it
requires all three Vite outputs to have the exact replacement Worker names, vars, bindings, cron,
and `workers_dev` policy, no routes or nested environment blocks, an existing main module, and a
matching `.wrangler/deploy/config.json` redirect. It records prior and new replacement Worker
versions and performs only passive HTTP smoke checks:

```sh
vp run deploy -- --env staging --confirm-replacement-deploy
```

The Cloudflare Vite plugin selects environments at build time. `wrangler deploy --env staging` has
no effect on its generated deployment output and must not be used for these Workers. After
validation, the aggregate script runs plain package-local `wrangler deploy` so Wrangler consumes
the generated redirect. Migration is the intentional exception: it uses the source config with
`--env staging --remote`. State-changing scripts are excluded from Vite+ script caching.

For a deliberately scoped replacement-Worker deployment, the package and root `deploy:mail`,
`deploy:api`, and `deploy:web` tasks use the same direct build, flattened-output validation, and
plain deploy semantics. Preview first, then confirm explicitly:

```sh
vp run deploy:mail -- --env staging --dry-run
vp run deploy:mail -- --env staging --confirm-replacement-deploy
```

Run passive smoke independently when needed:

```sh
vp run smoke -- --env staging
```

It checks the replacement root, docs, static search, health, capabilities, OpenAPI, and request IDs.
It does not authenticate, write D1/R2, send mail, or change routes.

Production additionally requires both confirmations:

```sh
export SMOKE_BASE_URL='https://simple-inbox-cf-production-web.<account-subdomain>.workers.dev'

vp run deploy -- \
  --env production \
  --confirm-production \
  --confirm-replacement-deploy
```

Preserve the printed version IDs and rollback commands in the change record. A failed aggregate
deploy stops immediately and prints rollback commands for replacement Workers only.

## Owner-only live smoke

Emulators cannot prove real Email Routing, HTTPS cookies, DNS, or binary attachment delivery. Only
the mailbox owner may run live smoke, using dedicated test addresses and uniquely identifiable
synthetic content. Never use customer mail.

Set reviewed prerequisites:

```sh
export CLOUDFLARE_INBOX_SMOKE_OWNER_EMAIL='owner@example.com'
export CLOUDFLARE_INBOX_SMOKE_INBOUND_ADDRESS='smoke@mail.example.com'
export CLOUDFLARE_INBOX_SMOKE_OUTBOUND_ADDRESS='allowlisted-smoke@example.net'
export SMOKE_BASE_URL='https://simple-inbox-cf-staging-web.<account-subdomain>.workers.dev'
```

Evidence contains addresses and operational notes, so keep it outside the repository:

```sh
vp run smoke:live -- \
  --env staging \
  --prepare \
  --confirm-owner-live-smoke \
  --evidence-file /private/tmp/cloudflare-inbox-staging-smoke.json
```

The prepare step runs passive checks and requests one real magic link. The owner must then verify:

1. magic-link login over HTTPS and single-use behavior;
2. a synthetic inbound message captured in replacement D1 and raw bytes in replacement R2;
3. owner forwarding and an outbound reply to the allowlisted test mailbox;
4. a reply back into the same thread in both directions;
5. a small binary attachment send, receive, authorized download, and digest/filename;
6. a correlated web -> API -> mail request-ID chain;
7. zero writes, deliveries, or routing changes involving legacy resources.

Set evidence booleans to `true` only after direct verification and record at least three request
IDs, then validate it:

```sh
vp run smoke:live -- \
  --env staging \
  --verify \
  --confirm-owner-live-smoke \
  --evidence-file /private/tmp/cloudflare-inbox-staging-smoke.json
```

Live smoke validation is an evidence gate, not a cutover command.

## Manual production cutover

There is deliberately no data import. Treat the replacement as a new mailbox store.

1. Keep legacy Workers, D1, R2, routes, and deploy artifacts untouched.
2. Deploy production replacement resources with their replacement-only `workers.dev` hostname
   enabled and a test mail subdomain. Keep `SMOKE_BASE_URL` and `APP_ORIGIN` on that hostname.
3. Complete passive checks, owner-only live smoke, browser parity, restore rehearsal, and an
   observability review.
4. Freeze configuration changes briefly. Record the exact current web route and Email Routing
   rule/catch-all target, replacement versions, time, approver, and rollback owner.
5. As one explicitly approved manual cutover change, update production `APP_ORIGIN` to the intended
   custom-domain origin, deploy that reviewed configuration, attach/switch the web custom domain to
   the replacement web Worker, and disable its `workers.dev` hostname. None of these actions is
   performed by the operator scripts. Verify HTTPS and login before proceeding.
6. Manually switch the intended Email Routing rule/catch-all to the replacement mail Worker.
7. Send uniquely titled inbound/outbound probes and verify replacement D1/R2/log state.
8. Monitor capture failures, unknown sends, auth failures, and Service Binding errors through the
   acceptance window. Do not delete legacy resources.

## Rollback

Rollback is manual and must be rehearsed in staging.

1. Switch Email Routing back to the recorded legacy target to stop new replacement captures.
2. Switch the web custom domain back to the recorded legacy Worker/route.
3. Verify legacy HTTPS and a controlled legacy probe.
4. If necessary, run the replacement-only `wrangler rollback` commands printed by deploy in reverse
   dependency order: web, API, then mail.
5. Preserve replacement D1/R2 and logs for incident review. Do not delete or overwrite them.

Messages received while the replacement route was active remain only in replacement D1/R2. They
are not merged into the legacy store automatically; identify and export them explicitly under the
retention/privacy policy before any later retry of cutover.
