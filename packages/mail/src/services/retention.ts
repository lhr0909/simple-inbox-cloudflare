import {
  MAX_RETENTION_BATCH_SIZE,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  RetentionRepository,
  type RetentionClaim,
} from '@cloudflare-inbox/db'

import { logEvent } from '../logging'
import type { MailBindings } from '../types'

const CLAIM_LEASE_MS = 5 * 60 * 1_000

export type RetentionRepositoryPort = Pick<
  RetentionRepository,
  | 'claimEligible'
  | 'completeApplicationDeletion'
  | 'enqueueEligible'
  | 'markRawDeleted'
  | 'recordFailure'
>

export interface RetentionDependencies {
  createRepository(binding: D1Database): RetentionRepositoryPort
  generateClaimToken(): string
  generateRequestId(): string
  now(): number
}

export interface RetentionPolicy {
  applicationRetentionDays: number
  batchSize: number
  rawRetentionDays: number
}

export interface RetentionRunSummary {
  claimed: number
  completed: number
  enqueued: number
  failed: number
  rawDeleted: number
}

const defaultDependencies: RetentionDependencies = {
  createRepository: (binding) => new RetentionRepository(binding),
  generateClaimToken: () => crypto.randomUUID(),
  generateRequestId: () => crypto.randomUUID(),
  now: Date.now,
}

/**
 * Scheduled retention is intentionally not a send retry mechanism. It only
 * advances durable deletion tombstones and never calls Email Sending.
 */
export async function runRetention(
  env: MailBindings,
  overrides: Partial<RetentionDependencies> = {},
): Promise<RetentionRunSummary> {
  const dependencies = { ...defaultDependencies, ...overrides }
  const policy = parseRetentionPolicy(env)
  const repository = dependencies.createRepository(env.DB)
  const now = dependencies.now()
  const requestId = dependencies.generateRequestId()
  const claimToken = dependencies.generateClaimToken()

  const enqueued = await repository.enqueueEligible({
    applicationRetentionDays: policy.applicationRetentionDays,
    limit: policy.batchSize,
    now,
    rawRetentionDays: policy.rawRetentionDays,
  })
  const claims = await repository.claimEligible({
    claimToken,
    leaseMs: CLAIM_LEASE_MS,
    limit: policy.batchSize,
    now,
  })
  const summary: RetentionRunSummary = {
    claimed: claims.length,
    completed: 0,
    enqueued,
    failed: 0,
    rawDeleted: 0,
  }

  logEvent(
    'info',
    'mail.retention.started',
    { environment: env.ENVIRONMENT, outcome: 'started', requestId },
    {
      applicationRetentionDays: policy.applicationRetentionDays,
      batchSize: policy.batchSize,
      claimed: claims.length,
      enqueued,
      rawRetentionDays: policy.rawRetentionDays,
    },
  )

  // Sequential processing makes the batch bound an actual external-operation
  // bound as well as a D1 claim bound and avoids bursty R2 deletes.
  for (const claim of claims) {
    await processClaim(claim, env, repository, dependencies, requestId, now, summary)
  }

  logEvent(
    summary.failed === 0 ? 'info' : 'warn',
    'mail.retention.finished',
    {
      environment: env.ENVIRONMENT,
      outcome: summary.failed === 0 ? 'completed' : 'partial_failure',
      requestId,
    },
    { ...summary },
  )
  return summary
}

export function parseRetentionPolicy(
  input: Pick<
    MailBindings,
    'APPLICATION_RECORD_RETENTION_DAYS' | 'RAW_EMAIL_RETENTION_DAYS' | 'RETENTION_BATCH_SIZE'
  >,
): RetentionPolicy {
  const rawRetentionDays = parseBoundedInteger(
    input.RAW_EMAIL_RETENTION_DAYS,
    'RAW_EMAIL_RETENTION_DAYS',
    MIN_RETENTION_DAYS,
    MAX_RETENTION_DAYS,
  )
  const applicationRetentionDays = parseBoundedInteger(
    input.APPLICATION_RECORD_RETENTION_DAYS,
    'APPLICATION_RECORD_RETENTION_DAYS',
    MIN_RETENTION_DAYS,
    MAX_RETENTION_DAYS,
  )
  const batchSize = parseBoundedInteger(
    input.RETENTION_BATCH_SIZE,
    'RETENTION_BATCH_SIZE',
    1,
    MAX_RETENTION_BATCH_SIZE,
  )
  if (applicationRetentionDays < rawRetentionDays) {
    throw new RangeError(
      'APPLICATION_RECORD_RETENTION_DAYS must be greater than or equal to RAW_EMAIL_RETENTION_DAYS.',
    )
  }
  return { applicationRetentionDays, batchSize, rawRetentionDays }
}

