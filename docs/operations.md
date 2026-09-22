# Operations runbook

This runbook operates the clean-slate `simple-inbox-cf` deployment. It does not discover, import,
modify, or delete any legacy Worker, D1 database, R2 bucket, DNS record, custom-domain route, or
Email Routing rule.

`vp run deploy` and `vp run deploy:first` are remote, state-changing commands. The obsolete
provision/bootstrap/dry-run wrappers no longer exist, so inspect the account and configuration and
complete local verification before running either command.

## Deployed resources

The root `wrangler.jsonc` is the single source deployment config:

| Resource                  | Fixed declaration                     |
| ------------------------- | ------------------------------------- |
| Worker                    | `simple-inbox-cf`                     |
| D1 binding/database       | `DB` / `simple-inbox-cf-db`           |
| Private R2 binding/bucket | `STORAGE` / `simple-inbox-cf-storage` |
| Email Sending binding     | `EMAIL`                               |
| Rate-limit binding        | `AUTH_RATE_LIMIT`                     |
| Retention schedule        | Disabled; no automatic expiration     |

Wrangler provisions the declared D1 database and R2 bucket when the deployment first requires them.
Do not add account-specific IDs, legacy identifiers, real addresses, routes, or secrets to the
repository. Do not enable an `r2.dev` hostname or R2 custom domain.

The checked-in rate-limit namespace is specific to this project. Cloudflare shares counters between
Workers that reuse a namespace in the same account, so choose a different positive integer before
deploying an additional Simple Inbox instance to that account.

## Prerequisites

- A Cloudflare account with Workers, D1, R2, and Email Routing available.
- Email Routing enabled on the intended new mail zone and at least one owner-controlled destination
  verified before deployment. Cloudflare requires both before attaching the `EMAIL` binding. Do not
  enable or reconfigure Email Routing on a legacy production mail zone to satisfy this prerequisite.
- Workers Paid and an onboarded Email Sending domain before testing full compose/reply delivery to
  arbitrary recipients. Verified-destination-only testing can remain narrower.
- Wrangler authenticated to the exact account the owner intends to use.
- The pinned Node, pnpm, and Vite+ versions from `package.json`.
- A clean checkout with the generated routes, OpenAPI document, binding types, and migrations in
  sync.
- Two independent secrets of at least 32 random bytes held in a secret manager.
- An owner-controlled mail domain or subdomain and owner-controlled test destinations.
- Keep R2 object expiration disabled for indefinite mail and attachment storage.
- A record of any existing/legacy Worker, domain route, and Email Routing target kept outside this
  repository. These records are for human safety and rollback only; repository commands never read
  them.

Use a narrowly scoped Cloudflare API token or an interactive Wrangler login. Confirm the selected
account before deployment:

```sh
vp exec wrangler whoami
```

The upload step runs Wrangler non-interactively to prevent resource-ID writeback. If `whoami` lists
more than one account, set `CLOUDFLARE_ACCOUNT_ID` to the intended account for the current shell or
CI project only; never add it to this repository.

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

### Deploy to Cloudflare button

Operators can deploy this public repository with:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lhr0909/simple-inbox-cloudflare)

Cloudflare reads the root Wrangler configuration, provisions supported resources, reads the custom
root deploy task, and prompts for the secrets described by `package.json`. Deploy buttons require a
public GitHub or GitLab repository. Review Cloudflare's current
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
3. `CI=1 wrangler deploy --config apps/web/dist/server/wrangler.json`

The build uses the Cloudflare Vite plugin and emits the flattened deployment config consumed by the
last command. `CI=1` keeps Wrangler's interactive auto-provisioning from writing a new D1 resource
ID back into tracked `wrangler.jsonc`; the ID remains in Cloudflare. Do not bypass the build by
deploying an old generated file. The migration step uses only checked-in SQL; generate and review
new migrations during development, never during a remote deployment.

On the first deployment, Wrangler creates/binds `simple-inbox-cf-db` and `simple-inbox-cf-storage` from
their declarations. Later deployments reuse them and apply migrations before uploading new code.
Neither command configures a sending domain, R2 lifecycle, custom domain, DNS, or Email Routing.

