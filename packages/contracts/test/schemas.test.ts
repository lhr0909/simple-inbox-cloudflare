import { describe, expect, it } from 'vitest'

import {
  API_ERROR_CODES_V1,
  ErrorEnvelopeSchema,
  InternalSendFormSchema,
  MagicLinkAcceptedResponseSchema,
  MessageSchema,
  NewMessageRequestSchema,
  NewMessageFormSchema,
  normalizeEmailAddress,
  normalizeThreadListQuery,
  OpaqueAuthTokenSchema,
  SendRequestHeadersSchema,
  SendResponseSchema,
  ThreadDetailResponseSchema,
  ThreadIdSchema,
} from '../src/index'

const ids = {
  mailbox: '01996f7a-7bcd-7abc-8def-1123456789ab',
  thread: '01996f7a-7bcd-7abc-8def-2123456789ab',
  message: '01996f7a-7bcd-7abc-8def-3123456789ab',
} as const

const baseMessage = {
  id: ids.message,
  mailboxId: ids.mailbox,
  threadId: ids.thread,
  direction: 'inbound',
  internetMessageId: '<synthetic-1@example.test>',
  inReplyTo: null,
  from: { address: 'sender@example.test', displayName: 'Synthetic Sender' },
  recipients: [
    {
      kind: 'to',
      position: 0,
      address: 'owner@example.test',
      displayName: null,
    },
  ],
  references: [],
  subject: 'Synthetic message',
  preview: 'Synthetic preview',
  textBody: 'Synthetic body',
  htmlBody: null,
  htmlPolicy: 'none',
  sentAt: '2026-08-01T05:00:00.000Z',
  receivedAt: '2026-08-01T05:00:01.000Z',
  readAt: null,
  sendState: 'not_applicable',
  forwardState: 'forwarded',
  failure: null,
  rawAvailable: true,
  rawSize: 256,
  attachments: [],
} as const

describe('opaque identifiers and auth tokens', () => {
  it('accepts UUIDv7 IDs and rejects non-sortable UUID versions', () => {
    expect(ThreadIdSchema.safeParse(ids.thread).success).toBe(true)
    expect(ThreadIdSchema.safeParse('550e8400-e29b-41d4-a716-446655440000').success).toBe(false)
  })

  it('requires long, unpadded base64url auth tokens', () => {
    expect(
      OpaqueAuthTokenSchema.safeParse('K3wnMJz4uVVYHF4eBgfRrtDXRskMJLR3zk4JP8Z_LjY').success,
    ).toBe(true)
    expect(OpaqueAuthTokenSchema.safeParse('short-secret').success).toBe(false)
  })
})

describe('boundary normalization', () => {
  it('normalizes addresses explicitly', () => {
    expect(normalizeEmailAddress(' Owner@Example.Test ')).toBe('owner@example.test')
  })

  it('normalizes the cursor query and caps page sizes', () => {
    expect(
      normalizeThreadListQuery({
        mailboxId: ids.mailbox,
        folder: 'needs-reply',
        unread: '1',
        limit: '50',
      }),
    ).toEqual({
      mailboxId: ids.mailbox,
      folder: 'needs-reply',
      unreadOnly: true,
      limit: 50,
    })

    expect(() => normalizeThreadListQuery({ mailboxId: ids.mailbox, limit: '51' })).toThrow()
  })
})

describe('privacy and message invariants', () => {
  it('does not admit BCC into client-visible message recipients', () => {
    expect(
      MessageSchema.safeParse({
        ...baseMessage,
        recipients: [
          {
            kind: 'bcc',
            position: 0,
            address: 'hidden@example.test',
            displayName: null,
          },
        ],
      }).success,
    ).toBe(false)
  })

  it("admits an authenticated sender's outbound BCC record", () => {
    expect(
      MessageSchema.safeParse({
        ...baseMessage,
        direction: 'outbound',
        forwardState: 'not_applicable',
        recipients: [
          {
            kind: 'bcc',
            position: 0,
            address: 'audit@example.test',
            displayName: null,
          },
        ],
        sendState: 'sent',
      }).success,
    ).toBe(true)
  })

  it('rejects outbound messages carrying unread state', () => {
    expect(
      MessageSchema.safeParse({
        ...baseMessage,
        direction: 'outbound',
        readAt: '2026-08-01T05:01:00.000Z',
        sendState: 'sent',
        forwardState: 'not_applicable',
      }).success,
    ).toBe(false)
  })

  it('requires manual confirmation for an unknown provider outcome', () => {
    const unknown = {
      ...baseMessage,
      forwardState: 'unknown',
      failure: {
        retryability: 'manual_confirmation_required',
        safeErrorCode: 'provider_send_unknown',
      },
    } as const

    expect(MessageSchema.parse(unknown).failure).toEqual(unknown.failure)
    expect(
      MessageSchema.safeParse({
        ...unknown,
        failure: { ...unknown.failure, retryability: 'retryable' },
      }).success,
    ).toBe(false)
  })

  it('rejects a detail response whose message crosses mailbox boundaries', () => {
    expect(
      ThreadDetailResponseSchema.safeParse({
        thread: {
          id: ids.thread,
          mailboxId: ids.mailbox,
          subject: 'Synthetic message',
          preview: 'Synthetic preview',
          participants: [{ address: 'sender@example.test', displayName: null }],
          workflowState: 'needs_reply',
          archivedAt: null,
          lastMessageAt: '2026-08-01T05:00:01.000Z',
          lastMessageDirection: 'inbound',
          messageCount: 1,
          unreadCount: 1,
          attachmentCount: 0,
          tags: [],
        },
        messages: [
          {
            ...baseMessage,
            mailboxId: '01996f7a-7bcd-7abc-8def-c123456789ab',
          },
        ],
      }).success,
    ).toBe(false)
  })
})

