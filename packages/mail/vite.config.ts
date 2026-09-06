import { defineConfig } from 'vite-plus'

export default defineConfig({
  test: {
    name: 'mail',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
