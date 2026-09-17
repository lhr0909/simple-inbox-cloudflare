import { describe, expect, it } from 'vitest'
import { matchBlacklist } from '../src/spam'

describe('explicit spam blacklist', () => {
  const rules = [
    { id: 'alias', kind: 'recipient' as const, value: 'unused@example.test' },
    { id: 'sender', kind: 'sender' as const, value: 'blocked@sender.example.test' },
    { id: 'domain', kind: 'domain' as const, value: 'sender.example.test' },
  ]
  it('matches normalized envelope aliases and gives them precedence', () => {
    expect(
      matchBlacklist(rules, {
        recipient: 'UNUSED@example.test',
        sender: 'blocked@sender.example.test',
      })?.id,
    ).toBe('alias')
  })
  it('matches sender addresses and domain subdomains, not suffix lookalikes', () => {
    expect(
      matchBlacklist(rules, {
        recipient: 'inbox@example.test',
        sender: 'blocked@sender.example.test',
      })?.id,
    ).toBe('sender')
    expect(
      matchBlacklist(rules, {
        recipient: 'inbox@example.test',
        sender: 'person@sub.sender.example.test',
      })?.id,
    ).toBe('domain')
    expect(
      matchBlacklist(rules, {
        recipient: 'inbox@example.test',
        sender: 'person@notsender.example.test',
      }),
    ).toBeUndefined()
    expect(
      matchBlacklist(rules, {
        recipient: 'inbox@example.test',
        sender: 'person@sender.example.test.evil.test',
      }),
    ).toBeUndefined()
  })
  it('does not infer spam from unknown senders or recipient aliases', () => {
    expect(
      matchBlacklist(rules, { recipient: 'new@example.test', sender: 'unknown@example.test' }),
    ).toBeUndefined()
  })
})
