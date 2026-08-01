import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          INTERNAL_REQUEST_SECRET: 'runtime-only-internal-secret-000000000001',
        },
      },
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  test: {
    include: ['test/worker/**/*.spec.ts'],
  },
})
