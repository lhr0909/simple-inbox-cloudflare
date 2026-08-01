import { describe, expect, it } from 'vitest'

import { LatestRequestCoordinator } from './inbox-request-coordinator'

describe('LatestRequestCoordinator', () => {
  it('aborts superseded work and only lets the last request commit', async () => {
    const coordinator = new LatestRequestCoordinator()
    const committed: string[] = []
    let resolveFirst: () => void = () => {}
    let resolveSecond: () => void = () => {}
    const firstResult = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    const secondResult = new Promise<void>((resolve) => {
      resolveSecond = resolve
    })

    const first = coordinator.begin()
    const firstCompletion = firstResult.then(() => {
      if (first.isLatest()) committed.push('first')
    })
    const second = coordinator.begin()
    const secondCompletion = secondResult.then(() => {
      if (second.isLatest()) committed.push('second')
    })

    expect(first.signal.aborted).toBe(true)
    resolveSecond()
    await secondCompletion
    resolveFirst()
    await firstCompletion

    expect(committed).toEqual(['second'])
  })

  it('invalidates pending work when URL state changes', () => {
    const coordinator = new LatestRequestCoordinator()
    const request = coordinator.begin()

    coordinator.invalidate()

    expect(request.signal.aborted).toBe(true)
    expect(request.isLatest()).toBe(false)
  })
})