## Sent-copy upgrade

Migration `0008_copy_sent_mail.sql` adds a default-on `forward_sent` mailbox preference. Existing
mailboxes retain their forwarding destinations; owners can opt out in mailbox settings. No new
Cloudflare bindings, resources, secrets, or routing changes are required. The standard deployment
applies the additive migration before uploading the Worker. Only future compose/reply sends gain
an automatic Bcc; migration does not send mail or replay old messages.

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

### Optional magic-link sender

Magic links default to `no-reply@<configured-mail-domain>`. To send authentication mail from a
separate onboarded domain, set the exact normalized address as `MAGIC_LINK_FROM_EMAIL`. Store this
value as a Worker secret so a later Wrangler deployment does not remove a dashboard-only variable:

```sh
vp exec wrangler secret put MAGIC_LINK_FROM_EMAIL --config wrangler.jsonc
```

The address's domain must be onboarded in Cloudflare Email Sending. This override affects only
magic links; forwarding, compose, and replies continue to use their assigned mailbox address.

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
5. review the indefinite-storage policy. No retention window is required.

The request must be same-origin and HTTPS (local loopback HTTP is the only exception), is protected
by the Cloudflare rate limiter, and compares the setup token by digest. The token is never written to
D1, returned, or logged.

One atomic D1 batch creates:

- the owner user;
- the primary mailbox, forwarding initially to the owner;
- the sole owner membership for that mailbox;
- the singleton installation record containing origin, mail domain, and retention settings.

The setup mail domain anchors the primary mailbox and malformed-message fallback identity. It is
not an application-level allowlist. After setup, any valid envelope recipient that Cloudflare Email
Routing delivers to the Worker is captured as a quiet owner mailbox in D1, with forwarding disabled
and mail accessible through **Other inbound** until the owner promotes it.

An exact replay is idempotent. Different values, an existing different owner, or partial pre-existing
user/mailbox state fails closed. If installation state is reported as inconsistent, stop and restore
D1 from a known-good backup rather than manually adding records.

After success, `/setup` redirects an unauthenticated visitor to `/sign-in`; normal UI and API flows
become available. Ordinary application operation no longer reads the plaintext setup token.

## Mailbox HTML settings

Open **Mailbox settings** beside the mailbox selector:

- **Forward full HTML** preserves original formatting and inline images in future forwarded mail.
  Existing forwarded copies are unaffected. The receiving email client controls remote-image loading.
- **Display full HTML in inbox** shows formatted previews for retained messages, including older mail.
  Remote images may reveal opens. Email scripts and forms remain blocked; **Show plain text** is
  available on each message. If original mail has expired or HTML exceeds the preview limit, text
  remains available while its application record is retained.

**Show HTML** beside **Raw email** previews just that message for the current conversation view,
without changing the mailbox preference. **Show plain text** switches back; reopening the
conversation uses the mailbox default. One-off previews use the same sanitizer and sandbox and can
load remote images.

Full HTML forwarding defaults on; inbox HTML display defaults off. Both are independent of the
forwarding destination. The mailbox PATCH API
accepts boolean `forwardHtml` and `renderHtml` values. Mailbox owner authorization is required.

Migration `0002_html_preferences.sql` introduced the preferences. Migration
`0003_default_html_forwarding.sql` enables full HTML forwarding for every existing mailbox, including
previously disabled ones, and changes the database default for new inboxes. It replaces only the
forwarding flag column without rebuilding the mailbox table or modifying related mail, forwarding
destinations, or HTML display preferences. Owners can disable forwarding HTML again after upgrading.
Apply pending migrations before uploading the Worker using the normal upgrade command. Code rollback
does not restore the previous forwarding preferences; neither migration sends or rewrites messages.

## Cloudflare Dashboard owner steps

These actions are intentionally absent from repository automation.

### Email Sending

Email Routing and one verified destination were pre-deployment requirements for the Worker binding.
After the Worker and wizard are ready:

