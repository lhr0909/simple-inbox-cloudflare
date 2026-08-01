import { describe, expect, it } from 'vitest'

import {
  formatAddress,
  normalizeEmailAddress,
  normalizeEnvelopeAddress,
  normalizeRecipientFields,
  parseAddressList,
  parseMailbox,
  parseReplyAlias,
} from '../src/address'

describe('address normalization', () => {
  it('parses quoted display names and normalizes addresses', () => {
    expect(
      parseAddressList('"Doe, Jane" <JANE@Example.COM>, Bob@example.com; bob@EXAMPLE.com'),
    ).toEqual([{ name: 'Doe, Jane', address: 'jane@example.com' }, { address: 'bob@example.com' }])
    expect(formatAddress({ name: 'Jane "JJ"', address: 'JANE@example.com' })).toBe(
      '"Jane \\"JJ\\"" <jane@example.com>',
    )
  })

  it('normalizes provider identity case-insensitively', () => {
    expect(normalizeEmailAddress(' Alice+Tag@Sub.Example.COM ')).toBe('alice+tag@sub.example.com')
    expect(parseMailbox('Support@Example.COM')).toEqual({
      address: 'support@example.com',
      localPart: 'support',
      domain: 'example.com',
    })
    expect(normalizeEnvelopeAddress('<>', { allowNullReversePath: true })).toBeNull()
    expect(() => normalizeEnvelopeAddress('<>')).toThrow()
  })

  it('deduplicates across To, CC, and BCC with field priority', () => {
    expect(
      normalizeRecipientFields({
        to: 'one@example.test, two@example.test',
        cc: ['TWO@example.test', 'three@example.test'],
        bcc: 'one@example.test, four@example.test',
      }),
    ).toEqual({
      to: [{ address: 'one@example.test' }, { address: 'two@example.test' }],
      cc: [{ address: 'three@example.test' }],
      bcc: [{ address: 'four@example.test' }],
      count: 4,
    })
  })

  it('enforces required To and the combined provider recipient limit', () => {
    expect(() => normalizeRecipientFields({ to: ' , ' })).toThrow('At least one To')
    expect(() =>
      normalizeRecipientFields({ to: ['one@example.test'], cc: ['two@example.test'] }, 1),
    ).toThrow('exceeds the provider limit')
  })

  it('rejects malformed and header-injection addresses', () => {
    for (const value of [
      'no-at-sign',
      '.dot@example.test',
      'two..dots@example.test',
      'a@example..test',
      'a@example.test\r\nBcc: victim@example.test',
      '"unclosed <a@example.test>',
    ]) {
      expect(() => parseAddressList(value)).toThrow()
    }
  })

  it('recognizes only opaque base32 reply aliases in the configured domain', () => {
    expect(
      parseReplyAlias('reply+abcdefghijklmnopqrstuvwxyz234567@example.test', {
        domain: 'example.test',
      }),
    ).toEqual({
      address: 'reply+abcdefghijklmnopqrstuvwxyz234567@example.test',
      token: 'abcdefghijklmnopqrstuvwxyz234567',
    })
    expect(parseReplyAlias('reply+thread-123@example.test', { domain: 'example.test' })).toBeNull()
    expect(
      parseReplyAlias('reply+abcdefghijklmnopqrstuvwxyz234567@other.test', {
        domain: 'example.test',
      }),
    ).toBeNull()
  })
})
