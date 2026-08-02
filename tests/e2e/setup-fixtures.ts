import { expect, test as base } from '@playwright/test'
import { startInboxTestHarness, type InboxTestHarness } from '@cloudflare-inbox/test-harness'

type WorkerFixtures = {
  freshInboxHarness: InboxTestHarness
}

export const test = base.extend<object, WorkerFixtures>({
  freshInboxHarness: [
    async ({ browserName }, use) => {
      void browserName
      const harness = await startInboxTestHarness()
      try {
        await harness.worker.applyD1Migrations('DB')
        await use(harness)
      } finally {
        await harness.close()
      }
    },
    { scope: 'worker' },
  ],
  baseURL: async ({ freshInboxHarness }, use) => {
    await use(freshInboxHarness.origin)
  },
})

export { expect }
