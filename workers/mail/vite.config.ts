import { cloudflare } from '@cloudflare/vite-plugin'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [cloudflare()],
  preview: { allowedHosts: ['mail.internal'] },
  server: { allowedHosts: ['mail.internal'] },
})
