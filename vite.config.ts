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
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.wrangler/**',
      'workers/**/test/worker/**',
      'tests/e2e/**',
      'tests/integration/**',
    ],
    include: [
      'apps/**/*.{test,spec}.{ts,tsx}',
      'packages/**/*.{test,spec}.ts',
      'tests/operator/**/*.{test,spec}.mjs',
      'workers/**/*.{test,spec}.ts',
    ],
  },
  run: {
    cache: {
      scripts: false,
      tasks: true,
    },
  },
  staged: {
    '*.{css,js,json,jsonc,jsx,md,mdx,mjs,ts,tsx,yaml,yml}': 'vp check --fix',
    '{apps,packages,tooling,workers}/**/*.{js,jsx,mjs,ts,tsx}':
      'node tooling/scripts/check-boundaries.mjs',
  },
})
