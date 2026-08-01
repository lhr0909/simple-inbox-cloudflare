import { describe, expect, it } from 'vitest'

import {
  appendReference,
  buildThreadFallbackInput,
  ensureReplySubject,
  normalizeInReplyTo,
  normalizeMessageId,
  normalizeReferences,
  normalizeSubject,
  normalizeSubjectForThreading,
} from '../src/headers'

describe('mail header normalization', () => {
  it('normalizes valid Message-IDs without trusting surrounding text', () => {
    expect(normalizeMessageId(' <Case.Sensitive@EXAMPLE.TEST> ')).toBe(
      '<Case.Sensitive@example.test>',
    )
    expect(normalizeMessageId('noise <id@example.test> comment')).toBe('<id@example.test>')
    expect(normalizeMessageId('not-an-id')).toBeNull()
    expect(normalizeMessageId('<bad id@example.test>')).toBeNull()
  })

  it('selects the newest In-Reply-To ID and normalizes References', () => {
    expect(normalizeInReplyTo('<old@x.test> <parent@X.TEST>')).toBe('<parent@x.test>')
    expect(normalizeReferences('junk <one@X.TEST> <two@x.test> <one@x.test>')).toEqual([
      '<two@x.test>',
      '<one@x.test>',
    ])
  })

  it('retains the newest useful references under count and byte caps', () => {
    expect(
      normalizeReferences(['<one@x.test>', '<two@x.test>', '<three@x.test>'], { maxCount: 2 }),
    ).toEqual(['<two@x.test>', '<three@x.test>'])
    expect(
      appendReference(['<one@x.test>', '<two@x.test>'], '<three@x.test>', {
        maxCount: 2,
      }),
    ).toEqual(['<two@x.test>', '<three@x.test>'])
  })

  it('uses a safe subject fallback and only strips leading reply/forward prefixes', () => {
    expect(normalizeSubject(' \r\n ')).toBe('No subject')
    expect(normalizeSubjectForThreading(' Re: FWD:  Quarterly Re: view ')).toBe(
      'quarterly re: view',
    )
    expect(ensureReplySubject('RE: Re: Hello')).toBe('Re: Hello')
    expect(ensureReplySubject('Fwd: Hello')).toBe('Re: Fwd: Hello')
    expect(ensureReplySubject('')).toBe('Re: No subject')
  })

  it('creates deterministic, order-independent conservative fallback inputs', () => {
    expect(
      buildThreadFallbackInput({
        subject: 'Re: Help',
        participants: ['CUSTOMER@example.test', 'support@example.test'],
      }),
    ).toEqual(
      buildThreadFallbackInput({
        subject: 'help',
        participants: ['support@example.test', 'customer@example.test'],
      }),
    )
    expect(buildThreadFallbackInput({ subject: '', participants: ['a@b.test'] })).toBeNull()
    expect(buildThreadFallbackInput({ subject: 'Hello', participants: ['invalid'] })).toBeNull()
  })
})
