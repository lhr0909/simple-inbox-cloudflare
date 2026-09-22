import { describe, expect, it } from 'vitest'
import { runRetention } from '../src/services/retention'
import { createFakeEnvironment } from './support/fakes'

describe('owner-controlled retention', () => {
  it('does not access D1 or delete R2, even with old retention settings', async () => {
    const runtime = createFakeEnvironment()
    runtime.objects.set('old.eml', new Uint8Array([1, 2, 3]))
    const result = await runRetention(runtime.env, {
      createRepository: () => {
        throw new Error('Must not resume historical tombstones')
      },
    })
    expect(result).toEqual({ claimed: 0, completed: 0, enqueued: 0, failed: 0, rawDeleted: 0 })
    expect(runtime.objects.has('old.eml')).toBe(true)
    expect(runtime.events).toEqual([])
  })
})