describe('send and error contracts', () => {
  it('never classifies an unknown send as casually retryable', () => {
    const unknown = {
      acceptedAt: '2026-08-01T05:00:00.000Z',
      completedAt: null,
      id: '01996f7a-7bcd-7abc-8def-4123456789ab',
      idempotencyKey: 'synthetic-send-key-0001',
      messageId: null,
      retryability: 'manual_confirmation_required',
      safeErrorCode: 'provider_send_unknown',
      state: 'unknown',
      threadId: ids.thread,
    } as const

    expect(SendResponseSchema.parse(unknown).retryability).toBe('manual_confirmation_required')
    expect(SendResponseSchema.safeParse({ ...unknown, retryability: 'retryable' }).success).toBe(
      false,
    )
  })

  it('accepts ordinary request headers alongside the required idempotency key', () => {
    expect(
      SendRequestHeadersSchema.safeParse({
        'idempotency-key': '01996f7a-7bcd-7abc-8def-b123456789ab',
        'content-type': 'multipart/form-data; boundary=synthetic',
        cookie: 'simple-inbox-development-session=synthetic',
        origin: 'https://inbox.example.test',
      }).success,
    ).toBe(true)
  })

  it('normalizes scalar multipart fields from one-recipient and one-file forms', () => {
    const attachment = new File(['synthetic attachment'], 'receipt.txt', {
      type: 'text/plain',
    })
    const parsed = NewMessageFormSchema.parse({
      mailboxId: ids.mailbox,
      to: 'recipient@example.test',
      subject: 'Synthetic send',
      body: 'A scalar form-field test.',
      format: 'plain',
      attachments: attachment,
    })

    expect(parsed.to).toEqual(['recipient@example.test'])
    expect(parsed.attachments).toEqual([attachment])
  })

  it('rejects recipients duplicated across visible and blind fields', () => {
    expect(
      NewMessageRequestSchema.safeParse({
        mailboxId: ids.mailbox,
        to: [{ address: 'person@example.test' }],
        cc: [{ address: 'PERSON@example.test' }],
        subject: 'Synthetic send',
        body: 'Hello from a contract test.',
        format: 'plain',
      }).success,
    ).toBe(false)
  })

  it('keeps the magic-link accepted response enumeration resistant', () => {
    expect(MagicLinkAcceptedResponseSchema.parse({ status: 'accepted' })).toEqual({
      status: 'accepted',
    })
    expect(
      MagicLinkAcceptedResponseSchema.safeParse({
        status: 'accepted',
        userExists: true,
      }).success,
    ).toBe(false)
  })

  it('keeps every v1 error code parseable by the envelope', () => {
    for (const code of API_ERROR_CODES_V1) {
      expect(
        ErrorEnvelopeSchema.safeParse({
          error: {
            code,
            message: 'Synthetic safe error.',
            requestId: '01JZXY8J6VSK8PKSRM3R7S3B2G',
          },
        }).success,
      ).toBe(true)
    }
  })

  it('binds internal multipart files to signed send metadata', () => {
    const attachment = new File(['synthetic attachment'], 'receipt.txt', {
      type: 'text/plain',
    })
    const metadata = JSON.stringify({
      requestId: '01JZXY8J6VSK8PKSRM3R7S3B2G',
      idempotencyKey: '01996f7a-7bcd-7abc-8def-b123456789ab',
      requestDigest: 'a'.repeat(64),
      actor: {
        userId: '01996f7a-7bcd-7abc-8def-0123456789ab',
        mailboxId: ids.mailbox,
        authKind: 'session',
        scopes: [],
      },
      command: {
        mode: 'new',
        message: {
          mailboxId: ids.mailbox,
          to: [{ address: 'recipient@example.test' }],
          subject: 'Synthetic attachment',
          body: 'The attachment is synthetic.',
          format: 'plain',
          attachments: [
            {
              filename: attachment.name,
              mediaType: attachment.type,
              size: attachment.size,
            },
          ],
        },
      },
    })

    expect(InternalSendFormSchema.safeParse({ metadata, attachments: [attachment] }).success).toBe(
      true,
    )
    expect(InternalSendFormSchema.parse({ metadata, attachments: attachment }).attachments).toEqual(
      [attachment],
    )
    expect(
      InternalSendFormSchema.safeParse({
        metadata,
        attachments: [new File(['changed'], 'receipt.txt', { type: 'text/plain' })],
      }).success,
    ).toBe(false)
  })
})
