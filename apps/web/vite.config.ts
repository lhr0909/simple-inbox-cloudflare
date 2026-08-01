import { defineConfig } from 'vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import tailwindcss from '@tailwindcss/vite'
import viteReact from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'
import { fumadocsMdx } from 'fumadocs-mdx/vite'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  ssr: {
    noExternal: ['fumadocs-core', 'fumadocs-ui'],
  },
  plugins: [
    tailwindcss(),
    fumadocsMdx(),
    cloudflare({ viteEnvironment: { name: 'ssr' } }),

    tanstackStart(),
    viteReact(),
  ],
})

export default config
