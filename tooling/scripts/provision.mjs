#!/usr/bin/env node

import {
  OperatorError,
  assertAccountAccess,
  assertEnvironment,
  hasFlag,
  isMainModule,
  optionalFlag,
  printOperatorError,
  replacementResourceNames,
  requireProductionConfirmation,
  requiredFlag,
  runCommand,
} from './operator-lib.mjs'

export async function provision(arguments_ = process.argv.slice(2), options = {}) {
  const environment = requiredFlag(arguments_, '--env')
  assertEnvironment(environment)
  requireProductionConfirmation(environment, arguments_)
  const apply = hasFlag(arguments_, '--apply')
  const names = replacementResourceNames(environment)
  const location = optionalFlag(arguments_, '--location')

  process.stdout.write(
    [
      `Replacement provisioning plan (${environment})`,
      `  D1: ${names.database}`,
      `  R2: ${names.rawBucket} (private; no r2.dev/custom domain)`,
      `  Workers: ${names.mail}, ${names.api}, ${names.web}`,
      '  Legacy resource cloudflare-inbox is never inspected, changed, or reused.',
      '',
    ].join('\n'),
  )

  if (!apply) {
    process.stdout.write(
      'Plan only. Re-run with --apply --confirm-provision after checking the target account.\n',
    )
    return { applied: false, names }
  }
  if (!hasFlag(arguments_, '--confirm-provision')) {
    throw new OperatorError('Resource creation requires --confirm-provision.')
  }

  const runner = options.runner ?? runCommand
  await (options.assertAccountAccess ?? assertAccountAccess)({
    environmentVariables: options.environmentVariables,
    runner,
  })

  let databases = await listDatabases(runner, options.environmentVariables)
  let database = databases.find((entry) => entry.name === names.database)
  if (!database) {
    runner(
      'wrangler',
      ['d1', 'create', names.database, ...(location ? ['--location', location] : [])],
      { environmentVariables: options.environmentVariables },
    )
    databases = await listDatabases(runner, options.environmentVariables)
    database = databases.find((entry) => entry.name === names.database)
  }
  if (!database?.uuid) {
    throw new OperatorError(`Could not resolve the UUID for replacement D1 ${names.database}.`)
  }

  const bucketInfo = runner('wrangler', ['r2', 'bucket', 'info', names.rawBucket], {
    allowFailure: true,
    capture: true,
    environmentVariables: options.environmentVariables,
  })
  if (bucketInfo.status !== 0) {
    runner(
      'wrangler',
      ['r2', 'bucket', 'create', names.rawBucket, ...(location ? ['--location', location] : [])],
      { environmentVariables: options.environmentVariables },
    )
  }

  process.stdout.write(
    [
      '',
      'Replacement resources are present. No Wrangler config was modified.',
      `D1 database_name=${names.database}`,
      `D1 database_id=${database.uuid}`,
      `R2 bucket_name=${names.rawBucket}`,
      'Add these values only to explicit replacement environment sections, then upload secrets.',
      'DNS, custom-domain routes, and Email Routing cutover remain manual.',
      '',
    ].join('\n'),
  )
  return { applied: true, databaseId: database.uuid, names }
}

async function listDatabases(runner, environmentVariables) {
  const result = runner('wrangler', ['d1', 'list', '--json'], {
    capture: true,
    environmentVariables,
  })
  let value
  try {
    value = JSON.parse(result.stdout)
  } catch {
    throw new OperatorError('wrangler d1 list did not return JSON.')
  }
  const entries = Array.isArray(value) ? value : value?.result
  if (!Array.isArray(entries)) throw new OperatorError('Unexpected wrangler d1 list response.')
  return entries
    .map((entry) => ({
      name: typeof entry?.name === 'string' ? entry.name : undefined,
      uuid:
        typeof entry?.uuid === 'string'
          ? entry.uuid
          : typeof entry?.database_id === 'string'
            ? entry.database_id
            : undefined,
    }))
    .filter((entry) => entry.name)
}

if (isMainModule(import.meta.url)) {
  provision().catch(printOperatorError)
}
