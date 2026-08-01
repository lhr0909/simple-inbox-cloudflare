# ADR 0001: Stack and single-Worker topology

- Status: accepted
- Date: 2026-08-01
- Owners: project maintainers

## Context

Simple Inbox needs a reproducible, self-hosted Cloudflare deployment with a browser UI, versioned
API, inbound and outbound mail handling, D1 persistence, raw-message storage, and scheduled
retention. The source code benefits from strong web/API/mail ownership boundaries, but a self-hosted
operator should not have to provision and coordinate three Workers, two Service Bindings, resource
IDs, environment-specific bootstrap scripts, and an ordered multi-Worker release.

The repository is also a clean-slate implementation. It must not import identifiers or data from a
legacy installation, probe legacy resources, or automate DNS and Email Routing cutover.

## Decision

Use Node 24 with pnpm 11 and Vite+ at the monorepo root. Keep TanStack Start, Hono, contracts,
repositories, and mail-core behavior in separate workspaces, but deploy one Cloudflare Worker named
`simple-inbox-cf`.

The root Worker exports:

- `fetch()` for the TanStack Start application, documentation, and `/api/v1/*` API;
- `email()` for Cloudflare Email Routing;
- `scheduled()` for the daily retention workflow.

The API and mail Hono applications run in the same isolate. A narrow in-process `Fetcher` adapter
replaces the former API-to-mail Service Binding, and the public router never maps the mail app's
internal routes. Package exports, explicit binding construction, repositories, authorization, and
static boundary tests retain the logical separation.

### Toolchain pins

| Component                      | Version                                  |
| ------------------------------ | ---------------------------------------- |
| Node.js                        | 24.18.1                                  |
| pnpm                           | 11.18.0                                  |
| Vite+ / `vite-plus`            | 0.2.7                                    |
| Vite resolution                | `npm:@voidzero-dev/vite-plus-core@0.2.7` |
| TypeScript                     | 7.0.2                                    |
| React / React DOM              | 19.2.8                                   |
| TanStack Start                 | 1.168.34                                 |
| TanStack React Router          | 1.170.18                                 |
| Cloudflare Vite plugin         | 1.50.0                                   |
| Wrangler                       | 4.118.0                                  |
| Hono                           | 4.12.33                                  |
| Base UI                        | 1.6.0                                    |
| Fumadocs core / UI             | 16.14.0                                  |
| Drizzle ORM / Kit              | 0.45.2 / 0.31.10                         |
| Vitest                         | 4.1.10                                   |
| Cloudflare Workers Vitest pool | 0.20.1                                   |

The root pnpm catalog is authoritative for all other exact versions. Internal dependencies use
`workspace:*`, and the workspace keeps one `pnpm-lock.yaml`.

### Resources and configuration

The root `wrangler.jsonc` is the only source deployment configuration. It declares:

- Worker `simple-inbox-cf`, public on `workers.dev` by default;
- D1 binding `DB` backed by `simple-inbox-cf-db`;
- private R2 binding `RAW_EMAILS` backed by `simple-inbox-cf-raw`;
- Email Sending binding `EMAIL`;
- rate-limit binding `AUTH_RATE_LIMIT`;
- daily retention cron `17 3 * * *`;
- structured application logs with invocation logs and automatic traces disabled.

Wrangler automatically provisions the declared D1 and R2 resources when required. Account-specific
resource IDs and real mail identities are not committed.

Two independent secret bindings are mandatory for a usable installation:

- `AUTH_TOKEN_PEPPER`, at least 32 random bytes, keys token digests;
- `SETUP_TOKEN`, a different value of at least 32 random bytes, authorizes first-run setup.

### First-run setup

Deploying schema and code does not create an owner. The unconfigured Worker redirects its UI to
`/setup`, rejects inbound email, skips retention, and makes protected API routes unavailable.

The setup wizard receives the one-time setup token plus normalized owner, mail-domain, mailbox, and
retention values. The API derives the canonical app origin from the verified same-origin HTTPS
request. A transactional D1 batch creates the owner user, primary mailbox, owner membership, and
singleton installation row. Exact replay is idempotent; conflicting or partial state fails closed.
The setup token itself is not stored, returned, or logged.

### Build and deployment

The root `deploy` task intentionally has a small, visible sequence:

1. build `@cloudflare-inbox/web` with the Cloudflare Vite plugin;
2. apply checked-in D1 migrations remotely through the root config;
3. deploy the generated `apps/web/dist/server/wrangler.json`.

There is no custom provision, bootstrap, smoke, environment-flattening, or multi-Worker deployment
script. Local checks and integration/browser tests are separate pre-deployment gates. Email Sending
domain setup, R2 lifecycle policy, custom domains, and Email Routing activation remain explicit
Cloudflare Dashboard operations.

## Consequences

Benefits:

- one Worker and one origin are easier to self-host and fit Deploy-to-Cloudflare resource
  provisioning;
- D1/R2 names are stable and no account IDs need to be committed;
- there are no Service Binding deployment-order or version-skew failures;
- setup collects installation-specific values without tracked real addresses or bootstrap SQL files;
- HTTP, email, and scheduled handlers share one installation gate and one configuration source.

Tradeoffs:

- logical web/API/mail boundaries no longer receive isolate-level or network-level separation;
- every root deployment updates all three behaviors together;
- all bindings are technically available to the root isolate, so adapter and authorization tests are
  important;
- the setup origin is captured at first run, so the owner must choose the intended HTTPS origin
  before completing setup;
- D1 migration rollback and retained-data recovery remain separate from Worker-version rollback.

## Alternatives considered

### Three deployed Workers with Service Bindings

This gives stronger runtime isolation and independent releases, but substantially increases initial
resource setup, configuration, deployment ordering, and failure modes for a self-hosted application.
The source package boundaries preserve most maintainability benefits without that operator cost.

### Public HTTP endpoints between logical modules

Rejected because internal mail commands would need another public authentication boundary and could
expose privileged delivery operations. In-process dispatch keeps those routes unreachable from the
public Worker router.

### Owner/mailbox values in Wrangler vars plus a bootstrap script

Rejected because it requires committing or privately patching installation-specific configuration,
duplicates validation outside the application, and makes one-click deployment difficult. A guarded
first-run transaction is simpler and auditable.

### Legacy import or automatic cutover

Rejected. Legacy resources and data remain external and read-only. Data migration, custom-domain
changes, and Email Routing changes require separate owner decisions and are not repository
automation.
