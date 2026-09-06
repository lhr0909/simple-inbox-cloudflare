import { defineConfig } from 'vite-plus'

export default defineConfig({
  test: {
    name: 'mail-core',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
