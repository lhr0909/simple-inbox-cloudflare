import { afterEach, describe, expect, it } from 'vitest'

import {
  InstallationConflictError,
  InstallationRepository,
  InstallationStateError,
} from '../src/repositories/installation'
import { NOW } from './support/fixtures'
import { TestD1Database } from './support/d1'

const databases: TestD1Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe('InstallationRepository', () => {
  it('completes a new installation atomically and is idempotent for exact retries', async () => {
    const { repository, testDb } = setup()
    expect(await repository.getStatus()).toEqual({ status: 'required' })

    const input = installationInput()
    const first = await repository.complete(input)
    const retry = await repository.complete({
      ...input,
      mailboxId: 'mailbox_retry_is_ignored',
      userId: 'user_retry_is_ignored',
    })

    expect(first.created).toBe(true)
    expect(retry).toEqual({ created: false, settings: first.settings })
    expect(await repository.requireSettings()).toEqual(first.settings)
    expect(testDb.sqlite.prepare('SELECT count(*) AS count FROM installations').get()).toEqual({
      count: 1,
    })
    expect(testDb.sqlite.prepare('SELECT count(*) AS count FROM users').get()).toEqual({ count: 1 })
    expect(testDb.sqlite.prepare('SELECT count(*) AS count FROM mailboxes').get()).toEqual({
      count: 1,
    })
    expect(testDb.sqlite.prepare('SELECT count(*) AS count FROM mailbox_members').get()).toEqual({
      count: 1,
    })
  })

  it('locks setup to the first completed values without creating losing identities', async () => {
    const { repository, testDb } = setup()
    await repository.complete(installationInput())

    await expect(
      repository.complete({
        ...installationInput(),
        mailDomain: 'other.example.test',
        mailboxAddress: 'inbox@other.example.test',
        mailboxId: 'mailbox_other',
        ownerEmail: 'other-owner@example.test',
        userId: 'user_other',
      }),
    ).rejects.toBeInstanceOf(InstallationConflictError)

    expect(testDb.sqlite.prepare('SELECT count(*) AS count FROM users').get()).toEqual({ count: 1 })
    expect(testDb.sqlite.prepare('SELECT count(*) AS count FROM mailboxes').get()).toEqual({
      count: 1,
    })
  })

  it('fails closed when identity state exists without the installation singleton', async () => {
    const { repository, testDb } = setup()
    testDb.sqlite
      .prepare('INSERT INTO users (id, email, created_at, disabled_at) VALUES (?, ?, ?, NULL)')
      .run('user_partial', 'owner@example.test', NOW)

    expect(await repository.getStatus()).toEqual({ status: 'inconsistent' })
    await expect(repository.complete(installationInput())).rejects.toBeInstanceOf(
      InstallationStateError,
    )
  })

  it('rejects unsafe origins and mismatched retention or mailbox domains before writing', async () => {
    const { repository, testDb } = setup()
    await expect(
      repository.complete({ ...installationInput(), appOrigin: 'http://public.example.test' }),
    ).rejects.toThrow('HTTPS')
    await expect(
      repository.complete({
        ...installationInput(),
        applicationRecordRetentionDays: 29,
      }),
    ).rejects.toThrow('retention')
    await expect(
      repository.complete({ ...installationInput(), mailboxAddress: 'inbox@other.example.test' }),
    ).rejects.toThrow('mail domain')
    expect(testDb.sqlite.prepare('SELECT count(*) AS count FROM installations').get()).toEqual({
      count: 0,
    })
  })
})

function setup(): { repository: InstallationRepository; testDb: TestD1Database } {
  const testDb = new TestD1Database()
  databases.push(testDb)
  return { repository: new InstallationRepository(testDb.asD1()), testDb }
}

function installationInput() {
  return {
    applicationRecordRetentionDays: 90,
    appOrigin: 'https://inbox.example.test',
    completedAt: NOW,
    mailDomain: 'mail.example.test',
    mailboxAddress: 'inbox@mail.example.test',
    mailboxId: 'mailbox_primary',
    ownerEmail: 'owner@example.test',
    rawEmailRetentionDays: 30,
    retentionBatchSize: 100,
    userId: 'user_owner',
  }
}
