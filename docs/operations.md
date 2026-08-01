# Operations runbook

This runbook operates the clean-slate `simple-inbox-cf` deployment. It does not discover, import,
modify, or delete any legacy Worker, D1 database, R2 bucket, DNS record, custom-domain route, or
Email Routing rule.

`vp run deploy` and `vp run deploy:first` are remote, state-changing commands. The obsolete
provision/bootstrap/dry-run wrappers no longer exist, so inspect the account and configuration and
complete local verification before running either command.

## Deployed resources

The root `wrangler.jsonc` is the single source deployment config:

| Resource                  | Fixed declaration                    |
| ------------------------- | ------------------------------------ |
| Worker                    | `simple-inbox-cf`                    |
| D1 binding/database       | `DB` / `simple-inbox-cf-db`          |
| Private R2 binding/bucket | `RAW_EMAILS` / `simple-inbox-cf-raw` |
| Email Sending binding     | `EMAIL`                              |
| Rate-limit binding        | `AUTH_RATE_LIMIT`                    |
| Retention schedule        | `17 3 * * *`                         |

Wrangler provisions the declared D1 database and R2 bucket when the deployment first requires them.
Do not add account-specific IDs, legacy identifiers, real addresses, routes, or secrets to the
repository. Do not enable an `r2.dev` hostname or R2 custom domain.

The checked-in rate-limit namespace is specific to this project. Cloudflare shares counters between
Workers that reuse a namespace in the same account, so choose a different positive integer before
deploying an additional Simple Inbox instance to that account.

## Prerequisites

- A Cloudflare account with Workers, D1, R2, Email Routing, and Email Sending available.
- Wrangler authenticated to the exact account the owner intends to use.
- The pinned Node, pnpm, and Vite+ versions from `package.json`.
- A clean checkout with the generated routes, OpenAPI document, binding types, and migrations in
  sync.
- Two independent secrets of at least 32 random bytes held in a secret manager.
- An owner-controlled mail domain or subdomain and owner-controlled test destinations.
- An explicit owner decision for raw-email and application-record retention.
- A record of any existing/legacy Worker, domain route, and Email Routing target kept outside this
  repository. These records are for human safety and rollback only; repository commands never read
  them.

Use a narrowly scoped Cloudflare API token or an interactive Wrangler login. Confirm the selected
account before deployment:

```sh
vp exec wrangler whoami
```

## Local verification

Deterministic verification uses local D1/R2 and simulated Email Sending. It does not send mail or
change a Cloudflare account.

```sh
vp install --frozen-lockfile
vp run check:generated
vp run check
vp run test:boundaries
vp test
vp run build
vp run test:integration
vp exec playwright install chromium
vp run test:e2e
```

The integration suite exercises the production single-Worker topology, including the in-process
web -> API -> mail flow, isolated D1/R2, and first-run setup. The browser suite requires the build
and an installed Chromium binary.

For local interactive use:

```sh
cp .dev.vars.example .dev.vars
# Replace both placeholders with independent local-only values of at least 32 random bytes.
vp run typegen
vp run dev
```

`vp run dev` applies checked-in migrations to local D1 and starts the app. Use only synthetic values,
for example:

- owner: `owner@example.test`
- mail domain: `mail.example.test`
- inbox: `inbox@mail.example.test`

Local emulation does not prove Cloudflare Email Routing, Email Sending, public HTTPS cookies, or a
real R2 lifecycle policy.

## Deployment options

### Future Deploy to Cloudflare button

When the repository is public, operators can use:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lhr0909/simple-inbox-cloudflare)

