import { describe, expect, it } from 'vitest'

import { selectReplyTarget } from '../src/reply'
import { transitionThreadWorkflow, type ThreadWorkflow } from '../src/workflow'

describe('workflow transitions', () => {
  const archived: ThreadWorkflow = {
    workflowState: 'resolved',
    unreadCount: 2,
    archivedAt: '2026-07-01T00:00:00.000Z',
  }

  it('makes new inbound need a reply, increments unread, and unarchives by default', () => {
    expect(
      transitionThreadWorkflow(archived, {
        type: 'inbound_received',
        occurredAt: '2026-08-01T00:00:00.000Z',
      }),
    ).toEqual({ workflowState: 'needs_reply', unreadCount: 3, archivedAt: null })
  })

  it('only preserves inbound archive state when explicitly requested', () => {
    expect(
      transitionThreadWorkflow(archived, {
        type: 'inbound_received',
        occurredAt: '2026-08-01T00:00:00.000Z',
        preserveArchive: true,
      }).archivedAt,
    ).toBe(archived.archivedAt)
  })

  it('makes outbound waiting, marks prior inbound read, and preserves archive', () => {
    expect(
      transitionThreadWorkflow(archived, {
        type: 'outbound_replied',
        occurredAt: '2026-08-01T00:00:00.000Z',
      }),
    ).toEqual({
      workflowState: 'waiting',
      unreadCount: 0,
      archivedAt: archived.archivedAt,
    })
  })

  it('accepts the shared-contract outbound event spelling', () => {
    expect(
      transitionThreadWorkflow(archived, {
        type: 'outbound_sent',
        occurredAt: '2026-08-01T00:00:00.000Z',
      }).workflowState,
    ).toBe('waiting')
  })

  it('keeps archive and workflow axes independent', () => {
    const resolved = transitionThreadWorkflow(archived, { type: 'resolved' })
    const rearchived = transitionThreadWorkflow(
      { ...resolved, archivedAt: null },
      { type: 'archived', occurredAt: '2026-08-01T01:02:03.000Z' },
    )
    expect(rearchived).toEqual({
      workflowState: 'resolved',
      unreadCount: 2,
      archivedAt: '2026-08-01T01:02:03.000Z',
    })
    expect(transitionThreadWorkflow(rearchived, { type: 'unarchived' })).toEqual({
      ...rearchived,
      archivedAt: null,
    })
  })
})

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
