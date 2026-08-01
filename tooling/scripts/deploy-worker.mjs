#!/usr/bin/env node

import {
  buildWorkerForEnvironment,
  expectedFlattenedConfigPath,
  workerDirectory,
} from './deployment-build.mjs'
import {
  OperatorError,
  assertCleanWorkspace,
  assertEnvironment,
  assertMutationTargetIdentity,
  assertRequiredSecrets,
  hasFlag,
  isMainModule,
  latestDeploymentVersion,
  loadDeploymentPlan,
  printOperatorError,
  repositoryRoot,
  requireProductionConfirmation,
  requiredFlag,
  runCommand,
} from './operator-lib.mjs'

const allowedWorkers = ['mail', 'api', 'web']

export async function deployWorker(arguments_ = process.argv.slice(2), options = {}) {
  const worker = arguments_[0]
  if (!allowedWorkers.includes(worker)) {
    throw new OperatorError('Use deploy-worker.mjs <mail|api|web> --env <staging|production>.')
  }
  const environment = requiredFlag(arguments_, '--env')
  assertEnvironment(environment)
  requireProductionConfirmation(environment, arguments_)
  const dryRun = hasFlag(arguments_, '--dry-run')
  if (!dryRun && !hasFlag(arguments_, '--confirm-replacement-deploy')) {
    throw new OperatorError('Deploying a replacement Worker requires --confirm-replacement-deploy.')
  }
  const root = options.root ?? repositoryRoot
  const environmentVariables = options.environmentVariables ?? process.env
  const plan = await (options.loadDeploymentPlan ?? loadDeploymentPlan)(environment, {
    environmentVariables,
    root,
  })
  const runner = options.runner ?? runCommand
  const cwd = workerDirectory(worker, root)

  process.stdout.write(
    `Replacement ${worker} deploy: ${plan.names[worker]} via ${expectedFlattenedConfigPath(plan, worker, root)}\n`,
  )
  if (dryRun) {
    runner('vp', ['build'], {
      cwd,
      displayEnvironmentVariables: ['CLOUDFLARE_ENV'],
      dryRun: true,
      environmentVariables: { ...environmentVariables, CLOUDFLARE_ENV: environment },
    })
    runner('wrangler', ['deploy'], {
      cwd,
      dryRun: true,
      environmentVariables,
      unsetEnvironmentVariables: ['CLOUDFLARE_ENV'],
    })
    process.stdout.write('Dry run complete; generated output would be validated before deploy.\n')
    return { dryRun: true, plan, worker }
  }

  ;(options.assertCleanWorkspace ?? assertCleanWorkspace)({ runner })
  const generatedConfig = await (options.buildWorkerForEnvironment ?? buildWorkerForEnvironment)(
    plan,
    worker,
    { environmentVariables, root, runner },
  )
  await (options.assertMutationTargetIdentity ?? assertMutationTargetIdentity)(plan, {
    assertAccountAccess: options.assertAccountAccess,
    environmentVariables,
    runner,
  })
  if (worker === 'api') {
    await (options.assertRequiredSecrets ?? assertRequiredSecrets)(plan, {
      environmentVariables,
      runner,
    })
  }
  const versionLookup = options.latestDeploymentVersion ?? latestDeploymentVersion
  const before = versionLookup(plan, worker, { environmentVariables, runner })
  runner('wrangler', ['deploy'], {
    cwd,
    environmentVariables,
    unsetEnvironmentVariables: ['CLOUDFLARE_ENV'],
  })
  const after = versionLookup(plan, worker, { environmentVariables, runner })
  process.stdout.write(
    `Replacement ${worker} deployed (${after ?? 'version unresolved'}); no route or Email Routing change was attempted.\n`,
  )
  return { after, before, dryRun: false, generatedConfig, plan, worker }
}

if (isMainModule(import.meta.url)) deployWorker().catch(printOperatorError)
