import { describe, expect, it } from 'vitest'

import {
  canonicalInboxSearch,
  inboxListSearchKey,
  inboxQueryFromSearch,
  parseInboxSearch,
  sameInboxSearch,
  updateInboxSearch,
} from './inbox-search'

const MAILBOX_ID = '019b08e0-1000-7000-8000-000000000001'
const OTHER_MAILBOX_ID = '019b08e0-1000-7000-8000-000000000002'
const THREAD_ID = '019b08e0-2000-7000-8000-000000000001'

describe('inbox URL state', () => {
  it('normalizes valid shareable search parameters', () => {
    expect(
      parseInboxSearch({
        mailbox: MAILBOX_ID,
        folder: 'needs-reply',
        unread: '1',
        q: '  invoice  ',
        thread: THREAD_ID,
      }),
    ).toEqual({
      mailbox: MAILBOX_ID,
      folder: 'needs-reply',
      unread: '1',
      q: 'invoice',
      thread: THREAD_ID,
    })
  })

  it('replaces malformed values with safe defaults and drops unknown fields', () => {
    expect(
      parseInboxSearch({
        mailbox: 'not-an-id',
        folder: 'spam',
        unread: 'true',
        q: '   ',
        thread: ['not', 'scalar'],
        token: 'must-not-survive',
      }),
    ).toEqual({ folder: 'all' })
  })

  it('converts route state into the normalized API-facing query model', () => {
    expect(
      inboxQueryFromSearch(
        { folder: 'sent', mailbox: MAILBOX_ID, q: 'receipt', thread: THREAD_ID, unread: '1' },
        MAILBOX_ID,
      ),
    ).toEqual({
      mailboxId: MAILBOX_ID,
      folder: 'sent',
      unreadOnly: true,
      search: 'receipt',
      threadId: THREAD_ID,
    })
  })

  it('clears a stale thread when list-defining state changes', () => {
    const current = {
      folder: 'all' as const,
      mailbox: MAILBOX_ID,
      q: 'invoice',
      thread: THREAD_ID,
    }

    expect(updateInboxSearch(current, { folder: 'archive' })).toEqual({
      folder: 'archive',
      mailbox: MAILBOX_ID,
      q: 'invoice',
    })
    expect(updateInboxSearch(current, { mailboxId: OTHER_MAILBOX_ID })).toEqual({
      folder: 'all',
      mailbox: OTHER_MAILBOX_ID,
      q: 'invoice',
    })
    expect(updateInboxSearch(current, { threadId: null })).toEqual({
      folder: 'all',
      mailbox: MAILBOX_ID,
      q: 'invoice',
    })
  })

  it('canonicalizes mailbox fallback and unavailable thread state', () => {
    const canonical = canonicalInboxSearch(
      { folder: 'all', mailbox: OTHER_MAILBOX_ID, thread: THREAD_ID, unread: '1' },
      MAILBOX_ID,
      false,
    )

    expect(canonical).toEqual({ folder: 'all', mailbox: MAILBOX_ID, unread: '1' })
    expect(sameInboxSearch(canonical, parseInboxSearch(canonical))).toBe(true)
  })

  it('keeps the paginated-list identity stable across detail navigation', () => {
    const list = { folder: 'all' as const, mailbox: MAILBOX_ID, q: 'invoice' }

    expect(inboxListSearchKey(list)).toBe(inboxListSearchKey({ ...list, thread: THREAD_ID }))
  })
})