1. On Workers Paid, onboard the chosen sending domain in Cloudflare Email Sending for delivery to
   arbitrary recipients.
2. Publish and verify the required SPF/DKIM records.
3. Verify only owner-controlled destinations while testing.
4. Confirm the Worker's `EMAIL` binding can send magic links, forwarding, and owner-composed mail.
5. Keep arbitrary-recipient sending disabled until provider and abuse controls are reviewed.

Repeat sender-domain onboarding for every routed domain whose mailboxes will be used as forwarding
or outbound `From` addresses. The Worker records mail from any routed domain, but Cloudflare Email
Sending can reject forwarding or replies from a domain that has not been onboarded for sending.

Use a separate test domain/subdomain and synthetic content for acceptance. A successful Worker
deployment alone does not prove Email Sending authorization.

### Private R2 lifecycle

Keep `simple-inbox-cf-storage` private and its lifecycle rule list empty. Remove object-expiration,
storage-class-transition, and incomplete-multipart-abort rules, including R2's default seven-day
multipart rule. New buckets also need this explicit owner action; provisioning alone does not remove
R2 defaults. The application performs no automatic deletion of mail, duplicate/unprojected raw
objects, completed uploads, or unfinished multipart sessions. Old retention settings and queued
deletion tombstones are ignored. Spam and Trash remain reversible until permanent deletion is
explicitly implemented and invoked.

A code deployment cannot override an existing bucket lifecycle rule. Do not roll back to code with
automatic deletion enabled. Deleted bytes cannot be recovered by a Worker rollback.

### Attachment uploads

Deployment declares the private bucket `simple-inbox-cf-storage` and its `STORAGE` binding.
The browser uploads chunks to the authenticated, same-origin Worker API. The Worker streams each
part into R2 multipart storage, verifies completion, and streams downloads from the same binding.
Production and local development use the same code path. No R2 S3 access keys, additional Worker
secrets, bucket CORS policy, public R2 hostname, or custom domain are required.

Deployment requires Worker deployment permission and D1 write access for pending migrations.
First installations also require R2 provisioning access. The running Worker accesses objects through
its binding. Existing auth/setup secrets remain; there is no attachment-specific secret to add.
This upgrade requires no DNS, custom-domain, or Email Routing changes. Live email acceptance tests
remain an explicit owner-authorized action.

### Storage layout and upgrades

The one `STORAGE` binding uses `simple-inbox-cf-storage`:

- `raw/inbound/YYYY/MM/DD/<hash>.eml`: original inbound MIME, including embedded attachments.
- `raw/outbound/YYYY/MM/DD/<id>.eml`: canonical outbound archives.
- `attachments/<upload-id>`: standalone files uploaded by webmail; filenames and associations live in D1.

Object keys stay stable when mail moves to Spam/Trash. Future permanent deletion must follow D1
references and retain objects still referenced by other mail. Inbound attachments are extracted from
the retained raw MIME when requested; they are not duplicated as separate objects.

Changing an existing installation's physical bucket name requires an owner-approved copy and
binding switch; editing Wrangler alone does not move data. Preserve object keys, HTTP metadata,
custom metadata (including raw SHA-256), and all existing D1 references. Account for concurrent
incoming mail during the copy, validate content and metadata, and keep the old bucket until its
removal is explicitly authorized. Migration-specific scripts and deployment details remain outside
this repository. Future installations use the final single-bucket configuration directly.

Every uploaded webmail attachment is sent as an HTML/plain-text link. Anyone possessing the link
can download without sign-in; forwarding the email grants the same access. Public links do not
expire. Moving mail to Spam/Trash does not revoke or delete files. Draft removal only detaches a
file; completed unused uploads remain stored. No automatic orphan-object deletion runs. Remove R2
incomplete-multipart abort rules too; unfinished uploads remain until explicitly cleaned up.

