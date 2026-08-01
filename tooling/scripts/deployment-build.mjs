#!/usr/bin/env node

import { access, readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { OperatorError, repositoryRoot, runCommand } from './operator-lib.mjs'

const workers = ['mail', 'api', 'web']

export function workerDirectory(worker, root = repositoryRoot) {
  assertWorker(worker)
  return worker === 'web' ? resolve(root, 'apps/web') : resolve(root, `workers/${worker}`)
}

export function expectedFlattenedConfigPath(_plan, worker, root = repositoryRoot) {
  const directory = workerDirectory(worker, root)
  if (worker === 'web') return resolve(directory, 'dist/server/wrangler.json')
  return resolve(directory, 'dist', `simple_inbox_cf_local_${worker}`, 'wrangler.json')
}

export async function buildWorkerForEnvironment(plan, worker, options = {}) {
  assertWorker(worker)
  const runner = options.runner ?? runCommand
  const root = options.root ?? repositoryRoot
  const environmentVariables = {
    ...(options.environmentVariables ?? process.env),
    CLOUDFLARE_ENV: plan.environment,
  }
  runner('vp', ['build'], {
    cwd: workerDirectory(worker, root),
    displayEnvironmentVariables: ['CLOUDFLARE_ENV'],
    environmentVariables,
  })
  const configPath = await findFlattenedWorkerConfig(plan, worker, { root })
  await assertFlattenedWorkerBuild(configPath, plan, worker)
  await assertDeploymentRedirect(configPath, worker, { root })
  return configPath
}

export async function findFlattenedWorkerConfig(plan, worker, options = {}) {
  assertWorker(worker)
  const root = options.root ?? repositoryRoot
  const dist = resolve(workerDirectory(worker, root), 'dist')
  const configs = await findNamedFiles(dist, 'wrangler.json')
  if (configs.length !== 1) {
    throw new OperatorError(
      `${worker} environment build must emit exactly one dist/**/wrangler.json; found ${configs.length}.`,
    )
  }
  const parsed = await readJson(configs[0])
  if (parsed.name !== plan.names[worker]) {
    throw new OperatorError(
      `${worker} environment build emitted ${JSON.stringify(parsed.name)} instead of ${JSON.stringify(plan.names[worker])}. Ensure CLOUDFLARE_ENV=${plan.environment} was set for the direct Vite build.`,
    )
  }
  return configs[0]
}

export async function assertFlattenedWorkerBuild(configPath, plan, worker) {
  assertWorker(worker)
  const config = await readJson(configPath)
  assertEqual(config.name, plan.names[worker], `${worker} generated Worker name`)
  if ('env' in config) {
    throw new OperatorError(
      `${worker} generated deployment config must be flattened (no env block).`,
    )
  }
  if (config.route !== undefined || config.routes !== undefined) {
    throw new OperatorError(`${worker} generated deployment config must not contain routes.`)
  }
  if (typeof config.main !== 'string' || config.main.length === 0) {
    throw new OperatorError(`${worker} generated deployment config has no main module.`)
  }
  try {
    await access(resolve(dirname(configPath), config.main))
  } catch {
    throw new OperatorError(`${worker} generated main module does not exist beside its config.`)
  }

  assertExactRecord(config.vars, plan.vars[worker], `${worker} generated vars`)
  assertExactRecord(
    config.observability,
    plan.observability[worker],
    `${worker} generated observability`,
  )
  assertEqual(config.workers_dev === true, plan.workersDev[worker], `${worker} workers_dev`)

  if (worker === 'api') {
    assertExactBindings(
      config.services,
      [{ binding: 'MAIL', service: plan.names.mail }],
      ['binding', 'service'],
      'API Service Bindings',
    )
    assertExactBindings(
      config.d1_databases,
      [{ binding: 'DB', database_id: plan.databaseId, database_name: plan.databaseName }],
      ['binding', 'database_id', 'database_name'],
      'API D1 bindings',
    )
    assertExactBindings(
      config.r2_buckets,
      [{ binding: 'RAW_EMAILS', bucket_name: plan.rawBucket }],
      ['binding', 'bucket_name'],
      'API R2 bindings',
    )
    assertExactBindings(
      config.ratelimits,
      [plan.rateLimit],
      ['name', 'namespace_id', 'simple'],
      'API rate-limit bindings',
    )
    assertExactBindings(config.send_email, [], ['name'], 'API Email Sending bindings')
  } else if (worker === 'mail') {
    assertExactBindings(config.services, [], ['binding', 'service'], 'mail Service Bindings')
    assertExactBindings(
      config.d1_databases,
      [{ binding: 'DB', database_id: plan.databaseId, database_name: plan.databaseName }],
      ['binding', 'database_id', 'database_name'],
      'mail D1 bindings',
    )
    assertExactBindings(
      config.r2_buckets,
      [{ binding: 'RAW_EMAILS', bucket_name: plan.rawBucket }],
      ['binding', 'bucket_name'],
      'mail R2 bindings',
    )
    assertExactBindings(config.send_email, [{ name: 'EMAIL' }], ['name'], 'mail Email Sending')
    assertExactRecord(config.triggers, { crons: plan.mailCrons }, 'mail generated triggers')
    assertExactBindings(config.ratelimits, [], ['name'], 'mail rate-limit bindings')
  } else {
    assertExactBindings(
      config.services,
      [{ binding: 'API', service: plan.names.api }],
      ['binding', 'service'],
      'web Service Bindings',
    )
    assertExactBindings(config.d1_databases, [], ['binding'], 'web D1 bindings')
    assertExactBindings(config.r2_buckets, [], ['binding'], 'web R2 bindings')
    assertExactBindings(config.send_email, [], ['name'], 'web Email Sending bindings')
    assertExactBindings(config.ratelimits, [], ['name'], 'web rate-limit bindings')
  }
  return config
}

export async function assertDeploymentRedirect(configPath, worker, options = {}) {
  const root = options.root ?? repositoryRoot
  const redirectPath = resolve(workerDirectory(worker, root), '.wrangler/deploy/config.json')
  const redirect = await readJson(redirectPath)
  if (typeof redirect.configPath !== 'string') {
    throw new OperatorError(`${worker} Vite build did not emit a deployment redirect config.`)
  }
  const redirectedConfigPath = resolve(dirname(redirectPath), redirect.configPath)
  if (redirectedConfigPath !== resolve(configPath)) {
    throw new OperatorError(
      `${worker} deployment redirect targets ${redirectedConfigPath} instead of the validated ${resolve(configPath)}.`,
    )
  }
  if (!Array.isArray(redirect.auxiliaryWorkers) || redirect.auxiliaryWorkers.length !== 0) {
    throw new OperatorError(`${worker} deployment redirect contains unreviewed auxiliary Workers.`)
  }
  return redirectPath
}

async function findNamedFiles(directory, name) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const paths = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...(await findNamedFiles(path, name)))
    else if (entry.isFile() && entry.name === name) paths.push(path)
  }
  return paths.sort((left, right) => left.localeCompare(right))
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new OperatorError(
      `Could not read generated deployment config ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function assertExactBindings(actual, expected, keys, label) {
  if (!Array.isArray(actual)) throw new OperatorError(`${label} are missing.`)
  const normalizedActual = actual.map((entry) => selectKeys(entry, keys))
  const normalizedExpected = expected.map((entry) => selectKeys(entry, keys))
  if (stableJson(normalizedActual) !== stableJson(normalizedExpected)) {
    throw new OperatorError(
      `${label} do not match the reviewed deployment plan: expected ${stableJson(normalizedExpected)}, received ${stableJson(normalizedActual)}.`,
    )
  }
}

function assertExactRecord(actual, expected, label) {
  if (stableJson(actual) !== stableJson(expected)) {
    throw new OperatorError(
      `${label} do not match the reviewed deployment plan: expected ${stableJson(expected)}, received ${stableJson(actual)}.`,
    )
  }
}

function selectKeys(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value?.[key]]))
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new OperatorError(
      `${label} must be ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    )
  }
}

function assertWorker(worker) {
  if (!workers.includes(worker))
    throw new OperatorError(`Unknown Worker ${JSON.stringify(worker)}.`)
}