Cloudflare reads the root Wrangler configuration, provisions supported resources, reads the custom
root deploy task, and prompts for the secrets described by `package.json`. Deploy buttons require a
public GitHub or GitLab repository. The source repository is currently private, so other users
cannot use this flow until it is made public. Review Cloudflare's current
[Deploy to Cloudflare button documentation](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
before publishing the button.

### Manual Wrangler deployment

Deploy to Cloudflare provisions the bindings before it invokes the custom `deploy` script. For the
first manual deployment from a shell, the resources do not exist yet, so use the explicit first-run
sequence after local verification and account confirmation:

```sh
vp run deploy:first
```

That command builds and deploys the fail-closed Worker once so Wrangler can provision D1/R2, then
applies the checked-in migrations. The app becomes ready for `/setup` when migration completes; no
second upload is needed. Add the required secrets immediately afterward.

For subsequent deployments, use:

```sh
vp run deploy
```

This command immediately performs the following sequence:

1. `vp run @cloudflare-inbox/web#build`
2. `wrangler d1 migrations apply DB --remote --config wrangler.jsonc`
3. `wrangler deploy --config apps/web/dist/server/wrangler.json`

The build uses the Cloudflare Vite plugin and emits the flattened deployment config consumed by the
last command. Do not bypass the build by deploying an old generated file. The migration step uses
only checked-in SQL; generate and review new migrations during development, never during a remote
deployment.

On the first deployment, Wrangler creates/binds `simple-inbox-cf-db` and `simple-inbox-cf-raw` from
their declarations. Later deployments reuse them and apply migrations before uploading new code.
Neither command configures a sending domain, R2 lifecycle, custom domain, DNS, or Email Routing.

## Required secrets

The application requires two different secret values:

| Secret              | Purpose                                            | Rotation effect                                         |
| ------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| `AUTH_TOKEN_PEPPER` | Keys magic-link, session, and bearer-token digests | Invalidates outstanding links, sessions, and API tokens |
| `SETUP_TOKEN`       | Authorizes the first-run `/setup` mutation         | Does not change completed installation data             |

Each value must contain at least 32 random bytes and should be generated and stored independently.
Never reuse a legacy value or one secret as the other. Never commit, print, log, paste into an issue,
or store either value in live-smoke evidence.

The Deploy to Cloudflare flow prompts for both secrets. For a manual first deployment, deploy the
fail-closed Worker, then add the secrets immediately through the Worker's Cloudflare Dashboard
settings or with Wrangler's interactive secret prompt:

```sh
vp exec wrangler secret put AUTH_TOKEN_PEPPER --config wrangler.jsonc
vp exec wrangler secret put SETUP_TOKEN --config wrangler.jsonc
```

Do not pass secret plaintext on a command line. Verify names, not values:

```sh
vp exec wrangler secret list --config wrangler.jsonc
```

Until `SETUP_TOKEN` exists and setup succeeds, protected API calls fail closed, inbound mail is
rejected, and retention is idle. Until `AUTH_TOKEN_PEPPER` is valid, authentication cannot operate.

## Choose the public origin

The setup transaction derives and stores `APP_ORIGIN` from the verified HTTPS request. Decide which
origin the installation will use before completing `/setup`:

- keep the generated `https://simple-inbox-cf.<account-subdomain>.workers.dev` origin; or
- manually attach the intended custom domain in the Cloudflare Dashboard first, then open `/setup`
  on that domain.

Do not complete setup on one origin and silently move the application to another. Magic links,
Secure cookies, and same-origin mutation checks use the stored origin. Changing it later requires an
explicit, reviewed data/configuration migration; there is no route or origin cutover script.

## First-run setup

Open the chosen HTTPS origin at `/setup`. The wizard asks for:

1. the exact `SETUP_TOKEN` held by the owner;
2. a normalized owner email, such as `owner@example.test` in a non-live test;
3. a lowercase mail domain, such as `mail.example.test`;
4. a primary mailbox on that domain, such as `inbox@mail.example.test`;
5. raw-email retention from 1 through 3,650 days;
6. application-record retention from the raw-retention value through 3,650 days;
7. a retention batch size from 1 through 100.

The request must be same-origin and HTTPS (local loopback HTTP is the only exception), is protected
by the Cloudflare rate limiter, and compares the setup token by digest. The token is never written to
D1, returned, or logged.

One atomic D1 batch creates:

- the owner user;
- the primary mailbox, forwarding initially to the owner;
- the sole owner membership for that mailbox;
- the singleton installation record containing origin, mail domain, and retention settings.

An exact replay is idempotent. Different values, an existing different owner, or partial pre-existing
user/mailbox state fails closed. If installation state is reported as inconsistent, stop and restore
D1 from a known-good backup rather than manually adding records.

After success, `/setup` redirects an unauthenticated visitor to `/sign-in`; normal UI and API flows
become available. Ordinary application operation no longer reads the plaintext setup token.

## Cloudflare Dashboard owner steps

These actions are intentionally absent from repository automation.

### Email Sending

1. Onboard the chosen sending domain in Cloudflare Email Sending.
2. Publish and verify the required SPF/DKIM records.
3. Verify only owner-controlled destinations while testing.
4. Confirm the Worker's `EMAIL` binding can send magic links, forwarding, and owner-composed mail.
5. Keep arbitrary-recipient sending disabled until provider and abuse controls are reviewed.

Use a separate test domain/subdomain and synthetic content for acceptance. A successful Worker
deployment alone does not prove Email Sending authorization.

### Private R2 lifecycle

Keep `simple-inbox-cf-raw` private. Add a bucket lifecycle rule that expires objects after the
approved raw-email retention period plus a short grace, such as two days. The scheduled application
retention job is authoritative and should delete first; the lifecycle rule is a delayed backstop for
an orphan left between the R2-first write and its D1 projection.

Review the lifecycle whenever the setup retention policy changes. Never configure a lifecycle
shorter than the approved raw-retention window, and never expect Worker rollback to restore expired
objects.

### Email Routing activation

1. Confirm setup, sign-in, health, and outbound test delivery on the new Worker.
2. Add a new staging/test-domain Email Routing rule or catch-all whose destination is the
   `simple-inbox-cf` Worker's `email()` handler.
3. Do not edit an existing legacy rule as part of deployment.
4. Send a uniquely titled synthetic inbound message and verify D1 projection, private R2 raw bytes,
   optional forwarding, reply alias behavior, and authorized attachment download.

Routing activation is a separate owner-approved change. Avoid dual delivery to legacy and new
stores: two handlers can capture duplicate messages even if each is internally idempotent.

## Acceptance checks

Passive checks, which should not write mailbox data:

- `/` redirects to setup, sign-in, or inbox as appropriate;
- `/docs` and `/api/search` return public documentation/search content;
- `/api/v1/health` reports the API service healthy;
- `/api/v1/capabilities` and `/api/v1/openapi.json` load;
- `/api/v1/setup` reports `complete` after first run;
- public `/internal/*` probes return 404;
- responses include opaque request IDs and private responses use `no-store`.

Owner-only live checks use synthetic content and an allowlisted destination:

1. request and consume one HTTPS magic link; confirm it cannot be reused;
2. receive one synthetic inbound message and verify D1/R2 capture;
3. verify forwarding, a reply, and the reply back into the same thread;
4. send and receive a small non-sensitive attachment and verify authorized download;
5. repeat an outbound request with the same idempotency key and confirm no duplicate send;
6. inspect content-safe request IDs without copying addresses, tokens, bodies, or object keys;
7. confirm no legacy Worker, store, route, or delivery changed.

There is no repository live-smoke script. The owner performs these checks deliberately in the
browser and Cloudflare Dashboard.

## Retention, export, and recovery

The daily cron advances a durable, bounded workflow:

1. enqueue eligible messages using trusted local creation time and snapshot both policy deadlines;
2. delete the private R2 raw object first (already missing counts as success);
3. transactionally remove the message's D1 children and projection;
4. repair the thread aggregates or delete the empty thread;
5. retain a content-free tombstone as operational evidence.

Failed work remains retryable after its lease expires. The job never calls Email Sending and is not
a delivery retry mechanism.

Retention deletion is irreversible at the application layer. Before shortening a window or applying
a destructive/contract migration:

- export required raw messages and attachments through owner-authorized endpoints to encrypted
  storage with its own lifecycle;
- create a D1 backup and prove restoration to an isolated test deployment;
- record only content-free counts, digests, request IDs, version IDs, and timestamps;
- use expand/backfill/contract migrations and do not race deployments.

There is no bulk export command. Search/list/detail bodies are bounded projections and may be
truncated; authorized raw messages are the fidelity source only until raw retention expires.

## Observability and privacy

Keep content-safe structured application logs enabled. Keep provider invocation logs and automatic
traces disabled: generated Fetch metadata can contain full URLs with magic-link tokens or search
terms, and Email invocation metadata contains recipients.

Investigate using request IDs, timestamps, safe states, and error codes. Do not copy message bodies,
addresses, raw MIME, attachment bytes, auth headers, cookie values, setup tokens, or R2 keys into
logs, tickets, or change records.

## Upgrades and rollback

For an upgrade, review dependency/configuration/migration changes, back up D1 when warranted, run
the complete local verification suite, and then run `vp run deploy` (not `deploy:first`). The deploy
task applies pending D1 migrations before uploading the new Worker. It does not rerun first-use
setup or replace secrets.

Preserve the Worker version identifier and migration/change record. Cloudflare Worker rollback can
restore an earlier code version, but it cannot undo D1 migrations or restore data removed from D1 or
R2. Do not delete the D1 database or R2 bucket during rollback.

If an owner-approved Email Routing or custom-domain change must be rolled back, manually restore the
recorded prior target/route and verify it separately. Messages received while `simple-inbox-cf` was
the active mail target remain in its D1/R2 and are not merged into a legacy store automatically.
