import { defineConfig } from 'vite-plus'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import tailwindcss from '@tailwindcss/vite'
import viteReact from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'
import { fumadocsMdx } from 'fumadocs-mdx/vite'

const config = defineConfig(({ mode }) => ({
  resolve: { tsconfigPaths: true },
  ssr: {
    noExternal: ['fumadocs-core', 'fumadocs-ui'],
  },
  test: {
    name: 'web',
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
  // Unit tests need transforms, not the Worker dev server or generated documentation.
  plugins:
    mode === 'test'
      ? []
      : [
          tailwindcss(),
          fumadocsMdx(),
          cloudflare({
            configPath: '../../wrangler.jsonc',
            persistState: { path: '../../.wrangler/state' },
            viteEnvironment: { name: 'ssr' },
          }),

          tanstackStart({ server: { entry: 'server.ts' } }),
          viteReact(),
        ],
}))

export default config
