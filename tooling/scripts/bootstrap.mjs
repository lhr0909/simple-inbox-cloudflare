#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  OperatorError,
  assertEnvironment,
  assertMutationTargetIdentity,
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

export async function bootstrap(arguments_ = process.argv.slice(2), options = {}) {
  const environment = requiredFlag(arguments_, '--env')
  assertEnvironment(environment)
  requireProductionConfirmation(environment, arguments_)
  const dryRun = hasFlag(arguments_, '--dry-run')
  const plan = await (options.loadDeploymentPlan ?? loadDeploymentPlan)(environment, {
    environmentVariables: options.environmentVariables,
    root: options.root,
  })
  const ownerEmail = normalizeEmail(optionalFlag(arguments_, '--owner-email') ?? plan.ownerEmail)
  const mailboxAddress = normalizeEmail(
    optionalFlag(arguments_, '--mailbox-address') ?? `inbox@${plan.mailDomain}`,
  )
  const timestamp = options.now?.() ?? Date.now()
  const ids = {
    mailbox: deterministicUuidV7(`mailbox:${mailboxAddress}`),
    user: deterministicUuidV7(`user:${ownerEmail}`),
  }
  const sql = bootstrapSql({ ids, mailboxAddress, ownerEmail, timestamp })

  if (dryRun) {
    process.stdout.write(
      [
        `Bootstrap dry run for ${environment}`,
        `  database: ${plan.databaseName} (${plan.databaseId})`,
        `  owner: ${ownerEmail}`,
        `  mailbox: ${mailboxAddress}`,
        `  deterministic user ID: ${ids.user}`,
        `  deterministic mailbox ID: ${ids.mailbox}`,
        'No Cloudflare API or database call was made.',
        '',
      ].join('\n'),
    )
    return { dryRun: true, ids, mailboxAddress, ownerEmail }
  }

  const runner = options.runner ?? runCommand
  await (options.assertMutationTargetIdentity ?? assertMutationTargetIdentity)(plan, {
    assertAccountAccess: options.assertAccountAccess,
    environmentVariables: options.environmentVariables,
    runner,
  })
  await (options.assertRequiredSecrets ?? assertRequiredSecrets)(plan, {
    environmentVariables: options.environmentVariables,
    runner,
  })

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'cloudflare-inbox-bootstrap-'))
  const sqlPath = join(temporaryDirectory, 'bootstrap.sql')
  try {
    await writeFile(sqlPath, sql, { encoding: 'utf8', mode: 0o600 })
    runner(
      'wrangler',
      [
        'd1',
        'execute',
        'DB',
        '--config',
        plan.configPaths.api,
        '--env',
        environment,
        '--remote',
        '--file',
        sqlPath,
        '--yes',
      ],
      { environmentVariables: options.environmentVariables },
    )
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true })
  }

  const verify = runner(
    'wrangler',
    [
      'd1',
      'execute',
      'DB',
      '--config',
      plan.configPaths.api,
      '--env',
      environment,
      '--remote',
      '--command',
      verificationSql({ ids, mailboxAddress, ownerEmail }),
      '--json',
    ],
    { capture: true, environmentVariables: options.environmentVariables },
  )
  assertBootstrapVerification(verify.stdout)
  process.stdout.write(`Idempotent owner/mailbox bootstrap verified for ${environment}.\n`)
  return { dryRun: false, ids, mailboxAddress, ownerEmail }
}