async function processClaim(
  initialClaim: RetentionClaim,
  env: MailBindings,
  repository: RetentionRepositoryPort,
  dependencies: RetentionDependencies,
  requestId: string,
  runNow: number,
  summary: RetentionRunSummary,
): Promise<void> {
  let claim = initialClaim
  if (claim.state === 'raw_pending') {
    try {
      // R2 delete is idempotent: Cloudflare treats an absent object as success.
      await env.RAW_EMAILS.delete(claim.rawR2Key)
    } catch {
      summary.failed += 1
      await safelyRecordFailure(repository, claim, dependencies.now(), 'r2_delete_failed')
      logRetentionOutcome(env, requestId, claim, 'r2_delete_failed', 'failed')
      return
    }

    const applicationDue = claim.applicationDeleteAfter <= runNow
    try {
      const transitioned = await repository.markRawDeleted({
        id: claim.id,
        keepClaim: applicationDue,
        now: dependencies.now(),
        token: claim.claimToken,
      })
      if (!transitioned) {
        logRetentionOutcome(env, requestId, claim, undefined, 'claim_lost')
        return
      }
      summary.rawDeleted += 1
    } catch {
      summary.failed += 1
      await safelyRecordFailure(repository, claim, dependencies.now(), 'raw_state_persist_failed')
      logRetentionOutcome(env, requestId, claim, 'raw_state_persist_failed', 'failed')
      return
    }

    if (!applicationDue) {
      logRetentionOutcome(env, requestId, claim, undefined, 'raw_deleted')
      return
    }
    claim = { ...claim, rawDeletedAt: dependencies.now(), state: 'application_pending' }
  }

  try {
    const completed = await repository.completeApplicationDeletion({
      id: claim.id,
      mailboxId: claim.mailboxId,
      messageId: claim.messageId,
      now: dependencies.now(),
      threadId: claim.threadId,
      token: claim.claimToken,
    })
    if (!completed) {
      logRetentionOutcome(env, requestId, claim, undefined, 'claim_lost')
      return
    }
    summary.completed += 1
    logRetentionOutcome(env, requestId, claim, undefined, 'completed')
  } catch {
    summary.failed += 1
    await safelyRecordFailure(repository, claim, dependencies.now(), 'd1_cleanup_failed')
    logRetentionOutcome(env, requestId, claim, 'd1_cleanup_failed', 'failed')
  }
}

async function safelyRecordFailure(
  repository: RetentionRepositoryPort,
  claim: RetentionClaim,
  now: number,
  errorCode: string,
): Promise<void> {
  try {
    await repository.recordFailure({ errorCode, id: claim.id, now, token: claim.claimToken })
  } catch {
    // The lease remains durable and will expire. A later run can safely repeat
    // R2 deletion (including a missing object) or D1 cleanup.
  }
}

function logRetentionOutcome(
  env: MailBindings,
  requestId: string,
  claim: RetentionClaim,
  code: string | undefined,
  outcome: 'claim_lost' | 'completed' | 'failed' | 'raw_deleted',
): void {
  logEvent(
    outcome === 'failed' ? 'warn' : 'info',
    'mail.retention.item',
    { environment: env.ENVIRONMENT, outcome, requestId },
    {
      attemptCount: claim.attemptCount,
      code,
      messageId: claim.messageId,
      tombstoneId: claim.id,
    },
  )
}

function parseBoundedInteger(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!/^[0-9]+$/u.test(value)) {
    throw new TypeError(`${name} must be a decimal integer.`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}.`)
  }
  return parsed
}
