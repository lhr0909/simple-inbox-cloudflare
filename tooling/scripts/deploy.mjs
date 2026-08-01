#!/usr/bin/env node

import { resolve } from 'node:path'

import {
  assertDeploymentRedirect,
  assertFlattenedWorkerBuild,
  expectedFlattenedConfigPath,
  findFlattenedWorkerConfig,
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
  replacementResourceNames,
  repositoryRoot,
  requireProductionConfirmation,
  requiredFlag,
  runCommand,
} from './operator-lib.mjs'
import { requireReplacementSmokeOrigin } from './smoke.mjs'

const workerOrder = ['mail', 'api', 'web']

export async function deploy(arguments_ = process.argv.slice(2), options = {}) {
  const environment = requiredFlag(arguments_, '--env')
  assertEnvironment(environment)
  requireProductionConfirmation(environment, arguments_)
  const dryRun = hasFlag(arguments_, '--dry-run')
  if (!dryRun && !hasFlag(arguments_, '--confirm-replacement-deploy')) {
    throw new OperatorError(
      'Deploying replacement resources requires --confirm-replacement-deploy.',
    )
  }
  const root = options.root ?? repositoryRoot
  const environmentVariables = options.environmentVariables ?? process.env
  const plan = await (options.loadDeploymentPlan ?? loadDeploymentPlan)(environment, {
    environmentVariables,
    root,
  })
  const runner = options.runner ?? runCommand
  const smokeOrigin = requireReplacementSmokeOrigin(plan, undefined, environmentVariables)
  const commands = deploymentCommands(environment, { root })

  printPlan(plan, smokeOrigin, root)
  if (dryRun) {
    for (const command of commands) runDescriptor(command, runner, environmentVariables, true)
    process.stdout.write('Dry run complete. No account, resource, route, or message was changed.\n')
    return { dryRun: true, plan }
  }

  ;(options.assertCleanWorkspace ?? assertCleanWorkspace)({ runner })
  await (options.assertMutationTargetIdentity ?? assertMutationTargetIdentity)(plan, {
    assertAccountAccess: options.assertAccountAccess,
    environmentVariables,
    runner,
  })
  await (options.assertRequiredSecrets ?? assertRequiredSecrets)(plan, {
    environmentVariables,
    runner,
  })

  for (const command of commands.filter(({ phase }) => phase !== 'mutate')) {
    runDescriptor(command, runner, environmentVariables, false)
  }
  const generatedConfigs = await validateEnvironmentBuilds(plan, {
    assertDeploymentRedirect: options.assertDeploymentRedirect,
    assertFlattenedWorkerBuild: options.assertFlattenedWorkerBuild,
    findFlattenedWorkerConfig: options.findFlattenedWorkerConfig,
    root,
  })

  const versionLookup = options.latestDeploymentVersion ?? latestDeploymentVersion
  const before = Object.fromEntries(
    workerOrder.map((worker) => [
      worker,
      versionLookup(plan, worker, { environmentVariables, runner }),
    ]),
  )
  try {
    for (const command of commands.filter(({ phase }) => phase === 'mutate')) {
      runDescriptor(command, runner, environmentVariables, false)
    }
  } catch (error) {
    process.stderr.write('\nReplacement deployment stopped. No cutover action was attempted.\n')
    printRollbackCommands(plan, before)
    throw error
  }

  const after = Object.fromEntries(
    workerOrder.map((worker) => [
      worker,
      versionLookup(plan, worker, { environmentVariables, runner }),
    ]),
  )
  process.stdout.write(
    [
      '',
      `Replacement ${environment} deployment and passive smoke completed.`,
      `  mail version: ${after.mail ?? 'unresolved'}`,
      `  API version: ${after.api ?? 'unresolved'}`,
      `  web version: ${after.web ?? 'unresolved'}`,
      'No DNS, custom-domain, or Email Routing value was changed.',
      'Run the owner-only live smoke and complete the manual cutover checklist before switching traffic.',
      '',
    ].join('\n'),
  )
  printRollbackCommands(plan, before)
  return { after, before, dryRun: false, generatedConfigs, plan }
}

