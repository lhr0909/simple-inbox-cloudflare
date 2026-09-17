import { afterEach, describe, expect, it, vi } from 'vitest'

import { blacklistAndMoveToSpam, sendNewMessage } from './inbox-api'

const MAILBOX_ID = '019b08e0-1000-7000-8000-000000000001'
const THREAD_ID = '019b08e0-2000-7000-8000-000000000001'
const MESSAGE_ID = '019b08e0-3000-7000-8000-000000000001'
const SEND_ID = '019b08e0-5000-7000-8000-000000000001'

afterEach(() => vi.unstubAllGlobals())

describe('inbox mutation client', () => {
  it('preserves quoted recipient lists in multipart sends and forwards the stable key', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = init?.body
      expect(body).toBeInstanceOf(FormData)
      if (!(body instanceof FormData)) throw new TypeError('Expected multipart body')
      expect(body.getAll('to')).toEqual(['"Doe, Jane" <jane@example.com>, other@example.com'])
      expect(body.get('mailboxId')).toBe(MAILBOX_ID)
      expect(new Headers(init?.headers).get('idempotency-key')).toBe('send-test-key-0001')

      return Response.json(
        {
          acceptedAt: '2026-08-01T00:00:00.000Z',
          completedAt: '2026-08-01T00:00:01.000Z',
          id: SEND_ID,
          idempotencyKey: 'send-test-key-0001',
          messageId: MESSAGE_ID,
          retryability: 'not_retryable',
          safeErrorCode: null,
          state: 'sent',
          threadId: THREAD_ID,
        },
        { status: 201 },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    await sendNewMessage(MAILBOX_ID, {
      attachments: [],
      bcc: '',
      body: 'A bounded message.',
      cc: '',
      idempotencyKey: 'send-test-key-0001',
      subject: 'Quoted recipient check',
      to: '"Doe, Jane" <jane@example.com>, other@example.com',
    })

    expect(fetchMock).toHaveBeenCalledOnce()
  })
})

describe('spam blacklist action', () => {
  it('does not move mail when saving the blacklist fails', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      blacklistAndMoveToSpam(THREAD_ID, { kind: 'sender', value: 'sender@example.test' }),
    ).rejects.toThrow('The update could not be saved.')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/spam-rules')
  })

  it('reports a saved rule when the conversation update fails so the user can retry', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      blacklistAndMoveToSpam(THREAD_ID, { kind: 'domain', value: 'example.test' }),
    ).rejects.toThrow(
      'The blacklist was saved, but this conversation could not be moved to Spam. Retry to finish.',
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/v1/threads/${THREAD_ID}/state`)
  })
})
