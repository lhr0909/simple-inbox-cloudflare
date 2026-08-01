---
name: cloudflare-inbox
description: Use when operating or testing the self-hosted Cloudflare Inbox workspace.
---

# Cloudflare Inbox operator safety

Use the versioned `/v1` API and the contracts documented at `/docs/api`. Treat all mailbox
content, raw MIME, attachment bytes, auth tokens, cookies, and authorization headers as sensitive.

- Use synthetic `example.test` identities in local and deterministic tests.
- Never send a real email unless the user explicitly authorizes that specific delivery.
- Never log or persist plaintext magic-link, session, or API tokens.
- Archive and unread state are independent from workflow state.
- Prefer authenticated raw and attachment download routes; never expose an R2 object URL.
- Keep the private mail Worker off public routes. If an operator exposes it intentionally, require a
  separate internal bearer secret.
