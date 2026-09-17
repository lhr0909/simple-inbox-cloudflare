export type BlacklistRule = Readonly<{
  id: string
  kind: 'recipient' | 'sender' | 'domain'
  value: string
}>

/** Explicit matching only. A domain includes its subdomains, never suffix lookalikes. */
export function matchBlacklist(
  rules: readonly BlacklistRule[],
  input: { recipient: string; sender: string },
): BlacklistRule | undefined {
  const recipient = input.recipient.trim().toLowerCase()
  const sender = input.sender.trim().toLowerCase()
  const domain = sender.slice(sender.lastIndexOf('@') + 1)
  // Recipient rules take precedence so the explanation stays deterministic.
  for (const kind of ['recipient', 'sender', 'domain'] as const) {
    const match = rules.find(
      (rule) =>
        rule.kind === kind &&
        (kind === 'recipient'
          ? recipient === rule.value
          : kind === 'sender'
            ? sender === rule.value
            : domain === rule.value || domain.endsWith('.' + rule.value)),
    )
    if (match) return match
  }
  return undefined
}
