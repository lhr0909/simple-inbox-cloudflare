import { normalizeCrlf, utf8Bytes } from './encoding'

export const SYNTHETIC_DOMAIN = 'example.test'

export interface SyntheticInboundFixtureOptions {
  messageId?: string
  from?: string
  to?: string
  subject?: string
  text?: string
  date?: string
  inReplyTo?: string
  references?: readonly string[]
}

export function createSyntheticInboundFixture(options: SyntheticInboundFixtureOptions = {}): {
  envelopeFrom: string
  envelopeTo: string
  raw: Uint8Array
  expected: {
    messageId: string
    subject: string
    text: string
  }
} {
  const messageId = options.messageId ?? '<inbound-001@sender.example.test>'
  const from = options.from ?? 'Synthetic Sender <sender@sender.example.test>'
  const to = options.to ?? 'support@example.test'
  const subject = options.subject ?? 'Synthetic support request'
  const text = options.text ?? 'This fixture is synthetic and contains no customer data.'
  const headers = [
    `Date: ${options.date ?? 'Sat, 01 Aug 2026 04:00:00 +0000'}`,
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    options.inReplyTo ? `In-Reply-To: ${options.inReplyTo}` : null,
    options.references?.length ? `References: ${options.references.join(' ')}` : null,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ].filter((header): header is string => header !== null)
  const raw = utf8Bytes(normalizeCrlf(`${headers.join('\n')}\n\n${text}\n`))
  return {
    envelopeFrom: 'sender@sender.example.test',
    envelopeTo: 'support@example.test',
    raw,
    expected: { messageId, subject, text },
  }
}

export const SYNTHETIC_THREAD_MESSAGES = Object.freeze([
  {
    id: 'synthetic-inbound-1',
    direction: 'inbound' as const,
    sentAt: '2026-08-01T04:00:00.000Z',
    from: 'Synthetic Sender <sender@sender.example.test>',
    replyTo: ['reply-target@sender.example.test'],
  },
  {
    id: 'synthetic-outbound-1',
    direction: 'outbound' as const,
    sentAt: '2026-08-01T04:05:00.000Z',
    from: 'support@example.test',
    replyTo: [],
  },
])

export const SYNTHETIC_SHA256 = 'a'.repeat(64)
