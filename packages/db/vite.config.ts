import { defineConfig } from 'vite-plus'

export default defineConfig({
  test: {
    name: 'db',
    coverage: {
      enabled: false,
    },
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
