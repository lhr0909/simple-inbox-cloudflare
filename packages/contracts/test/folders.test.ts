import { describe, expect, it } from 'vitest'
import { ThreadFolderSchema } from '../src/folders'
import { PatchMessageStateSchema } from '../src/threads'
describe('message organization contracts', () => {
  it('accepts standard folders and rejects retired workflow folders', () => {
    for (const folder of ['inbox', 'starred', 'sent', 'all', 'spam', 'trash'])
      expect(ThreadFolderSchema.safeParse(folder).success).toBe(true)
    expect(ThreadFolderSchema.safeParse('needs-reply').success).toBe(false)
  })
  it('requires an action and prevents empty message selections', () => {
    expect(PatchMessageStateSchema.safeParse({}).success).toBe(false)
    expect(PatchMessageStateSchema.safeParse({ read: true, messageIds: [] }).success).toBe(false)
    expect(PatchMessageStateSchema.safeParse({ starred: true }).success).toBe(true)
  })
})
