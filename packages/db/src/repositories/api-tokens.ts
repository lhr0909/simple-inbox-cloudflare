import { decodeApiTokenScopes, encodeApiTokenScopes, type ApiTokenScope } from '../auth'

export interface ApiTokenRecord {
  id: string
  name: string
  scopes: ApiTokenScope[]
  mailboxIds: string[] | null
  createdAt: number
  expiresAt: number | null
  revokedAt: number | null
  lastUsedAt: number | null
}

/** Owner-bound token administration; plaintext credentials never enter this repository. */
export class ApiTokenRepository {
  private readonly db: D1Database
  private readonly userId: string
  constructor(db: D1Database, userId: string) {
    this.db = db
    this.userId = userId
  }

  async list(): Promise<ApiTokenRecord[]> {
    const rows = await this.db
      .prepare(`SELECT id, name, scopes, all_mailboxes AS allMailboxes,
      created_at AS createdAt, expires_at AS expiresAt, revoked_at AS revokedAt, last_used_at AS lastUsedAt
      FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC, id DESC`)
      .bind(this.userId)
      .all<
        Omit<ApiTokenRecord, 'scopes' | 'mailboxIds'> & { scopes: number; allMailboxes: number }
      >()
    const grants = await this.db
      .prepare(`SELECT token_id AS tokenId, mailbox_id AS mailboxId
      FROM api_token_mailboxes WHERE token_id IN (SELECT id FROM api_tokens WHERE user_id = ?)
      ORDER BY mailbox_id`)
      .bind(this.userId)
      .all<{ tokenId: string; mailboxId: string }>()
    return rows.results.map(({ allMailboxes, scopes, ...row }) => ({
      ...row,
      scopes: decodeApiTokenScopes(scopes),
      mailboxIds: allMailboxes
        ? null
        : grants.results
            .filter((grant) => grant.tokenId === row.id)
            .map((grant) => grant.mailboxId),
    }))
  }

  async create(input: {
    id: string
    name: string
    scopes: ApiTokenScope[]
    mailboxIds: string[] | null
    digest: string
    now: number
    expiresAt: number | null
  }): Promise<void> {
    const statements = [
      this.db
        .prepare(`INSERT INTO api_tokens
      (id, user_id, token_digest, name, scopes, all_mailboxes, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          input.id,
          this.userId,
          input.digest,
          input.name,
          encodeApiTokenScopes(input.scopes),
          input.mailboxIds === null ? 1 : 0,
          input.now,
          input.expiresAt,
        ),
    ]
    for (const mailboxId of input.mailboxIds ?? []) {
      statements.push(
        this.db
          .prepare(`INSERT INTO api_token_mailboxes (token_id, mailbox_id)
        VALUES (?, (SELECT mailbox_id FROM mailbox_members WHERE user_id = ? AND mailbox_id = ?))`)
          .bind(input.id, this.userId, mailboxId),
      )
    }
    // A missing membership violates NOT NULL, rolling back the entire token creation.
    await this.db.batch(statements)
  }

  async revoke(id: string, now: number): Promise<boolean> {
    const result = await this.db
      .prepare(`UPDATE api_tokens SET revoked_at = coalesce(revoked_at, ?)
      WHERE id = ? AND user_id = ?`)
      .bind(now, id, this.userId)
      .run()
    return result.meta.changes > 0
  }
}
