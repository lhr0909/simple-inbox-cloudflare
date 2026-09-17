import { describe, expect, it } from 'vitest'
import { CreateSpamRuleSchema } from '../src/spam'

describe('blacklist request validation', () => {
  it('accepts only recipient addresses, sender addresses, and domains', () => {
    expect(CreateSpamRuleSchema.parse({ kind: 'domain', value: ' SENDER.EXAMPLE.TEST ' })).toEqual({
      kind: 'domain',
      value: 'sender.example.test',
    })
    for (const rule of [
      { kind: 'keyword', value: 'urgent' },
      { kind: 'sender', value: 'not an address' },
      { kind: 'domain', value: 'https://sender.example.test' },
      { kind: 'recipient', value: 'hello@example.test', action: 'delete' },
    ])
      expect(CreateSpamRuleSchema.safeParse(rule).success).toBe(false)
  })
})