export function bootstrapSql({ ids, mailboxAddress, ownerEmail, timestamp }) {
  return [
    'CREATE TABLE __cloudflare_inbox_bootstrap_guard (ok INTEGER NOT NULL CHECK (ok = 1));',
    `INSERT INTO __cloudflare_inbox_bootstrap_guard (ok) SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM users WHERE (email = ${sqlString(ownerEmail)} AND id <> ${sqlString(ids.user)}) OR (id = ${sqlString(ids.user)} AND email <> ${sqlString(ownerEmail)})) AND NOT EXISTS (SELECT 1 FROM mailboxes WHERE (address = ${sqlString(mailboxAddress)} AND id <> ${sqlString(ids.mailbox)}) OR (id = ${sqlString(ids.mailbox)} AND address <> ${sqlString(mailboxAddress)})) AND NOT EXISTS (SELECT 1 FROM mailbox_members mm JOIN mailboxes m ON m.id = mm.mailbox_id WHERE (m.id = ${sqlString(ids.mailbox)} OR m.address = ${sqlString(mailboxAddress)}) AND ((mm.role = 'owner' AND mm.user_id <> ${sqlString(ids.user)}) OR (mm.user_id = ${sqlString(ids.user)} AND mm.role <> 'owner'))) THEN 1 ELSE 0 END;`,
    `INSERT OR IGNORE INTO users (id, email, created_at, disabled_at) VALUES (${sqlString(ids.user)}, ${sqlString(ownerEmail)}, ${timestamp}, NULL);`,
    `INSERT OR IGNORE INTO mailboxes (id, address, sender_alias, forward_to, created_at, updated_at) VALUES (${sqlString(ids.mailbox)}, ${sqlString(mailboxAddress)}, NULL, ${sqlString(ownerEmail)}, ${timestamp}, ${timestamp});`,
    `INSERT OR IGNORE INTO mailbox_members (mailbox_id, user_id, role, created_at) VALUES (${sqlString(ids.mailbox)}, ${sqlString(ids.user)}, 'owner', ${timestamp});`,
    `INSERT INTO __cloudflare_inbox_bootstrap_guard (ok) SELECT CASE WHEN (SELECT count(*) FROM users WHERE id = ${sqlString(ids.user)} AND email = ${sqlString(ownerEmail)}) = 1 AND (SELECT count(*) FROM mailboxes WHERE id = ${sqlString(ids.mailbox)} AND address = ${sqlString(mailboxAddress)}) = 1 AND (SELECT count(*) FROM mailbox_members WHERE mailbox_id = ${sqlString(ids.mailbox)} AND user_id = ${sqlString(ids.user)} AND role = 'owner') = 1 AND (SELECT count(*) FROM mailbox_members WHERE mailbox_id = ${sqlString(ids.mailbox)} AND role = 'owner') = 1 THEN 1 ELSE 0 END;`,
    'DROP TABLE __cloudflare_inbox_bootstrap_guard;',
    '',
  ].join('\n')
}

export function assertBootstrapVerification(source) {
  let parsed
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw new OperatorError(
      `Bootstrap verification did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const rows = collectResultRows(parsed)
  const verified = rows.some(
    (row) =>
      Number(row.exactUsers) === 1 &&
      Number(row.emailUsers) === 1 &&
      Number(row.exactMailboxes) === 1 &&
      Number(row.addressMailboxes) === 1 &&
      Number(row.desiredOwners) === 1 &&
      Number(row.totalOwners) === 1,
  )
  if (!verified) {
    throw new OperatorError(
      'Bootstrap verification requires the exact deterministic user/mailbox IDs and exactly one total owner.',
    )
  }
}

function verificationSql({ ids, mailboxAddress, ownerEmail }) {
  return `SELECT (SELECT count(*) FROM users WHERE id = ${sqlString(ids.user)} AND email = ${sqlString(ownerEmail)}) AS exactUsers, (SELECT count(*) FROM users WHERE email = ${sqlString(ownerEmail)}) AS emailUsers, (SELECT count(*) FROM mailboxes WHERE id = ${sqlString(ids.mailbox)} AND address = ${sqlString(mailboxAddress)}) AS exactMailboxes, (SELECT count(*) FROM mailboxes WHERE address = ${sqlString(mailboxAddress)}) AS addressMailboxes, (SELECT count(*) FROM mailbox_members WHERE mailbox_id = ${sqlString(ids.mailbox)} AND user_id = ${sqlString(ids.user)} AND role = 'owner') AS desiredOwners, (SELECT count(*) FROM mailbox_members WHERE mailbox_id = ${sqlString(ids.mailbox)} AND role = 'owner') AS totalOwners`
}

function collectResultRows(value, output = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectResultRows(entry, output)
  } else if (value !== null && typeof value === 'object') {
    if (Array.isArray(value.results)) {
      for (const row of value.results) {
        if (row !== null && typeof row === 'object' && !Array.isArray(row)) output.push(row)
      }
    }
    for (const entry of Object.values(value)) collectResultRows(entry, output)
  }
  return output
}

export function deterministicUuidV7(value) {
  const digest = createHash('sha256').update(value).digest('hex')
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-7${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

function normalizeEmail(value) {
  const normalized = value.trim().toLowerCase()
  if (normalized !== value || !/^\S+@\S+\.\S+$/u.test(normalized)) {
    throw new OperatorError(
      'Owner and mailbox addresses must already be normalized lower-case emails.',
    )
  }
  return normalized
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

if (isMainModule(import.meta.url)) {
  bootstrap().catch(printOperatorError)
}
