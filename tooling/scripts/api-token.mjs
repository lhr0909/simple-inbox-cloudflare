#!/usr/bin/env node

import { createHmac, randomBytes } from 'node:crypto'

import { deterministicUuidV7 } from './bootstrap.mjs'
import {
  OperatorError,
  assertAccountAccess,
  assertEnvironment,
  assertRequiredSecrets,
  hasFlag,
  isMainModule,
  loadDeploymentPlan,
  optionalFlag,
  printOperatorError,
  requireProductionConfirmation,
  requiredFlag,
  runCommand,
} from './operator-lib.mjs'

const scopeBits = { read: 1, send: 2, settings: 4 }
const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export async function apiToken(arguments_ = process.argv.slice(2), options = {}) {
  const action = arguments_[0]
  if (!['create', 'list', 'revoke'].includes(action)) {
    throw new OperatorError('Use api-token <create|list|revoke> with explicit flags.')
  }
  const environment = requiredFlag(arguments_, '--env')
  assertEnvironment(environment)
  requireProductionConfirmation(environment, arguments_)
  const ownerEmail = normalizeEmail(requiredFlag(arguments_, '--owner-email'))
  const plan = await (options.loadDeploymentPlan ?? loadDeploymentPlan)(environment, {
    environmentVariables: options.environmentVariables,
    root: options.root,
  })
  if (ownerEmail !== plan.ownerEmail) {
    throw new OperatorError(
      '--owner-email must exactly match the reviewed replacement OWNER_EMAIL.',
    )
  }
  const runner = options.runner ?? runCommand
  await (options.assertAccountAccess ?? assertAccountAccess)({
    environmentVariables: options.environmentVariables,
    runner,
  })
  await (options.assertRequiredSecrets ?? assertRequiredSecrets)(plan, {
    environmentVariables: options.environmentVariables,
    runner,
  })

  if (action === 'create') {
    return createToken({
      arguments_,
      environmentVariables: options.environmentVariables,
      generatePlaintextToken: options.generatePlaintextToken,
      now: options.now,
      ownerEmail,
      plan,
      runner,
    })
  }
  if (action === 'revoke') {
    return revokeToken({
      arguments_,
      environmentVariables: options.environmentVariables,
      now: options.now,
      ownerEmail,
      plan,
      runner,
    })
  }
  return listTokens({
    environmentVariables: options.environmentVariables,
    ownerEmail,
    plan,
    runner,
  })
}

async function createToken({
  arguments_,
  environmentVariables = process.env,
  generatePlaintextToken = () => randomBytes(32).toString('base64url'),
  now: getNow = Date.now,
  ownerEmail,
  plan,
  runner,
}) {
  const name = requiredFlag(arguments_, '--name').trim()
  if (name.length < 1 || name.length > 100 || /[\r\n]/u.test(name)) {
    throw new OperatorError('--name must contain 1-100 characters without newlines.')
  }
  const scopes = repeatedFlags(arguments_, '--scope')
  if (scopes.length === 0) throw new OperatorError('Creation requires at least one --scope.')
  const uniqueScopes = [...new Set(scopes)]
  for (const scope of uniqueScopes) {
    if (!(scope in scopeBits)) throw new OperatorError(`Unsupported API token scope: ${scope}`)
  }
  const encodedScopes = uniqueScopes.reduce((bits, scope) => bits | scopeBits[scope], 0)
  const now = getNow()
  const expiresAtFlag = optionalFlag(arguments_, '--expires-at')
  const expiresAt = expiresAtFlag === undefined ? null : Date.parse(expiresAtFlag)
  if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= now)) {
    throw new OperatorError('--expires-at must be a future ISO-8601 timestamp.')
  }
  const pepper = environmentVariables.CLOUDFLARE_INBOX_AUTH_TOKEN_PEPPER
  if (typeof pepper !== 'string' || Buffer.byteLength(pepper, 'utf8') < 32) {
    throw new OperatorError(
      'Set CLOUDFLARE_INBOX_AUTH_TOKEN_PEPPER from secure operator storage to the exact deployed API pepper (at least 32 bytes).',
    )
  }
  const plaintext = generatePlaintextToken()
  if (typeof plaintext !== 'string' || !/^[A-Za-z0-9_-]{43,}$/u.test(plaintext)) {
    throw new OperatorError('The API token generator returned an invalid base64url secret.')
  }
  const digest = createHmac('sha256', pepper).update(plaintext).digest('hex')
  const id = deterministicUuidV7(`api-token:${digest}`)
  const sql = [
    'PRAGMA foreign_keys = ON;',
    `INSERT INTO api_tokens (id, user_id, token_digest, name, scopes, expires_at, revoked_at, last_used_at, created_at) SELECT ${sqlString(id)}, u.id, ${sqlString(digest)}, ${sqlString(name)}, ${encodedScopes}, ${expiresAt ?? 'NULL'}, NULL, NULL, ${now} FROM users u WHERE u.email = ${sqlString(ownerEmail)} AND u.disabled_at IS NULL;`,
    `SELECT id, name, scopes, created_at AS createdAt, expires_at AS expiresAt, revoked_at AS revokedAt, last_used_at AS lastUsedAt FROM api_tokens WHERE id = ${sqlString(id)} AND user_id = (SELECT id FROM users WHERE email = ${sqlString(ownerEmail)});`,
  ].join('\n')
  const rows = executeJson(plan, sql, runner, environmentVariables)
  const created = rows.find((row) => row.id === id)
  if (!created) {
    throw new OperatorError(
      'Token was not created. Bootstrap the reviewed owner before creating API tokens.',
    )
  }
  process.stdout.write(
    [
      `Created replacement ${plan.environment} API token ${id} (${uniqueScopes.join(', ')}).`,
      `API token (shown once): ${plaintext}`,
      'Store it now in the intended client secret manager. It cannot be recovered or listed later.',
      '',
    ].join('\n'),
  )
  return sanitizeRow(created)
}

