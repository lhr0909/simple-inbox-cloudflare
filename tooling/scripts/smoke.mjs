#!/usr/bin/env node

import {
  OperatorError,
  assertEnvironment,
  isMainModule,
  loadDeploymentPlan,
  optionalFlag,
  printOperatorError,
  requireProductionConfirmation,
  requiredFlag,
} from './operator-lib.mjs'

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u

export async function smoke(arguments_ = process.argv.slice(2), options = {}) {
  const environment = requiredFlag(arguments_, '--env')
  assertEnvironment(environment)
  requireProductionConfirmation(environment, arguments_)
  const plan = await (options.loadDeploymentPlan ?? loadDeploymentPlan)(environment, {
    environmentVariables: options.environmentVariables,
    root: options.root,
  })
  const smokeOrigin = requireReplacementSmokeOrigin(
    plan,
    optionalFlag(arguments_, '--base-url'),
    options.environmentVariables,
  )
  return runHttpSmoke(smokeOrigin, options.fetch ?? fetch)
}

export function requireReplacementSmokeOrigin(plan, baseUrl, environmentVariables = process.env) {
  const configured = environmentVariables.SMOKE_BASE_URL
  if (baseUrl !== undefined && configured !== undefined && baseUrl !== configured) {
    throw new OperatorError('--base-url and SMOKE_BASE_URL must match exactly when both are set.')
  }
  const value = baseUrl ?? configured
  if (typeof value !== 'string' || value.length === 0) {
    throw new OperatorError(
      'Set SMOKE_BASE_URL (or pass --base-url) to the explicit replacement workers.dev origin. APP_ORIGIN is never probed implicitly.',
    )
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new OperatorError('SMOKE_BASE_URL must be a valid URL.')
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== value ||
    url.pathname !== '/' ||
    url.port !== ''
  ) {
    throw new OperatorError('SMOKE_BASE_URL must be an exact HTTPS origin without a path or port.')
  }
  const expectedPrefix = `${plan.names.web}.`
  const expectedSuffix = '.workers.dev'
  const accountSubdomain = url.hostname.slice(
    expectedPrefix.length,
    url.hostname.length - expectedSuffix.length,
  )
  if (
    !url.hostname.startsWith(expectedPrefix) ||
    !url.hostname.endsWith(expectedSuffix) ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(accountSubdomain)
  ) {
    throw new OperatorError(
      `SMOKE_BASE_URL must target ${plan.names.web}.<account-subdomain>.workers.dev exactly.`,
    )
  }
  const legacyHosts = legacySmokeHosts(environmentVariables)
  if (legacyHosts.has(url.hostname)) {
    throw new OperatorError(`Refusing to probe declared legacy host: ${url.hostname}`)
  }
  if (plan.appOrigin !== url.origin) {
    throw new OperatorError(
      'Replacement APP_ORIGIN must exactly match SMOKE_BASE_URL before pre-cutover auth or smoke checks.',
    )
  }
  return url.origin
}

export async function runHttpSmoke(baseUrl, fetchImplementation = fetch) {
  const origin = new URL(baseUrl)
  if (origin.protocol !== 'https:' || origin.origin !== baseUrl) {
    throw new OperatorError('Smoke checks require an exact HTTPS replacement origin.')
  }
  const checks = [
    { path: '/', type: 'html' },
    { path: '/docs', type: 'html' },
    { path: '/api/search', type: 'json' },
    { path: '/api/v1/health', type: 'health' },
    { path: '/api/v1/capabilities', type: 'json' },
    { path: '/api/v1/openapi.json', type: 'openapi' },
  ]
  const results = []
  for (const check of checks) {
    const response = await fetchImplementation(new URL(check.path, origin), {
      headers: { accept: check.type === 'html' ? 'text/html' : 'application/json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status !== 200) {
      throw new OperatorError(`${check.path} returned ${response.status}; expected 200.`)
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (check.type === 'html') {
      if (!contentType.includes('text/html')) {
        throw new OperatorError(`${check.path} did not return HTML.`)
      }
      const body = await response.text()
      if (!/<(?:html|main|body)(?:\s|>)/iu.test(body)) {
        throw new OperatorError(`${check.path} returned an unexpected HTML body.`)
      }
    } else {
      if (!contentType.includes('application/json')) {
        throw new OperatorError(`${check.path} did not return JSON.`)
      }
      const body = await response.json()
      if (check.type === 'health' && (body?.ok !== true || body?.service !== 'api')) {
        throw new OperatorError('API health response has an unexpected shape.')
      }
      if (check.type === 'openapi' && body?.openapi !== '3.1.0') {
        throw new OperatorError('OpenAPI smoke response is not the reviewed 3.1 document.')
      }
    }
    if (check.path.startsWith('/api/v1/')) {
      const requestId = response.headers.get('x-request-id')
      if (!requestId || !REQUEST_ID_PATTERN.test(requestId)) {
        throw new OperatorError(`${check.path} did not return a valid request ID.`)
      }
    }
    results.push({ path: check.path, status: response.status })
    process.stdout.write(`smoke ok ${check.path}\n`)
  }
  process.stdout.write('Passive replacement smoke checks passed; no data or routes were changed.\n')
  return results
}

function legacySmokeHosts(environmentVariables) {
  const hosts = new Set()
  const list = environmentVariables.CLOUDFLARE_INBOX_LEGACY_HOSTS
  if (typeof list === 'string') {
    for (const value of list.split(',')) {
      const host = value.trim().toLowerCase()
      if (host.length > 0) hosts.add(host)
    }
  }
  const origin = environmentVariables.CLOUDFLARE_INBOX_LEGACY_APP_ORIGIN
  if (typeof origin === 'string') {
    try {
      hosts.add(new URL(origin).hostname)
    } catch {
      throw new OperatorError('CLOUDFLARE_INBOX_LEGACY_APP_ORIGIN must be a valid URL.')
    }
  }
  return hosts
}

if (isMainModule(import.meta.url)) {
  smoke().catch(printOperatorError)
}
