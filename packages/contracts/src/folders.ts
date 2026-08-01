import { z } from '@hono/zod-openapi'

import { IsoDateTimeSchema, NonNegativeIntegerSchema } from './primitives'

export const WORKFLOW_STATES = ['needs_reply', 'waiting', 'resolved'] as const
export const WorkflowStateSchema = z.enum(WORKFLOW_STATES).openapi('WorkflowState')
export type WorkflowState = z.infer<typeof WorkflowStateSchema>

export const THREAD_FOLDERS = ['all', 'sent', 'needs-reply', 'archive'] as const
export const ThreadFolderSchema = z.enum(THREAD_FOLDERS).openapi('ThreadFolder')
export type ThreadFolder = z.infer<typeof ThreadFolderSchema>

export const ThreadFolderCountsSchema = z
  .object({
    all: NonNegativeIntegerSchema,
    unread: NonNegativeIntegerSchema,
    needsReply: NonNegativeIntegerSchema,
    sent: NonNegativeIntegerSchema,
    archive: NonNegativeIntegerSchema,
  })
  .strict()
  .openapi('ThreadFolderCounts')
export type ThreadFolderCounts = z.infer<typeof ThreadFolderCountsSchema>

export const WORKFLOW_EVENTS = [
  'inbound_received',
  'outbound_sent',
  'mark_needs_reply',
  'mark_waiting',
  'mark_resolved',
] as const
export const WorkflowEventSchema = z.enum(WORKFLOW_EVENTS)
export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>

export const ThreadOrganizationSchema = z
  .object({
    workflowState: WorkflowStateSchema,
    archivedAt: IsoDateTimeSchema.nullable(),
  })
  .strict()
  .openapi('ThreadOrganization')
export type ThreadOrganization = z.infer<typeof ThreadOrganizationSchema>

export function nextWorkflowState(_current: WorkflowState, event: WorkflowEvent): WorkflowState {
  switch (event) {
    case 'inbound_received':
    case 'mark_needs_reply':
      return 'needs_reply'
    case 'outbound_sent':
    case 'mark_waiting':
      return 'waiting'
    case 'mark_resolved':
      return 'resolved'
  }
}

export function withArchiveState(
  organization: ThreadOrganization,
  archivedAt: string | null,
): ThreadOrganization {
  return ThreadOrganizationSchema.parse({
    workflowState: organization.workflowState,
    archivedAt,
  })
}

export type ThreadFolderPredicate = Readonly<{
  archived: boolean
  workflowState?: WorkflowState
  requiresOutbound?: boolean
}>

export function folderPredicate(folder: ThreadFolder): ThreadFolderPredicate {
  switch (folder) {
    case 'all':
      return { archived: false }
    case 'sent':
      return { archived: false, requiresOutbound: true }
    case 'needs-reply':
      return { archived: false, workflowState: 'needs_reply' }
    case 'archive':
      return { archived: true }
  }
}
