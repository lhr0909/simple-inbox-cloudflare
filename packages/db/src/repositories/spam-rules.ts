import { and, eq } from 'drizzle-orm'
import { createInboxDatabase } from '../database'
import { spamRules, users } from '../schema'

export type SpamRuleKind = 'recipient' | 'sender' | 'domain'

export class SpamRuleRepository {
  readonly #db: ReturnType<typeof createInboxDatabase>
  readonly userId: string
  constructor(binding: D1Database, userId: string) {
    this.userId = userId
    this.#db = createInboxDatabase(binding)
  }
  async list() {
    return this.#db
      .select({
        id: spamRules.id,
        kind: spamRules.kind,
        value: spamRules.value,
        createdAt: spamRules.createdAt,
      })
      .from(spamRules)
      .where(eq(spamRules.userId, this.userId))
      .orderBy(spamRules.kind, spamRules.value)
  }
  async add(input: { id: string; kind: SpamRuleKind; value: string; createdAt: number }) {
    await this.#db
      .insert(spamRules)
      .values({ ...input, userId: this.userId })
      .onConflictDoNothing()
  }
  async remove(id: string) {
    await this.#db
      .delete(spamRules)
      .where(and(eq(spamRules.id, id), eq(spamRules.userId, this.userId)))
  }
  static async forOwner(binding: D1Database, ownerEmail: string) {
    return createInboxDatabase(binding)
      .select({ id: spamRules.id, kind: spamRules.kind, value: spamRules.value })
      .from(spamRules)
      .innerJoin(users, and(eq(users.id, spamRules.userId), eq(users.email, ownerEmail)))
  }
}
