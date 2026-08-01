import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'

import { schema } from './schema'

export type InboxDatabase = DrizzleD1Database<typeof schema>

export function createInboxDatabase(binding: D1Database): InboxDatabase {
  return drizzle(binding, { schema })
}
