# Cloudflare Inbox

Cloudflare Inbox is a clean-room, self-hosted mail workspace built as three Cloudflare Workers:

- a TanStack Start web Worker with shadcn/Base UI and embedded Fumadocs;
- a Hono API Worker for authentication, authorization, OpenAPI, and inbox operations;
- a private Hono mail Worker with both `fetch()` and Email Routing `email()` entry points.

D1 is the source of truth for queryable state. R2 stores only canonical raw RFC 822 `.eml`
objects. The browser never receives direct D1 or R2 access.

This repository is independent from the legacy Cloudflare Inbox repository and deployment. Its
Workers and storage use `simple-inbox-cf-<environment>-*` names. Repository automation
never changes legacy Workers, routes, D1/R2 resources, DNS, or Email Routing; cutover is an explicit
manual owner operation described in [the operations runbook](docs/operations.md).

## Architecture

```text
browser -> web Worker -> API Worker -> mail Worker
                         |              |
                         +---- D1 ------+
                         +---- R2 ------+
```

Private Cloudflare Service Bindings connect `web -> API` and `API -> mail`. The web Worker
proxies the browser's same-origin `/api/v1/*` requests; the API independently authenticates and
authorizes every mailbox, thread, message, raw object, and attachment request.

| Workspace            | Responsibility                                                           |
| -------------------- | ------------------------------------------------------------------------ |
| `apps/web`           | TanStack Start routes, inbox UI, same-origin API bridge, public Fumadocs |
| `workers/api`        | Hono `/v1` API, magic-link sessions, authorization, OpenAPI              |
| `workers/mail`       | inbound capture, MIME projection, forwarding, alias relay, outbound mail |
| `packages/contracts` | Zod wire contracts, DTOs, errors, route metadata                         |
| `packages/db`        | Drizzle schema, checked-in D1 migration, scoped repositories             |
| `packages/mail-core` | runtime-neutral parsing, threading, rendering, and limit rules           |

See [the architecture guide](docs/architecture.md), [ADR 0001](docs/adr/0001-stack-and-topology.md),
the [visual parity checklist](docs/visual-parity.md), and the
[migration handoff](TANSTACK_START_MIGRATION_HANDOFF.md) for the design invariants.

## Pinned toolchain

- Node 24.18.1
- pnpm 11.18.0
- Vite+ 0.2.7

Install the pinned Vite+ launcher, then let it provision the exact Node and pnpm versions declared by
the workspace.

```sh
vp install --frozen-lockfile
vp run check
vp test
vp run build
```

Useful root tasks include:

```sh
vp run dev
vp run typegen
vp run db:generate
vp run db:migrate -- --env staging --dry-run
vp run bootstrap -- --env staging --dry-run
vp run deploy -- --env staging --dry-run
```

Remote mutation requires a second, explicit command: migrations need `--confirm-migrate`, and the
aggregate deploy needs `--confirm-replacement-deploy` (plus `--confirm-production` in production).
The deploy command is deliberately ordered and guarded: verify, build each package directly with
the selected `CLOUDFLARE_ENV`, validate all flattened Vite deployment output, migrate replacement
D1, bootstrap the exact deterministic owner/mailbox records, deploy replacement mail, API, and web
Workers, then run non-destructive smoke checks. It refuses placeholder or legacy resource
identifiers and cannot switch traffic. See the runbook for the complete commands.

## Local development

All committed configuration uses synthetic `example.test` identities and local resource
placeholders. Never point routine local development at production D1 or R2 resources.

1. Copy the relevant values from `.dev.vars.example` into the package-local `.dev.vars` files.
2. Generate binding types with `vp run typegen`.
3. Apply the checked-in D1 migration locally.
4. Start the three packages with `vp run dev`.

The primary routes are:

- `/` — auth-aware redirect only;
- `/sign-in` and `/auth/verify` — passwordless sign-in;
- `/inbox` — authenticated inbox;
- `/docs` — public embedded documentation;
- `/api/v1/*` — same-origin bridge to the API Worker.

Cloudflare Email Routing and Email Sending require account-level setup that local emulation cannot
fully prove. Use only synthetic messages and allowlisted staging recipients for live smoke tests.

## Security model

Magic-link and session tokens are opaque random values; D1 stores only HMAC digests. Production
sessions use a Secure, HttpOnly, SameSite=Lax `__Host-` cookie. Cookie-authenticated mutations
enforce same-origin/fetch-metadata checks, and resource queries are scoped by mailbox membership.

Raw email is sensitive. R2 buckets must remain private, message bodies and recipient lists must not
be logged, and raw/attachment downloads are authorized on every request with private no-store
responses. Provider invocation logs and automatic traces remain disabled because their generated
metadata can contain full URLs, magic-link query tokens, search terms, or Email recipients; only
content-safe structured application logs are enabled.

The committed 365-day raw-email and application-record retention values are deliberate pre-launch
placeholders, not an implicit policy decision. Review them before provisioning: raw retention must
not exceed application retention, the scheduled deletion batch is capped at 100, and an owner must
export required data before shortening either window. The application performs no AI inference and
sends mailbox content to no AI service.

Report vulnerabilities through the process in [SECURITY.md](SECURITY.md).

## Deployment status

The repository contains local implementations, checked-in migrations, deterministic tests, Worker
configs, and production build paths. Before a real staging or production deployment, an operator
must supply Cloudflare resource IDs, a replacement `workers.dev` origin, verified sending
domains/destinations, secrets, and isolated Email Routing rules, then execute the documented live
mail/auth/browser smoke tests. Custom-domain and routing cutover remains manual.

A public license must be chosen deliberately before the first public distribution. The migration
handoff recommends evaluating Apache-2.0 and AGPL-3.0 rather than accepting a scaffold default.
