# Security policy

## Supported versions

Cloudflare Inbox is pre-1.0 software. Security fixes are made only on the current `main` branch and
the currently deployed production version once one exists. Old commits, forks, and preview
deployments are not supported.

## Reporting a vulnerability

Do not open a public issue or discussion for a suspected vulnerability. Use GitHub's private
vulnerability reporting flow from the repository's **Security** tab. If that option is unavailable,
ask a maintainer for a private contact channel without including exploit details in the request.

Include, when safe:

- the affected commit or deployed environment;
- impact and prerequisites;
- minimal reproduction steps using synthetic data;
- relevant request IDs with secrets and message content removed;
- any mitigation already attempted.

Do not access other people's mailboxes, retain raw email, degrade the service, or exfiltrate data
while researching. We aim to acknowledge a report within three business days, agree on a disclosure
plan after triage, and credit reporters who want attribution.

## Secrets and sensitive data

The repository must never contain Cloudflare tokens, account IDs tied to private infrastructure,
magic-link URLs, session values, raw `.eml` files, production addresses, or customer attachments.
Use `.dev.vars` locally and store deployed secrets through Cloudflare's secret facilities. Example
files must contain non-working placeholders.

Pull requests run secret scanning, dependency review, and a moderate-or-higher production dependency
audit. If a secret reaches Git history, remove it from use and rotate it immediately; deleting the
line in a later commit is not sufficient.
Organization-owned repositories must configure the `GITLEAKS_LICENSE` Actions secret required by
the pinned scanner; personal repositories do not require it.

## Security boundaries

The web Worker has no D1 or R2 binding. The API owns browser authorization and calls the mail Worker
through a private Service Binding. The mail Worker owns email events and raw-object access. D1 access
is implemented through repositories. `tooling/scripts/check-boundaries.mjs` enforces the static
parts of these boundaries in CI.
