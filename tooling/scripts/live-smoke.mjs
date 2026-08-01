#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  OperatorError,
  assertEnvironment,
  hasFlag,
  isMainModule,
  loadDeploymentPlan,
  printOperatorError,
  repositoryRoot,
  requireProductionConfirmation,
  requiredFlag,
} from './operator-lib.mjs'
import { requireReplacementSmokeOrigin, runHttpSmoke } from './smoke.mjs'

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u
const requiredEvidence = [
  'magicLinkHttps',
  'inboundCaptured',
  'outboundDelivered',
  'replyRoundTrip',
  'binaryAttachmentRoundTrip',
  'traceIdChain',
  'noLegacyResourcesTouched',
]

export async function liveSmoke(arguments_ = process.argv.slice(2), options = {}) {
  const environment = requiredFlag(arguments_, '--env')
  assertEnvironment(environment)
  requireProductionConfirmation(environment, arguments_)
  if (!hasFlag(arguments_, '--confirm-owner-live-smoke')) {
    throw new OperatorError('Live mail/auth checks require --confirm-owner-live-smoke.')
  }
  const prepare = hasFlag(arguments_, '--prepare')
  const verify = hasFlag(arguments_, '--verify')
  if (prepare === verify) throw new OperatorError('Choose exactly one of --prepare or --verify.')
  const evidencePath = resolve(requiredFlag(arguments_, '--evidence-file'))
  if (evidencePath === repositoryRoot || evidencePath.startsWith(`${repositoryRoot}/`)) {
    throw new OperatorError(
      'Live-smoke evidence may contain addresses; store it outside the repository.',
    )
  }
  const plan = await (options.loadDeploymentPlan ?? loadDeploymentPlan)(environment, {
    environmentVariables: options.environmentVariables,
    root: options.root,
  })
  const environmentVariables = options.environmentVariables ?? process.env
  const smokeOrigin = requireReplacementSmokeOrigin(plan, undefined, environmentVariables)
  const ownerEmail = requiredEnvironmentEmail(
    environmentVariables.CLOUDFLARE_INBOX_SMOKE_OWNER_EMAIL,
    'CLOUDFLARE_INBOX_SMOKE_OWNER_EMAIL',
  )
  if (ownerEmail !== plan.ownerEmail) {
    throw new OperatorError('Live-smoke owner must exactly match the replacement OWNER_EMAIL.')
  }
  const inboundAddress = requiredEnvironmentEmail(
    environmentVariables.CLOUDFLARE_INBOX_SMOKE_INBOUND_ADDRESS,
    'CLOUDFLARE_INBOX_SMOKE_INBOUND_ADDRESS',
  )
  if (!inboundAddress.endsWith(`@${plan.mailDomain}`)) {
    throw new OperatorError('Live-smoke inbound address must use the replacement mail domain.')
  }
  const outboundAddress = requiredEnvironmentEmail(
    environmentVariables.CLOUDFLARE_INBOX_SMOKE_OUTBOUND_ADDRESS,
    'CLOUDFLARE_INBOX_SMOKE_OUTBOUND_ADDRESS',
  )

  await runHttpSmoke(smokeOrigin, options.fetch ?? fetch)
  if (verify) {
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'))
    validateEvidence(evidence, environment)
    process.stdout.write(
      `Owner-verified live smoke evidence passed for ${environment}. Cutover is still a separate manual operation.\n`,
    )
    return evidence
  }

  const response = await (options.fetch ?? fetch)(
    new URL('/api/v1/auth/magic-links', smokeOrigin),
    {
      body: JSON.stringify({ email: ownerEmail }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    },
  )
  if (response.status !== 202) {
    throw new OperatorError(`Magic-link preparation returned ${response.status}; expected 202.`)
  }
  const requestId = response.headers.get('x-request-id')
  if (!requestId || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new OperatorError('Magic-link preparation did not return a valid request ID.')
  }
  const runId = `replacement-smoke-${randomUUID()}`
  const template = {
    binaryAttachmentRoundTrip: false,
    environment,
    inboundCaptured: false,
    magicLinkHttps: false,
    noLegacyResourcesTouched: false,
    notes: `Use only the synthetic ${runId} subject/body. Inbound: ${inboundAddress}; allowlisted outbound: ${outboundAddress}.`,
    outboundDelivered: false,
    replyRoundTrip: false,
    requestIds: [requestId],
    runId,
    traceIdChain: false,
  }
  await writeFile(evidencePath, `${JSON.stringify(template, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
  process.stdout.write(
    [
      `Prepared owner-only replacement smoke ${runId}.`,
      `Evidence template: ${evidencePath}`,
      `1. Consume the HTTPS magic link sent to ${ownerEmail}.`,
      `2. Send a uniquely titled synthetic inbound message to ${inboundAddress}.`,
      `3. Reply to ${outboundAddress}, then reply back into the same thread.`,
      '4. Round-trip a small binary attachment and verify its authorized download.',
      '5. Record the web -> API -> mail request IDs and confirm legacy resources were untouched.',
      '6. Set every evidence boolean true only after direct verification, then run --verify.',
      'This command did not switch DNS, custom-domain routes, or Email Routing.',
      '',
    ].join('\n'),
  )
  return template
}

export function validateEvidence(evidence, environment) {
  if (evidence?.environment !== environment)
    throw new OperatorError('Evidence environment mismatch.')
  if (typeof evidence.runId !== 'string' || !evidence.runId.startsWith('replacement-smoke-')) {
    throw new OperatorError('Evidence has no replacement smoke run ID.')
  }
  for (const field of requiredEvidence) {
    if (evidence[field] !== true)
      throw new OperatorError(`Live-smoke evidence is incomplete: ${field}.`)
  }
  if (
    !Array.isArray(evidence.requestIds) ||
    evidence.requestIds.length < 3 ||
    evidence.requestIds.some(
      (value) => typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value),
    )
  ) {
    throw new OperatorError(
      'Evidence must include at least three valid request IDs across the trace.',
    )
  }
}

function requiredEnvironmentEmail(value, name) {
  if (
    typeof value !== 'string' ||
    value !== value.trim().toLowerCase() ||
    !/^\S+@\S+\.\S+$/u.test(value)
  ) {
    throw new OperatorError(`Set ${name} to a normalized allowlisted test email.`)
  }
  return value
}

if (isMainModule(import.meta.url)) {
  liveSmoke().catch(printOperatorError)
}
