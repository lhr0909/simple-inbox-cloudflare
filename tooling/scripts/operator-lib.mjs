#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export class OperatorError extends Error {
  constructor(message) {
    super(message)
    this.name = 'OperatorError'
  }
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
export const repositoryRoot = resolve(moduleDirectory, '../..')

const legacyResourceGuardVariables = {
  databaseId: 'CLOUDFLARE_INBOX_LEGACY_D1_DATABASE_ID',
  rawBucket: 'CLOUDFLARE_INBOX_LEGACY_R2_BUCKET',
  workerApi: 'CLOUDFLARE_INBOX_LEGACY_API_WORKER',
  workerMail: 'CLOUDFLARE_INBOX_LEGACY_MAIL_WORKER',
  workerWeb: 'CLOUDFLARE_INBOX_LEGACY_WEB_WORKER',
}

export function replacementResourceNames(environment) {
  assertEnvironment(environment)
  const prefix = `cloudflare-inbox-replacement-${environment}`
  return {
    api: `${prefix}-api`,
    database: `${prefix}-db`,
    mail: `${prefix}-mail`,
    rawBucket: `${prefix}-raw`,
    web: `${prefix}-web`,
  }
}

export function assertEnvironment(environment) {
  if (environment !== 'staging' && environment !== 'production') {
    throw new OperatorError(
      'Use --env <staging|production>. Local verification uses the test harness.',
    )
  }
}

export function requiredFlag(arguments_, name) {
  const index = arguments_.indexOf(name)
  const value = index >= 0 ? arguments_[index + 1] : undefined
  if (typeof value !== 'string' || value.startsWith('--') || value.length === 0) {
    throw new OperatorError(`Missing required ${name} value.`)
  }
  return value
}

export function optionalFlag(arguments_, name) {
  const index = arguments_.indexOf(name)
  if (index < 0) return undefined
  const value = arguments_[index + 1]
  if (typeof value !== 'string' || value.startsWith('--') || value.length === 0) {
    throw new OperatorError(`Missing ${name} value.`)
  }
  return value
}

export function hasFlag(arguments_, name) {
  return arguments_.includes(name)
}

export function requireProductionConfirmation(environment, arguments_) {
  if (environment === 'production' && !hasFlag(arguments_, '--confirm-production')) {
    throw new OperatorError('Production operations require --confirm-production.')
  }
}

