import { expect, test as base } from '@playwright/test'
import {
  injectSyntheticInbound,
  migrateAndSeedHarness,
  startInboxTestHarness,
  type InboxTestHarness,
} from '@cloudflare-inbox/test-harness'

type WorkerFixtures = {
  inboxHarness: InboxTestHarness
}

export const test = base.extend<object, WorkerFixtures>({
  inboxHarness: [
    async ({ browserName }, use) => {
      void browserName
      const harness = await startInboxTestHarness()
      try {
        await migrateAndSeedHarness(harness)
        await injectSyntheticInbound(harness)
        await use(harness)
      } finally {
        await harness.close()
      }
    },
    { scope: 'worker' },
  ],
  baseURL: async ({ inboxHarness }, use) => {
    await use(inboxHarness.origin)
  },
})

export { expect }
