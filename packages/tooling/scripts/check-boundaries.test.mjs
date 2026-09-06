import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { inspectWorkspace } from './check-boundaries.mjs'

function compareStrings(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'simple-inbox-boundaries-'))

  return {
    file(relativePath, source) {
      const path = join(root, relativePath)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, source)
    },
    package(relativeRoot, manifest, files = {}) {
      const packageRoot = join(root, relativeRoot)
      mkdirSync(packageRoot, { recursive: true })
      writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
      for (const [relativePath, source] of Object.entries(files)) {
        const path = join(packageRoot, relativePath)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, source)
      }
    },
    root,
    cleanup() {
      rmSync(root, { force: true, recursive: true })
    },
  }
}

void test('accepts declared workspace exports along allowed dependency edges', () => {
  const workspace = fixture()
  try {
    workspace.package(
      'packages/contracts',
      {
        name: '@cloudflare-inbox/contracts',
        type: 'module',
        exports: { '.': './src/index.ts', './auth': './src/auth.ts' },
      },
      { 'src/index.ts': 'export const ok = true\n', 'src/auth.ts': 'export const auth = true\n' },
    )
    workspace.package(
      'apps/web',
      {
        name: '@cloudflare-inbox/web',
        dependencies: { '@cloudflare-inbox/contracts': 'workspace:*' },
      },
      { 'src/index.ts': "import { auth } from '@cloudflare-inbox/contracts/auth'\nvoid auth\n" },
    )

    assert.deepEqual(inspectWorkspace(workspace.root), [])
  } finally {
    workspace.cleanup()
  }
})

void test('rejects forbidden edges, undeclared imports, and non-exported deep imports', () => {
  const workspace = fixture()
  try {
    workspace.package(
      'packages/db',
      { name: '@cloudflare-inbox/db', exports: { '.': './src/index.ts' } },
      { 'src/index.ts': 'export const db = true\n' },
    )
    workspace.package(
      'apps/web',
      { name: '@cloudflare-inbox/web' },
      { 'src/index.ts': "import '@cloudflare-inbox/db/src/repository'\n" },
    )

    const codes = inspectWorkspace(workspace.root).map(({ code }) => code)
    assert.deepEqual(codes.sort(compareStrings), [
      'undeclared-workspace-import',
      'workspace-deep-import',
    ])
  } finally {
    workspace.cleanup()
  }
})

void test('requires workspace protocol for internal dependencies', () => {
  const workspace = fixture()
  try {
    workspace.package('packages/contracts', {
      name: '@cloudflare-inbox/contracts',
      exports: './src/index.ts',
    })
    workspace.package('packages/api', {
      name: '@cloudflare-inbox/api',
      dependencies: { '@cloudflare-inbox/contracts': '0.0.0' },
    })

    assert.deepEqual(
      inspectWorkspace(workspace.root).map(({ code }) => code),
      ['workspace-version'],
    )
  } finally {
    workspace.cleanup()
  }
})

void test('checks nested test workspaces with their own dependency declarations', () => {
  const workspace = fixture()
  try {
    workspace.package('apps/web', { name: '@cloudflare-inbox/web' })
    workspace.package(
      'packages/test-harness',
      {
        name: '@cloudflare-inbox/test-harness',
        exports: './src/index.ts',
      },
      { 'src/index.ts': 'export const harness = true\n' },
    )
    workspace.package(
      'apps/web/tests/e2e',
      {
        name: '@cloudflare-inbox/e2e-tests',
        devDependencies: { '@cloudflare-inbox/test-harness': 'workspace:*' },
      },
      { 'flow.e2e.ts': "import { harness } from '@cloudflare-inbox/test-harness'\nvoid harness\n" },
    )
    assert.deepEqual(inspectWorkspace(workspace.root), [])
    workspace.package('apps/web/tests/e2e', { name: '@cloudflare-inbox/e2e-tests' })
    assert.deepEqual(
      inspectWorkspace(workspace.root).map(({ code }) => code),
      ['undeclared-workspace-import'],
    )
  } finally {
    workspace.cleanup()
  }
})

void test('detects Worker, route, repository, and UI boundary leaks', () => {
  const workspace = fixture()
  try {
    workspace.package(
      'packages/api',
      { name: '@cloudflare-inbox/api' },
      {
        'src/routes/inbox.ts':
          "const value = process.env.SECRET\nconst row = env.DB.prepare('SELECT 1')\nenv.MAIL.fetch('https://mail')\nconsole.log(value, row)\n",
        'src/repositories/thread.ts': 'export function bad(): Response { return new Response() }\n',
      },
    )
    workspace.package(
      'apps/web',
      { name: '@cloudflare-inbox/web' },
      { 'src/components/button.tsx': 'export const bad = <button asChild />\n' },
    )

    const codes = new Set(inspectWorkspace(workspace.root).map(({ code }) => code))
    assert.deepEqual(
      [...codes].sort(compareStrings),
      [
        'console-log',
        'direct-mail-fetch',
        'http-in-repository',
        'radix-as-child',
        'raw-sql-outside-db',
        'sql-in-route',
        'worker-process-env',
      ].sort(compareStrings),
    )
  } finally {
    workspace.cleanup()
  }
})

void test('keeps runtime and binding types out of pure packages', () => {
  const workspace = fixture()
  try {
    workspace.package(
      'packages/mail-core',
      { name: '@cloudflare-inbox/mail-core' },
      {
        'src/index.ts':
          "import React from 'react'\nimport type { CloudflareBindings } from './bindings'\nexport type Bad = Context\nvoid React\n",
      },
    )

    const codes = new Set(inspectWorkspace(workspace.root).map(({ code }) => code))
    assert.deepEqual([...codes].sort(compareStrings), [
      'binding-leak',
      'hono-context-leak',
      'runtime-leak',
    ])
  } finally {
    workspace.cleanup()
  }
})

void test('rejects nested lockfiles and Git repositories', () => {
  const workspace = fixture()
  try {
    workspace.package(
      'apps/web',
      { name: '@cloudflare-inbox/web' },
      { '.git/config': '[core]\n', 'package-lock.json': '{}\n' },
    )

    assert.deepEqual(
      inspectWorkspace(workspace.root)
        .map(({ code }) => code)
        .sort(compareStrings),
      ['nested-git-directory', 'nested-lockfile'],
    )
  } finally {
    workspace.cleanup()
  }
})

void test('requires generated drift checks to run before generators mutate the CI checkout', () => {
  const workspace = fixture()
  try {
    workspace.file(
      '.github/workflows/ci.yml',
      ['steps:', '  - run: vp run -r generate-openapi', '  - run: vp run check:generated', ''].join(
        '\n',
      ),
    )

    assert.deepEqual(
      inspectWorkspace(workspace.root).map(({ code }) => code),
      ['generated-drift-masked'],
    )

    workspace.file(
      '.github/workflows/ci.yml',
      ['steps:', '  - run: vp run check:generated', '  - run: vp test', ''].join('\n'),
    )
    assert.deepEqual(inspectWorkspace(workspace.root), [])
  } finally {
    workspace.cleanup()
  }
})
