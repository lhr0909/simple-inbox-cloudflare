import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const directory = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@cloudflare-inbox/db/testing': resolve(directory, '../../packages/db/src/testing.ts'),
      '@cloudflare-inbox/test-harness': resolve(directory, '../harness/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['**/*.integration.ts'],
    testTimeout: 60_000,
  },
})
