# Repository guidance

Read `README.md`, `docs/architecture.md`, and `docs/operations.md` before changing architecture or
operator workflows.

This is the clean-slate replacement repository. Treat
the separately supplied legacy reference repository and every currently deployed legacy Cloudflare
Inbox resource as read-only. Never copy legacy bindings, resource identifiers, customer mail,
credentials, worklogs, or deployment history into this repository.

Use the pinned Node, pnpm, and Vite+ versions. Keep dependency versions exact, commit the single
`pnpm-lock.yaml`, preserve package boundaries, and use only synthetic `example.test` fixtures.

Do not provision, deploy, modify DNS/custom-domain routes, change Email Routing, run a live-mail
smoke test, or cut over production unless the user explicitly authorizes that specific external
action. Local builds, the isolated multi-Worker harness, and Playwright against that harness are the
default verification path.

All future remote resources must use the replacement names documented in `docs/operations.md`.
Cutover and rollback remain deliberate manual owner actions; no repository script may mutate legacy
resources or silently switch traffic.