export async function loadDeploymentPlan(environment, options = {}) {
  assertEnvironment(environment)
  const root = options.root ?? repositoryRoot
  const expected = replacementResourceNames(environment)
  const configPaths = {
    api: resolve(root, 'workers/api/wrangler.jsonc'),
    mail: resolve(root, 'workers/mail/wrangler.jsonc'),
    web: resolve(root, 'apps/web/wrangler.jsonc'),
  }
  const [apiRoot, mailRoot, webRoot] = await Promise.all([
    readJsonc(configPaths.api),
    readJsonc(configPaths.mail),
    readJsonc(configPaths.web),
  ])
  const api = environmentSection(apiRoot, environment, configPaths.api)
  const mail = environmentSection(mailRoot, environment, configPaths.mail)
  const web = environmentSection(webRoot, environment, configPaths.web)

  assertEqual(api.name, expected.api, 'API Worker replacement name')
  assertEqual(mail.name, expected.mail, 'mail Worker replacement name')
  assertEqual(web.name, expected.web, 'web Worker replacement name')

  const apiDatabase = binding(api.d1_databases, 'DB', 'API D1')
  const mailDatabase = binding(mail.d1_databases, 'DB', 'mail D1')
  assertEqual(apiDatabase.database_name, expected.database, 'replacement D1 name')
  assertEqual(mailDatabase.database_name, expected.database, 'mail replacement D1 name')
  assertResourceId(apiDatabase.database_id, 'API D1 database ID')
  assertEqual(mailDatabase.database_id, apiDatabase.database_id, 'shared D1 database ID')

  const apiBucket = binding(api.r2_buckets, 'RAW_EMAILS', 'API R2')
  const mailBucket = binding(mail.r2_buckets, 'RAW_EMAILS', 'mail R2')
  assertEqual(apiBucket.bucket_name, expected.rawBucket, 'replacement R2 bucket name')
  assertEqual(mailBucket.bucket_name, expected.rawBucket, 'shared replacement R2 bucket name')

  const apiMail = binding(api.services, 'MAIL', 'API -> mail Service Binding')
  const webApi = binding(web.services, 'API', 'web -> API Service Binding')
  assertEqual(apiMail.service, expected.mail, 'API -> mail Service Binding target')
  assertEqual(webApi.service, expected.api, 'web -> API Service Binding target')

  const apiVars = requiredRecord(api.vars, 'API vars')
  const mailVars = requiredRecord(mail.vars, 'mail vars')
  const webVars = requiredRecord(web.vars, 'web vars')
  for (const [label, vars] of [
    ['API', apiVars],
    ['mail', mailVars],
    ['web', webVars],
  ]) {
    assertEqual(vars.ENVIRONMENT, environment, `${label} ENVIRONMENT`)
  }
  const appOrigin = normalizedHttpsOrigin(webVars.APP_ORIGIN, 'web APP_ORIGIN')
  assertEqual(
    normalizedHttpsOrigin(apiVars.APP_ORIGIN, 'API APP_ORIGIN'),
    appOrigin,
    'API APP_ORIGIN',
  )
  assertEqual(
    normalizedHttpsOrigin(mailVars.APP_ORIGIN, 'mail APP_ORIGIN'),
    appOrigin,
    'mail APP_ORIGIN',
  )
  assertEmail(apiVars.OWNER_EMAIL, 'API OWNER_EMAIL')
  assertEqual(mailVars.OWNER_EMAIL, apiVars.OWNER_EMAIL, 'mail OWNER_EMAIL')
  assertDomain(apiVars.MAIL_DOMAIN, 'API MAIL_DOMAIN')
  assertEqual(mailVars.MAIL_DOMAIN, apiVars.MAIL_DOMAIN, 'mail MAIL_DOMAIN')

  const rawEmailRetentionDays = positiveInteger(
    apiVars.RAW_EMAIL_RETENTION_DAYS,
    'API RAW_EMAIL_RETENTION_DAYS',
  )
  assertEqual(
    mailVars.RAW_EMAIL_RETENTION_DAYS,
    apiVars.RAW_EMAIL_RETENTION_DAYS,
    'mail RAW_EMAIL_RETENTION_DAYS',
  )
  const applicationRecordRetentionDays = positiveInteger(
    mailVars.APPLICATION_RECORD_RETENTION_DAYS,
    'mail APPLICATION_RECORD_RETENTION_DAYS',
  )
  const retentionBatchSize = positiveInteger(
    mailVars.RETENTION_BATCH_SIZE,
    'mail RETENTION_BATCH_SIZE',
  )
  if (rawEmailRetentionDays > applicationRecordRetentionDays) {
    throw new OperatorError(
      'RAW_EMAIL_RETENTION_DAYS must not exceed APPLICATION_RECORD_RETENTION_DAYS.',
    )
  }
  if (rawEmailRetentionDays > 3_650 || applicationRecordRetentionDays > 3_650) {
    throw new OperatorError('Retention windows must be between 1 and 3650 days.')
  }
  if (retentionBatchSize > 100) {
    throw new OperatorError('RETENTION_BATCH_SIZE must be between 1 and 100.')
  }

  const rateLimit = binding(api.ratelimits, 'AUTH_RATE_LIMIT', 'API auth rate limit')
  if (
    ['1001', '2001', '3001'].includes(String(rateLimit.namespace_id)) ||
    !/^\d+$/u.test(String(rateLimit.namespace_id))
  ) {
    throw new OperatorError('API AUTH_RATE_LIMIT must use a real, non-local namespace ID.')
  }
  binding(mail.send_email, 'EMAIL', 'mail Email Sending binding')
  const mailTriggers = requiredRecord(mail.triggers ?? mailRoot.triggers, 'mail triggers')
  if (
    !Array.isArray(mailTriggers.crons) ||
    mailTriggers.crons.length !== 1 ||
    mailTriggers.crons[0] !== '17 3 * * *'
  ) {
    throw new OperatorError('Mail retention must use the reviewed daily 17 3 * * * cron.')
  }

  for (const [label, rootConfig, target] of [
    ['API', apiRoot, api],
    ['mail', mailRoot, mail],
    ['web', webRoot, web],
  ]) {
    if (
      rootConfig.route !== undefined ||
      rootConfig.routes !== undefined ||
      target.route !== undefined ||
      target.routes !== undefined
    ) {
      throw new OperatorError(
        `${label} config contains routes. Automated deploys may not alter routes; use replacement workers.dev/temporary hostnames and perform cutover manually.`,
      )
    }
  }
  if (api.workers_dev !== false || mail.workers_dev !== false) {
    throw new OperatorError(
      'Replacement API and mail Workers must keep workers_dev disabled; only the web Worker is public.',
    )
  }
  if (web.workers_dev !== true) {
    throw new OperatorError(
      `The replacement ${environment} web Worker must enable workers_dev for pre-cutover smoke checks. Disable it only during an explicitly approved manual cutover.`,
    )
  }

  const observability = {}
  for (const [worker, rootConfig, target] of [
    ['api', apiRoot, api],
    ['mail', mailRoot, mail],
    ['web', webRoot, web],
  ]) {
    const settings = requiredRecord(
      target.observability ?? rootConfig.observability,
      `${worker} observability`,
    )
    const logs = requiredRecord(settings.logs, `${worker} observability logs`)
    const traces = requiredRecord(settings.traces, `${worker} observability traces`)
    if (settings.enabled !== true || logs.enabled !== true) {
      throw new OperatorError(`${worker} structured Worker logs must remain enabled.`)
    }
    if (logs.invocation_logs !== false) {
      throw new OperatorError(
        `${worker} invocation logs must be disabled because they record request URLs or email recipients.`,
      )
    }
    if (traces.enabled !== false) {
      throw new OperatorError(
        `${worker} automatic traces must remain disabled until their request-metadata privacy is reviewed.`,
      )
    }
    observability[worker] = structuredClone(settings)
  }

  const plan = {
    appOrigin,
    configPaths,
    databaseId: apiDatabase.database_id,
    databaseName: expected.database,
    environment,
    mailDomain: apiVars.MAIL_DOMAIN,
    mailCrons: [...mailTriggers.crons],
    names: expected,
    observability,
    ownerEmail: apiVars.OWNER_EMAIL,
    rawBucket: expected.rawBucket,
    rateLimit: structuredClone(rateLimit),
    retention: {
      applicationRecordDays: applicationRecordRetentionDays,
      batchSize: retentionBatchSize,
      rawEmailDays: rawEmailRetentionDays,
    },
    vars: {
      api: structuredClone(apiVars),
      mail: structuredClone(mailVars),
      web: structuredClone(webVars),
    },
    workersDev: {
      api: api.workers_dev === true,
      mail: mail.workers_dev === true,
      web: web.workers_dev === true,
    },
  }
  assertLegacyResourcesAreDistinct(plan, options.environmentVariables ?? process.env)
  return plan
}

