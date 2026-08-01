import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        serviceBindings: {
          MAIL() {
            return new Response(null, {
              headers: { 'x-test-service-binding': 'MAIL' },
              status: 204,
            })
          },
        },
      },
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  test: {
    include: ['test/worker/**/*.spec.ts'],
  },
})
