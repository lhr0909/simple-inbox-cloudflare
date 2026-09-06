# Simple Inbox

Simple Inbox is a clean-room, self-hosted mail workspace deployed as one Cloudflare Worker named
`simple-inbox-cf`. That Worker exports all three Cloudflare entry points the application needs:

- `fetch()` serves the TanStack Start UI, public documentation, and the versioned Hono API;
- `email()` receives messages from Cloudflare Email Routing;
- `scheduled()` runs the bounded daily retention job.

D1 is the source of truth for queryable state. A private R2 bucket stores canonical RFC 822 `.eml`
objects. The browser never receives a D1 or R2 binding or a public R2 object URL.

This repository is independent from every legacy Cloudflare Inbox repository and deployment. Its
automation creates or updates only `simple-inbox-cf`, `simple-inbox-cf-db`, and
`simple-inbox-cf-raw`. It contains no legacy resource identifiers and never changes DNS, custom
domains, or Email Routing rules.

## Architecture

```text
browser --fetch()--> simple-inbox-cf --> D1
                         |              R2 (private)
Email Routing --email()--+              Email Sending
Cloudflare Cron --scheduled()-----------+
```

The API and mail implementations remain separate packages, but the root Worker calls them through
in-process adapters rather than Cloudflare Service Bindings. Only the root router is public; the
mail package's internal Hono routes are not mapped to public URLs.

| Workspace            | Responsibility                                                        |
| -------------------- | --------------------------------------------------------------------- |
| `apps/web`           | Root Worker entry, TanStack Start UI, setup wizard, API bridge, docs  |
| `packages/api`       | Hono `/v1` contracts, setup, authentication, authorization, inbox API |
| `packages/mail`      | Inbound capture, MIME projection, forwarding, sending, retention      |
| `packages/contracts` | Zod wire contracts, DTOs, errors, and route metadata                  |
| `packages/db`        | Drizzle schema, checked-in D1 migrations, scoped repositories         |
| `packages/mail-core` | Runtime-neutral parsing, threading, rendering, and limit rules        |

Application-owned end-to-end and integration tests live in `apps/web/tests`; shared synthetic
Worker support lives in `packages/test-harness`, and repository checks live in `packages/tooling`.
Each tested package owns a `vite.config.ts`. The root Vite+ config selects unit-test projects;
integration tests and Playwright remain separate commands.

See [the architecture guide](docs/architecture.md),
[ADR 0001](docs/adr/0001-stack-and-topology.md), and
[the operations runbook](docs/operations.md).

## Pinned toolchain

- Node 24.18.1
- pnpm 11.18.0
- Vite+ 0.2.7

Install with the pinned Vite+ launcher:

```sh
vp install --frozen-lockfile
vp run check:generated
vp run check
vp test
vp run build
```

## Local development

Local development uses Wrangler's local D1/R2 implementations and synthetic `example.test`
identities. It does not configure or send through Cloudflare Email Routing or Email Sending.

```sh
cp .dev.vars.example .dev.vars
# Replace both placeholders with different local-only values of at least 32 random bytes.
vp run typegen
vp run dev
```

`vp run dev` applies the checked-in D1 migrations locally before starting the app. Visit `/setup`
and use synthetic values such as `owner@example.test`, `mail.example.test`, and
`inbox@mail.example.test`.

Primary routes:

- `/setup` — one-time owner, mailbox, and retention initialization;
- `/sign-in` and `/auth/verify` — passwordless sign-in;
- `/inbox` — authenticated inbox;
- `/docs` — public embedded documentation;
- `/api/v1/*` — same-origin versioned API.

## Deploy

The root [wrangler.jsonc](wrangler.jsonc) declares the one Worker, D1 database, private R2 bucket,
Email Sending binding, rate limiter, and daily cron. Wrangler provisions the declared D1 and R2
resources when the deployment first needs them; no resource IDs are copied into the repository.

Before a real deployment, authenticate Wrangler to the intended Cloudflare account and run the
local verification suite in [the operations runbook](docs/operations.md). Cloudflare requires Email
Routing to be enabled and at least one owner-controlled destination to be verified before it can
attach the `EMAIL` binding; do that on the intended new mail zone without changing a legacy route.
Full compose and reply delivery to arbitrary recipients also requires Workers Paid and an onboarded
Email Sending domain.

Deploy to Cloudflare uses the following remote, state-changing command after it provisions the
declared resources; it builds the app, applies checked-in D1 migrations remotely, and deploys the
generated Worker configuration:

```sh
vp run deploy
```

For a first manual deployment outside Deploy to Cloudflare, use `vp run deploy:first` so Wrangler
can provision and bind the empty D1/R2 resources before migrations run. Subsequent manual upgrades
use `vp run deploy`.

Create two independent Worker secrets of at least 32 random bytes:

- `AUTH_TOKEN_PEPPER` protects magic-link, session, and API-token digests;
- `SETUP_TOKEN` authorizes the first and only installation setup.

After deployment, open the Worker's HTTPS origin at `/setup`. The wizard verifies `SETUP_TOKEN` and
atomically creates the owner, primary mailbox, owner membership, application origin, mail domain,
and retention settings in D1. Until setup completes, inbound email is rejected, retention is idle,
and protected API routes fail closed.

Email Sending domain verification, the private R2 lifecycle backstop, and activation of an Email
Routing rule remain explicit Cloudflare Dashboard owner actions. Deploying code never switches an
existing route or touches a legacy Worker or data store.

### Future Deploy to Cloudflare button

Once this repository is public, it can use Cloudflare's one-click flow:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lhr0909/simple-inbox-cloudflare)

Cloudflare's deploy button only works for public GitHub or GitLab repositories. This repository is
currently private, so the link is guidance for the future public release and will not work for other
users until then. See Cloudflare's
[Deploy to Cloudflare button documentation](https://developers.cloudflare.com/workers/platform/deploy-buttons/).

## Security and retention

Magic links and sessions are opaque random values; D1 stores only keyed digests. Deployed sessions
use a Secure, HttpOnly, SameSite=Lax `__Host-` cookie. Cookie-authenticated mutations require a
same-origin request, and every mailbox/thread/message lookup is scoped to the authenticated owner.

Raw mail is sensitive. Keep R2 private, invocation logs and automatic traces disabled, and message
content, addresses, tokens, object keys, and attachment bytes out of logs. The setup wizard requires
an explicit retention decision: raw retention must not exceed application-record retention, both
must be 1–3,650 days, and each scheduled batch is capped at 100. Export required data and test D1
restoration before shortening a policy; Worker rollback cannot restore deleted D1/R2 data.

The application performs no AI inference and sends mailbox content to no AI service. Report
vulnerabilities through [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Xanthous Tech LLC.
