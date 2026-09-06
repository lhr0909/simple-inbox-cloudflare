import { defineConfig } from 'vite-plus'

const generatedFiles = [
  '**/.source/**',
  '**/.wrangler/**',
  '**/.output/**',
  '**/dist/**',
  '**/coverage/**',
  '**/routeTree.gen.ts',
  '**/worker-configuration.d.ts',
]

export default defineConfig({
  fmt: {
    ignorePatterns: generatedFiles,
    printWidth: 100,
    semi: false,
    singleQuote: true,
    sortPackageJson: true,
    trailingComma: 'all',
  },
  lint: {
    ignorePatterns: generatedFiles,
    options: {
      typeAware: true,
      typeCheck: true,
    },
    plugins: ['typescript'],
    rules: {
      'no-console': ['error', { allow: ['info', 'warn', 'error'] }],
    },
    overrides: [
      {
        files: ['apps/web/**/*.{ts,tsx}'],
        plugins: ['typescript', 'react'],
        rules: {
          'react/self-closing-comp': 'error',
        },
      },
      {
        files: ['**/*.{test,spec}.{ts,tsx}'],
        plugins: ['typescript', 'vitest'],
        rules: {
          'vitest/no-disabled-tests': 'error',
        },
      },
    ],
  },
  test: {
    projects: ['apps/web/vite.config.ts', 'packages/*/vite.config.ts'],
  },
  run: {
    cache: {
      scripts: false,
      tasks: true,
    },
  },
  staged: {
    '*.{css,js,json,jsonc,jsx,md,mdx,mjs,ts,tsx,yaml,yml}': 'vp check --fix',
    '{apps,packages}/**/*.{js,jsx,mjs,ts,tsx}':
      'node packages/tooling/scripts/check-boundaries.mjs',
  },
})
