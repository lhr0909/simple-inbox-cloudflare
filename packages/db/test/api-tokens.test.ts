import { afterEach, describe, expect, it } from 'vitest'
import { ApiTokenRepository } from '../src/repositories/api-tokens'
import { AuthRepository } from '../src/repositories/auth-repository'
import { MailboxScopedRepository } from '../src/repositories/scoped-inbox'
import { TestD1Database } from './support/d1'
import { NOW, SHA_A, SHA_B, insertUser, insertMailbox, insertMember } from './support/fixtures'

const databases: TestD1Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
function setup() {
  const db = new TestD1Database()
  databases.push(db)
  insertUser(db.sqlite, 'owner', 'owner@example.test')
  insertUser(db.sqlite, 'other', 'other@example.test')
  insertMailbox(db.sqlite, 'allowed', 'allowed@example.test')
  insertMailbox(db.sqlite, 'excluded', 'excluded@example.test')
  insertMember(db.sqlite, 'allowed', 'owner')
  insertMember(db.sqlite, 'excluded', 'other')
  return {
    db,
    tokens: new ApiTokenRepository(db.asD1(), 'owner'),
    auth: new AuthRepository(db.asD1()),
  }
}
const input = {
  id: 'token',
  name: 'Agent',
  scopes: ['read'] as ['read'],
  mailboxIds: ['allowed'],
  digest: SHA_A,
  now: NOW,
  expiresAt: null,
}

describe('API token lifecycle and mailbox grants', () => {
  it('stores digests, enforces expiry/revocation, and isolates token administration by owner', async () => {
    const { db, tokens, auth } = setup()
    await tokens.create({ ...input, expiresAt: NOW + 100 })
    expect(db.sqlite.prepare('SELECT token_digest, all_mailboxes FROM api_tokens').get()).toEqual({
      token_digest: SHA_A,
      all_mailboxes: 0,
    })
    expect(await auth.findApiToken(SHA_A, 'read', NOW + 1)).toMatchObject({
      mailboxIds: ['allowed'],
      tokenId: 'token',
    })
    expect(await auth.findApiToken(SHA_A, 'send', NOW + 1)).toBeUndefined()
    expect(await auth.findApiToken(SHA_A, 'read', NOW + 100)).toBeUndefined()
    expect((await tokens.list())[0]).toMatchObject({
      name: 'Agent',
      lastUsedAt: NOW + 1,
      mailboxIds: ['allowed'],
    })
    expect(JSON.stringify(await tokens.list())).not.toContain(SHA_A)
    const other = new ApiTokenRepository(db.asD1(), 'other')
    expect(await other.list()).toEqual([])
    expect(await other.revoke('token', NOW + 2)).toBe(false)
    expect(await tokens.revoke('token', NOW + 2)).toBe(true)
    expect(await tokens.revoke('token', NOW + 3)).toBe(true)
    expect(await auth.findApiToken(SHA_A, 'read', NOW + 4)).toBeUndefined()
  })

  it('rolls back creation when any selected mailbox is not owned', async () => {
    const { tokens } = setup()
    await expect(tokens.create({ ...input, mailboxIds: ['allowed', 'excluded'] })).rejects.toThrow()
    expect(await tokens.list()).toEqual([])
  })

  it('preserves explicit all access and fails closed when the final selected grant disappears', async () => {
    const { db, tokens, auth } = setup()
    await tokens.create(input)
    await tokens.create({ ...input, id: 'all', mailboxIds: null, digest: SHA_B })
    expect(await auth.findApiToken(SHA_B, 'read', NOW)).toMatchObject({ mailboxIds: null })
    db.sqlite.prepare('DELETE FROM api_token_mailboxes WHERE token_id = ?').run('token')
    const actor = await auth.findApiToken(SHA_A, 'read', NOW)
    expect(actor).toMatchObject({ mailboxIds: [] })
    const inbox = new MailboxScopedRepository(db.asD1(), actor!)
    expect(await inbox.listMailboxes()).toEqual([])
    expect(await inbox.getMailboxSettings('allowed')).toBeUndefined()
    expect(
      await inbox.updateMailboxSettings('allowed', { forwardTo: 'agent@example.test' }, NOW),
    ).toBe(false)
    expect((await tokens.list()).find((token) => token.id === 'token')?.mailboxIds).toEqual([])
  })
})
