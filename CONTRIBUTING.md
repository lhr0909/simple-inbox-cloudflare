# Contributing

Thanks for helping build Cloudflare Inbox. This repository is an independent clean-room,
multi-Worker implementation. Product work belongs in `apps/`, `workers/`, or `packages/`; no
legacy application source or deployment configuration is retained here.

## Prerequisites

- Node.js 24.18.1 (see `.node-version`)
- pnpm 11.18.0 (declared by `packageManager`)
- a Cloudflare account only when exercising Worker bindings or staging deployment

Vite+ provisions the declared runtime and package manager. Install the workspace from the root:

```sh
vp install --frozen-lockfile
```

Never use an unpinned `latest` scaffold or dependency command in automation. External dependencies
must use the root pnpm catalog, and internal dependencies must use `workspace:*`.

## Local workflow

```sh
vp run dev                 # start package dev tasks in parallel
vp run check               # format, lint, type-check, and architecture boundaries
vp test                    # fast unit tests
vp run test:worker         # Workers runtime tests
vp run build               # production builds in dependency order
```

Run `vp config --hooks-dir .vite-hooks --no-agent` once if you want Vite+'s pre-commit integration.
The hook runs the staged rules in `vite.config.ts`; CI remains authoritative.

Package-specific commands can be targeted without changing directories:

```sh
vp run @cloudflare-inbox/web#dev
vp run @cloudflare-inbox/api#test
vp run @cloudflare-inbox/mail#cf-typegen
```

Keep `.dev.vars` local. Copy only documented example keys and use synthetic email data in fixtures.
Never put customer mail, API tokens, session cookies, magic links, attachment bytes, or resource IDs
for private accounts in commits, issues, snapshots, or logs.

## Architecture rules

- Import another workspace only through an export declared by that package.
- Keep web code independent of D1, R2, and mail-core.
- Keep contracts and mail-core independent of React, concrete Cloudflare bindings, and request
  context objects.
- Put SQL and D1 access in `packages/db`; route handlers call repositories.
- Put direct `MAIL.fetch()` calls behind the API mail client.
- Read Worker configuration from typed `env` bindings, never `process.env`.
- Use the structured logger and do not log message content or credentials.

Run `vp run check:boundaries` after changing package dependencies or moving code across layers. The
checker has dependency-free tests:

```sh
vp run test:boundaries
```

## Generated files

Route trees, Cloudflare binding types, OpenAPI output, and Drizzle migration metadata are reviewed
artifacts. Regenerate them with their package scripts, inspect the diff, and commit them. CI runs
the generators and then `vp run check:generated` to detect drift. Never generate a migration as
part of a production deploy.

## Pull requests

Keep commits and pull requests focused on one concern. Include:

- the behavior and architectural layer changed;
- the commands run and their results;
- screenshots for visible UI changes at relevant breakpoints;
- binding, migration, privacy, and rollback impact when applicable;
- an ADR update when intentionally changing a recorded decision.

Use synthetic data in all examples. Do not deploy a contributor branch to production. This
repository has no automatic deployment workflow: maintainers run the guarded replacement-only
operator scripts manually after CI, with both explicit confirmations required for production.

## License status

The public license is an explicit owner decision and is not selected yet. Until a `LICENSE` file is
added, copyright law reserves reuse rights; contributions do not imply a license choice.

By participating, you agree to follow [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). For security
reports, follow [SECURITY.md](./SECURITY.md) instead of opening a public issue.