export function assertLegacyResourcesAreDistinct(plan, environmentVariables = process.env) {
  const legacyValues = Object.values(legacyResourceGuardVariables)
    .map((name) => environmentVariables[name])
    .filter((value) => typeof value === 'string' && value.length > 0)
  const replacementValues = [
    plan.databaseId,
    plan.rawBucket,
    plan.names.web,
    plan.names.api,
    plan.names.mail,
  ]
  for (const value of replacementValues) {
    if (value === 'cloudflare-inbox' || legacyValues.includes(value)) {
      throw new OperatorError(`Refusing to use legacy Cloudflare Inbox resource: ${value}`)
    }
  }
}

export function requireLegacyResourceGuards(environmentVariables = process.env) {
  const missing = Object.values(legacyResourceGuardVariables).filter((name) => {
    const value = environmentVariables[name]
    return typeof value !== 'string' || value.trim().length === 0
  })
  if (missing.length > 0) {
    throw new OperatorError(
      `State-changing replacement operations require every explicit legacy resource guard: ${missing.join(', ')}. If legacy API, mail, and web used one Worker, repeat that Worker name in all three variables.`,
    )
  }

  const guards = Object.fromEntries(
    Object.entries(legacyResourceGuardVariables).map(([key, name]) => {
      const value = environmentVariables[name]
      if (value !== value.trim() || /[<>\r\n]/u.test(value)) {
        throw new OperatorError(`${name} must contain the exact recorded legacy resource value.`)
      }
      return [key, value]
    }),
  )
  assertResourceId(guards.databaseId, legacyResourceGuardVariables.databaseId)
  for (const [key, name] of Object.entries(legacyResourceGuardVariables)) {
    if (key === 'databaseId') continue
    const value = guards[key]
    if (value.length > 128 || /\s/u.test(value)) {
      throw new OperatorError(`${name} must contain one exact legacy resource name.`)
    }
  }
  return guards
}

export async function assertMutationTargetIdentity(plan, options = {}) {
  const environmentVariables = options.environmentVariables ?? process.env
  const runner = options.runner ?? runCommand
  requireLegacyResourceGuards(environmentVariables)
  assertLegacyResourcesAreDistinct(plan, environmentVariables)
  await (options.assertAccountAccess ?? assertAccountAccess)({ environmentVariables, runner })
  return assertRemoteReplacementTargets(plan, { environmentVariables, runner })
}

