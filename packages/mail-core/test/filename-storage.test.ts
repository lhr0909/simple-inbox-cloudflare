import { describe, expect, it } from 'vitest'

import {
  buildContentDisposition,
  safeAttachmentContentType,
  sanitizeFilename,
} from '../src/filename'
import { buildInboundRawKey, buildOutboundRawKey } from '../src/storage'

describe('safe attachment response metadata', () => {
  it('removes paths, controls, dangerous punctuation, and reserved basenames', () => {
    expect(sanitizeFilename('../../secret\r\nreport?.pdf')).toBe('secretreport_.pdf')
    expect(sanitizeFilename('C:\\temp\\CON')).toBe('_CON')
    expect(sanitizeFilename('...', 'download.bin')).toBe('download.bin')
  })

  it('truncates by UTF-8 bytes while retaining a short extension', () => {
    const filename = sanitizeFilename(`${'😀'.repeat(100)}.png`, 'attachment.bin', 40)
    expect(new TextEncoder().encode(filename).byteLength).toBeLessThanOrEqual(40)
    expect(filename.endsWith('.png')).toBe(true)
  })

  it('builds quoted and RFC 5987 content disposition without injection', () => {
    const header = buildContentDisposition('résumé"\r\nX-Evil: yes.pdf')
    expect(header).toContain('attachment; filename="r_sum_X-Evil_ yes.pdf"')
    expect(header).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9_X-Evil_%20yes.pdf")
    expect(header).not.toContain('\r')
    expect(header).not.toContain('\n')
  })

  it('falls back for syntactically invalid or active content types', () => {
    expect(safeAttachmentContentType('application/pdf')).toBe('application/pdf')
    expect(safeAttachmentContentType('text/html')).toBe('application/octet-stream')
    expect(safeAttachmentContentType('image/svg+xml')).toBe('application/octet-stream')
    expect(safeAttachmentContentType('bad\r\nvalue')).toBe('application/octet-stream')
  })
})

describe('immutable raw object keys', () => {
  it('uses a content-addressed inbound UTC date key', () => {
    expect(buildInboundRawKey('2026-08-01T23:00:00-05:00', 'A'.repeat(64))).toBe(
      `raw/inbound/2026/08/02/${'a'.repeat(64)}.eml`,
    )
    expect(() => buildInboundRawKey('2026-08-01', 'not-a-sha')).toThrow()
  })

  it('encodes outbound IDs into one inert segment', () => {
    const key = buildOutboundRawKey('2026-08-01T00:00:00Z', '../../filename/attack')
    expect(key).toMatch(/^raw\/outbound\/2026\/08\/01\/id-[A-Za-z0-9_-]+\.eml$/u)
    expect(key).not.toContain('..')
    expect(key).not.toContain('filename')
    expect(() => buildOutboundRawKey('2026-08-01', '😀'.repeat(500))).toThrow('bounded')
  })
})
