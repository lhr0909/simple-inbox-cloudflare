# Cloudflare Inbox clean-room migration handoff

Status: implementation-ready plan

Research date: 2026-08-01

Target: a new public Git repository; this repository is a behavior reference only

## 1. Purpose

Rebuild Cloudflare Inbox from a clean slate as a small suite of Cloudflare Workers:

- a TanStack Start web Worker for the authenticated inbox and embedded static docs;
- a Hono API Worker for authentication and the public/browser API;
- a Hono-based mail Worker that can receive and send email without the web app;
- D1 for queryable application state, using Drizzle ORM and checked-in SQL migrations;
- R2 only for raw RFC 822 email objects (`.eml`), not JSON records, settings, or separately stored attachment blobs.

The current Waku application must not be migrated file by file. Treat it as an executable product specification: observe its production behavior, read its focused domain tests, and reimplement that behavior behind clean contracts. There is no URL, storage-format, or data-migration compatibility requirement.

This document is intentionally portable. Copy it into the new repository before implementation and keep it updated as architecture decisions become code.

## 2. Decisions already made

### 2.1 Product and route decisions

- `/` performs only an auth-aware redirect:
  - valid, unexpired session -> `/inbox`;
  - no valid session -> `/sign-in`.
- `/inbox` is the protected inbox application.
- `/sign-in` and `/auth/verify` implement passwordless magic-link sign-in.
- `/docs` is a public, build-time Fumadocs site embedded in the TanStack Start Worker.
- There is no landing page in this repository.
- Marketing, public installation documentation, pricing, and paid-offering documentation belong in a different repository.
- Embedded `/docs` should cover product usage, operator help, the API, privacy/security behavior, and troubleshooting. Do not duplicate the external marketing or installation site.
- Preserve the current inbox behavior: mailbox selection, All/Sent/Needs reply/Archive organization, unread filtering, search, conversation threading, reply targeting, editable recipients, attachments, sender aliases, raw-message downloads, reply-alias relay, and forwarding to the owner.

### 2.2 Architecture decisions