export async function assertRemoteReplacementTargets(plan, options = {}) {
  const environmentVariables = options.environmentVariables ?? process.env
  const runner = options.runner ?? runCommand
  const expected = replacementResourceNames(plan.environment)
  assertEqual(plan.databaseName, expected.database, 'replacement D1 name')
  assertEqual(plan.rawBucket, expected.rawBucket, 'replacement R2 bucket name')
  for (const worker of ['mail', 'api', 'web']) {
    assertEqual(plan.names?.[worker], expected[worker], `${worker} replacement Worker name`)
  }

  const databaseResult = runner('wrangler', ['d1', 'list', '--json'], {
    capture: true,
    environmentVariables,
  })
  const databases = remoteD1Records(parseJsonOutput(databaseResult.stdout, 'wrangler d1 list'))
  const idMatches = databases.filter(({ id }) => id === plan.databaseId)
  const nameMatches = databases.filter(({ name }) => name === plan.databaseName)
  if (
    idMatches.length !== 1 ||
    idMatches[0].name !== plan.databaseName ||
    nameMatches.length !== 1 ||
    nameMatches[0].id !== plan.databaseId
  ) {
    throw new OperatorError(
      `Configured replacement D1 identity ${plan.databaseName} (${plan.databaseId}) does not resolve exactly in the target account. Refusing remote mutation.`,
    )
  }

  const bucketResult = runner('wrangler', ['r2', 'bucket', 'info', plan.rawBucket, '--json'], {
    capture: true,
    environmentVariables,
  })
  const bucket = parseJsonOutput(bucketResult.stdout, 'wrangler r2 bucket info')
  if (bucket === null || typeof bucket !== 'object' || bucket.name !== plan.rawBucket) {
    throw new OperatorError(
      `Configured replacement R2 bucket ${plan.rawBucket} did not resolve exactly in the target account. Refusing remote mutation.`,
    )
  }

  const workers = {}
  for (const worker of ['mail', 'api', 'web']) {
    const name = plan.names[worker]
    const result = runner('wrangler', ['deployments', 'list', '--name', name, '--json'], {
      allowFailure: true,
      capture: true,
      environmentVariables,
    })
    if (result.status === 0) {
      const deployments = parseJsonOutput(result.stdout, `wrangler deployments list --name ${name}`)
      if (!Array.isArray(deployments)) {
        throw new OperatorError(
          `Configured replacement Worker ${name} returned an invalid identity response. Refusing remote mutation.`,
        )
      }
      workers[worker] = 'present'
      continue
    }
    if (/\b(?:10007|10090)\b/u.test(result.stderr)) {
      // A first deployment has no remote Worker object yet. Wrangler queried the
      // exact reviewed replacement name and Cloudflare confirmed that it is absent.
      workers[worker] = 'absent'
      continue
    }
    throw new OperatorError(
      `Could not resolve configured replacement Worker ${name} in the target account. Refusing remote mutation.`,
    )
  }

  return {
    database: { id: plan.databaseId, name: plan.databaseName },
    rawBucket: plan.rawBucket,
    workers,
  }
}

export async function assertAccountAccess(options = {}) {
  const environmentVariables = options.environmentVariables ?? process.env
  const accountId = environmentVariables.CLOUDFLARE_ACCOUNT_ID
  if (typeof accountId !== 'string' || !/^[0-9a-f]{32}$/u.test(accountId)) {
    throw new OperatorError(
      'Set CLOUDFLARE_ACCOUNT_ID to the explicit 32-character target account ID.',
    )
  }
  if (accountId === '00000000000000000000000000000000') {
    throw new OperatorError('CLOUDFLARE_ACCOUNT_ID must not use the committed placeholder value.')
  }
  const runner = options.runner ?? runCommand
  const result = runner('wrangler', ['whoami', '--json', '--account', accountId], {
    capture: true,
    environmentVariables,
  })
  const body = parseJsonOutput(result.stdout, 'wrangler whoami')
  if (!containsValue(body, accountId)) {
    throw new OperatorError('Wrangler is authenticated, but not for CLOUDFLARE_ACCOUNT_ID.')
  }
  return accountId
}

