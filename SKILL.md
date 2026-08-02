---
name: simple-inbox-cloudflare
description: Use when operating or testing the self-hosted Simple Inbox Cloudflare Worker.
---

# Simple Inbox operator safety

Operate the single public Worker `simple-inbox-cf`, which exports `fetch`, `email`, and `scheduled`.
Use the versioned `/api/v1` API and the contracts documented at `/docs/api`.

- Treat mailbox content, raw MIME, attachment bytes, addresses, auth/setup tokens, cookies, and
  authorization headers as sensitive.
- Use only synthetic `example.test` identities and non-sensitive attachments in deterministic tests.
- Never send real email or activate/change Email Routing unless the user explicitly authorizes that
  specific external action.
- Treat `vp run deploy:first` and `vp run deploy` as immediately remote and state-changing. The
  former provisions a fresh manual installation before migration; the latter migrates before an
  upgrade upload. Confirm the Wrangler account first.
- Require two different secret bindings of at least 32 random bytes: `AUTH_TOKEN_PEPPER` and
  `SETUP_TOKEN`. Never print, commit, log, or reuse them.
- First-run `/setup` atomically creates the owner, primary mailbox, owner membership, origin, mail
  domain, and retention settings. Do not recreate the deleted bootstrap workflow or insert these
  records manually.
- Keep `simple-inbox-cf-raw` private and use authenticated raw/attachment routes; never expose an R2
  object URL.
- Keep the mail package's internal Hono routes unreachable from the public root router.
- Email Sending domain verification, R2 lifecycle, custom-domain attachment, and Email Routing
  activation are explicit Cloudflare Dashboard owner steps, not deployment automation.
- Never discover, import, modify, delete, or cut over legacy Workers, D1/R2 resources, routes, DNS,
  mail rules, or data.
- Prefer the local single-Worker integration and browser harnesses before any authorized remote
  operation.
