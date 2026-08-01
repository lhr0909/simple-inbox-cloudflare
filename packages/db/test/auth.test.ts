import { afterEach, describe, expect, it } from 'vitest'

import {
  decodeApiTokenScopes,
  digestOpaqueToken,
  encodeApiTokenScopes,
  generateOpaqueToken,
  hasApiTokenScopes,
} from '../src/auth'
import { AuthRepository } from '../src/repositories/auth-repository'
import { NOW, SHA_A, SHA_B } from './support/fixtures'
import { TestD1Database } from './support/d1'

const databases: TestD1Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
})

describe('auth credential helpers', () => {
  it('generates one-time plaintext and stable peppered digests', async () => {
    const token = generateOpaqueToken()
    const pepper = 'synthetic-test-pepper-32-bytes-minimum'
    expect(token.plaintext).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    const first = await digestOpaqueToken(token.plaintext, pepper)
    const second = await digestOpaqueToken(token.plaintext, pepper)
    expect(first).toMatch(/^[0-9a-f]{64}$/u)
    expect(second).toBe(first)
    expect(await digestOpaqueToken(token.plaintext, `${pepper}-different`)).not.toBe(first)
  })

  it('encodes read/send/settings as an explicit bit set', () => {
    const bits = encodeApiTokenScopes(['read', 'settings'])
    expect(bits).toBe(5)
    expect(decodeApiTokenScopes(bits)).toEqual(['read', 'settings'])
    expect(hasApiTokenScopes(bits, 'read')).toBe(true)
    expect(hasApiTokenScopes(bits, ['read', 'send'])).toBe(false)
  })
})

describe('AuthRepository', () => {
  it('bootstraps idempotently and applies the exact per-user magic-link cooldown', async () => {
    const { repository, testDb } = setup()
    const first = await repository.bootstrapOwner({
      mailboxAddress: 'inbox@example.test',
      mailboxId: 'mailbox_first',
      now: NOW,
      ownerEmail: 'owner@example.test',
      userId: 'user_first',
    })
    const second = await repository.bootstrapOwner({
      mailboxAddress: 'inbox@example.test',
      mailboxId: 'mailbox_ignored',
      now: NOW + 1,
      ownerEmail: 'owner@example.test',
      userId: 'user_ignored',
    })
    expect(first).toEqual({ mailboxId: 'mailbox_first', userId: 'user_first' })
    expect(second).toEqual(first)
    expect(testDb.sqlite.prepare('SELECT count(*) AS count FROM users').get()).toEqual({ count: 1 })

    expect(
      await repository.tryCreateMagicLink({
        cooldownMs: 60_000,
        expiresAt: NOW + 15 * 60_000,
        id: 'link_first',
        normalizedEmail: 'owner@example.test',
        requestedAt: NOW + 10,
        tokenDigest: SHA_A,
      }),
    ).toBe(true)
    expect(
      await repository.tryCreateMagicLink({
        cooldownMs: 60_000,
        expiresAt: NOW + 15 * 60_000,
        id: 'link_cooldown',
        normalizedEmail: 'owner@example.test',
        requestedAt: NOW + 20,
        tokenDigest: SHA_B,
      }),
    ).toBe(false)
    expect(
      await repository.tryCreateMagicLink({
        cooldownMs: 60_000,
        expiresAt: NOW + 15 * 60_000,
        id: 'link_unknown',
        normalizedEmail: 'unknown@example.test',
        requestedAt: NOW + 20,
        tokenDigest: 'c'.repeat(64),
      }),
    ).toBe(false)
  })

  it('never broadens an existing mailbox to a differently configured owner', async () => {
    const { repository, testDb } = setup()
    await repository.bootstrapOwner({
      mailboxAddress: 'inbox@example.test',
      mailboxId: 'mailbox_owner',
      now: NOW,
      ownerEmail: 'owner@example.test',
      userId: 'user_owner',
    })

    await expect(
      repository.bootstrapOwner({
        mailboxAddress: 'inbox@example.test',
        mailboxId: 'mailbox_ignored',
        now: NOW + 1,
        ownerEmail: 'other-owner@example.test',
        userId: 'user_other',
      }),
    ).rejects.toThrow('ownership')

    expect(
      testDb.sqlite
        .prepare(`
          SELECT users.email
          FROM mailbox_members
          INNER JOIN users ON users.id = mailbox_members.user_id
          INNER JOIN mailboxes ON mailboxes.id = mailbox_members.mailbox_id
          WHERE mailboxes.address = 'inbox@example.test' AND mailbox_members.role = 'owner'
        `)
        .all(),
    ).toEqual([{ email: 'owner@example.test' }])
    expect(testDb.sqlite.prepare('SELECT count(*) AS count FROM users').get()).toEqual({ count: 1 })
  })

  it('consumes a magic link once and creates exactly one expiring session', async () => {
    const { repository, testDb } = setup()
    await repository.bootstrapOwner({
      mailboxAddress: 'inbox@example.test',
      mailboxId: 'mailbox_owner',
      now: NOW,
      ownerEmail: 'owner@example.test',
      userId: 'user_owner',
    })
    await repository.tryCreateMagicLink({
      cooldownMs: 0,
      expiresAt: NOW + 15 * 60_000,
      id: 'link_once',
      normalizedEmail: 'owner@example.test',
      requestedAt: NOW + 1,
      tokenDigest: SHA_A,
    })

    const results = await Promise.all([
      repository.consumeMagicLink({
        consumedAt: NOW + 2,
        sessionExpiresAt: NOW + 30 * 24 * 60 * 60_000,
        sessionId: 'session_a',
        sessionTokenDigest: SHA_B,
        tokenDigest: SHA_A,
      }),
      repository.consumeMagicLink({
        consumedAt: NOW + 2,
        sessionExpiresAt: NOW + 30 * 24 * 60 * 60_000,
        sessionId: 'session_b',
        sessionTokenDigest: 'c'.repeat(64),
        tokenDigest: SHA_A,
      }),
    ])
    expect(results.filter((result) => result !== undefined)).toHaveLength(1)
    expect(results.find((result) => result !== undefined)).toMatchObject({
      email: 'owner@example.test',
      expiresAt: NOW + 30 * 24 * 60 * 60_000,
      userId: 'user_owner',
    })
    expect(testDb.sqlite.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual({
      count: 1,
    })
    expect(
      testDb.sqlite.prepare("SELECT used_at FROM magic_links WHERE id = 'link_once'").get(),
    ).toEqual({
      used_at: NOW + 2,
    })
  })
})

function setup(): { repository: AuthRepository; testDb: TestD1Database } {
  const testDb = new TestD1Database()
  databases.push(testDb)
  return { repository: new AuthRepository(testDb.asD1()), testDb }
}
