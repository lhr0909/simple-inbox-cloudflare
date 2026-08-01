import { describe, expect, it } from 'vitest'

import { resolveThread, type ThreadResolutionInput } from '../src/threading'

const base: ThreadResolutionInput = {
  mailboxId: 'mailbox-1',
  receivedAt: '2026-08-01T12:00:00.000Z',
  subject: 'Re: Need help',
  participants: ['support@example.test', 'sender@example.test'],
  inReplyTo: '<parent@example.test>',
  references: ['<old@example.test>', '<referenced@example.test>'],
  knownMessages: [
    {
      threadId: 'thread-parent',
      mailboxId: 'mailbox-1',
      internetMessageId: '<parent@example.test>',
    },
    {
      threadId: 'thread-reference',
      mailboxId: 'mailbox-1',
      internetMessageId: '<referenced@example.test>',
    },
  ],
  fallbackCandidates: [
    {
      threadId: 'thread-fallback',
      mailboxId: 'mailbox-1',
      subject: 'Need help',
      participants: ['sender@example.test', 'support@example.test'],
      latestMessageAt: '2026-07-31T12:00:00.000Z',
    },
  ],
}

describe('thread resolution', () => {
  it('uses reply alias, In-Reply-To, References, then subject fallback in order', () => {
    expect(resolveThread({ ...base, replyAliasThreadId: 'thread-alias' })).toEqual({
      kind: 'reply_alias',
      threadId: 'thread-alias',
    })
    expect(resolveThread(base)).toMatchObject({
      kind: 'in_reply_to',
      threadId: 'thread-parent',
    })
    expect(resolveThread({ ...base, inReplyTo: null })).toMatchObject({
      kind: 'references',
      threadId: 'thread-reference',
    })
    expect(resolveThread({ ...base, inReplyTo: null, references: null })).toEqual({
      kind: 'subject_participants',
      threadId: 'thread-fallback',
    })
  })

  it('walks References newest to oldest', () => {
    expect(
      resolveThread({
        ...base,
        inReplyTo: null,
        references: ['<parent@example.test>', '<referenced@example.test>'],
      }),
    ).toMatchObject({ threadId: 'thread-reference' })
  })

  it('never resolves a Message-ID from another mailbox', () => {
    expect(
      resolveThread({
        ...base,
        knownMessages: [
          {
            threadId: 'foreign-thread',
            mailboxId: 'mailbox-2',
            internetMessageId: '<parent@example.test>',
          },
        ],
        fallbackCandidates: [],
      }),
    ).toEqual({ kind: 'new' })
  })

  it('requires the same participant set inside the bounded past window', () => {
    expect(
      resolveThread({
        ...base,
        inReplyTo: null,
        references: null,
        fallbackCandidates: [
          { ...base.fallbackCandidates[0]!, participants: ['someone-else@example.test'] },
          {
            ...base.fallbackCandidates[0]!,
            threadId: 'too-old',
            latestMessageAt: '2025-01-01T00:00:00.000Z',
          },
          {
            ...base.fallbackCandidates[0]!,
            threadId: 'future',
            latestMessageAt: '2026-08-02T00:00:00.000Z',
          },
        ],
      }),
    ).toEqual({ kind: 'new' })
  })

  it('breaks equal fallback timestamps deterministically by thread ID', () => {
    const candidate = base.fallbackCandidates[0]!
    expect(
      resolveThread({
        ...base,
        inReplyTo: null,
        references: null,
        fallbackCandidates: [
          { ...candidate, threadId: 'thread-z' },
          { ...candidate, threadId: 'thread-a' },
        ],
      }),
    ).toEqual({ kind: 'subject_participants', threadId: 'thread-a' })
  })
})
