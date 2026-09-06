import { defineConfig } from 'vite-plus'

export default defineConfig({
  test: {
    name: 'contracts',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
