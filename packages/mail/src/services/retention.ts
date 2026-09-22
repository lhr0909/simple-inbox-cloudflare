import { RetentionRepository } from '@cloudflare-inbox/db'

import type { MailBindings } from '../types'

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

export interface RetentionRunSummary {
  claimed: number
  completed: number
  enqueued: number
  failed: number
  rawDeleted: number
}

/**
 * Compatibility entry point for previously configured cron triggers. It never
 * resumes old deletion work, deletes mail, or calls Email Sending.
 */
export async function runRetention(
  env: MailBindings,
  overrides: Partial<RetentionDependencies> = {},
): Promise<RetentionRunSummary> {
  // Historical retention settings and queued tombstones must never cause deletion.
  // Retained mail (including Spam/Trash) is owner-controlled, without an age deadline.
  void env
  void overrides
  return { claimed: 0, completed: 0, enqueued: 0, failed: 0, rawDeleted: 0 }
}
