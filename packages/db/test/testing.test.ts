import { afterEach, describe, expect, it } from 'vitest'

import { createInboxDatabase } from '../src/database'
import { apiTokens, mailboxMembers, mailboxes, magicLinks, users } from '../src/schema'
import { seedSyntheticInbox, type SyntheticInboxSeed } from '../src/testing'
import { TestD1Database } from './support/d1'
import { NOW, SHA_A, SHA_B } from './support/fixtures'

const databases: TestD1Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe('synthetic inbox seed helper', () => {
  it('creates an idempotent, relationally complete operator fixture', async () => {
    const database = new TestD1Database()
    databases.push(database)
    const input = fixture()

    await seedSyntheticInbox(database.asD1(), input)
    await seedSyntheticInbox(database.asD1(), input)

    const db = createInboxDatabase(database.asD1())
    const [userRows, mailboxRows, memberRows, linkRows, tokenRows] = await Promise.all([
      db.select().from(users),
      db.select().from(mailboxes),
      db.select().from(mailboxMembers),
      db.select().from(magicLinks),
      db.select().from(apiTokens),
    ])
    expect(userRows).toHaveLength(2)
    expect(mailboxRows).toHaveLength(2)
    expect(memberRows).toEqual([
      expect.objectContaining({ mailboxId: 'mailbox_owner', role: 'owner', userId: 'user_owner' }),
      expect.objectContaining({
        mailboxId: 'mailbox_second',
        role: 'owner',
        userId: 'user_second',
      }),
    ])
    expect(linkRows).toEqual([
      expect.objectContaining({ id: 'magic_link', tokenDigest: SHA_A, userId: 'user_owner' }),
    ])
    expect(tokenRows).toEqual([
      expect.objectContaining({ id: 'api_token', scopes: 7, tokenDigest: SHA_B }),
    ])
  })

  it('rejects malformed deterministic credential material before writing', async () => {
    const database = new TestD1Database()
    databases.push(database)
    const input = fixture()
    input.magicLinks = [{ ...input.magicLinks![0]!, tokenDigest: 'not-a-digest' }]

    await expect(seedSyntheticInbox(database.asD1(), input)).rejects.toThrow(
      'Magic-link digest must be a lower-case SHA-256 hex value.',
    )
    expect(await createInboxDatabase(database.asD1()).select().from(users)).toEqual([])
  })
})

function fixture(): SyntheticInboxSeed {
  return {
    apiTokens: [
      {
        createdAt: NOW,
        id: 'api_token',
        name: 'synthetic cross-mailbox token',
        scopes: 7,
        tokenDigest: SHA_B,
        userId: 'user_second',
      },
    ],
    magicLinks: [
      {
        expiresAt: NOW + 15 * 60_000,
        id: 'magic_link',
        requestedAt: NOW - 2 * 60_000,
        tokenDigest: SHA_A,
        userId: 'user_owner',
      },
    ],
    mailboxes: [
      {
        address: 'inbox@example.test',
        forwardTo: 'owner@example.test',
        id: 'mailbox_owner',
        ownerUserId: 'user_owner',
        senderAlias: 'Synthetic Inbox',
      },
      {
        address: 'private@example.test',
        forwardTo: 'second@example.test',
        id: 'mailbox_second',
        ownerUserId: 'user_second',
        senderAlias: null,
      },
    ],
    now: NOW,
    users: [
      { email: 'owner@example.test', id: 'user_owner' },
      { email: 'second@example.test', id: 'user_second' },
    ],
  }
}
