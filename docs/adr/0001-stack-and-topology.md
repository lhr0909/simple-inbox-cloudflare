# ADR 0001: Stack and Worker topology

- Status: accepted for implementation; external Phase 0 validation pending
- Date: 2026-08-01
- Owners: project maintainers

## Context

The previous root application combines UI, browser API, persistence, and mail-event behavior in one
Waku Worker. The clean-room replacement needs independently deployable web, API, and mail surfaces,
strict data boundaries, one deterministic toolchain, and a path to staging/cutover without importing
the old data store.

The ecosystem is moving quickly. Reproducibility therefore matters more than tracking floating tags.
All package manifests consume the root pnpm catalog; internal dependencies use `workspace:*`.

## Decision

Use Node 24 with pnpm 11 and Vite+ at the monorepo root. Deploy a TanStack Start web Worker and two
Hono Workers. Keep schemas/contracts, D1 access, and runtime-neutral mail behavior in separate source
packages. Use shadcn's Base UI output only inside the web app and embed Fumadocs in TanStack Start.

### Toolchain and scaffold pins

| Component                      | Version                                  |
| ------------------------------ | ---------------------------------------- |
| Node.js                        | 24.18.1                                  |
| pnpm                           | 11.18.0                                  |
| Vite+ / `vite-plus`            | 0.2.7                                    |
| Vite resolution                | `npm:@voidzero-dev/vite-plus-core@0.2.7` |
| TypeScript                     | 7.0.2                                    |
| React / React DOM              | 19.2.5                                   |
| TanStack Start                 | 1.168.34                                 |
| TanStack React Router          | 1.170.18                                 |
| TanStack Router Devtools       | 1.167.0                                  |
| TanStack Router CLI / plugin   | 1.167.21 / 1.168.23                      |
| Cloudflare Vite plugin         | 1.50.0                                   |
| Wrangler                       | 4.118.0                                  |
| Hono                           | 4.12.33                                  |
| shadcn CLI                     | 4.16.1                                   |
| Base UI                        | 1.6.0                                    |
| Fumadocs core / UI             | 16.14.0                                  |
| Fumadocs MDX                   | 15.2.1                                   |
| Drizzle ORM / Kit              | 0.45.2 / 0.31.10                         |
| Vitest                         | 4.1.10                                   |
| Cloudflare Workers Vitest pool | 0.20.1                                   |

The catalog also pins scaffold support packages such as React types, Tailwind, Zod/OpenAPI,
postal-mime, and Playwright. `pnpm-workspace.yaml` is the source of truth for their exact values.
Vite and Vitest are overridden workspace-wide so plugins do not load split tool copies.
TanStack publishes Start, Router, Devtools, CLI, and plugin independently; the versions above are
the registry-verified compatible set rather than an assumed shared release number.

### Repository topology

```text
apps/web              TanStack Start, UI, docs, same-origin API bridge
workers/api           browser-facing Hono API and authorization
workers/mail          Hono private commands plus module Worker email() handler
packages/contracts    schemas, DTOs, errors, API type surface
packages/db           Drizzle schema, migrations, repositories
packages/mail-core    runtime-neutral mail logic
tooling/scripts       architecture, generated-drift, and deploy checks
tests/integration     multi-Worker harness
tests/e2e             Playwright against explicit local/deployed base URL
```

Web has no D1/R2 binding. API owns browser authentication and calls mail through a private Service
Binding. Mail owns email events and raw message access. Package exports and the boundary checker
enforce the dependency direction recorded in `docs/architecture.md`.

### Root command contract

```text
vp install --frozen-lockfile
vp run dev
vp run check
vp test
vp run test:worker
vp run build
vp run typegen
vp run db:generate
vp run db:migrate -- --env staging --dry-run
vp run db:migrate -- --env staging --confirm-migrate
vp run deploy -- --env staging --dry-run
vp run deploy -- --env staging --confirm-replacement-deploy
```

The ordinary root build uses `vp run` to dispatch package tasks. Deployment deliberately bypasses
the task cache: it runs a direct package-local `vp build` with the selected `CLOUDFLARE_ENV`,
validates the flattened Vite output and deployment redirect, applies checked-in remote migrations,
then runs plain package-local `wrangler deploy` in mail -> API -> web order and performs passive
smoke checks. It never changes routes or Email Routing.

### Test approach

- Vite+ runs fast Node/DOM unit tests from the root.
- Each Worker exposes `test:worker` using the Cloudflare Vitest pool.
- The integration harness starts the configured Workers together and proves
  `web -> API -> mail` with a web-generated trace ID and a synthetic email event. It also proves
  that an untrusted browser-supplied request ID is replaced at the web boundary.
- Playwright tests an explicit base URL and never rely on a developer's ambient deployment.
- Staging smoke tests cover real inbound/outbound/auth flows only after account approval.

## Consequences

Exact pins make upgrades deliberate and reviewable but require a coordinated catalog/lockfile PR.
Vite+ remains beta; if its task runner blocks the project, keep pnpm workspaces and call the pinned
underlying tools directly. If the Cloudflare Vite plugin cannot build a plain Hono Worker, keep the
root Vite+ policy and use that package's pinned Wrangler build/deploy script.

No shared UI package is created until there is a second real UI consumer. No React Server Components,
Queue, AI, billing, marketing site, or proprietary runtime is part of this decision.

## Validation and deviations still open

This foundation change does not claim the external Phase 0 proof. Before feature work is considered
production-ready, staging must prove Service Bindings end to end, the mail Worker's combined
`fetch`/`email` export, arbitrary-recipient Email Sending availability, and synthetic mail capture.

This repository was initialized as a clean slate. It contains no legacy Waku source, npm lockfile,
customer fixture, deployment binding, or Git history. The legacy repository and its deployed
Cloudflare resources remain separate and read-only; only the sanitized migration handoff was copied
here as a design record. This workspace has one root `pnpm-lock.yaml`.

The repository license is deliberately unresolved. Maintainers must choose Apache-2.0 or AGPL-3.0
before the first public release; no scaffold may choose silently.