export async function assertRequiredSecrets(plan, options = {}) {
  const runner = options.runner ?? runCommand
  const result = runner(
    'wrangler',
    [
      'secret',
      'list',
      '--config',
      plan.configPaths.api,
      '--env',
      plan.environment,
      '--format',
      'json',
    ],
    { capture: true, environmentVariables: options.environmentVariables },
  )
  const body = parseJsonOutput(result.stdout, 'wrangler secret list')
  const names = collectNamedValues(body)
  if (!names.has('AUTH_TOKEN_PEPPER')) {
    throw new OperatorError(
      `API secret AUTH_TOKEN_PEPPER is missing in ${plan.environment}; upload it before migration or deployment.`,
    )
  }
}

export function assertCleanWorkspace(options = {}) {
  const runner = options.runner ?? runCommand
  const result = runner('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    capture: true,
  })
  if (result.stdout.trim().length > 0) {
    throw new OperatorError(
      `Operator mutations require a clean workspace. Commit or stash:\n${result.stdout.trim()}`,
    )
  }
}

export function latestDeploymentVersion(plan, worker, options = {}) {
  const runner = options.runner ?? runCommand
  const result = runner(
    'wrangler',
    [
      'deployments',
      'list',
      '--config',
      plan.configPaths[worker],
      '--env',
      plan.environment,
      '--json',
    ],
    { capture: true, environmentVariables: options.environmentVariables },
  )
  return findVersionId(parseJsonOutput(result.stdout, 'wrangler deployments list'))
}

export function runCommand(command, arguments_, options = {}) {
  const environmentVariables = {
    ...(options.environmentVariables ?? process.env),
  }
  for (const name of options.unsetEnvironmentVariables ?? []) delete environmentVariables[name]
  const environmentPrefix = (options.displayEnvironmentVariables ?? [])
    .filter((name) => environmentVariables[name] !== undefined)
    .map((name) => `${name}=${shellQuote(environmentVariables[name])}`)
    .join(' ')
  const renderedCommand = `${environmentPrefix.length > 0 ? `${environmentPrefix} ` : ''}${formatCommand(command, arguments_)}`
  if (options.dryRun === true) {
    process.stdout.write(`> ${renderedCommand}\n`)
    return { status: 0, stderr: '', stdout: '' }
  }
  if (options.capture !== true) process.stdout.write(`\n> ${renderedCommand}\n`)
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: environmentVariables,
    stdio: options.capture === true ? 'pipe' : 'inherit',
  })
  if (result.error) throw new OperatorError(result.error.message)
  const status = result.status ?? 1
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  if (status !== 0 && options.allowFailure !== true) {
    if (stderr.length > 0) process.stderr.write(stderr)
    throw new OperatorError(`${formatCommand(command, arguments_)} failed with status ${status}.`)
  }
  return { status, stderr, stdout }
}

export async function readJsonc(path) {
  const source = await readFile(path, 'utf8')
  try {
    return JSON.parse(removeTrailingCommas(stripJsonComments(source)))
  } catch (error) {
    throw new OperatorError(
      `Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export function stripJsonComments(source) {
  let output = ''
  let inString = false
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (current === '\n') {
        lineComment = false
        output += current
      }
      continue
    }
    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false
        index += 1
      } else if (current === '\n') {
        output += '\n'
      }
      continue
    }
    if (!inString && current === '/' && next === '/') {
      lineComment = true
      index += 1
      continue
    }
    if (!inString && current === '/' && next === '*') {
      blockComment = true
      index += 1
      continue
    }
    output += current
    if (inString) {
      if (escaped) escaped = false
      else if (current === '\\') escaped = true
      else if (current === '"') inString = false
    } else if (current === '"') {
      inString = true
    }
  }
  return output
}

export function removeTrailingCommas(source) {
  let output = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]
    if (inString) {
      output += current
      if (escaped) escaped = false
      else if (current === '\\') escaped = true
      else if (current === '"') inString = false
      continue
    }
    if (current === '"') {
      inString = true
      output += current
      continue
    }
    if (current === ',') {
      let cursor = index + 1
      while (/\s/u.test(source[cursor] ?? '')) cursor += 1
      if (source[cursor] === '}' || source[cursor] === ']') continue
    }
    output += current
  }
  return output
}

export function isMainModule(metaUrl) {
  return process.argv[1] !== undefined && fileURLToPath(metaUrl) === resolve(process.argv[1])
}

export function printOperatorError(error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`operator error: ${message}\n`)
  process.exitCode = 1
}

function environmentSection(root, environment, path) {
  const section = root?.env?.[environment]
  if (section === null || typeof section !== 'object' || Array.isArray(section)) {
    throw new OperatorError(
      `${path} has no explicit [env.${environment}] replacement configuration. Refusing to fall back to local or legacy resources.`,
    )
  }
  return section
}

function binding(value, name, label) {
  if (!Array.isArray(value)) throw new OperatorError(`${label} bindings are missing.`)
  const found = value.find((entry) => entry?.binding === name || entry?.name === name)
  if (!found) throw new OperatorError(`${label} binding ${name} is missing.`)
  return found
}

function requiredRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperatorError(`${label} are missing.`)
  }
  return value
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new OperatorError(
      `${label} must be ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
    )
  }
}

