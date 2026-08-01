import { describe, expect, it } from 'vitest'

import {
  clampThreadPageSize,
  decodeThreadCursor,
  encodeThreadCursor,
  InvalidCursorError,
} from '../src/cursor'

describe('thread cursors', () => {
  it('round-trips only a versioned stable sort position', () => {
    const value = { id: '01996f7a-7bcd-7abc-8def-2123456789ab', lastMessageAt: 1_785_571_200_000 }
    expect(decodeThreadCursor(encodeThreadCursor(value))).toEqual(value)
  })

  it('fails closed for malformed, oversized, and unsupported payloads', () => {
    expect(() => decodeThreadCursor('not+base64')).toThrow(InvalidCursorError)
    expect(() => decodeThreadCursor('a'.repeat(513))).toThrow(InvalidCursorError)
    const wrongVersion = btoa(JSON.stringify([2, 10, 'thread_a'])).replaceAll('=', '')
    expect(() => decodeThreadCursor(wrongVersion)).toThrow(InvalidCursorError)
  })

  it('caps repository work at fifty rows', () => {
    expect(clampThreadPageSize(undefined)).toBe(25)
    expect(clampThreadPageSize(0)).toBe(1)
    expect(clampThreadPageSize(500)).toBe(50)
  })
})
