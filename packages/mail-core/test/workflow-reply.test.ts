import { describe, expect, it } from 'vitest'

import { selectReplyTarget } from '../src/reply'
describe('reply target selection', () => {
  const messages = [
    {
      id: 'inbound-old',
      direction: 'inbound' as const,
      sentAt: '2026-07-01T00:00:00.000Z',
      from: 'Old Sender <old@example.test>',
      replyTo: ['old-reply@example.test'],
    },
    {
      id: 'inbound-new',
      direction: 'inbound' as const,
      sentAt: '2026-08-01T00:00:00.000Z',
      from: 'New Sender <new@example.test>',
      replyTo: [' ', 'new-reply@example.test'],
    },
    {
      id: 'outbound',
      direction: 'outbound' as const,
      sentAt: '2026-08-02T00:00:00.000Z',
      from: 'support@example.test',
    },
  ]

  it('prefers Reply-To on the latest eligible inbound message', () => {
    expect(selectReplyTarget(messages)).toEqual({
      address: { address: 'new-reply@example.test' },
      messageId: 'inbound-new',
      source: 'reply_to',
    })
  })

  it('honors an explicitly selected inbound and falls back to From', () => {
    expect(
      selectReplyTarget(
        [{ ...messages[0]!, replyTo: [] }, messages[1]!, messages[2]!],
        'inbound-old',
      ),
    ).toEqual({
      address: { address: 'old@example.test', name: 'Old Sender' },
      messageId: 'inbound-old',
      source: 'from',
    })
  })

  it('ignores an outbound explicit selection', () => {
    expect(selectReplyTarget(messages, 'outbound')?.messageId).toBe('inbound-new')
  })
})
