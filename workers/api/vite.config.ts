import { cloudflare } from '@cloudflare/vite-plugin'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [cloudflare()],
  preview: { allowedHosts: ['api.internal'] },
  server: { allowedHosts: ['api.internal'] },
})
