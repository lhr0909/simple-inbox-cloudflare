import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RetentionClaim } from '@cloudflare-inbox/db'

import worker, { scheduledRetention } from '../src/index'
import {
  parseRetentionPolicy,
  runRetention,
  type RetentionRepositoryPort,
} from '../src/services/retention'
import { createFakeEnvironment, NOW, testUuid } from './support/fakes'

const RAW_KEY = 'raw/inbound/2025/08/01/' + 'a'.repeat(64) + '.eml'

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('scheduled retention service', () => {
  it('records an R2 failure without advancing D1 state', async () => {
    const runtime = createFakeEnvironment({ failR2Delete: true })
    runtime.objects.set(RAW_KEY, new Uint8Array([1, 2, 3]))
    const repository = new FakeRetentionRepository(rawClaim())

    const summary = await runRetention(runtime.env, dependencies(repository))

    expect(summary).toEqual({ claimed: 1, completed: 0, enqueued: 0, failed: 1, rawDeleted: 0 })
    expect(runtime.events).toEqual(['r2:delete'])
    expect(repository.markRawCalls).toBe(0)
    expect(repository.failures).toEqual(['r2_delete_failed'])
    expect(repository.state).toBe('raw_pending')
    expect(runtime.objects.has(RAW_KEY)).toBe(true)
  })

  it('resumes application cleanup after R2 succeeded and D1 cleanup failed', async () => {
    const runtime = createFakeEnvironment()
    runtime.objects.set(RAW_KEY, new Uint8Array([1, 2, 3]))
    const repository = new FakeRetentionRepository(rawClaim())
    repository.failComplete = true

    const first = await runRetention(runtime.env, dependencies(repository, 'run-one-request'))
    expect(first).toMatchObject({ completed: 0, failed: 1, rawDeleted: 1 })
    expect(repository.state).toBe('application_pending')
    expect(repository.failures).toEqual(['d1_cleanup_failed'])
    expect(runtime.objects.has(RAW_KEY)).toBe(false)

    repository.failComplete = false
    const second = await runRetention(runtime.env, dependencies(repository, 'run-two-request'))
    expect(second).toMatchObject({ completed: 1, failed: 0, rawDeleted: 0 })
    expect(repository.state).toBe('completed')
    expect(runtime.events).toEqual(['r2:delete'])
  })

  it('treats a missing R2 object as success and emits safe completed observability', async () => {
    const runtime = createFakeEnvironment()
    const repository = new FakeRetentionRepository(rawClaim())
    const info = vi.mocked(console.info)

    const summary = await runRetention(runtime.env, dependencies(repository, 'retention-request'))

    expect(summary).toEqual({ claimed: 1, completed: 1, enqueued: 0, failed: 0, rawDeleted: 1 })
    expect(repository.state).toBe('completed')
    expect(runtime.events).toEqual(['r2:delete'])
    const events = info.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    )
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          environment: 'test',
          event: 'mail.retention.item',
          outcome: 'completed',
          requestId: 'retention-request',
          service: 'mail',
          timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        }),
      ]),
    )
    expect(events.some((event) => 'rawR2Key' in event)).toBe(false)
  })

  it('rejects unsafe configuration before claiming or deleting', () => {
    expect(() =>
      parseRetentionPolicy({
        APPLICATION_RECORD_RETENTION_DAYS: '30',
        RAW_EMAIL_RETENTION_DAYS: '31',
        RETENTION_BATCH_SIZE: '100',
      }),
    ).toThrow('greater than or equal')
    expect(() =>
      parseRetentionPolicy({
        APPLICATION_RECORD_RETENTION_DAYS: '365',
        RAW_EMAIL_RETENTION_DAYS: '365',
        RETENTION_BATCH_SIZE: '101',
      }),
    ).toThrow('between 1 and 100')
    expect(() =>
      parseRetentionPolicy({
        APPLICATION_RECORD_RETENTION_DAYS: '365',
        RAW_EMAIL_RETENTION_DAYS: '365 days',
        RETENTION_BATCH_SIZE: '100',
      }),
    ).toThrow('decimal integer')
  })

  it('wires the scheduled handler on the deployed Worker export', () => {
    expect(worker.scheduled).toBe(scheduledRetention)
  })
})

class FakeRetentionRepository implements RetentionRepositoryPort {
  readonly failures: string[] = []
  attemptCount = 0
  failComplete = false
  failMarkRaw = false
  markRawCalls = 0
  state: 'application_pending' | 'completed' | 'raw_pending'
  readonly #base: RetentionClaim

  constructor(claim: RetentionClaim) {
    this.#base = claim
    this.state = claim.state
  }

  async enqueueEligible(): Promise<number> {
    return 0
  }

  async claimEligible(input: { claimToken: string; leaseMs: number; limit: number; now: number }) {
    if (this.state === 'completed') return []
    this.attemptCount += 1
    return [
      {
        ...this.#base,
        attemptCount: this.attemptCount,
        claimExpiresAt: input.now + input.leaseMs,
        claimToken: input.claimToken,
        claimedAt: input.now,
        state: this.state,
      },
    ] satisfies RetentionClaim[]
  }

  async markRawDeleted(): Promise<boolean> {
    this.markRawCalls += 1
    if (this.failMarkRaw) throw new Error('synthetic D1 transition failure')
    this.state = 'application_pending'
    return true
  }

  async completeApplicationDeletion(): Promise<boolean> {
    if (this.failComplete) throw new Error('synthetic D1 cleanup failure')
    this.state = 'completed'
    return true
  }

  async recordFailure(input: { errorCode: string }): Promise<boolean> {
    this.failures.push(input.errorCode)
    return true
  }
}

function dependencies(repository: FakeRetentionRepository, requestId = 'retention-request') {
  return {
    createRepository: () => repository,
    generateClaimToken: () => 'retention-worker-claim-token-0001',
    generateRequestId: () => requestId,
    now: () => NOW,
  }
}

function rawClaim(): RetentionClaim {
  return {
    applicationDeleteAfter: NOW - 1,
    applicationDeletedAt: null,
    attemptCount: 1,
    claimExpiresAt: NOW + 60_000,
    claimToken: 'retention-worker-claim-token-0001',
    claimedAt: NOW,
    completedAt: null,
    createdAt: NOW - 1_000,
    id: testUuid(801),
    lastErrorCode: null,
    lastFailedAt: null,
    mailboxId: testUuid(802),
    messageId: testUuid(803),
    messageCreatedAt: NOW - 366 * 86_400_000,
    rawDeleteAfter: NOW - 86_400_000,
    rawDeletedAt: null,
    rawR2Key: RAW_KEY,
    state: 'raw_pending',
    threadId: testUuid(804),
    updatedAt: NOW - 1_000,
  }
}
