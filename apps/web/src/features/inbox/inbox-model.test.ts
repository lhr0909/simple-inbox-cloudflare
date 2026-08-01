import { describe, expect, it } from 'vitest'

import { ThreadListResponseSchema } from '@cloudflare-inbox/contracts/threads'

import { createPreviewInboxData } from './preview-data'
import {
  applyOptimisticThreadStates,
  attachmentLimitError,
  appendThreadPage,
  clampPaneSize,
  filterThreads,
  inboundReplyTargets,
  initials,
  messageDeliveryPresentation,
  replySubject,
  threadMatchesFolder,
} from './inbox-model'

const data = createPreviewInboxData()

describe('inbox presentation model', () => {
  it('keeps archived state independent from unread state', () => {
    const archived = data.threads.find((thread) => thread.archivedAt !== null)
    expect(archived).toBeDefined()
    expect(archived && threadMatchesFolder(archived, 'archive')).toBe(true)
  })

  it('filters needs-reply without including archived threads', () => {
    const results = filterThreads(data.threads, 'needs-reply', false, '')
    expect(results).toHaveLength(2)
    expect(results.every((thread) => thread.archivedAt === null)).toBe(true)
  })

  it('searches subject, preview, address, and display name case-insensitively', () => {
    expect(filterThreads(data.threads, 'all', false, 'MAYA')).toHaveLength(1)
    expect(filterThreads(data.threads, 'all', false, 'routing@example.test')).toHaveLength(1)
    expect(filterThreads(data.threads, 'all', false, 'production checks')).toHaveLength(1)
  })

  it('applies unread filtering after folder filtering', () => {
    const results = filterThreads(data.threads, 'all', true, '')
    expect(results).toHaveLength(2)
    expect(results.every((thread) => thread.unreadCount > 0)).toBe(true)
  })

  it('builds stable two-character fallbacks', () => {
    expect(initials('Maya Chen')).toBe('MC')
    expect(initials('routing@example.test')).toBe('R')
    expect(initials('')).toBe('?')
  })

  it('projects reversible read and archive state without mutating server data', () => {
    const selected = data.selectedThread
    expect(selected).not.toBeNull()
    if (selected === null) return

    const readAt = '2026-08-01T06:30:00.000Z'
    const projected = applyOptimisticThreadStates(data, {
      [selected.thread.id]: { archivedAt: readAt, readAt, unreadCount: 0 },
    })

    expect(projected.selectedThread?.thread).toMatchObject({ archivedAt: readAt, unreadCount: 0 })
    expect(
      projected.selectedThread?.messages
        .filter((message) => message.direction === 'inbound')
        .every((message) => message.readAt !== null),
    ).toBe(true)
    expect(projected.mailboxes[0]?.counts).toMatchObject({ all: 17, archive: 8, unread: 2 })
    expect(selected.thread).toMatchObject({ archivedAt: null, unreadCount: 1 })
  })

  it('uses unread-message totals and reapplies active list membership optimistically', () => {
    const thread = data.threads.find((item) => item.unreadCount === 2)
    expect(thread).toBeDefined()
    if (thread === undefined) return

    const projected = applyOptimisticThreadStates(
      data,
      { [thread.id]: { unreadCount: 0 } },
      { folder: 'all', unreadOnly: true },
    )

    expect(projected.threads.some((item) => item.id === thread.id)).toBe(false)
    expect(projected.mailboxes[0]?.counts.unread).toBe(data.mailboxes[0]!.counts.unread - 2)
  })

  it('lists every inbound message as an explicit reply target', () => {
    expect(
      inboundReplyTargets(data.selectedThread?.messages ?? []).map((message) => message.id),
    ).toEqual(['019b08e0-3000-7000-8000-000000000001', '019b08e0-3000-7000-8000-000000000003'])
  })

  it('clamps keyboard and pointer resizing to usable pane bounds', () => {
    expect(clampPaneSize(100, 220, 360)).toBe(220)
    expect(clampPaneSize(280, 220, 360)).toBe(280)
    expect(clampPaneSize(900, 220, 360)).toBe(360)
  })

  it('appends cursor pages without duplicating overlapping summaries', () => {
    const page = ThreadListResponseSchema.parse({
      items: [data.threads[0]!, { ...data.threads[1]!, id: data.threads[5]!.id }],
      nextCursor: 'next_cursor_value_1234',
    })
    const projected = appendThreadPage(
      { ...data, threads: data.threads.slice(0, 1), nextCursor: 'prior_cursor_value_1234' },
      page,
    )

    expect(projected.threads.map((thread) => thread.id)).toEqual([
      data.threads[0]!.id,
      data.threads[5]!.id,
    ])
    expect(projected.nextCursor).toBe('next_cursor_value_1234')
  })

  it('never presents unknown delivery as sent and surfaces forwarding failures safely', () => {
    expect(
      messageDeliveryPresentation({
        direction: 'outbound',
        failure: {
          retryability: 'manual_confirmation_required',
          safeErrorCode: 'provider_outcome_unknown',
        },
        forwardState: 'not_applicable',
        sendState: 'unknown',
      }),
    ).toMatchObject({
      label: 'Delivery unknown',
      notice:
        'Delivery could not be confirmed. Do not retry automatically; confirm the outcome with the recipient or provider first. Reference: provider_outcome_unknown.',
      variant: 'destructive',
    })
    expect(
      messageDeliveryPresentation({
        direction: 'inbound',
        failure: { retryability: 'not_retryable', safeErrorCode: 'forward_rejected' },
        forwardState: 'failed',
        sendState: 'not_applicable',
      }),
    ).toMatchObject({
      label: 'Forward failed',
      notice:
        'Forwarding failed. The message remains safely available in this inbox. Reference: forward_rejected.',
    })
  })

  it('bounds reply subjects and mirrors attachment limits before upload', () => {
    expect(replySubject('RE: Existing subject')).toBe('RE: Existing subject')
    expect(replySubject('x'.repeat(998))).toHaveLength(998)
    expect(attachmentLimitError(Array.from({ length: 21 }, () => ({ size: 1 })))).toBe(
      'Attach at most 20 files.',
    )
    expect(attachmentLimitError([{ size: 10 * 1_024 * 1_024 + 1 }])).toBe(
      'Each attachment must be 10 MiB or smaller.',
    )
  })
})
