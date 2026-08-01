#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { cp, lstat, mkdtemp, mkdir, readdir, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(moduleDirectory, '../..')

const ignoredDirectoryNames = new Set([
  '.git',
  '.pnpm-store',
  '.turbo',
  '.vite',
  '.wrangler',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
])

const generatedEntries = [
  { label: 'TanStack route tree', path: 'apps/web/src/routeTree.gen.ts' },
  { label: 'Cloudflare binding types', path: 'apps/web/worker-configuration.d.ts' },
  { label: 'API OpenAPI document', path: 'workers/api/openapi.json' },
  { label: 'Drizzle migration SQL and metadata', path: 'packages/db/migrations' },
]

const generators = [
  {
    arguments_: ['build'],
    binary: 'apps/web/node_modules/.bin/vp',
    cwd: 'apps/web',
    label: 'TanStack route tree (production web build)',
  },
  {
    arguments_: ['types', 'worker-configuration.d.ts', '--config', '../../wrangler.jsonc'],
    binary: 'node_modules/.bin/wrangler',
    cwd: 'apps/web',
    label: 'Cloudflare binding types',
  },
  {
    arguments_: ['--import', 'tsx', 'scripts/generate-openapi.ts'],
    binary: process.execPath,
    cwd: 'workers/api',
    label: 'API OpenAPI document',
  },
  {
    arguments_: ['generate', '--config', 'drizzle.config.ts'],
    binary: 'packages/db/node_modules/.bin/drizzle-kit',
    cwd: 'packages/db',
    label: 'Drizzle migration SQL and metadata',
  },
]

async function main() {
  const temporaryParent = await mkdtemp(join(tmpdir(), 'cloudflare-inbox-generated-'))
  const temporaryRoot = join(temporaryParent, 'workspace')
  try {
    process.stdout.write('Regenerating artifacts in an isolated workspace copy...\n')
    await copyWorkspace(repositoryRoot, temporaryRoot)
    await linkDependencyDirectories(repositoryRoot, temporaryRoot)
    runGenerators(temporaryRoot)

    const differences = await compareGeneratedArtifacts(repositoryRoot, temporaryRoot)
    if (differences.length > 0) {
      process.stderr.write('Generated files are missing or out of date:\n')
      for (const difference of differences) process.stderr.write(`  - ${difference}\n`)
      process.stderr.write(
        'Run the relevant route, OpenAPI, Cloudflare type, or Drizzle generator and commit every generated result.\n',
      )
      process.exitCode = 1
      return
    }
    process.stdout.write('Generated files match fresh generator output.\n')
  } finally {
    if (process.env.CLOUDFLARE_INBOX_KEEP_GENERATED_CHECK === '1') {
      process.stdout.write(`Kept isolated workspace for inspection: ${temporaryRoot}\n`)
    } else {
      await rm(temporaryParent, { force: true, recursive: true })
    }
  }
}

async function copyWorkspace(sourceRoot, targetRoot) {
  await cp(sourceRoot, targetRoot, {
    filter(source) {
      const relativePath = relative(sourceRoot, source)
      if (relativePath === '') return true
      const segments = relativePath.split(sep)
      if (segments.some((segment) => ignoredDirectoryNames.has(segment))) return false
      const basename = segments.at(-1) ?? ''
      return !(
        basename === '.env' ||
        basename.startsWith('.env.') ||
        basename === '.dev.vars' ||
        basename.startsWith('.dev.vars.')
      )
    },
    recursive: true,
  })
}

async function linkDependencyDirectories(sourceRoot, targetRoot) {
  const directories = await findDependencyDirectories(sourceRoot)
  for (const source of directories) {
    const target = join(targetRoot, relative(sourceRoot, source))
    await mkdir(dirname(target), { recursive: true })
    await symlink(source, target, 'dir')
  }
}

async function findDependencyDirectories(root) {
  const output = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(directory, entry.name)
      if (entry.name === 'node_modules') {
        output.push(path)
      } else if (!ignoredDirectoryNames.has(entry.name)) {
        await visit(path)
      }
    }
  }
  await visit(root)
  return output
}

function runGenerators(temporaryRoot) {
  const executablePaths = [
    join(temporaryRoot, 'node_modules/.bin'),
    join(temporaryRoot, 'apps/web/node_modules/.bin'),
    join(temporaryRoot, 'workers/api/node_modules/.bin'),
    join(temporaryRoot, 'packages/db/node_modules/.bin'),
    process.env.PATH ?? '',
  ].join(':')

  for (const generator of generators) {
    process.stdout.write(`  ${generator.label}\n`)
    const executable = generator.binary.startsWith('/')
      ? generator.binary
      : join(temporaryRoot, generator.binary)
    const result = spawnSync(executable, generator.arguments_, {
      cwd: join(temporaryRoot, generator.cwd),
      encoding: 'utf8',
      env: { ...process.env, CI: '1', PATH: executablePaths, WRANGLER_WRITE_LOGS: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) {
      if (result.stdout) process.stderr.write(result.stdout)
      if (result.stderr) process.stderr.write(result.stderr)
      throw new Error(
        `${generator.label} generator failed with status ${result.status ?? 'unknown'}.`,
      )
    }
  }
}

export async function compareGeneratedArtifacts(sourceRoot, generatedRoot) {
  const differences = []
  for (const entry of generatedEntries) {
    const source = await snapshotPath(join(sourceRoot, entry.path))
    const generated = await snapshotPath(join(generatedRoot, entry.path))
    if (source === undefined) {
      differences.push(`${entry.label}: ${entry.path} is missing`)
      continue
    }
    if (generated === undefined) {
      differences.push(`${entry.label}: generator did not produce ${entry.path}`)
      continue
    }
    const paths = new Set([...source.keys(), ...generated.keys()])
    for (const path of [...paths].sort((left, right) => left.localeCompare(right))) {
      const current = source.get(path)
      const fresh = generated.get(path)
      if (current === undefined)
        differences.push(`${entry.label}: missing ${displayPath(entry.path, path)}`)
      else if (fresh === undefined)
        differences.push(`${entry.label}: obsolete ${displayPath(entry.path, path)}`)
      else if (!current.equals(fresh))
        differences.push(`${entry.label}: stale ${displayPath(entry.path, path)}`)
    }
  }
  return differences
}

async function snapshotPath(path) {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  const output = new Map()
  if (stats.isFile()) {
    output.set('', await readFile(path))
    return output
  }
  if (!stats.isDirectory()) return output

  async function visit(directory, prefix) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const child = join(directory, entry.name)
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await visit(child, relativePath)
      else if (entry.isFile()) output.set(relativePath, await readFile(child))
    }
  }
  await visit(path, '')
  return output
}

function displayPath(root, child) {
  return child === '' ? root : `${root}/${child}`
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(
      `Unable to verify generated files: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 2
  })
}
