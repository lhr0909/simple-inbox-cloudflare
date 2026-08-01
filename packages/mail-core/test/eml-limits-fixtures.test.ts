import { describe, expect, it } from 'vitest'

import { canonicalEmlToText, generateCanonicalOutboundEml } from '../src/eml'
import {
  checkProviderLimits,
  estimateBase64WireBytes,
  estimateOutboundWireSize,
  MAX_INBOUND_BYTES,
  MEBIBYTE,
} from '../src/limits'
import { renderSafeMessageContent } from '../src/render'
import { createSyntheticInboundFixture, SYNTHETIC_DOMAIN } from '../src/testing'

const canonicalInput = {
  providerMessageId: 'provider-send-001',
  sentAt: '2026-08-01T12:34:56.000Z',
  from: 'Support <support@example.test>',
  to: ['"Doe, Jane" <jane@example.test>', 'other@example.test'],
  cc: 'manager@example.test',
  subject: 'Re: Héllo\r\nBcc: injected@example.test',
  content: renderSafeMessageContent({
    source: 'app' as const,
    markdown: '**Hello** from support.',
  }),
  inReplyTo: '<inbound@example.test>',
  references: ['<older@example.test>', '<inbound@example.test>'],
  attachments: [
    {
      filename: '../../résumé.pdf',
      contentType: 'application/pdf',
      content: new Uint8Array([0, 1, 2, 255]),
    },
  ],
}

describe('canonical outbound EML', () => {
  it('is deterministic RFC 822 with canonical threading and provider identity', () => {
    const first = canonicalEmlToText(generateCanonicalOutboundEml(canonicalInput))
    const second = canonicalEmlToText(generateCanonicalOutboundEml(canonicalInput))
    expect(first).toBe(second)
    expect(first).toContain('Date: Sat, 01 Aug 2026 12:34:56 GMT\r\n')
    expect(first).toContain('Message-ID: <')
    expect(first).toContain('X-Provider-Message-ID: provider-send-001')
    expect(first).toContain('In-Reply-To: <inbound@example.test>')
    expect(first).toContain('References: <older@example.test> <inbound@example.test>')
    expect(first).toContain('Content-Type: multipart/mixed;')
    expect(first).toContain('Content-Transfer-Encoding: base64')
  })

  it('prevents header injection, path filenames, and Bcc disclosure', () => {
    const eml = canonicalEmlToText(generateCanonicalOutboundEml(canonicalInput))
    expect(eml).not.toContain('\r\nBcc:')
    expect(eml).not.toContain('../')
    expect(eml).toContain('Content-Disposition: attachment; filename="r_sum_.pdf"')
    expect(eml).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf")
  })

  it('uses the provider Message-ID directly when it is RFC-valid', () => {
    const eml = canonicalEmlToText(
      generateCanonicalOutboundEml({
        ...canonicalInput,
        providerMessageId: '<provider@EXAMPLE.TEST>',
        attachments: [],
      }),
    )
    expect(eml).toContain('Message-ID: <provider@example.test>')
    expect(eml).not.toContain('X-Provider-Message-ID')
  })

  it('folds long unstructured headers below the RFC hard line limit', () => {
    const eml = canonicalEmlToText(
      generateCanonicalOutboundEml({ ...canonicalInput, subject: 'long '.repeat(300) }),
    )
    expect(Math.max(...eml.split('\r\n').map((line) => line.length))).toBeLessThan(998)
  })
})

describe('provider size estimates', () => {
  it('accounts for base64 and MIME overhead', () => {
    expect(estimateBase64WireBytes(3)).toBe(6)
    const estimate = estimateOutboundWireSize({
      text: 'hello',
      attachments: [{ size: 3, filename: 'a.txt', contentType: 'text/plain' }],
      recipientCount: 2,
    })
    expect(estimate.estimatedWireBytes).toBeGreaterThan(5 + 3)
    expect(estimate.attachmentBytes).toBeGreaterThan(3)
  })

  it('applies distinct verified-owner and arbitrary-recipient profiles', () => {
    const input = { attachments: [{ size: 6 * MEBIBYTE }] }
    expect(checkProviderLimits('user-send', input)).toMatchObject({
      allowed: false,
      reasons: ['message_size_limit'],
    })
    expect(checkProviderLimits('owner-forward', input).allowed).toBe(true)
  })

  it('enforces combined recipients and attachment counts', () => {
    expect(checkProviderLimits('user-send', { recipientCount: 51 }).reasons).toContain(
      'recipient_limit',
    )
    expect(
      checkProviderLimits('user-send', {
        attachments: Array.from({ length: 33 }, () => ({ size: 0 })),
      }).reasons,
    ).toContain('attachment_limit')
    expect(MAX_INBOUND_BYTES).toBe(25 * MEBIBYTE)
  })
})

describe('synthetic fixtures', () => {
  it('contains only reserved example data and exact CRLF raw bytes', () => {
    const fixture = createSyntheticInboundFixture()
    const raw = new TextDecoder().decode(fixture.raw)
    expect(SYNTHETIC_DOMAIN).toBe('example.test')
    expect(fixture.envelopeTo.endsWith(`@${SYNTHETIC_DOMAIN}`)).toBe(true)
    expect(raw).toContain('Message-ID: <inbound-001@sender.example.test>\r\n')
    expect(raw.replaceAll('\r\n', '')).not.toContain('\n')
    expect(raw).toContain('contains no customer data')
  })
})
