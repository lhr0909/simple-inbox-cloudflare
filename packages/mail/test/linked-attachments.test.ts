import { describe, expect, it } from 'vitest'
import { MAX_MESSAGE_PROJECTION_BODY_BYTES } from '@cloudflare-inbox/mail-core'
import type { UploadedFile } from '@cloudflare-inbox/db'
import { appendLinkedAttachments } from '../src/services/linked-attachments'

const file: UploadedFile = {
  id: 'synthetic',
  ownerUserId: 'owner',
  filename: '<img src=x onerror=alert(1)> & report.txt',
  mediaType: 'text/plain',
  size: 1024 ** 3,
  objectKey: 'attachments/synthetic',
  multipartId: 'synthetic',
  downloadToken: 'a'.repeat(64),
  etag: 'verified',
  outboundSendId: null,
  createdAt: 0,
}

describe('linked email rendering', () => {
  it('escapes filenames, includes stable links in both alternatives, and does not include bytes', () => {
    const rendered = appendLinkedAttachments(
      { text: 'Your report', html: '<p>Your report</p>' },
      [file],
      'https://inbox.example.test',
    )
    expect(rendered.html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; report.txt')
    expect(rendered.html).not.toContain('<img')
    expect(rendered.html).toContain(
      `href="https://inbox.example.test/api/v1/downloads/${file.downloadToken}"`,
    )
    expect(rendered.text).toContain(
      `https://inbox.example.test/api/v1/downloads/${file.downloadToken}`,
    )
    expect(rendered.text).toContain('1,073,741,824 bytes')
  })
  it('checks the final styled body budget even without linked files', () => {
    expect(() =>
      appendLinkedAttachments(
        { text: 'Body', html: 'x'.repeat(MAX_MESSAGE_PROJECTION_BODY_BYTES) },
        [],
        'https://inbox.example.test',
      ),
    ).toThrow(expect.objectContaining({ code: 'request_too_large', status: 413 }))
  })
  it('has no arbitrary file-count limit', () => {
    const rendered = appendLinkedAttachments(
      { text: 'Files', html: '<p>Files</p>' },
      Array.from({ length: 101 }, () => file),
      'https://inbox.example.test',
    )
    expect(rendered.html.match(/<a href=/gu)).toHaveLength(101)
  })
})
