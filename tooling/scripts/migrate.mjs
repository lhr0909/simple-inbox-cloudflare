#!/usr/bin/env node

import {
  OperatorError,
  assertCleanWorkspace,
  assertEnvironment,
  assertMutationTargetIdentity,
  hasFlag,
  isMainModule,
  loadDeploymentPlan,
  printOperatorError,
  repositoryRoot,
  requireProductionConfirmation,
  requiredFlag,
  runCommand,
} from './operator-lib.mjs'

export async function migrate(arguments_ = process.argv.slice(2), options = {}) {
  const environment = requiredFlag(arguments_, '--env')
  assertEnvironment(environment)
  requireProductionConfirmation(environment, arguments_)
  const dryRun = hasFlag(arguments_, '--dry-run')
  if (!dryRun && !hasFlag(arguments_, '--confirm-migrate')) {
    throw new OperatorError('Remote D1 migration requires --confirm-migrate.')
  }
  const root = options.root ?? repositoryRoot
  const environmentVariables = options.environmentVariables ?? process.env
  const plan = await (options.loadDeploymentPlan ?? loadDeploymentPlan)(environment, {
    environmentVariables,
    root,
  })
  const runner = options.runner ?? runCommand
  const command = [
    'd1',
    'migrations',
    'apply',
    'DB',
    '--config',
    plan.configPaths.api,
    '--env',
    environment,
    '--remote',
    '--yes',
  ]
  process.stdout.write(
    `Replacement migration target: ${plan.databaseName} (${plan.databaseId}), ${environment}.\n`,
  )
  if (dryRun) {
    runner('wrangler', command, { dryRun: true, environmentVariables })
    process.stdout.write('Dry run complete. D1 was not changed.\n')
    return { dryRun: true, plan }
  }
  ;(options.assertCleanWorkspace ?? assertCleanWorkspace)({ runner })
  await (options.assertMutationTargetIdentity ?? assertMutationTargetIdentity)(plan, {
    assertAccountAccess: options.assertAccountAccess,
    environmentVariables,
    runner,
  })
  runner('wrangler', command, { environmentVariables })
  process.stdout.write(`Checked-in migrations applied to replacement ${environment} D1.\n`)
  return { dryRun: false, plan }
}

if (isMainModule(import.meta.url)) migrate().catch(printOperatorError)
