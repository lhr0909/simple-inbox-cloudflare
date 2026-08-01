import { describe, expect, it } from 'vitest'

import {
  computeIdempotencyRequestDigest,
  computeInboundIngestDigest,
  createIdempotencyKey,
  decideIdempotentSend,
  sha256Hex,
  stableSerialize,
  type WebCryptoLike,
} from '../src/crypto'

describe('Web Crypto-compatible digest helpers', () => {
  it('hashes exact bytes with SHA-256', async () => {
    await expect(sha256Hex('abc')).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('creates stable request digests independent of object key order', async () => {
    await expect(
      computeIdempotencyRequestDigest({ z: [1, 2], a: 'value', omitted: undefined }),
    ).resolves.toBe(await computeIdempotencyRequestDigest({ a: 'value', z: [1, 2] }))
    expect(stableSerialize(new Uint8Array([1, 2, 3]))).toBe('{"$bytes":"AQID"}')
  })

  it('binds inbound idempotency to raw bytes and normalized envelope', async () => {
    const input = {
      rawSha256: 'a'.repeat(64),
      envelopeFrom: 'Sender@EXAMPLE.TEST',
      envelopeTo: 'Support@example.test',
    }
    await expect(computeInboundIngestDigest(input)).resolves.toBe(
      await computeInboundIngestDigest({
        ...input,
        envelopeFrom: 'sender@example.test',
      }),
    )
    await expect(
      computeInboundIngestDigest({ ...input, envelopeTo: 'other@example.test' }),
    ).resolves.not.toBe(await computeInboundIngestDigest(input))
    await expect(computeInboundIngestDigest({ ...input, envelopeFrom: '<>' })).resolves.toMatch(
      /^[a-f0-9]{64}$/u,
    )
  })

  it('generates bounded URL-safe keys from an injected Web Crypto source', () => {
    const realCrypto = globalThis.crypto as unknown as WebCryptoLike
    const deterministic: WebCryptoLike = {
      subtle: realCrypto.subtle,
      getRandomValues<T extends ArrayBufferView>(array: T): T {
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(7)
        return array
      },
    }
    expect(createIdempotencyKey(deterministic, 16)).toBe('BwcHBwcHBwcHBwcHBwcHBw')
  })

  it('rejects unsupported or cyclic canonical digest inputs', () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(() => stableSerialize(cyclic)).toThrow('cyclic')
    expect(() => stableSerialize(Number.NaN)).toThrow('finite')
    expect(() => stableSerialize(() => undefined)).toThrow('Unsupported')
  })
})

describe('idempotency state decisions', () => {
  const digest = 'a'.repeat(64)

  it.each([
    [null, 'start'],
    [{ requestDigest: digest, state: 'pending' as const }, 'in_progress'],
    [{ requestDigest: digest, state: 'complete' as const }, 'replay'],
    [{ requestDigest: digest, state: 'unknown' as const }, 'unknown'],
    [{ requestDigest: 'b'.repeat(64), state: 'complete' as const }, 'conflict'],
  ])('maps persisted send state %#', (existing, action) => {
    expect(decideIdempotentSend(existing, digest)).toEqual({ action })
  })
})