Webmail has no application-defined size/count limits; R2 service limits and the email link-body
budget remain. Raw MIME attachment API requests retain their existing safety bounds for backwards
compatibility. They are separate from webmail's streamed uploads. Each upload chunk is subject to Cloudflare's
per-request body-size limit; the default chunk is 16 MiB and grows for very large files to respect
R2's 10,000-part limit.

### Email Routing activation

1. Confirm setup, sign-in, health, and outbound test delivery on the new Worker.
2. Add an owner-approved catch-all whose destination is the `simple-inbox-cf` Worker's `email()`
   handler. The catch-all is also the route for opaque `<token>@domain` reply aliases; Cloudflare
   subaddressing is not required.
3. Select the daily-use aliases inside the app. Newly discovered catch-all recipients appear under
   **Other inbound** without forwarding; only whitelisted inboxes with a destination can forward
   messages that do not match a spam blacklist.
4. Do not leave legacy and replacement catch-alls active for the same domain. Record the prior
   target so the owner can restore it manually if rollback is required.
5. Send a uniquely titled synthetic inbound message and verify the D1 mailbox/thread/message
   projection, private R2 raw bytes, forwarding, owner reply relay, and authorized attachment
   download.

Replacing a legacy catch-all does not import that system's private reply-alias records. Before
cutover, the owner must explicitly accept that replying from a personal inbox to an older forwarded
legacy thread will no longer relay through the retired Worker. Complete or move any active legacy
threads first. Aliases previously issued by this replacement application remain compatible in both
the direct `<token>@domain` and former `reply+<token>@domain` forms.

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

Mail, raw source, and completed attachments are stored indefinitely. Scheduled deletion is disabled,
including queued work from previous versions. Spam and Trash are reversible message states and do
not start expiration timers. Automatic Spam/Trash purging and a permanent-delete UI are not enabled.

The old setup API accepts retention fields only for client/schema compatibility; those values have
no deletion effect. The setup wizard no longer asks for them. Existing data already deleted by old
retention jobs or lifecycle rules cannot be restored by this change.

Owners control storage and backups. Before explicitly deleting data or applying destructive
migrations, export required raw mail/attachments and test D1 restoration in an isolated environment.
There is no bulk export command. Worker rollback does not restore deleted D1/R2 data.

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

## Alias and spam management

The mailbox dropdown offers **Other inbound** and **+ New inbox…**. Create an alias with a full email
address and set a forwarding destination, or leave it empty to disable forwarding. In Other inbound, opening a
conversation offers **Create inbox for this mailbox**, opening the creation form with its address filled in.
**Mailbox settings** can turn **Show as an inbox** off to hide an existing alias and stop its forwarding.
No action creates Cloudflare routing rules; the existing catch-all must already route that domain.

**General settings** contains appearance preferences and the installation owner's shared **Spam blacklist**. Add a receiving mailbox address, sender
address, or sender domain. Domain rules include subdomains. Matching future mail is stored in Spam,
never forwarded. Rules match addresses, not display names, and do not authenticate a sender.
The conversation **Spam** action asks whether to block the sender address or the entire sender domain
before moving the conversation to Spam. For multiple incoming senders, choose which sender to block.
**Block mailbox** in **Mailbox settings** adds that receiving address to the blacklist in one click.
It hides the mailbox from the dropdown and groups its mail under Other inbound. Existing messages, including the open conversation, remain unchanged; future mail goes to Spam without forwarding.
For an address in Other inbound, open its conversation and choose **Mailbox settings**. Removing the rule restores its prior dropdown visibility.
Cancel in the sender confirmation leaves the conversation and blacklist unchanged. **Not spam** restores messages but leaves
blacklist rules intact; remove a rule separately in **General settings** to allow future mail.

Migrations 0004–0006 preserve existing inbox visibility/forwarding, backfill message inbox membership
from direction and archive state, and create the blacklist table. Newly discovered aliases start
quiet. Existing read state and mail remain intact. Review existing aliases in Settings to hide those
that should become Other inbound. Spam and Trash have no automatic expiration; a Worker
rollback cannot recover deleted mail. The migrations are additive and keep legacy workflow columns
for compatibility, but the UI and public API no longer expose workflow statuses.
