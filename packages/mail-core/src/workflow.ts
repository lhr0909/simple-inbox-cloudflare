export type WorkflowState = 'needs_reply' | 'waiting' | 'resolved'

export interface ThreadWorkflow {
  workflowState: WorkflowState
  unreadCount: number
  archivedAt: string | null
}

export type ThreadWorkflowEvent =
  | { type: 'inbound_received'; occurredAt: string; preserveArchive?: boolean }
  | { type: 'outbound_replied'; occurredAt: string; openThread?: boolean }
  | { type: 'outbound_sent'; occurredAt: string; openThread?: boolean }
  | { type: 'resolved' }
  | { type: 'mark_resolved' }
  | { type: 'archived'; occurredAt: string }
  | { type: 'unarchived' }
  | { type: 'marked_read' }

export function transitionThreadWorkflow(
  current: Readonly<ThreadWorkflow>,
  event: ThreadWorkflowEvent,
): ThreadWorkflow {
  assertUnreadCount(current.unreadCount)

  switch (event.type) {
    case 'inbound_received':
      return {
        workflowState: 'needs_reply',
        unreadCount: current.unreadCount + 1,
        archivedAt: event.preserveArchive ? current.archivedAt : null,
      }
    case 'outbound_replied':
    case 'outbound_sent':
      return {
        workflowState: 'waiting',
        unreadCount: 0,
        archivedAt: event.openThread ? null : current.archivedAt,
      }
    case 'resolved':
    case 'mark_resolved':
      return { ...current, workflowState: 'resolved' }
    case 'archived':
      return { ...current, archivedAt: requireTimestamp(event.occurredAt) }
    case 'unarchived':
      return { ...current, archivedAt: null }
    case 'marked_read':
      return { ...current, unreadCount: 0 }
  }
}

export const transitionThreadState = transitionThreadWorkflow

function assertUnreadCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Unread count must be a non-negative integer.')
  }
}

function requireTimestamp(value: string): string {
  if (!value || !Number.isFinite(new Date(value).getTime())) {
    throw new RangeError('Workflow event requires a valid timestamp.')
  }
  return value
}