function assertResourceId(value, label) {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value) ||
    value === '00000000-0000-0000-0000-000000000000'
  ) {
    throw new OperatorError(`${label} must be a real, non-placeholder UUID.`)
  }
}

function remoteD1Records(input) {
  const records = new Map()
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    const id = value.uuid ?? value.id ?? value.database_id
    if (typeof id === 'string' && typeof value.name === 'string') {
      records.set(`${id}\u0000${value.name}`, { id, name: value.name })
    }
    for (const child of Object.values(value)) visit(child)
  }
  visit(input)
  return [...records.values()]
}

function assertEmail(value, label) {
  if (
    typeof value !== 'string' ||
    value !== value.trim().toLowerCase() ||
    !/^\S+@\S+\.\S+$/u.test(value)
  ) {
    throw new OperatorError(`${label} must be a normalized email address.`)
  }
  if (value.endsWith('@example.test') || value.endsWith('.example.test')) {
    throw new OperatorError(`${label} must not use the committed example.test placeholder.`)
  }
}

function assertDomain(value, label) {
  if (
    typeof value !== 'string' ||
    value !== value.trim().toLowerCase() ||
    !/^[a-z0-9.-]+\.[a-z]{2,}$/u.test(value)
  ) {
    throw new OperatorError(`${label} must be a normalized mail domain.`)
  }
  if (value === 'example.test' || value.endsWith('.example.test')) {
    throw new OperatorError(`${label} must not use the committed example.test placeholder.`)
  }
}

function positiveInteger(value, label) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) {
    throw new OperatorError(`${label} must be a positive integer string.`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new OperatorError(`${label} exceeds the supported integer range.`)
  }
  return parsed
}

function normalizedHttpsOrigin(value, label) {
  if (typeof value !== 'string') throw new OperatorError(`${label} is missing.`)
  let url
  try {
    url = new URL(value)
  } catch {
    throw new OperatorError(`${label} must be a valid URL.`)
  }
  if (url.protocol !== 'https:' || url.origin !== value || url.pathname !== '/') {
    throw new OperatorError(`${label} must be an exact HTTPS origin without a path.`)
  }
  if (url.hostname === 'example.test' || url.hostname.endsWith('.example.test')) {
    throw new OperatorError(`${label} must not use the committed example.test placeholder.`)
  }
  return url.origin
}

function containsValue(input, expected) {
  if (input === expected) return true
  if (Array.isArray(input)) return input.some((value) => containsValue(value, expected))
  if (input !== null && typeof input === 'object') {
    return Object.values(input).some((value) => containsValue(value, expected))
  }
  return false
}

function collectNamedValues(input, output = new Set()) {
  if (Array.isArray(input)) {
    for (const value of input) collectNamedValues(value, output)
  } else if (input !== null && typeof input === 'object') {
    if (typeof input.name === 'string') output.add(input.name)
    for (const value of Object.values(input)) collectNamedValues(value, output)
  }
  return output
}

function findVersionId(input) {
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = findVersionId(item)
      if (found) return found
    }
  } else if (input !== null && typeof input === 'object') {
    for (const key of ['version_id', 'versionId']) {
      if (typeof input[key] === 'string') return input[key]
    }
    if (
      typeof input.id === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(input.id) &&
      ('created_on' in input || 'createdOn' in input || 'annotations' in input)
    ) {
      return input.id
    }
    for (const value of Object.values(input)) {
      const found = findVersionId(value)
      if (found) return found
    }
  }
  return undefined
}

function parseJsonOutput(source, label) {
  try {
    return JSON.parse(source)
  } catch (error) {
    throw new OperatorError(
      `${label} did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function formatCommand(command, arguments_) {
  return [command, ...arguments_].map(shellQuote).join(' ')
}

function shellQuote(value) {
  return /^[A-Za-z0-9_./:@=-]+$/u.test(value) ? value : JSON.stringify(value)
}
