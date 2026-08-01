import { describe, expect, it } from 'vitest'

import {
  folderPredicate,
  nextWorkflowState,
  THREAD_FOLDERS,
  withArchiveState,
} from '../src/folders'

describe('thread organization', () => {
  it('keeps archive orthogonal to workflow state', () => {
    const archived = withArchiveState(
      { workflowState: 'waiting', archivedAt: null },
      '2026-08-01T05:00:00.000Z',
    )
    const restored = withArchiveState(archived, null)

    expect(archived.workflowState).toBe('waiting')
    expect(restored).toEqual({ workflowState: 'waiting', archivedAt: null })
  })

  it('maps domain events deterministically', () => {
    expect(nextWorkflowState('resolved', 'inbound_received')).toBe('needs_reply')
    expect(nextWorkflowState('needs_reply', 'outbound_sent')).toBe('waiting')
    expect(nextWorkflowState('waiting', 'mark_resolved')).toBe('resolved')
  })

  it('defines explicit, non-overloaded folder predicates', () => {
    expect(THREAD_FOLDERS).toEqual(['all', 'sent', 'needs-reply', 'archive'])
    expect(folderPredicate('needs-reply')).toEqual({
      archived: false,
      workflowState: 'needs_reply',
    })
    expect(folderPredicate('archive')).toEqual({ archived: true })
  })
})