export function deploymentCommands(environment, options = {}) {
  assertEnvironment(environment)
  const root = options.root ?? repositoryRoot
  const bootstrapPath = resolve(root, 'tooling/scripts/bootstrap.mjs')
  const smokePath = resolve(root, 'tooling/scripts/smoke.mjs')
  const apiConfig = resolve(root, 'workers/api/wrangler.jsonc')
  const verification = [
    descriptor('vp', ['run', 'check:generated'], root, 'verify'),
    descriptor('vp', ['run', 'check'], root, 'verify'),
    descriptor('vp', ['run', 'test:boundaries'], root, 'verify'),
    descriptor('vp', ['test'], root, 'verify'),
    ...workerOrder.map((worker) => ({
      ...descriptor('vp', ['build'], workerDirectory(worker, root), 'verify'),
      unsetEnvironmentVariables: ['CLOUDFLARE_ENV'],
    })),
    descriptor('vp', ['run', 'test:integration'], root, 'verify'),
    descriptor('vp', ['run', 'test:e2e'], root, 'verify'),
    ...workerOrder.map((worker) => ({
      ...descriptor('vp', ['build'], workerDirectory(worker, root), 'environment-build'),
      displayEnvironmentVariables: ['CLOUDFLARE_ENV'],
      environmentVariables: { CLOUDFLARE_ENV: environment },
    })),
  ]
  const mutations = [
    descriptor(
      'wrangler',
      [
        'd1',
        'migrations',
        'apply',
        'DB',
        '--config',
        apiConfig,
        '--env',
        environment,
        '--remote',
        '--yes',
      ],
      root,
      'mutate',
    ),
    descriptor(
      process.execPath,
      [
        bootstrapPath,
        '--env',
        environment,
        ...(environment === 'production' ? ['--confirm-production'] : []),
      ],
      root,
      'mutate',
    ),
    ...workerOrder.map((worker) => ({
      ...descriptor('wrangler', ['deploy'], workerDirectory(worker, root), 'mutate'),
      unsetEnvironmentVariables: ['CLOUDFLARE_ENV'],
    })),
    descriptor(
      process.execPath,
      [
        smokePath,
        '--env',
        environment,
        ...(environment === 'production' ? ['--confirm-production'] : []),
      ],
      root,
      'mutate',
    ),
  ]
  return [...verification, ...mutations]
}

export async function validateEnvironmentBuilds(plan, options = {}) {
  const root = options.root ?? repositoryRoot
  const findConfig = options.findFlattenedWorkerConfig ?? findFlattenedWorkerConfig
  const assertConfig = options.assertFlattenedWorkerBuild ?? assertFlattenedWorkerBuild
  const assertRedirect = options.assertDeploymentRedirect ?? assertDeploymentRedirect
  const output = {}
  for (const worker of workerOrder) {
    const configPath = await findConfig(plan, worker, { root })
    await assertConfig(configPath, plan, worker)
    await assertRedirect(configPath, worker, { root })
    output[worker] = configPath
  }
  return output
}

export function dryRunGeneratedConfigPaths(environment, root = repositoryRoot) {
  const names = replacementResourceNames(environment)
  return Object.fromEntries(
    workerOrder.map((worker) => [worker, expectedFlattenedConfigPath({ names }, worker, root)]),
  )
}

function descriptor(command, arguments_, cwd, phase) {
  return { arguments_, command, cwd, phase }
}

function runDescriptor(descriptor_, runner, baseEnvironment, dryRun) {
  runner(descriptor_.command, descriptor_.arguments_, {
    cwd: descriptor_.cwd,
    displayEnvironmentVariables: descriptor_.displayEnvironmentVariables,
    dryRun,
    environmentVariables: {
      ...baseEnvironment,
      ...descriptor_.environmentVariables,
    },
    unsetEnvironmentVariables: descriptor_.unsetEnvironmentVariables,
  })
}

function printPlan(plan, smokeOrigin, root) {
  const generated = dryRunGeneratedConfigPaths(plan.environment, root)
  process.stdout.write(
    [
      `Replacement deploy plan (${plan.environment})`,
      `  mail -> ${plan.names.mail}`,
      `  API  -> ${plan.names.api}`,
      `  web  -> ${plan.names.web}`,
      `  D1   -> ${plan.databaseName} (${plan.databaseId})`,
      `  R2   -> ${plan.rawBucket}`,
      `  smoke -> ${smokeOrigin}`,
      `  generated configs -> ${generated.mail}, ${generated.api}, ${generated.web}`,
      '  DNS/custom-domain and Email Routing cutover are explicitly excluded.',
      '',
    ].join('\n'),
  )
}

function printRollbackCommands(plan, versions) {
  process.stdout.write('\nRollback commands for the pre-deploy replacement versions:\n')
  for (const worker of ['web', 'api', 'mail']) {
    const version = versions[worker]
    if (!version) {
      process.stdout.write(`  ${worker}: no earlier replacement version was resolved\n`)
      continue
    }
    process.stdout.write(
      `  wrangler rollback ${version} --config ${plan.configPaths[worker]} --env ${plan.environment} --name ${plan.names[worker]} --yes\n`,
    )
  }
  process.stdout.write(
    'These commands roll back replacement Workers only; route rollback is manual.\n',
  )
}

if (isMainModule(import.meta.url)) {
  deploy().catch(printOperatorError)
}