- Keep a pnpm workspace monorepo by default. pnpm and Vite+ both support this layout, and shared contracts/domain code are valuable for three Workers. Use pnpm's explicit `workspace:*` protocol for internal packages: [pnpm workspaces](https://pnpm.io/workspaces). Vite+ supports a root configuration plus package-specific Vite configurations in a monorepo: [Vite+ monorepo guide](https://viteplus.dev/guide/monorepo).
- Use Vite+ across the workspace for environment management, package-manager dispatch, formatting, linting, type checking, tests, builds, task orchestration, caching, and commit hooks. Vite+ is still presented as beta, so pin it and preserve an exit ramp to direct Vite/Vitest/Oxlint/Oxfmt commands: [Vite+](https://viteplus.dev/) and [getting started](https://viteplus.dev/guide/).
- Scaffold the frontend fresh with the current TanStack CLI rather than adapting the Waku tree. The current official minimal command is `npx @tanstack/cli create my-app --blank --deployment cloudflare -y`: [TanStack CLI quick start](https://tanstack.com/cli/latest/docs/quick-start).
- Use the official Cloudflare Vite plugin for all three deployable Workers. It supports TanStack Start, standalone Workers, and multi-Worker applications: [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/).
- Initialize shadcn/ui through its CLI with Base UI explicitly selected. Base UI is the current default for new shadcn projects, but pass the flag so the choice remains visible: [shadcn CLI](https://ui.shadcn.com/docs/cli) and [Base UI default announcement](https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default).
- Add Fumadocs manually to the already-created TanStack Start app, following its TanStack Start and Vite MDX instructions: [TanStack Start installation](https://www.fumadocs.dev/docs/manual-installation/tanstack-start) and [Vite MDX setup](https://www.fumadocs.dev/docs/mdx/vite).
- The browser talks to the API through the web origin. The web Worker forwards `/api/v1/*` to the API Worker over a private Cloudflare Service Binding. This avoids cross-origin cookies and CORS while keeping domain logic out of TanStack Start. Service Bindings are designed for private Worker-to-Worker calls: [Cloudflare Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/).
- The API Worker calls the mail Worker through another Service Binding. The mail Worker exports both Hono's `fetch` handler and Cloudflare's `email()` handler.
- The API and mail Workers bind the same D1 database. Both may use the same repositories, but only through the shared database package.
- The API and mail Workers bind the same private R2 bucket. The web Worker has no direct D1 or R2 binding.
- Do not add Queues in this rebuild. Keep use cases and side effects separated so a queue processor can be added later without rewriting parsing or persistence.

### 2.3 Monorepo and “one-click” deployment

The monorepo is not the blocker for development or CI. The blocker is Cloudflare's native Deploy to Cloudflare button: Cloudflare currently states that multiple Worker applications in a monorepo are not deployed together, and public deploy buttons require a public repository. See [Deploy to Cloudflare button limitations](https://developers.cloudflare.com/workers/platform/deploy-buttons/).

Therefore:

1. Keep the monorepo and the separate Workers.
2. Make local/CI provisioning and deployment deterministic from the workspace root.
3. Treat a hosted OAuth installer as a later control-plane product, not part of this migration.
4. Do not collapse the API, email handler, and UI into one Worker merely to obtain the native button.

If a phase-zero spike finds a genuine Vite+/workspace incompatibility, retain the same three-service architecture and fall back in this order:

1. pnpm workspace with direct Vite, Vitest, Oxlint, and Oxfmt commands;
2. only if the workspace itself is demonstrably blocking deployment, three repositories plus versioned contract packages.

Splitting repositories does not make Cloudflare deploy three Workers atomically; it only makes three separate deploy buttons possible. A custom installer is still the coherent one-click path.

## 3. Scope and non-goals

### In scope

- fresh workspace/toolchain and public-repository hygiene;
- three deployable Workers and private Service Bindings;
- D1 schema, Drizzle repositories, migrations, and seed/bootstrap flow;
- inbound capture, owner forwarding, reply aliases, outbound send/reply, and attachments;
- Hono `/v1` API with validated contracts and OpenAPI output;
- secure magic-link sessions and optional scoped bearer API tokens;
- the current responsive inbox experience rebuilt with current shadcn/Base UI components;
- embedded public Fumadocs;
- local, integration, browser, and deployed smoke tests;
- staging deployment and a reversible production cutover.

### Explicitly out of scope

- compatibility with Waku routes or R2 JSON keys;
- importing existing R2 messages or sessions;
- dual reads, dual writes, or a rolling application-level migration;
- a queue producer/consumer;
- AI behavior, billing, licensing enforcement, or proprietary features;
- a marketing site or public installation portal;
- multi-tenant SaaS control-plane behavior;
- a native Deploy to Cloudflare button for the whole suite;
- redesigning the visual language. This is a faithful rebuild with newer primitives.

Operational rollback is still required: the old deployment can remain available until cutover, and Email Routing/web routes can be pointed back to it. That is not backward compatibility in the new codebase.

## 4. Target topology

```text
Browser
  |
  | HTTPS: pages, assets, same-origin /api/v1/*
  v
web Worker (TanStack Start + shadcn/Base UI + Fumadocs)
  |
  | private Service Binding: API.fetch(request)
  v
api Worker (Hono /v1, auth, authorization, OpenAPI)
  |                         |
  | D1 + R2 bindings        | private Service Binding: MAIL.fetch(request)
  |                         v
  +-------------------- mail Worker (Hono fetch + email event)
                              |       |        |
                              |       |        +-- Cloudflare Email Service send binding
                              |       +----------- R2 raw .eml objects
                              +------------------- D1 metadata/state

Cloudflare Email Routing catch-all
  |
  +-- email(message, env, ctx) -> mail Worker
```

### Worker responsibilities

| Workspace      | Public surface                                                                      | Bindings                                  | Owns                                                                                              | Must not own                                                |
| -------------- | ----------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `apps/web`     | `/`, `/sign-in`, `/auth/verify`, `/inbox`, `/docs/*`, same-origin `/api/v1/*` proxy | `API` Service Binding, static assets      | SSR/routing, UI state, Fumadocs, forwarding API responses and cookies                             | SQL, MIME parsing, mail send logic, authorization decisions |
| `workers/api`  | Hono `/v1`; private by default, optionally exposed for bearer-token clients         | `DB`, `RAW_EMAILS`, `MAIL`, rate limiters | auth, mailbox authorization, query/mutation orchestration, raw/attachment downloads, OpenAPI      | email event handling, rendering pages                       |
| `workers/mail` | private Hono `/internal/v1/*`; Cloudflare `email()` event                           | `DB`, `RAW_EMAILS`, `EMAIL`               | MIME parsing, inbound capture, forwarding, reply-alias relay, outbound submission and persistence | browser sessions, UI                                        |

The mail Worker is “standalone” in the runtime sense: it has its own configuration and deploy, exports `fetch` and `email`, and can send/receive with only its bindings. In production, disable its `workers.dev` URL and give it no public route; the API reaches its Hono endpoint through a Service Binding. Do not interpret standalone as “unauthenticated public send endpoint.”

## 5. Proposed repository layout

```text
.
├── apps/
│   └── web/
│       ├── content/docs/
│       ├── public/
│       ├── src/
│       │   ├── components/
│       │   │   ├── inbox/
│       │   │   └── ui/          # shadcn CLI-owned source
│       │   ├── features/
│       │   ├── lib/
│       │   ├── routes/
│       │   ├── router.tsx
│       │   └── styles/
│       ├── components.json
│       ├── source.config.ts
│       ├── vite.config.ts
│       └── wrangler.jsonc
├── workers/
│   ├── api/
│   │   ├── src/
│   │   │   ├── middleware/
│   │   │   ├── routes/
│   │   │   ├── services/
│   │   │   └── index.ts
│   │   ├── test/
│   │   ├── vite.config.ts
│   │   ├── vitest.config.ts
│   │   └── wrangler.jsonc
│   └── mail/
│       ├── src/
│       │   ├── handlers/
│       │   ├── services/
│       │   └── index.ts
│       ├── test/fixtures/
│       ├── vite.config.ts
│       ├── vitest.config.ts
│       └── wrangler.jsonc
├── packages/
│   ├── contracts/               # Zod schemas, DTOs, error codes, Hono AppType
│   ├── db/                      # Drizzle schema, migrations, repositories
│   └── mail-core/               # runtime-neutral parsing/threading/render helpers
├── tooling/
│   ├── lint/                    # shared/custom Vite+/Oxlint configuration
│   └── scripts/                 # boundary, OpenAPI, bootstrap, deploy checks
├── tests/
│   ├── integration/             # multi-Worker harness
│   └── e2e/                     # Playwright
├── .github/workflows/
├── .node-version
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── vite.config.ts               # Vite+ workspace policy and tasks
```

Do not create a shared UI package initially. Only the web app consumes shadcn components, and keeping `components.json`, the Tailwind entrypoint, and `src/components/ui` together makes CLI upgrades predictable. Extract a UI package only after a second real consumer exists.

### Dependency direction

```text
contracts <- web
contracts <- api -> db
contracts <- mail -> db
                mail -> mail-core
api ----------------> mail-core (only for shared request normalization if needed)
```

Enforce these rules:

- workspace code imports another workspace only through its declared package exports;
- no deep imports across workspaces;
- `web` cannot import `db` or `mail-core`;
- `contracts` and the pure portions of `mail-core` cannot import `cloudflare:*`, Hono context objects, React, or concrete bindings;
- route handlers do not contain SQL;
- repositories do not know about HTTP responses;
- Cloudflare bindings are passed at the edge of each request/event;
- do not read `process.env` in Worker code; use generated binding types and `env`.

Implement a workspace-boundary check under `tooling/scripts` and run it through Vite+ in CI. If an Oxlint JavaScript plugin is a clean fit, use it; Vite+ documents JavaScript plugin support for critical custom rules: [Vite+ lint guide](https://viteplus.dev/guide/lint).

## 6. Phase 0: validate the stack before building features

Time-box this spike to one working day. It is the only point at which changing the repository topology should be considered.

1. Create an empty Git repository and a feature branch.
2. Install the current `vp`, record `vp --version`, and pin the matching local `vite-plus` version. Vite+ can pin its installer with `VP_VERSION`: [installer variables](https://viteplus.dev/guide/installer-env-vars).
3. Use Node 24 and pnpm 11 unless current scaffold requirements demand a newer compatible version. Fumadocs requires Node 22 or newer, while Vite+'s current CI examples use Node 24: [Fumadocs quick start](https://www.fumadocs.dev/docs) and [Vite+ CI](https://viteplus.dev/guide/ci).
4. Create the pnpm workspace and minimal `web`, `api`, and `mail` packages.
5. Make each Worker return a distinct health response.
6. Bind web -> API and API -> mail with Service Bindings.
7. Run all three locally, build all three, and deploy all three to a throwaway Cloudflare staging account/environment.
8. Prove one request can travel browser/web -> API -> mail and return a trace ID.
9. Prove the mail Worker's `email()` export deploys alongside Hono's `fetch` export.
10. Record exact scaffold/tool versions and any generated-file deviations in an ADR.

Go forward with the monorepo when this passes. If Vite+ is the only failure, keep pnpm workspaces and use the direct underlying tools. If the Cloudflare Vite plugin is the failure for a plain Hono Worker, keep Vite+ for policy/tasks and let Wrangler build that Worker; do not split the repository merely because one package uses `wrangler deploy`.

## 7. Workspace and toolchain bootstrap

All commands below are starting points, not permission to ignore current CLI help. The ecosystem is moving quickly. At implementation time, run each CLI's `--help`, follow the linked current documentation, then commit the resulting lockfile and generated configuration. Never run an unpinned `latest` command in CI.

### 7.1 Create the workspace

Vite+ can create a monorepo and can invoke community templates: [creating a Vite+ project](https://viteplus.dev/guide/create). In a new empty repository, use the current equivalent of:

```bash
vp create vite:monorepo --directory . --package-manager pnpm --no-git
```

Then normalize the generated workspace to the layout in section 5. The root must contain:

- `packageManager` pinned to an exact pnpm 11 release;
- `.node-version` pinned to an exact Node 24 release;
- an exact local `vite-plus` development dependency;
- `private: true`;
- `pnpm-workspace.yaml` covering `apps/*`, `workers/*`, `packages/*`, and `tooling/*` as appropriate;
- `workspace:*` for internal dependencies;
- one lockfile, with no nested lockfiles or nested `.git` directories.

Vite+ detects and dispatches to the declared package manager, and can write a deterministic package-manager declaration when it detects a workspace: [Vite+ dependency installation](https://viteplus.dev/guide/install).

### 7.2 Scaffold TanStack Start, do not copy Waku

Run the TanStack CLI from the workspace root. The current non-interactive shape is:

```bash
pnpm dlx @tanstack/cli@latest create apps/web --blank --deployment cloudflare -y
```

If the current CLI does not accept a path as the project name, scaffold into a temporary child directory, move only the generated project files into `apps/web`, and remove its nested lockfile and `.git`. Do not copy any Waku route, generated page file, or server entrypoint.

The official Cloudflare TanStack Start guide currently configures:

- `@cloudflare/vite-plugin` with the `ssr` Vite environment;
- `@tanstack/react-start/plugin/vite`;
- `@vitejs/plugin-react`;
- `main: "@tanstack/react-start/server-entry"`;
- `nodejs_compat` and observability.

Compare the generated app to [Cloudflare's TanStack Start guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/) and [TanStack Start hosting](https://tanstack.com/start/latest/docs/framework/react/guide/hosting). Keep the CLI's current working structure if it differs from examples in this document.

Use stable Start features only: file routing, loaders, server routes, SSR, and the standard server entrypoint. Do not adopt experimental React Server Components. TanStack's overview identifies RSC support as experimental: [TanStack Start overview](https://tanstack.com/start/latest/docs/framework/react/overview).

### 7.3 Scaffold the Hono Workers

Use `create-hono` with its current Cloudflare Worker template for both `workers/api` and `workers/mail`, then add the official Cloudflare Vite plugin to each package. Start from the official shapes rather than inventing an adapter: [Hono on Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers), [create-hono](https://hono.dev/docs/guides/create-hono), and [Hono Cloudflare Workers + Vite](https://hono.dev/docs/getting-started/cloudflare-workers-vite).

Conceptually:

```bash
pnpm create hono@latest workers/api --template cloudflare-workers
pnpm create hono@latest workers/mail --template cloudflare-workers
```

Remove demo JSX/static assets from the Hono packages. They are JSON/internal APIs, not additional frontends. Configure a package-local `vite.config.ts` with `@cloudflare/vite-plugin`; retain `wrangler.jsonc` as the binding/deployment source of truth.

The API Worker may export its Hono app directly. The mail Worker must use the module-Worker multi-handler shape documented by Hono:

```ts
const app = new Hono<{ Bindings: CloudflareBindings }>()

export default {
  fetch: app.fetch,
  email: receiveEmail,
} satisfies ExportedHandler<CloudflareBindings>
```

Hono handles `fetch`; a plain TypeScript function handles the non-HTTP `email` event. Calling the entire mail Worker “Hono” must not lead to forcing an email event through an HTTP abstraction.

### 7.4 Configure Vite+ once, consume it everywhere

Use a root `vite.config.ts` imported from `vite-plus` for shared policy:

- Oxfmt formatting;
- Oxlint with `typeAware: true` and `typeCheck: true`;
- TypeScript, React, and Vitest overrides by workspace;
- staged checks;
- recursive `check`, `test`, `build`, `typegen`, and boundary tasks;
- ignore lists limited to generated files (`routeTree.gen.ts`, `.source`, build output, generated Cloudflare types).

Vite+ documents that `vp check` combines format, lint, and type checks: [Vite+ check](https://viteplus.dev/guide/check). It also supports root overrides while preserving package-local Vite/Vitest/framework configs: [Vite+ monorepo guide](https://viteplus.dev/guide/monorepo).

Every workspace package must expose consistent tasks that Vite+ can orchestrate. A reasonable root contract is:

```text
vp check                     # static checks for the whole workspace
vp test                      # fast/unit tests configured from the root
vp run -r test:worker        # Worker-runtime projects
vp run -r build              # package-specific production builds
vp run -r cf-typegen         # generated Cloudflare binding types
vp run test:integration      # multi-Worker harness
vp run test:e2e              # Playwright against an explicit base URL
```

Use `vp run`, not an assumption that built-in `vp build` executes a package's custom `build` script; Vite+ documents that distinction in its [troubleshooting guide](https://viteplus.dev/guide/troubleshooting).

Install Vite+ commit hooks with `vp config` and configure `vp staged` rather than adding another staged-file framework: [Vite+ commit hooks](https://viteplus.dev/guide/commit-hooks). Hooks are a developer convenience; CI is authoritative.

### 7.5 Code-quality policy

Start with strict TypeScript and enforce at least:

- no implicit `any` and no unchecked index access;
- no floating promises;
- exhaustive switches for domain states;
- no cross-workspace deep imports;
- no raw SQL outside `packages/db` migrations/repositories;
- no direct `fetch` to the mail Worker outside the API mail client;
- no direct D1/R2 access in Hono route modules;
- no `console.log` except through the structured logger (allow `warn`/`error` only during bootstrap if needed);
- no secrets, raw email bodies, auth tokens, magic-link URLs, or attachment bytes in logs;
- no unsanitized `dangerouslySetInnerHTML`;
- no `asChild` copied from Radix examples in Base UI components—Base UI commonly uses `render` instead;
- imports from concrete modules instead of broad barrel files on hot paths.

Use an explicit boundary script for architectural rules that a stock linter cannot express clearly. Keep it deterministic and fast enough for `vp staged` and CI.

### 7.6 CI baseline

Use the official `voidzero-dev/setup-vp@v1` action and pin action SHAs before public release. The current Vite+ CI sequence is `vp install`, `vp check`, `vp test`, `vp build`: [Vite+ CI](https://viteplus.dev/guide/ci).

The pull-request workflow should run:

1. frozen dependency install;
2. generated-file drift check (`routeTree`, Cloudflare types, OpenAPI, Drizzle migrations metadata);
3. `vp check`;
4. unit tests;
5. Worker-runtime tests;
6. production builds for all Workers and packages;
7. multi-Worker integration tests;
8. Playwright against locally built Workers for UI-affecting changes;
9. secret scanning and dependency review.

Deploy staging only after CI. Production deploys should require an environment approval until the replacement has been used safely for a while.

## 8. shadcn/ui and visual parity

### 8.1 Installation order

Install shadcn after the blank TanStack Start app builds successfully and before rebuilding the inbox. Use the CLI, never copied registry source. The current TanStack guidance supports app-local CLI operations in a monorepo: [shadcn TanStack Start installation](https://ui.shadcn.com/docs/installation/tanstack).

Run the current equivalent of:

```bash
pnpm dlx shadcn@latest init --template start --base base --cwd apps/web
pnpm dlx shadcn@latest info --json --cwd apps/web
```

Choose a neutral Nova-like preset with Lucide icons to stay close to the current product, save the resulting preset/configuration in `components.json`, and verify the info output says Base UI. Explicitly inspect CLI diffs:

```bash
pnpm dlx shadcn@latest add button badge dialog field input input-group textarea \
  select tabs toggle-group sidebar scroll-area separator resizable sheet dropdown-menu \
  tooltip collapsible skeleton empty sonner --cwd apps/web --dry-run
```

Then add only the components actually used. Before implementing a component, fetch its current API documentation with `shadcn docs`; when updating a component, use `--diff` first. The CLI provides `docs`, `view`, `--dry-run`, and `--diff`: [shadcn CLI reference](https://ui.shadcn.com/docs/cli).

As of the research date, a CLI search of the official registry did not expose the old “mail/inbox” block as an installable current block. Do not stall waiting for it and do not paste an old Radix-based block. Rebuild the existing interface from current Base UI-backed primitives.

### 8.2 Capture the current app as a specification

Before writing the new inbox components:

1. Use the current live application and the current repository as the reference.
2. With Playwright Interactive (when available), capture authenticated screenshots and interaction notes at phone, tablet, desktop, and wide-desktop widths.
3. Record empty, loading, populated, unread, search-empty, archived, send-error, refresh-error, settings-dialog, attachment-preview, and mobile detail states.
4. Record keyboard order, focus treatment, dialog behavior, scroll ownership, and panel resizing.
5. Save a small visual-parity checklist in the new repository. Do not copy screenshots containing private mail into the public repository; use seeded fixture data for committed baselines.

### 8.3 Required inbox behavior and layout

Wide desktop (`xl` and above):

- three full-height panes;
- collapsible mailbox navigation, approximately 18% expanded / 5% collapsed with sensible pixel minimums;
- thread list approximately 32%;
- conversation/reply pane fills the remainder;
- resizable separators with keyboard-accessible handles.

Tablet/small desktop (`md` through `xl`):

- compact mailbox/folder header;
- two columns, thread list roughly 38% with a 280px minimum and conversation in the remainder.

Phone (below `md`):

- compact mailbox/folder header;
- list and detail are separate panes, not squeezed columns;
- selecting a thread opens detail; a visible back action returns to the list;
- navigation state participates in history so the browser back action is useful.

Functional parity checklist:

- switch between all discovered mailboxes;
- display and update a sender alias per mailbox;
- refresh with a visible pending state and non-destructive error;
- All mail, Needs reply, Sent, and Archive counts and filters;
- All/Unread toggle;
- debounced search across mailbox, subject, participants, preview/body, status, and tags;
- selected thread, unread indicator, latest-time label, status and attachment badges;
- chronological messages with safe body rendering;
- choose any inbound message as the reply target;
- default reply recipient from the latest inbound `Reply-To`, falling back to `From`;
- editable To, CC, and BCC;
- plain text/Markdown composition and attachment add/remove;
- optimistic mark-read and archive/unarchive with rollback and toast/error state;
- send pending/success/failure states without duplicate submission;
- raw `.eml` download and authenticated attachment download;
- responsive settings dialog and sign-out.

Do not recreate the current monolithic client snapshot. Put mailbox/folder/query/thread selection in validated route search parameters and fetch paginated summaries separately from thread detail. Use TanStack route loaders for the initial request and TanStack Query only where it materially improves mutation/invalidation behavior. Fetch independent data in parallel and avoid serial client/server waterfalls. Protect data at the API boundary, not only in `beforeLoad`; TanStack's own server-function guidance makes that distinction: [TanStack Start server functions and data-boundary auth](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions).

### 8.4 HTML and accessibility rules

- Render inbound plain text by default.
- Never render arbitrary inbound HTML into the app document. If rich inbound HTML is added, sanitize it with an audited allowlist and render it in a sandboxed, origin-isolated iframe; that is a separate security-reviewed feature.
- App-generated outbound HTML may be previewed only from the stored trusted source generated by `mail-core`.
- Every dialog/sheet has a title and description, including visually hidden text where appropriate.
- Icon-only actions have accessible names and tooltips where the meaning is not obvious.
- Use shadcn `Field`/field groups for forms, semantic color tokens, `gap-*` for spacing, and `size-*` for square icons/actions.
- Verify keyboard use, visible focus, screen-reader names, reduced motion, and 200% zoom.

## 9. Fumadocs inside TanStack Start

Fumadocs is part of `apps/web`; it is not a fourth deployment.

### 9.1 Install and configure

Follow the current manual TanStack Start instructions rather than the Waku integration. The official setup requires Tailwind CSS 4, Fumadocs MDX, `fumadocs-core`, `fumadocs-ui`, `RootProvider` from `fumadocs-ui/provider/tanstack`, docs routes, and a search route: [Fumadocs TanStack Start manual installation](https://www.fumadocs.dev/docs/manual-installation/tanstack-start).

The Vite content setup currently requires `fumadocs-mdx`, `fumadocs-core`, `@types/mdx`, `source.config.ts`, the `fumadocs-mdx/vite` plugin, generated `.source` collections, and a loader with `baseUrl: '/docs'`: [Fumadocs MDX with Vite](https://www.fumadocs.dev/docs/mdx/vite).

Implementation order:

1. Confirm Tailwind 4 and shadcn build on the blank app.
2. Install Fumadocs packages in `apps/web`.
3. Add `source.config.ts` and `content/docs`.
4. Add `mdx()` to the existing Vite plugin list without disturbing the Cloudflare/TanStack ordering.
5. Add the generated collection alias and ignore `.source` in lint/format while keeping it out of hand-edited source.
6. Wrap the root in the TanStack-specific Fumadocs `RootProvider`.
7. Add `/docs` and `/docs/$` routes plus the documented static search route.
8. Build and deploy immediately, before authoring extensive docs.

Fumadocs documents a Vite pre-bundling issue and recommends excluding its packages from pre-bundling/adding them to `noExternal`: [Fumadocs Vite FAQ](https://www.fumadocs.dev/docs). Apply the current documented setting only if it is still required by the pinned versions, and cover it with a production build test.

### 9.2 CSS integration

Maintain one Tailwind entrypoint. Combine the imports required by shadcn and Fumadocs rather than importing Tailwind twice. Keep generated shadcn theme variables and deliberate inbox overrides after library imports so their precedence is explicit.

After integration, test both `/inbox` and `/docs` in light and dark modes. Specifically check borders, background/foreground tokens, typography, code blocks, dialogs, focus rings, and resizable panels. The current repository has already experienced a Fumadocs style collision; make this a gated checkpoint rather than a late polish task.

### 9.3 Initial embedded documentation

Ship these build-time MDX sections:

- Inbox concepts and folder/status semantics
- Receiving and forwarding behavior
- Sending, replies, reply aliases, CC/BCC, and attachment limits
- Mailbox sender settings
- Magic-link sessions and sign-out
- API authentication and endpoint examples
- Raw message and attachment downloads
- Privacy/security model (what is stored in D1 and R2)
- Operator troubleshooting and observability
- Version/build information

Installation, pricing, marketing, and paid-feature docs remain external. `/docs` must be reachable without a session even though `/` redirects to sign-in.

## 10. Hono API design

Use Hono's normal composition model: small route modules, middleware, validated inputs, use-case services, repositories. Do not recreate the current collection of framework-specific endpoint files or put all behavior in one Hono file.

Use current Hono validation and OpenAPI facilities. `@hono/zod-openapi` provides validated `OpenAPIHono` routes and spec generation: [Hono Zod OpenAPI](https://hono.dev/examples/zod-openapi). Export focused route types for Hono RPC clients, but regard the generated OpenAPI schema and JSON behavior as the durable contract. Hono RPC supports a custom Service Binding `fetch` implementation: [Hono RPC](https://hono.dev/docs/guides/rpc).

### 10.1 External/browser API

Version all application endpoints under `/v1`. Suggested contract:

| Method   | Path                                                | Purpose                                                              |
| -------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| `POST`   | `/v1/auth/magic-links`                              | Request a magic link; always return the same accepted response       |
| `POST`   | `/v1/auth/magic-links/verify`                       | Consume a token and create a session                                 |
| `GET`    | `/v1/auth/session`                                  | Return the current principal/capabilities                            |
| `POST`   | `/v1/auth/logout`                                   | Revoke the current session and expire the cookie                     |
| `GET`    | `/v1/mailboxes`                                     | List authorized mailboxes and counts                                 |
| `PATCH`  | `/v1/mailboxes/:mailboxId`                          | Update sender alias/allowed settings                                 |
| `GET`    | `/v1/threads`                                       | Cursor-paginated summaries with mailbox/folder/unread/search filters |
| `GET`    | `/v1/threads/:threadId`                             | Chronological messages and attachment metadata                       |
| `POST`   | `/v1/threads/:threadId/read`                        | Mark inbound messages in the thread read                             |
| `POST`   | `/v1/threads/:threadId/archive`                     | Archive while retaining workflow state                               |
| `DELETE` | `/v1/threads/:threadId/archive`                     | Unarchive to the retained workflow state                             |
| `POST`   | `/v1/messages`                                      | Send a new thread, accepting multipart form data                     |
| `POST`   | `/v1/threads/:threadId/messages`                    | Reply, accepting multipart form data and optional target message ID  |
| `GET`    | `/v1/messages/:messageId/raw`                       | Authorized raw RFC 822 download                                      |
| `GET`    | `/v1/messages/:messageId/attachments/:attachmentId` | Authorized extraction/download from raw email                        |
| `GET`    | `/v1/capabilities`                                  | Public-core/optional-service capability description                  |
| `GET`    | `/v1/openapi.json`                                  | Generated API description without secrets or private topology        |
| `GET`    | `/health`                                           | Liveness only; no private resource contents                          |

Use cursor pagination based on `(last_message_at, id)`, never an unbounded snapshot or offset pagination. The thread-list response returns summaries only. The thread-detail response returns only one authorized thread. Apply a conservative maximum page size such as 50.

All success responses should be explicit DTOs. All errors should use one envelope:

```json
{
  "error": {
    "code": "thread_not_found",
    "message": "The thread was not found.",
    "requestId": "..."
  }
}
```

Validation details may be returned for safe client errors, but never expose SQL, binding names, stack traces, raw headers, or provider credentials.

### 10.2 Internal mail API

The mail Worker exposes a private Hono contract to the API Worker:

| Method | Path                                 | Purpose                                                                                     |
| ------ | ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `POST` | `/internal/v1/send`                  | Submit a new message or reply with an idempotency key                                       |
| `POST` | `/internal/v1/auth/magic-link`       | Deliver an API-authorized, already-rendered magic-link email to one normalized user address |
| `GET`  | `/internal/v1/sends/:idempotencyKey` | Inspect a prior/unknown send result                                                         |
| `GET`  | `/internal/health`                   | Binding smoke test                                                                          |

The mail Worker validates again at its trust boundary. Do not expose these routes on `workers.dev` in production. If an operator deliberately exposes the mail Worker, require a separately provisioned internal bearer secret and document the added risk.

### 10.3 Same-origin API bridge

Implement a narrow TanStack server route that forwards `/api/v1/*` to `env.API.fetch()` and returns the upstream response, including multiple `Set-Cookie` headers. Preserve method, body stream, safe request headers, and abort signal. Strip hop-by-hop headers and never allow the client to choose the service-binding destination.

Use the bridge for browser calls and Start loaders. Do not reimplement API behavior in Start server functions. TanStack documents server routes as the appropriate HTTP endpoint mechanism and server functions as same-origin RPC: [TanStack Start server routes](https://tanstack.com/start/latest/docs/framework/react/guide/server-routes) and [server functions](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions).

The API Worker can optionally receive a public custom domain for automation clients. That surface accepts bearer API tokens, not browser session cookies, and has no permissive wildcard CORS policy by default.

### 10.4 Authorization

Every mailbox, thread, message, raw object, and attachment lookup must scope the query by the authenticated user's mailbox membership. Never fetch by object ID and authorize afterward. Return the same not-found response for absent and unauthorized resources.

For public API tokens:

- generate at least 32 random bytes;
- show the plaintext once;
- store only an HMAC/SHA-256 digest;
- support `read`, `send`, and `settings` scopes;
- allow revocation and optional expiry;
- never permit a token to reach a mailbox its user cannot access.

The first public release may hide API-token management behind operator SQL/CLI if UI scope is too large, but keep bearer-token middleware and tests if programmatic usage is considered product parity.

## 11. D1 and Drizzle design

D1 is the source of truth for everything the app queries or mutates. Drizzle fully supports the D1 driver: [Drizzle with Cloudflare D1](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-d1). Use Drizzle schema/repositories at runtime, but use generated and reviewed SQL files for production migrations rather than `drizzle-kit push`.

Cloudflare's migration system supports ORM-generated nested layouts through `migrations_pattern`: [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/). Generate with `drizzle-kit generate`, review the SQL, commit it, test it locally, then apply with Wrangler. `push` is acceptable only for disposable local experiments.

### 11.1 Proposed relational model

All IDs are opaque text IDs generated in application code (UUIDv7 or another sortable, well-tested implementation). Store timestamps as integer Unix milliseconds or consistently formatted UTC text; pick one convention and never mix it. The following is the minimum intended shape, not copy-paste SQL.

| Table                  | Important fields and constraints                                                                                                                                 | Purpose                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `users`                | `id` PK, normalized `email` UNIQUE, `created_at`, `disabled_at`                                                                                                  | Auth principals; seed the configured owner                                   |
| `mailboxes`            | `id` PK, normalized `address` UNIQUE, `sender_alias`, `forward_to`, timestamps                                                                                   | Catch-all addresses discovered on receive and their settings                 |
| `mailbox_members`      | `(mailbox_id,user_id)` PK, `role` CHECK                                                                                                                          | Authorization boundary and future shared inboxes                             |
| `magic_links`          | `id` PK, `user_id`, `token_digest` UNIQUE, `expires_at`, `used_at`, `requested_at`                                                                               | Opaque, expiring, one-use login challenges                                   |
| `sessions`             | `id` PK, `user_id`, `token_digest` UNIQUE, `source_magic_link_id` UNIQUE, `expires_at`, `revoked_at`, `last_seen_at`                                             | Revocable browser sessions; unique source enforces one-use login under races |
| `api_tokens`           | `id` PK, `user_id`, digest UNIQUE, name, scopes, expiry/revocation/last-used timestamps                                                                          | Optional automation auth                                                     |
| `threads`              | `id` PK, `mailbox_id`, subject fields, `workflow_state`, `archived_at`, latest-message fields, counts, timestamps                                                | Server-side folder organization and list summaries                           |
| `messages`             | IDs/FKs, direction, dedupe digest, Internet/provider IDs, threading headers, subject/from/body/preview, raw-object metadata, read/send/forward state, timestamps | Queryable normalized message state                                           |
| `message_recipients`   | `message_id`, `kind`, `position`, normalized address and display name                                                                                            | Ordered To/CC/BCC/Reply-To without opaque JSON                               |
| `message_references`   | `message_id`, `position`, normalized referenced Internet Message-ID                                                                                              | RFC thread-chain lookup and reproduction                                     |
| `attachments`          | `id`, `message_id`, MIME ordinal, display filename, media type, size, disposition, content ID                                                                    | Metadata/locator only; bytes remain inside raw `.eml`                        |
| `reply_aliases`        | random local part UNIQUE, mailbox/thread/target IDs, relay destination, created/revoked timestamps                                                               | Resolve owner replies without leaking recipient addresses into aliases       |
| `tags` / `thread_tags` | unique tag name and join table                                                                                                                                   | Preserve searchable thread labels without duplication                        |
| `outbound_sends`       | idempotency key UNIQUE, actor, request digest, state, message/provider IDs, error/timestamps                                                                     | Prevent UI retries from casually sending twice and surface uncertain sends   |
| `message_search`       | FTS5 virtual table keyed to message/thread IDs                                                                                                                   | Search subject, participants, body, mailbox, status, and tags                |

Important `threads` design choice: `workflow_state` is one of `needs_reply`, `waiting`, or `resolved`; archive is an independent nullable `archived_at`. Do not encode archive as a fourth state or recreate `archivedFromStatus`. Unarchive is then a timestamp update, not state reconstruction.

Important `messages` fields include:

- `mailbox_id`, `thread_id`, `direction` (`inbound`/`outbound`);
- `ingest_digest` unique for inbound idempotency;
- `internet_message_id`, `provider_message_id`, `in_reply_to`;
- `from_address`, `from_name`, `subject`, `preview`, `text_body`, optional `html_body` and explicit `html_policy`;
- `sent_at` from the message and `received_at` from the Worker;
- `raw_r2_key`, `raw_size`, `raw_sha256`;
- `read_at` for inbound unread behavior;
- `send_state`, `forward_state`, safe provider error code, and attempt timestamps.

Do not store BCC in a client-visible thread response. It may be retained for the authenticated sender where necessary, but it must never leak to other participants or forwarded copies.

### 11.2 Indexes and queries

Create indexes based on actual endpoint predicates, including:

- unique normalized user email and mailbox address;
- mailbox membership by user;
- `(mailbox_id, archived_at, last_message_at DESC, id DESC)` for All/Archive;
- `(mailbox_id, workflow_state, archived_at, last_message_at DESC)` for Needs reply;
- `(thread_id, sent_at, id)` for chronological detail;
- partial unique `(mailbox_id, internet_message_id)` where the Internet ID is present;
- unique inbound digest;
- reply-alias local part;
- message recipient normalized address;
- magic/session/token digests and expiry/revocation lookup.

Cloudflare recommends indexes for frequently filtered and joined columns and explains composite leftmost behavior: [D1 index guidance](https://developers.cloudflare.com/d1/best-practices/use-indexes/).

Use D1's supported FTS5 extension for message search: [D1 SQL/extension support](https://developers.cloudflare.com/d1/sql-api/sql-statements/). Because participants and tags span tables, update a denormalized FTS row through the repository in the same D1 batch as the message/tag changes. Do not rely on application-wide R2 scans. Escape/normalize user search syntax and cap result work.

### 11.3 Atomicity and invariants

D1 `batch()` executes prepared statements sequentially and rolls the batch back on failure: [D1 database batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/). Use batches for message insert + recipients + references + attachment metadata + thread counters + FTS row.

Enforce invariants in both schema and services:

- foreign keys are on and actions are deliberate; D1 enforces them by default: [D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/);
- no negative unread/message counts;
- one mailbox per thread and message;
- only inbound messages can be unread;
- one active row per idempotency key;
- one session per magic-link row;
- normalized mailbox/user/recipient addresses are lower-case for comparison while display names retain original presentation;
- latest-message and counts are updated in the same batch as message changes.

Do not enable D1 read replication initially. The inbox needs immediate read-after-write behavior after mark-read, archive, and send. Revisit it only with an explicit Sessions API consistency design: [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/).

## 12. R2 raw-email policy

R2 contains only immutable email objects. It must not contain mailbox settings, message JSON, auth data, search documents, or standalone attachment objects.

Suggested keys:

```text
raw/inbound/YYYY/MM/DD/<sha256>.eml
raw/outbound/YYYY/MM/DD/<message-id-or-send-id>.eml
```

For inbound mail, store the exact bytes from `ForwardableEmailMessage.raw`. R2 accepts streams and buffers and supports conditional operations and checksums: [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/). Store `Content-Type: message/rfc822` plus minimal non-sensitive custom metadata; D1 holds the searchable metadata.

For UI/API outbound mail, Cloudflare Email Service's structured builder generates the actual MIME and platform-controlled `Message-ID`. After a successful send, create a canonical RFC 822 representation from the submitted fields plus returned provider ID and store it as the outbound raw object. Document that this is the canonical submitted record, not a byte-for-byte copy of Cloudflare's delivered message. Owner replies received through a reply alias already have exact inbound raw bytes; those may be semantically recorded as outbound/relayed messages while retaining their exact received `.eml`.

Attachment rows store the MIME attachment ordinal and metadata. On an authorized download, the API reads the message's raw object, parses it with `postal-mime`, selects the recorded ordinal, verifies metadata defensively, and streams/returns the bytes with a sanitized `Content-Disposition`. Never form an R2 key from a user-supplied filename.

This on-demand parse is an intentional simplicity tradeoff for the first release. Measure it with 25 MiB inbound fixtures before launch. If it becomes expensive, add a bounded cache later; do not quietly start treating R2 attachment blobs as source-of-truth objects.

Raw and attachment responses require authorization and should send at least:

- `Cache-Control: private, no-store`;
- `X-Content-Type-Options: nosniff`;
- a safe content type with `application/octet-stream` fallback;
- a sanitized quoted filename;
- no public R2 URL.

Because R2 and D1 cannot participate in one transaction, design for visible partial failure:

- write inbound raw before committing normalized D1 state;
- content-address inbound objects so retries overwrite/resolve harmlessly;
- make the D1 inbound digest unique;
- log an orphan-safe object key on a parse/database failure;
- do not delete raw automatically in the request path;
- add an operator reconciliation command later if orphan volume justifies it.

## 13. Mail Worker behavior

Cloudflare's email handler exposes the envelope, headers, raw stream, size, and forward/reply actions, and its documentation recommends `postal-mime` for parsing: [Email Routing Workers API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/). Cloudflare Email Service's `send_email` binding accepts structured messages, multiple recipients, attachments, and custom reply headers: [Email Service Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/).

Email Sending is currently beta and general arbitrary-recipient sending is available on Workers Paid; Email Routing is available on free and paid plans: [Cloudflare Email Service overview](https://developers.cloudflare.com/email-service/). Make this prerequisite obvious in operator docs and the future installer.

### 13.1 Inbound capture flow

For a normal catch-all recipient:

1. Normalize envelope addresses and reject a recipient outside the configured domain(s).
2. Enforce Cloudflare's current inbound size limit before buffering. The documented limit is 25 MiB: [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/).
3. After the envelope size check, buffer the raw stream once, calculate SHA-256 with Web Crypto, and store those exact bytes at a content-addressed R2 key. Keep the buffer lifetime bounded and release it after parsing/persistence.
4. If the recipient local part matches an active `reply_aliases` row, branch to the relay flow in section 13.3.
5. Parse with `postal-mime`; preserve the envelope separately from display headers.
6. Normalize subject, From, To, CC, Reply-To, Date, `Message-ID`, `In-Reply-To`, and `References`; generate a safe fallback ID/subject where absent.
7. Compute the unique ingest digest. Prefer the raw SHA-256 plus normalized envelope rather than trusting `Message-ID` alone.
8. If D1 already has that digest, return successfully without forwarding again.
9. Upsert the destination mailbox and ensure the configured owner has membership.
10. Resolve the thread using the algorithm in section 13.4.
11. Insert message, recipients, references, attachment metadata, FTS text, and thread aggregates in one D1 batch.
12. Create or reuse a random reply alias for the thread.
13. Forward a clean representation to the configured verified owner address through the Email Service binding, setting `Reply-To` to the alias.
14. Record forward success/provider ID, or a safe failure state. A capture is still successful even if forwarding fails; the inbox must show that failure for retry/operator diagnosis.

Do not log bodies, full headers, raw bytes, attachment bytes, or magic/reply-alias tokens. Structured logs may include internal IDs, normalized event names, byte counts, duration, and safe provider error codes.

### 13.2 Owner forwarding

The forwarded owner copy should include sender, mailbox recipient, subject, safe text/HTML, and attachments when within limits. Cloudflare currently permits up to 50 combined recipients, up to 32 attachments, and generally 5 MiB total outbound size; messages to verified destination addresses may be up to 25 MiB: [Email Service send API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/) and [limits](https://developers.cloudflare.com/email-service/platform/limits/).

Never assume the 25 MiB verified-destination exception for normal replies. Implement one size estimator with explicit profiles:

- `owner-forward`: verified owner destination, current verified-destination limit;
- `user-send`: arbitrary recipients, current general limit;
- a safety margin for MIME/base64 overhead.

If an owner-forward copy cannot carry attachments, send a text/HTML notice with authenticated app download links. The links point to API attachment IDs, not R2 object keys, and require a valid session. If the owner is signed out, the app returns to the intended safe path after magic-link sign-in.

### 13.3 Reply-alias relay

Reply aliases preserve the current ability to reply from an external mailbox to a forwarded notification.

- Generate an opaque random local part such as `reply+<base32-random>@mail-domain`; do not embed the customer email, thread ID, or reversible signed payload.
- Store its thread, target inbound message, relay destination, and lifecycle in D1.
- When Email Routing receives a message for that alias, require an active mapping and a sender matching the configured owner/membership policy.
- Store the exact received raw `.eml` first.
- Parse the owner's To/CC/body/attachments, but relay only to destinations allowed by the mapping and explicitly valid editable recipients. Never accept an arbitrary destination encoded in the alias email.
- Send through Email Service with the mailbox identity, correct `In-Reply-To` and `References`, and `Reply-To` set to the public mailbox.
- Store the relayed message as outbound, mark prior inbound messages read, and set the thread to `waiting`.
- Reject or safely drop unknown/revoked aliases; do not create a new public mailbox from them.

Cloudflare's `message.reply()` has DMARC, one-reply-per-event, same-sender-domain, and References-chain constraints. Because this product supports editable recipients and relay semantics, prefer the Email Service send binding for the relay while explicitly setting allowed threading headers. Cloudflare allowlists `In-Reply-To` and `References` and generates `Message-ID`: [Email Service header reference](https://developers.cloudflare.com/email-service/reference/headers/).

### 13.4 Thread resolution

Threading must be deterministic and tested with fixtures:

1. If a valid reply alias resolved the request, use its thread.
2. Within the same mailbox, look up `In-Reply-To` against known Internet/provider message IDs.
3. Walk `References` from newest to oldest and use the first known message in the same mailbox.
4. Only as a conservative fallback, match a normalized subject plus participant set inside a bounded time window.
5. Otherwise create a new thread.

Normalize only leading reply/forward prefixes for fallback comparison; do not aggressively rewrite subjects. A matching `Message-ID` in another mailbox must never merge threads. Cap persisted/re-emitted References chains to provider and header limits while retaining the newest useful IDs.

Thread state transitions:

| Event                                             | `workflow_state` | unread behavior         | archive behavior                                                       |
| ------------------------------------------------- | ---------------- | ----------------------- | ---------------------------------------------------------------------- |
| New inbound                                       | `needs_reply`    | increment unread        | preserve archive only if product explicitly chooses; default unarchive |
| UI/alias outbound reply                           | `waiting`        | mark prior inbound read | preserve current archive flag unless send action explicitly opens it   |
| Explicit resolve (future/current API if retained) | `resolved`       | unchanged               | unchanged                                                              |
| Archive                                           | unchanged        | unchanged               | set `archived_at`                                                      |
| Unarchive                                         | unchanged        | unchanged               | clear `archived_at`                                                    |

Folder derivation stays compatible:

- All: not archived;
- Needs reply: not archived and `workflow_state = needs_reply`;
- Sent: not archived and latest message direction is outbound;
- Archive: archived.

### 13.5 UI/API outbound send flow

1. The client creates a cryptographically random idempotency key per explicit submit and sends multipart form data to the API.
2. The API authenticates, authorizes the mailbox, validates metadata/files, and forwards a normalized multipart request plus actor context to the private mail Worker.
3. The mail Worker validates again and inserts an `outbound_sends` row with unique idempotency key and request digest before the external side effect.
4. If the key already completed with the same digest, return the recorded result. If the digest differs, return conflict. If the state is `unknown`, do not automatically resend.
5. Resolve the sender identity and reply target. For a reply, use the selected inbound message when valid; otherwise use the latest inbound message. Prefer its `Reply-To`, then `From`.
6. Render a plain-text version and a safe app-generated HTML version from Markdown. Prefix `Re:` exactly once in reply mode; preserve exact subject in new-message mode.
7. Validate recipients and current provider limits before calling `env.EMAIL.send()`.
8. Include `In-Reply-To` and `References` for replies. Let Cloudflare generate `Message-ID` and record the returned provider ID.
9. Create/store the canonical outbound `.eml` in R2.
10. Insert the outbound message and update thread aggregates/state in D1.
11. Mark the send complete and return a thread/message DTO.

There is an unavoidable uncertainty window if the provider accepts a message and the following D1 update fails. Without a queue/provider idempotency primitive, exactly-once delivery is not possible. Represent that send as `unknown`, surface it to the user/operator, and require an intentional retry rather than automatically risking a duplicate. This is preferable to pretending synchronous calls are transactional.

Cloudflare's local email simulator cannot currently serialize binary `ArrayBuffer` attachments. Unit-test builders locally, use text attachments in simulator tests, and run binary attachment smoke tests on a deployed staging Worker: [local email sending limitations](https://developers.cloudflare.com/email-service/local-development/sending/).

## 14. Magic-link authentication and sessions

Authentication belongs to the API Worker; the mail Worker only delivers the already-rendered auth email.

### 14.1 Bootstrap and principal model

- Require an `OWNER_EMAIL` setting during bootstrap.
- Seed one `users` row and mailbox membership policy through an idempotent bootstrap command after migrations.
- Only configured/seeded users receive a link in the first release. Do not auto-register arbitrary submitted addresses.
- Return the same `202 Accepted` response for known, unknown, rate-limited, and mail-send-failed addresses. Record safe internal outcomes separately.

### 14.2 Request and verification

On `POST /v1/auth/magic-links`:

1. Normalize and validate the address.
2. Apply an exact D1 per-user cooldown plus Cloudflare rate-limit bindings for abuse absorption. Cloudflare notes its Worker rate limiter is local/permissive and not exact accounting: [Workers Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
3. Optionally require Turnstile after suspicious volume. If enabled, validate every token server-side; Turnstile tokens are expiring and single-use: [Turnstile server validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).
4. For a known enabled user, generate at least 32 random bytes with Web Crypto, base64url encode them, store only an HMAC-SHA-256 digest with a 15-minute expiry, and send the plaintext only in the HTTPS URL.
5. Build the URL from a trusted configured `APP_ORIGIN`, never the request `Host` header.

The verification link should target `/auth/verify?token=...` on the web origin. The Start route immediately POSTs the token to the API through the Service Binding, sets `Referrer-Policy: no-referrer`, never renders the token into reusable page markup, and redirects to `/inbox` after success. The OWASP reset-token guidance is directly applicable: random, long, securely stored, single-use, expiring URL tokens; generic request responses; rate limiting; trusted HTTPS origins: [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html). Cloudflare also publishes a basic Email Service magic-link example, but its placeholder token comment is not a complete auth design: [Cloudflare magic-link email example](https://developers.cloudflare.com/email-service/examples/email-sending/magic-link/).

Consume the magic link and create the session in a D1 batch. Make `sessions.source_magic_link_id` unique so two concurrent verifies cannot both commit. Check affected rows and unique failures explicitly.

### 14.3 Session cookie

Use a new opaque 32-byte random session token and store only its HMAC digest. Production cookie:

```text
__Host-cloudflare-inbox-session=<token>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000
```

No `Domain` attribute is allowed with `__Host-`. Use a clearly different non-secure development cookie only on localhost, or run local HTTPS. Never relax production flags based on a request header.

Sessions have an absolute 30-day expiry, `revoked_at`, and a throttled `last_seen_at` update. Rotate on every magic-link login. Logout revokes the row before clearing the cookie. A global auth-secret rotation may invalidate all sessions and should be documented.

OWASP recommends Secure/HttpOnly/SameSite cookie controls and server-side session lifecycle management: [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

### 14.4 CSRF and headers

For cookie-authenticated state changes:

- reject cross-site `Sec-Fetch-Site` values;
- validate `Origin`, falling back carefully to `Referer` only when appropriate;
- require JSON or multipart requests with the expected content type;
- use an HMAC-bound CSRF token/custom header if route behavior cannot be made safe with origin/fetch-metadata checks alone;
- keep `SameSite=Lax` as defense in depth, not the only defense.

Use Hono secure headers and an explicit CSP for the web/docs app. Account for Fumadocs search and any Turnstile script in CSP rather than adding wildcards. See [OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

Store `AUTH_TOKEN_PEPPER`, provider credentials, and any internal bearer secret as Worker secrets, never Wrangler `vars`. Cloudflare documents secret bindings and warns not to commit `.dev.vars`/`.env`: [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

## 15. Web routing, data loading, and client state

### 15.1 Route behavior

| Route                 | Access                | Server behavior                                                                                                                                                                 |
| --------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                   | public                | Ask the API Worker to validate the session cookie, then issue a server redirect to `/inbox` or `/sign-in`. Never render a landing page or an intermediate shell.                |
| `/sign-in`            | anonymous-first       | Redirect an already-authenticated user to `/inbox`; otherwise render the email form.                                                                                            |
| `/auth/verify`        | public, token-bearing | Consume the token server-side through the API binding, set the returned session cookie, strip the token by redirecting, then land on `/inbox` or a generic expired-link screen. |
| `/inbox`              | authenticated         | Validate the session in the route's server boundary before loading mailbox data. Preserve filter, mailbox, thread, and search selection in URL search parameters.               |
| `/docs` and `/docs/*` | public                | Render build-time MDX content through Fumadocs. No D1 lookup and no session requirement.                                                                                        |
| `/api/v1/*`           | mixed                 | Pass an allowlisted request to the API Service Binding; preserve method, body, safe headers, status, `Set-Cookie`, and streaming response semantics.                            |

Do not rely only on a client-side auth context. Every protected Start loader/server function and every API handler must independently validate the session at its data boundary. TanStack Start's server functions are isomorphic RPC endpoints, not an authorization boundary by themselves: [TanStack Start server functions](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions).

### 15.2 Inbox URL state

Use shareable, back-button-safe search parameters:

```text
/inbox?mailbox=<id>&folder=needs-reply&unread=1&q=invoice&thread=<id>
```

- Parse search parameters through a schema and replace invalid values with defaults.
- On wide screens, selecting a thread updates `thread` without destroying the list scroll position.
- On small screens, the same URL renders either the list or thread detail and browser Back returns to the list.
- The API, not the browser, owns folder and search semantics. The UI sends normalized query parameters and renders the returned page/cursor.
- Debounce search input, cancel superseded requests, and keep the previous list visible while a new result loads.
- Use optimistic state only for reversible, well-defined mutations such as read/unread and archive. Reconcile with the API response and visibly revert on failure.
- Never optimistically show an email as sent before the mail Worker reports a completed send.

### 15.3 Loading strategy

- Load session, mailbox navigation counts, and the first thread page in parallel where their dependencies permit it.
- Load a selected thread and its raw/attachment URLs only when selected; do not return raw MIME or attachment bodies in list DTOs.
- Return explicit cursors instead of page numbers for message/thread feeds. Use a stable `(last_message_at, id)` ordering.
- Keep server-only clients and binding access behind server-only modules so browser bundles cannot accidentally include them.
- Use direct component/module imports. Avoid a workspace-wide barrel that causes the inbox route to evaluate docs, editor, or mail modules.
- Lazy-load the Markdown composer and other heavy client-only affordances after the inbox shell is usable.
- Keep React context scoped and stable. Server state belongs in route/query data; transient composer and pane state belongs locally.

TanStack Start currently documents React Server Components as experimental. Do not make the migration depend on RSC; use the stable Start routing, loaders, server functions/routes, and Cloudflare deployment path: [TanStack Start overview](https://tanstack.com/start/latest/docs/framework/react/overview), [hosting guide](https://tanstack.com/start/latest/docs/framework/react/guide/hosting), and [Cloudflare TanStack Start guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/).

## 16. Configuration, bindings, and environments

Use `wrangler.jsonc` in each deployable workspace. Keep binding names identical between local, staging, and production; only resource IDs, routes, and non-secret values should change.

### 16.1 Binding inventory

| Worker | Binding           | Kind                  | Purpose                                                                                |
| ------ | ----------------- | --------------------- | -------------------------------------------------------------------------------------- |
| web    | `API`             | Service Binding       | Private access to the API Worker's `fetch` handler.                                    |
| web    | `ASSETS`          | Workers static assets | Start client assets and public files.                                                  |
| api    | `DB`              | D1                    | Auth, threads, messages, settings, and API state.                                      |
| api    | `RAW_EMAILS`      | R2                    | Authorized raw-message/attachment reads. Writes are reserved for mail-domain services. |
| api    | `MAIL`            | Service Binding       | Private send/reply requests to the mail Worker.                                        |
| api    | `AUTH_RATE_LIMIT` | Rate Limit binding    | Coarse magic-link abuse protection.                                                    |
| mail   | `DB`              | D1                    | Message/thread/reply-alias/send metadata.                                              |
| mail   | `RAW_EMAILS`      | R2                    | Exact inbound and canonical outbound `.eml` objects.                                   |
| mail   | `EMAIL`           | Send Email binding    | Forwarding, magic-link delivery, and user-authored outbound mail.                      |

The API may deliver R2 objects directly after authorization or call the mail Worker for extraction. Choose one path in the phase-zero ADR and keep it consistent. The recommended first implementation binds R2 to the API for efficient authorized reads but keeps all raw-object writes and key construction in `packages/mail-core`/mail services.

### 16.2 Non-secret variables and secrets

Suggested non-secret variables:

```text
APP_ORIGIN
MAIL_DOMAIN
OWNER_EMAIL
ENVIRONMENT
RAW_EMAIL_RETENTION_DAYS
```

Suggested secrets:

```text
AUTH_TOKEN_PEPPER
INTERNAL_REQUEST_SECRET   # only if an HTTP fallback exists; not needed for a pure Service Binding
```

An email address is configuration, not authentication. `OWNER_EMAIL` may be a variable, while any third-party API key is always a secret. Do not put secrets in `vars`, committed `.env` files, generated client code, or GitHub Actions command lines.

Generate binding types from each Wrangler configuration using Wrangler's type-generation command and consume them in that Worker: [Cloudflare TypeScript/type generation](https://developers.cloudflare.com/workers/languages/typescript/#generate-types). Do not maintain a handwritten global `Env` interface that silently drifts. Fail the build when generated types or OpenAPI output are stale.

### 16.3 Environment policy

- Use separate D1 databases and R2 buckets for local, staging, and production. Never point ordinary local development at production bindings.
- Use a staging mail subdomain/address and explicit allowlisted recipients for smoke tests.
- Pin a `compatibility_date` when the repository is created; update it deliberately with release notes and tests.
- Add `nodejs_compat` only when an audited dependency requires it. Prefer Worker-native Web APIs in shared/domain code.
- Keep preview Worker names and routes distinct from production.
- Disable `workers.dev` for the private mail Worker in production. Expose the API Worker publicly only when scoped bearer-token access is intentionally shipped.
- Configure local bindings explicitly. Cloudflare documents which bindings can be simulated or connected remotely: [local development and bindings](https://developers.cloudflare.com/workers/local-development/bindings-per-env/).

## 17. API and contract conventions

### 17.1 Contract source of truth

`packages/contracts` owns:

- Zod request, query, response, and error schemas;
- opaque/branded identifier types where useful;
- a versioned error-code enum;
- the exported Hono `AppType` for a typed first-party client;
- OpenAPI metadata for the stable `/v1` surface.

Use Hono's validator integration and generate OpenAPI from the same schemas rather than maintaining a separate YAML contract. Hono documents both typed RPC and Zod/OpenAPI patterns: [Hono RPC](https://hono.dev/docs/guides/rpc) and [Zod OpenAPI example](https://hono.dev/examples/zod-openapi).

The browser may use a small typed client built from `AppType`, but the wire API remains ordinary HTTP. Do not couple UI components to Hono context types or return React-specific shapes.

### 17.2 Response and error rules

- JSON response keys are `camelCase`; timestamps are UTC ISO 8601 strings at the boundary.
- Successful creates return `201`; async-neutral magic-link requests return `202`; empty successful mutations may return `204`.
- Errors use one stable envelope:

```json
{
  "error": {
    "code": "thread_not_found",
    "message": "The thread could not be found.",
    "requestId": "01...",
    "details": {}
  }
}
```

- Do not expose stack traces, SQL, R2 keys, account IDs, recipient enumeration, or upstream provider bodies.
- Validate content type and cap bodies before parsing. Apply stricter limits than provider limits where the UI cannot safely handle the maximum.
- Use `ETag`/conditional GET for immutable raw messages and attachment projections when practical.
- Return `Cache-Control: no-store` for session, mailbox, thread, and auth responses. Static fingerprinted assets and built docs may use long-lived caching.
- Add a generated request ID at the web edge and forward it through API and mail. Preserve a valid inbound ID only from trusted internal hops.
- Version breaking wire changes under a new prefix; do not silently change `/v1` semantics after public API tokens ship.

### 17.3 Service Binding calls

Construct an internal `Request` and call the binding's `fetch()` method. Do not invent a second in-process adapter that behaves differently from production. Service Binding requests should carry:

- a request/trace ID;
- authenticated actor and mailbox context from the API to mail in a signed or otherwise non-spoofable internal representation;
- an idempotency key and request digest for sends;
- a bounded deadline/abort signal where supported.

Never accept actor headers from a public API request and forward them unchanged. The API derives them after authentication and strips any conflicting incoming headers.

## 18. Test strategy and parity matrix

Treat tests as the executable handoff. Use pure unit tests for domain rules, the Cloudflare runtime for binding behavior, a multi-Worker harness for topology, and Playwright for user-visible flows.

Cloudflare's Vitest integration runs tests inside the Workers runtime and supports isolated storage: [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/). For cross-Worker tests, prefer Cloudflare's current test harness, which can run a multi-Worker configuration: [test harness](https://developers.cloudflare.com/workers/testing/test-harness/get-started/) and [harness configuration](https://developers.cloudflare.com/workers/testing/test-harness/configure/). Re-check those pages at implementation time because the harness is newer than the original Workers Vitest pool.

### 18.1 Unit tests

`packages/mail-core` must cover at least:

- recipient/address parsing, normalization, deduplication, and limits;
- mailbox and reply-alias parsing;
- `Message-ID`, `In-Reply-To`, and `References` normalization;
- deterministic thread resolution and fallback order;
- exact status transitions and archive independence;
- reply target selection (`Reply-To` before `From`);
- prefixing `Re:` only once;
- safe attachment filename/content-disposition behavior;
- safe HTML rendering/sanitization and plain-text fallback;
- R2 key construction without user-controlled path traversal;
- idempotency-key digest and duplicate/conflict behavior.

`packages/db` must cover schema constraints, foreign keys, migrations from an empty database, repository query ordering, authorization filters, FTS synchronization, atomic thread aggregate updates, and concurrent magic-link consumption.

### 18.2 Worker tests

API Worker tests must prove:

- generic magic-link responses and exact expiry/single use;
- tampered, replayed, expired, and concurrent verification failures;
- secure cookie creation, rotation, revocation, and expiry;
- fail-closed auth when secrets/bindings are missing;
- per-mailbox authorization on every object lookup, including downloads;
- CSRF/origin/fetch-metadata rejection;
- request-size, content-type, and schema validation;
- `no-store` on private responses;
- bearer-token scope enforcement if API tokens ship.

Mail Worker tests must use checked-in synthetic `.eml` fixtures and prove:

- raw bytes are preserved before parsing;
- inbound capture, owner forwarding, and reply-alias relay;
- malformed MIME is retained with a diagnosable failed parse state;
- duplicate delivery does not duplicate the logical message;
- outbound request idempotency and `unknown` send handling;
- thread headers and selected recipients are preserved;
- R2/D1 failure paths produce a recoverable, visible state;
- addresses outside the configured domain/alias space are rejected.

Do not commit real customer email fixtures. Generate or hand-author synthetic messages with no production addresses, tokens, or content.

### 18.3 Multi-Worker integration tests

Run the actual web -> API -> mail Service Binding chain with isolated D1/R2. At minimum:

1. request and consume a magic link through the web origin;
2. load an empty inbox;
3. inject a synthetic inbound email event;
4. observe the thread/list/navigation counters;
5. mark read, archive, unarchive, and search;
6. reply with edited To/CC/BCC and an attachment using a fake send binding;
7. download the authorized raw email and projected attachment;
8. prove a second user/mailbox cannot access any of those resources;
9. prove a repeated send request returns the original result rather than sending twice.

Keep network calls out of deterministic tests. Wrap the Cloudflare send binding behind a tiny injected port so tests can record the exact `EmailMessage` without delivery.

### 18.4 Browser and visual tests

Use Playwright at desktop, tablet, and narrow-mobile widths. Cover sign-in, expired link, list/detail navigation, search, folders, unread, archive, compose/reply, editable recipients, attachment removal/download, sender settings, empty/error/loading states, keyboard navigation, and logout.

Before rebuilding the UI, capture approved screenshots and interaction notes from the current production app using synthetic test mail. Store only sanitized references. Compare the new app against those references at:

- desktop three-pane layout;
- tablet navigation + content layout;
- mobile thread list and thread detail;
- light and dark themes if both are retained;
- long subjects, long addresses, multiple recipients, large threads, and attachment rows.

Prefer structural assertions and a small set of stable visual snapshots over snapshotting every page. Run automated accessibility checks and manually verify focus order, focus return after dialogs, keyboard-only compose, and screen-reader labels.

### 18.5 Deployed smoke tests

Cloudflare emulators cannot prove Email Routing, arbitrary-recipient sending, DNS, production cookies, or every attachment path. Every staging release must therefore run:

- a real inbound email to the staging address;
- a real outbound email to an allowlisted test mailbox;
- a real threaded reply in both directions;
- a binary attachment send/receive/download;
- a magic-link login over HTTPS;
- the complete web -> API -> mail trace-ID chain.

Do not use a production customer's message for smoke testing. Cloudflare publishes the current Email Routing handler contract, Email Sending API, provider headers, and limits here: [email handler](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/), [send from Workers](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/), [headers](https://developers.cloudflare.com/email-service/reference/headers/), and [limits](https://developers.cloudflare.com/email-service/platform/limits/).

## 19. Observability, privacy, and failure handling

### 19.1 Structured events

Emit JSON logs with `timestamp`, `level`, `service`, `environment`, `requestId`, `event`, safe entity IDs, duration, and outcome. Define a small event catalog, including:

- `auth.magic_link.requested`, `auth.magic_link.consumed`, `auth.session.revoked`;
- `mail.inbound.received`, `mail.inbound.persisted`, `mail.inbound.failed`;
- `mail.forward.completed`, `mail.reply_alias.relayed`;
- `mail.outbound.started`, `mail.outbound.completed`, `mail.outbound.unknown`;
- `api.request.completed`, `api.authorization.denied`.

Never log session/magic-link/API tokens, cookie values, raw MIME, bodies, attachment bytes, full recipient lists, or authorization headers. Hash an address only when correlation is operationally necessary and the key/retention policy is documented.

### 19.2 Durable failure state

A caught exception in an email event is not an operational record. Persist a message/import/send state with a short safe error code and retryability classification. The inbox/operator view should make failed parse, failed forward, and uncertain send visible without revealing secrets.

Without Queues, do not build an automatic general retry loop. Safe idempotent actions can have an explicit operator retry endpoint; `unknown` outbound delivery requires an intentional confirmation. Keep service methods shaped around commands so a future queue consumer can call the same command handlers.

### 19.3 Privacy and retention

- Raw email contains highly sensitive data. Use a private R2 bucket and never expose a public bucket/custom domain.
- Every raw/attachment response is authorized at request time and returned through a short request, not a stable public R2 URL.
- Set explicit raw-email and application-record retention policy before launch. Implement deletion of D1 metadata and R2 objects as one observable workflow with retryable tombstones.
- Document what is forwarded to the owner and what a future AI service would receive.
- Render a safe text-first view. If rich inbound display is included, use the separately reviewed sanitized, sandboxed-iframe design from section 8.4 and block remote images; never execute scripts or event handlers.
- Proxying remote images creates privacy and abuse obligations; leave it out unless intentionally designed.

## 20. Implementation sequence with exit criteria

Every phase ends with green format/lint/type/test/build checks and a deployable state. Keep commits small enough to review by concern; do not make one migration-sized commit.

### Phase 0 — topology and toolchain spike

Complete the spike in section 6 and record an ADR with exact versions, CLI commands, Vite+ decision, local dev command, and multi-Worker test approach.

Exit: three health endpoints deploy to staging, Service Bindings work end-to-end, and the mail Worker accepts a synthetic email event.

### Phase 1 — public repository foundation

1. Add license choice, code of conduct, contributing/security policies, architecture overview, and secret-scanning guidance.
2. Commit the workspace, lockfile, version pins, Vite+ config, TypeScript config, boundary checks, CI, and Changesets or an equivalent release policy only if packages will be published.
3. Scaffold all three Workers with their official CLIs/configuration rather than copying this repository.
4. Add health/readiness responses, request IDs, structured logging, and environment validation.
5. Add deterministic root commands for development, verification, provisioning, migration, deployment, and smoke tests.

Exit: a new contributor can clone, install, verify, run all services locally, and deploy staging using only documented commands.

### Phase 2 — contracts, schema, and repositories

1. Define IDs, DTOs, errors, workflow state machine, and OpenAPI schemas.
2. Implement the Drizzle schema and generate the first checked-in migration.
3. Add empty-database migration tests, foreign-key checks, indexes, FTS triggers, and repository tests.
4. Implement the idempotent bootstrap command for the owner, default mailbox, and membership.
5. Add D1/R2 development fixtures with synthetic mail only.

Exit: a fresh D1 database can be migrated/seeded repeatedly, and repository tests express all organization/threading invariants.

### Phase 3 — standalone mail Worker

1. Implement raw inbound persistence, MIME projection, deduplication, and thread resolution.
2. Implement owner forwarding and reply-alias allocation/relay.
3. Implement outbound compose/reply rendering, recipient validation, attachments, canonical `.eml` storage, and idempotency records.
4. Expose only the private Hono command/read endpoints needed by API.
5. Add synthetic email fixtures and staging email smoke tests.

Exit: without the web app, tests and a small operator script can receive, list through D1, send, forward, relay, and retrieve a raw email.

### Phase 4 — API, auth, and authorization

1. Add global error/request-ID/security middleware.
2. Implement magic-link request, verification, session, logout, and bootstrap policy.
3. Implement mailbox/thread/message/settings/read/archive/search/download endpoints.
4. Implement internal send/reply orchestration through `MAIL`.
5. Generate OpenAPI and add API-token support only if a concrete non-browser client needs it.
6. Run cross-mailbox authorization and CSRF tests before UI integration.

Exit: API integration tests can exercise the complete product without React, and no object endpoint accepts an unauthorized mailbox/user combination.

### Phase 5 — TanStack Start shell, shadcn/Base UI, and docs

1. Scaffold Start and install shadcn/Base UI/Fumadocs in the required order.
2. Build the root redirects, sign-in/verify flow, authenticated shell, same-origin API bridge, error boundaries, and docs routes.
3. Establish tokens, typography, density, responsive breakpoints, dark-mode decision, CSP, and sanitization boundary.
4. Write the initial embedded docs and verify production MDX/search behavior.

Exit: auth and docs work on staging, route guards do not flash protected content, and no Waku dependency or copied framework adapter exists.

### Phase 6 — inbox parity

Implement vertical slices, each with worker tests and Playwright coverage:

1. mailbox navigation, folders, counts, unread filter, and responsive shell;
2. thread list, cursors, search, empty/loading/error states;
3. conversation view, safe bodies, raw and attachment downloads;
4. read/unread, archive/unarchive, and URL-state/back behavior;
5. reply/new composer, recipients, aliases, Markdown, attachments, and send uncertainty;
6. sender settings and remaining keyboard/accessibility polish.

Exit: every row in the parity checklist below is accepted at desktop/tablet/mobile against sanitized current-app references.

### Phase 7 — hardening and cutover

1. Complete abuse limits, secret review, CSP, dependency audit, retention/deletion, observability, and runbook.
2. Load-test representative large thread lists and message bodies within D1/Worker limits.
3. Exercise rollback and restore against staging.
4. Deploy production resources under new names, run smoke tests, then switch web and Email Routing deliberately.
5. Monitor delivery/capture/auth errors before decommissioning anything old.

Exit: all definition-of-done items pass, production mail round trips succeed, and a tested rollback remains available.

## 21. Provisioning, deployment, and cutover

### 21.1 Root operator commands

Expose memorable, CI-safe root tasks through Vite+ (exact spelling may follow the chosen Vite+ task model):

```text
vp install
vp check
vp test
vp build
vp run dev
vp run db:generate
vp run db:migrate -- --env staging
vp run bootstrap -- --env staging
vp run deploy:mail -- --env staging
vp run deploy:api -- --env staging
vp run deploy:web -- --env staging
vp run smoke -- --env staging
vp run deploy -- --env staging
```

The aggregate deploy task must be a visible script, not undocumented shell knowledge. It should:

1. verify a clean/generated workspace and authenticated account;
2. resolve explicit account/environment/resource identifiers;
3. apply D1 migrations once;
4. deploy mail, then API, then web so downstream Service Binding targets exist;
5. verify versions and health endpoints;
6. run non-destructive smoke checks;
7. print deployed Worker versions and rollback commands.

Vite+ documents workspace task orchestration with `vp run`, CI setup, and commit hooks: [monorepo tasks](https://viteplus.dev/guide/monorepo), [CI](https://viteplus.dev/guide/ci), and [commit hooks](https://viteplus.dev/guide/commit-hooks).

### 21.2 D1 migrations

- Generate SQL from Drizzle, inspect it, and commit it; never generate migrations during production deploy.
- Apply migrations through Cloudflare's D1 migration mechanism in CI/operator workflows: [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/) and [Drizzle migration generation](https://orm.drizzle.team/docs/drizzle-kit-generate).
- Back up/verify restore before a destructive schema change.
- Use expand/backfill/contract for future live schema changes even though there is no old-app data migration.
- Keep foreign keys enabled and understand D1's migration behavior around them: [D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/).

### 21.3 Initial Cloudflare setup

Document both automated commands and dashboard-only steps:

1. create staging and production D1 databases;
2. create private staging and production R2 buckets;
3. create/configure Email Sending bindings and verify required sending domains/destinations;
4. deploy the mail Worker and bind Email Routing rules/catch-all to its `email()` handler;
5. deploy API and web with their Service Bindings;
6. configure routes/custom domains and TLS;
7. upload secrets independently to each environment;
8. apply migrations and run bootstrap;
9. run real mail/auth/browser smoke tests.

Email Sending is subject to product availability, account plan, domain verification, and current limits; check the current overview before promising one-click behavior: [Cloudflare Email Service](https://developers.cloudflare.com/email-service/). As of the research date, the documented limits include 50 recipients, 32 attachments, a 5 MiB general outbound limit, a 25 MiB verified-destination limit, and a 25 MiB inbound limit; enforce the live documented limits rather than hard-coding this paragraph forever: [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/).

### 21.4 Production cutover and rollback

There is deliberately no data import. Treat the new instance as a new mailbox store.

1. Keep the current Worker and its R2 objects untouched.
2. Deploy the new suite under staging/temporary routes and a test email subdomain.
3. Complete a two-way mail thread, attachment test, auth test, and browser parity pass.
4. Freeze configuration changes briefly and record current web route and Email Routing targets.
5. Switch the web custom domain to the new web Worker.
6. Switch the target Email Routing rule/catch-all to the new mail Worker.
7. Send uniquely identifiable inbound and outbound probes and verify D1/R2/log state.
8. Monitor failed captures, unknown sends, auth errors, and binding errors closely.
9. Keep the old web/mail target deployable and the prior routing values in the runbook until the acceptance window closes.

Rollback changes the web route and Email Routing target back. Messages received by the new Worker during its active window remain in the new D1/R2 and are not automatically merged into the old system; export them explicitly if rollback occurs.

## 22. Future one-click installer, open core, and paid features

This section is architectural guidance, not migration scope.

### 22.1 Native deploy button versus OAuth installer

Cloudflare's native deploy button requires a public Git repository and currently does not deploy multiple Worker applications in a monorepo together: [Deploy to Cloudflare](https://developers.cloudflare.com/workers/platform/deploy-buttons/). It is suitable only if the suite is collapsed, separately installed in several steps, or Cloudflare changes the limitation.

A future hosted installer can instead use Cloudflare OAuth and the REST APIs to coordinate the suite. Cloudflare documents creating OAuth clients and integrating authorization-code flows here: [OAuth overview](https://developers.cloudflare.com/fundamentals/oauth/), [create an OAuth client](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/), and [integrate with Cloudflare](https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/).

Before productizing it, build a separate feasibility spike that proves the exact least-privilege scopes and operations for:

- selecting an account and zone;
- creating D1 databases through the [D1 API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/);
- creating/configuring R2 through the [R2 API](https://developers.cloudflare.com/api/resources/r2/);
- uploading Worker scripts, modules, versions, bindings, routes, and secrets through the [Workers API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/);
- configuring applicable Email Routing rules through the [Email Routing API](https://developers.cloudflare.com/api/resources/email_routing/);
- identifying any Email Sending/domain-verification step that still requires the customer or dashboard.

Do not advertise a fully automatic install until the last item has been tested in a clean customer account. OAuth permission does not guarantee that every account/product prerequisite is automatable.

The installer should be an idempotent state machine: authorize with `state` and PKCE where applicable, select explicit account/zone, plan, create resources, migrate, upload mail/API/web in dependency order, configure routes, verify, and issue an installation receipt. Persist only encrypted refresh credentials when ongoing management is an explicit product feature; otherwise discard access after install. Make reruns resume safely, show every permission, and leave recoverable resources on partial failure.

### 22.2 What can and cannot be kept private

OAuth answers “may this installer act in the customer's account?” It does not make installed code secret from that account's owner. Any JavaScript, Wasm, source map, asset, or bundle deployed into a customer-controlled Cloudflare account must be treated as customer-accessible and reverse-engineerable.

Therefore:

- keep the self-hosted core, UI, contracts, and extension interfaces public;
- never put a durable vendor secret or paid-feature trust decision in customer-deployed code;
- enforce entitlements and perform proprietary computation in a vendor-hosted service;
- use short-lived, installation-scoped credentials issued after server-side entitlement checks;
- allow the public core to fail clearly and continue safely when a paid capability is absent;
- publish the data boundary and make remote processing opt-in.

A separately distributed compiled paid Worker may discourage casual copying, but it is not a confidentiality boundary. Choose it for offline/self-contained deployment or commercial licensing, not because OAuth hides it.

### 22.3 Extension shape for queue and AI features

Do not pre-build the queue now, but keep the core use cases transport-neutral:

```text
inbound email event -> ReceiveMessage command -> parse/store/thread -> domain events
API send request    -> SendMessage command    -> validate/send/store -> domain events
```

A later queue processor can subscribe to durable jobs/domain events and invoke the same application services. It should not own an alternative thread model.

For AI, public UI code is not the paid asset. It is acceptable—and trust-enhancing—for the button, panel, disclosure, and client contract to be public. The proprietary value can remain in a hosted model/orchestration service. Define a small capability contract only when a first feature exists, for example:

```ts
type CapabilityDescriptor = {
  id: 'ai.thread-summary' | 'ai.draft-reply'
  available: boolean
  reason?: 'not_configured' | 'not_entitled' | 'unavailable'
}
```

The public UI asks the API for capabilities and renders the checked-in UI when available. The API sends a minimized, explicitly disclosed payload to the vendor service using an installation credential; the vendor validates entitlement and returns a typed result. Store provenance/model metadata when generated content can be sent externally, require a human confirmation for AI-authored outbound mail, and never silently upload a mailbox.

Avoid runtime-downloaded proprietary React bundles or remote module federation in the inbox. They complicate CSP, integrity, version compatibility, accessibility, and customer trust while still exposing code to the browser. Public extension slots plus private remote computation are simpler.

## 23. Current-product behavior map

The implementation agent may consult these files in this repository as behavioral references, not copy targets. Paths may change after this handoff is moved into the new repository.

| Behavior                                | Current reference                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Responsive shell/orchestration          | `src/components/inbox/inbox-app.tsx`                                                                                               |
| Mailbox/folder navigation               | `src/components/inbox/mailbox-nav.tsx`                                                                                             |
| Searchable/filterable thread list       | `src/components/inbox/thread-list.tsx`                                                                                             |
| Conversation display and actions        | `src/components/inbox/thread-view.tsx`                                                                                             |
| Composer/recipients/attachments         | `src/components/inbox/reply-composer.tsx`                                                                                          |
| Thread derivation/status/search         | `src/components/inbox/thread-model.ts`                                                                                             |
| Shared mail shapes                      | `src/lib/mail-types.ts`                                                                                                            |
| Recipient and reply normalization       | `src/lib/recipient-fields.test.ts`, `src/lib/reply-content.test.ts`                                                                |
| Existing persistence/mail orchestration | `src/server/mailbox.ts`                                                                                                            |
| Auth and API edge cases                 | `src/server/auth.test.ts`, `src/server/magic-link-auth.test.ts`, `src/server/api-auth.test.ts`, `src/server/public-api.test.ts`    |
| Mailbox/thread/send edge cases          | the focused `src/server/mailbox-*.test.ts`, `message-api.test.ts`, `thread-archive-api.test.ts`, and `web-send-api.test.ts` suites |

Extract a test/specification for each behavior before replacing it. Preserve outcomes, not Waku component boundaries, current R2 JSON layout, or accidental quirks.

### Parity acceptance checklist

| Area          | Acceptance condition                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Navigation    | Mailbox switcher and All/Sent/Needs reply/Archive counts and selections are correct.                                                       |
| List          | Unread state, participants, subject, snippet, time, tags/status, search, refresh, pagination, and selection behave consistently.           |
| Thread        | Messages are chronological; inbound/outbound identity, recipients, bodies, attachments, and raw download are correct.                      |
| Reply         | Default target follows latest selected/eligible inbound `Reply-To` then `From`; To/CC/BCC remain editable and deduplicated.                |
| Send          | New and reply modes, sender alias, Markdown/plain/HTML output, attachments, thread headers, progress, errors, and uncertainty are handled. |
| State         | Read/unread and archive/unarchive persist without corrupting workflow state; folders update promptly.                                      |
| Alias relay   | A reply to an issued alias reaches the intended external participant and is captured as outbound in the same thread.                       |
| Forwarding    | New inbound mail is captured first, forwarded to the owner, and records delivery/failure state.                                            |
| Responsive UI | Three-pane desktop, reduced tablet, and list/detail mobile flows remain usable with keyboard and touch.                                    |
| Auth          | Root redirect, sign-in, single-use link, session persistence/expiry, logout, and generic failure states work.                              |
| Docs          | `/docs` is public, searchable, built into Start, and does not pull application/private data.                                               |

## 24. Known risks and decisions still required

These are owner decisions; defaults below keep implementation moving without hiding tradeoffs.

| Decision/risk                         | Recommended default                                                                                                                                                                             | Decision deadline   |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Public license                        | Choose deliberately before the first public push. Apache-2.0 is permissive with an explicit patent grant; AGPL is a different open-core/business choice. Do not let a scaffold choose silently. | Phase 1             |
| Vite+ beta churn                      | Pin exact versions and commands; keep direct-tool escape scripts and an ADR.                                                                                                                    | Phase 0             |
| Cloudflare Email Sending availability | Prove arbitrary-recipient sending, required plan, domains, and limits in the target account.                                                                                                    | Phase 0/3           |
| API public exposure                   | Keep API private behind web initially; enable a public route only with a concrete token-client requirement.                                                                                     | Phase 4             |
| Multi-user/tenant model               | Schema memberships now, ship one owner initially, and enforce mailbox scoping everywhere.                                                                                                       | Phase 2             |
| HTML display                          | Text-first plus sanitized HTML with remote images blocked.                                                                                                                                      | Phase 5             |
| Retention/deletion/export             | Document a default retention window and deletion runbook before production.                                                                                                                     | Phase 7             |
| FTS content                           | Index normalized subject/addresses/plain text only; test D1 size/query cost and exclude raw HTML.                                                                                               | Phase 2             |
| Data location/privacy for future AI   | No AI transfer in core; later feature requires explicit configuration, disclosure, minimization, and retention terms.                                                                           | Future paid feature |
| Installer automation                  | Keep root scripts deterministic now; validate every OAuth/API operation in a separate clean-account spike.                                                                                      | Future installer    |

D1 supports SQLite FTS5 and recommends indexes for production queries: [D1 SQL statements/FTS5](https://developers.cloudflare.com/d1/sql-api/sql-statements/) and [use indexes](https://developers.cloudflare.com/d1/best-practices/use-indexes/). D1's `batch()` calls are transactional and roll back together on failure, which is useful for thread/auth state transitions: [D1 Worker API](https://developers.cloudflare.com/d1/worker-api/d1-database/). Drizzle's Cloudflare D1 driver is documented here: [Drizzle with D1](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-d1).

## 25. Definition of done

The clean-room migration is complete only when all of the following are true:

- the repository is public-ready, licensed, secret-scanned, documented, and contains no customer data or copied credentials;
- a fresh clone can install and run through pinned pnpm/Vite+ root commands;
- web, API, and mail are separate deployable Workers with tested private Service Bindings;
- web has no D1/R2 access and mail has no browser-session responsibility;
- D1 owns all queryable state through Drizzle and checked-in migrations; R2 contains only raw `.eml` objects;
- the standalone mail Worker receives, captures, threads, forwards, relays aliases, sends, replies, and records failure/uncertainty;
- magic links are opaque, hashed, single-use, expiring, enumeration-resistant, rate-limited, and exchanged for revocable secure sessions;
- every mailbox/message/download/send operation is authorized server-side;
- `/` redirects correctly, `/inbox` is protected, `/sign-in` works, and `/docs` is public and embedded;
- current inbox behavior passes the parity checklist across desktop, tablet, and mobile using current shadcn/Base UI components;
- OpenAPI/contracts, generated binding types, format, lint, type check, unit, Worker, integration, browser, and production build checks pass in CI;
- staging passes real inbound/outbound/thread/auth/binary-attachment smoke tests;
- production provisioning, migration, deploy, smoke, cutover, and rollback steps are written and rehearsed;
- no Queue, AI, billing, marketing site, or proprietary runtime bundle has leaked into migration scope.

## 26. Implementation handoff checklist

The next agent should begin in a **new Git repository**, not by deleting this one:

1. Copy this document and open an architecture/scaffolding PR.
2. Confirm the account can use the required Cloudflare Email Sending behavior.
3. Run Phase 0 and commit its ADR before writing product code.
4. Record exact Node, pnpm, Vite+, TanStack CLI/Start, Cloudflare plugin/Wrangler, Hono, shadcn/Base UI, Fumadocs, Drizzle, and Vitest/harness versions.
5. Capture sanitized screenshots and convert existing behavior into the parity/test inventory.
6. Implement phases 1–7 in order, opening reviewable PRs and deploying each phase to staging.
7. Update this document whenever the implementation intentionally differs; do not allow silent architectural drift.

When a current CLI or document conflicts with a command in this handoff, use the current official documentation, record the deviation in the ADR, and keep the architectural invariants unless there is concrete evidence to change them.

## 27. Reference index

All links below were checked during research on 2026-08-01. They are retained here because this ecosystem changes quickly; the implementation agent should re-check them at each scaffold or upgrade.

### pnpm and Vite+

- [pnpm workspaces and `workspace:` protocol](https://pnpm.io/workspaces)
- [Overview](https://viteplus.dev/)
- [Getting started](https://viteplus.dev/guide/)
- [Installation](https://viteplus.dev/guide/install)
- [Create a project](https://viteplus.dev/guide/create)
- [Monorepos and tasks](https://viteplus.dev/guide/monorepo)
- [Check](https://viteplus.dev/guide/check)
- [Lint and custom JavaScript plugins](https://viteplus.dev/guide/lint)
- [CI](https://viteplus.dev/guide/ci)
- [Commit hooks](https://viteplus.dev/guide/commit-hooks)
- [Troubleshooting](https://viteplus.dev/guide/troubleshooting)
- [Installer environment variables](https://viteplus.dev/guide/installer-env-vars)

### TanStack Start, shadcn/ui, and Fumadocs

- [TanStack CLI quick start](https://tanstack.com/cli/latest/docs/quick-start)
- [TanStack Start overview](https://tanstack.com/start/latest/docs/framework/react/overview)
- [TanStack Start hosting](https://tanstack.com/start/latest/docs/framework/react/guide/hosting)
- [TanStack Start server functions](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions)
- [TanStack Start server routes](https://tanstack.com/start/latest/docs/framework/react/guide/server-routes)
- [Cloudflare's TanStack Start guide](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/)
- [shadcn TanStack installation](https://ui.shadcn.com/docs/installation/tanstack)
- [shadcn CLI](https://ui.shadcn.com/docs/cli)
- [shadcn Base UI default announcement](https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default)
- [Fumadocs documentation/requirements](https://www.fumadocs.dev/docs)
- [Fumadocs manual TanStack Start installation](https://www.fumadocs.dev/docs/manual-installation/tanstack-start)
- [Fumadocs Vite MDX](https://www.fumadocs.dev/docs/mdx/vite)

### Hono and Cloudflare Workers

- [Hono on Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers)
- [Hono with the Cloudflare Vite plugin](https://hono.dev/docs/getting-started/cloudflare-workers-vite)
- [Create Hono](https://hono.dev/docs/guides/create-hono)
- [Hono RPC](https://hono.dev/docs/guides/rpc)
- [Hono testing helpers](https://hono.dev/docs/helpers/testing)
- [Hono Zod OpenAPI example](https://hono.dev/examples/zod-openapi)
- [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)
- [Cloudflare TypeScript and generated binding types](https://developers.cloudflare.com/workers/languages/typescript/#generate-types)
- [Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Local binding configuration](https://developers.cloudflare.com/workers/local-development/bindings-per-env/)
- [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [Multi-Worker test harness](https://developers.cloudflare.com/workers/testing/test-harness/get-started/)
- [Test harness configuration](https://developers.cloudflare.com/workers/testing/test-harness/configure/)
- [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)

### D1, Drizzle, and R2

- [Drizzle Cloudflare D1 driver](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-d1)
- [Drizzle migration generation](https://orm.drizzle.team/docs/drizzle-kit-generate)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 indexes](https://developers.cloudflare.com/d1/best-practices/use-indexes/)
- [D1 FTS5/SQL support](https://developers.cloudflare.com/d1/sql-api/sql-statements/)
- [D1 `batch()` transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)
- [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)

### Cloudflare Email Service

- [Email Service overview](https://developers.cloudflare.com/email-service/)
- [Email Routing `email()` handler](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)
- [Send Email binding](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
- [Email Service headers](https://developers.cloudflare.com/email-service/reference/headers/)
- [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/)
- [Local email sending](https://developers.cloudflare.com/email-service/local-development/sending/)
- [Cloudflare magic-link example](https://developers.cloudflare.com/email-service/examples/email-sending/magic-link/)

### Authentication and security

- [Workers Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)

### Future OAuth installer

- [Cloudflare OAuth overview](https://developers.cloudflare.com/fundamentals/oauth/)
- [Create an OAuth client](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)
- [Integrate with Cloudflare OAuth](https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/)
- [D1 create-database API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/)
- [R2 API](https://developers.cloudflare.com/api/resources/r2/)
- [Workers Scripts API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/)
- [Email Routing API](https://developers.cloudflare.com/api/resources/email_routing/)
