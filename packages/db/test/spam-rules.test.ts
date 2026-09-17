import { afterEach, describe, expect, it } from 'vitest'
import { SpamRuleRepository } from '../src/repositories/spam-rules'
import { TestD1Database } from './support/d1'
import { insertUser, NOW } from './support/fixtures'

const databases: TestD1Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
describe('owner-scoped spam rules', () => {
  it('deduplicates rules and prevents reading or deleting another owner’s rules', async () => {
    const db = new TestD1Database()
    databases.push(db)
    insertUser(db.sqlite, 'owner', 'owner@example.test')
    insertUser(db.sqlite, 'other', 'other@example.test')
    const owner = new SpamRuleRepository(db.asD1(), 'owner')
    const other = new SpamRuleRepository(db.asD1(), 'other')
    await owner.add({ id: 'rule1', kind: 'domain', value: 'blocked.example.test', createdAt: NOW })
    await owner.add({
      id: 'rule2',
      kind: 'domain',
      value: 'blocked.example.test',
      createdAt: NOW + 1,
    })
    expect(await owner.list()).toHaveLength(1)
    expect(await other.list()).toEqual([])
    await other.remove('rule1')
    expect(await SpamRuleRepository.forOwner(db.asD1(), 'owner@example.test')).toHaveLength(1)
    await owner.remove('rule1')
    await owner.remove('rule1')
    expect(await owner.list()).toEqual([])
  })
})