function listTokens({ environmentVariables, ownerEmail, plan, runner }) {
  const rows = executeJson(
    plan,
    `SELECT t.id, t.name, t.scopes, t.created_at AS createdAt, t.expires_at AS expiresAt, t.revoked_at AS revokedAt, t.last_used_at AS lastUsedAt FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = ${sqlString(ownerEmail)} ORDER BY t.created_at DESC, t.id DESC;`,
    runner,
    environmentVariables,
  ).map(sanitizeRow)
  process.stdout.write(
    `${JSON.stringify({ environment: plan.environment, ownerEmail, tokens: rows }, null, 2)}\n`,
  )
  return rows
}

function revokeToken({
  arguments_,
  environmentVariables,
  now: getNow = Date.now,
  ownerEmail,
  plan,
  runner,
}) {
  if (!hasFlag(arguments_, '--confirm-revoke')) {
    throw new OperatorError('Revocation requires --confirm-revoke.')
  }
  const tokenId = requiredFlag(arguments_, '--token-id')
  if (!uuidV7Pattern.test(tokenId))
    throw new OperatorError('--token-id must be a lower-case UUIDv7.')
  const now = getNow()
  const rows = executeJson(
    plan,
    [
      `UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, ${now}) WHERE id = ${sqlString(tokenId)} AND user_id = (SELECT id FROM users WHERE email = ${sqlString(ownerEmail)});`,
      `SELECT id, name, scopes, created_at AS createdAt, expires_at AS expiresAt, revoked_at AS revokedAt, last_used_at AS lastUsedAt FROM api_tokens WHERE id = ${sqlString(tokenId)} AND user_id = (SELECT id FROM users WHERE email = ${sqlString(ownerEmail)});`,
    ].join('\n'),
    runner,
    environmentVariables,
  )
  const revoked = rows.find((row) => row.id === tokenId)
  if (!revoked || revoked.revokedAt === null || revoked.revokedAt === undefined) {
    throw new OperatorError('Token does not exist for the reviewed owner; no token was revoked.')
  }
  const result = sanitizeRow(revoked)
  process.stdout.write(
    `${JSON.stringify({ environment: plan.environment, revoked: result }, null, 2)}\n`,
  )
  return result
}

function executeJson(plan, sql, runner, environmentVariables) {
  const result = runner(
    'wrangler',
    [
      'd1',
      'execute',
      'DB',
      '--config',
      plan.configPaths.api,
      '--env',
      plan.environment,
      '--remote',
      '--command',
      sql,
      '--json',
    ],
    { capture: true, environmentVariables },
  )
  let body
  try {
    body = JSON.parse(result.stdout)
  } catch {
    throw new OperatorError('wrangler d1 execute did not return JSON.')
  }
  return collectRows(body)
}

function collectRows(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectRows(item, output)
  } else if (value !== null && typeof value === 'object') {
    if (Array.isArray(value.results)) output.push(...value.results)
    else for (const nested of Object.values(value)) collectRows(nested, output)
  }
  return output
}

function sanitizeRow(row) {
  const scopes = Object.entries(scopeBits)
    .filter(([, bit]) => (Number(row.scopes) & bit) === bit)
    .map(([scope]) => scope)
  return {
    createdAt: numberOrNull(row.createdAt),
    expiresAt: numberOrNull(row.expiresAt),
    id: String(row.id),
    lastUsedAt: numberOrNull(row.lastUsedAt),
    name: String(row.name),
    revokedAt: numberOrNull(row.revokedAt),
    scopes,
  }
}

function numberOrNull(value) {
  return value === null || value === undefined ? null : Number(value)
}

function repeatedFlags(arguments_, name) {
  const values = []
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] !== name) continue
    const value = arguments_[index + 1]
    if (typeof value !== 'string' || value.startsWith('--')) {
      throw new OperatorError(`${name} requires a value.`)
    }
    values.push(
      ...value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    )
  }
  return values
}

function normalizeEmail(value) {
  if (value !== value.trim().toLowerCase() || !/^\S+@\S+\.\S+$/u.test(value)) {
    throw new OperatorError('--owner-email must be a normalized lower-case email.')
  }
  return value
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

if (isMainModule(import.meta.url)) {
  apiToken().catch(printOperatorError)
}
