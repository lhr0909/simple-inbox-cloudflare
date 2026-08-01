import { createHmac } from 'node:crypto'
import { access, readdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { seedSyntheticInbox } from '@cloudflare-inbox/db/testing'
import {
  createTestHarness,
  type TestHarness,
  type TestHarnessOptions,
  type WorkerHandle,
} from 'wrangler'

export const TEST_AUTH_PEPPER = 'integration-only-auth-pepper-00000000000000000000'
export const TEST_MAGIC_TOKEN = 'integration-magic-token-000000000000000000000000'
export const TEST_SECOND_API_TOKEN = 'integration-api-token-000000000000000000000000000'

export const TEST_IDS = {
  apiToken: '019fbbcf-73c9-7a01-8a00-000000000007',
  magicLink: '019fbbcf-73c9-7a01-8a00-000000000006',
  mailbox: '019fbbcf-73c9-7a01-8a00-000000000002',
  secondMailbox: '019fbbcf-73c9-7a01-8a00-000000000004',
  secondUser: '019fbbcf-73c9-7a01-8a00-000000000003',
  user: '019fbbcf-73c9-7a01-8a00-000000000001',
} as const

export const TEST_ADDRESSES = {
  inboundSender: 'alice@sender.test',
  mailbox: 'inbox@example.test',
  owner: 'owner@example.test',
  secondMailbox: 'private@example.test',
  secondUser: 'second-owner@example.test',
} as const

type HarnessBindings = {
  DB: D1Database
  RAW_EMAILS: R2Bucket
}

export type InboxTestHarness = {
  api: WorkerHandle<HarnessBindings>
  close(): Promise<void>
  mail: WorkerHandle<HarnessBindings>
  origin: string
  server: TestHarness
  web: WorkerHandle
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
export const repositoryRoot = resolve(moduleDirectory, '../../..')

export async function startInboxTestHarness(): Promise<InboxTestHarness> {
  const buildConfigs = await locateProductionBuilds()
  const names = await workerNames(buildConfigs)
  const server = createTestHarness(buildOptions('http://127.0.0.1', names, buildConfigs))
  const firstListen = await server.listen()
  const origin = firstListen.url.origin
  await server.update(buildOptions(origin, names, buildConfigs))
  const finalListen = await server.listen()

  return {
    api: server.getWorker<HarnessBindings>(names.api),
    close: () => server.close(),
    mail: server.getWorker<HarnessBindings>(names.mail),
    origin: finalListen.url.origin,
    server,
    web: server.getWorker(names.web),
  }
}

export async function migrateAndSeedHarness(harness: InboxTestHarness): Promise<void> {
  await harness.api.applyD1Migrations('DB')
  const { DB } = await harness.api.getEnv()
  const now = Date.now()
  const oldRequestTime = now - 2 * 60 * 1_000

  await seedSyntheticInbox(DB, {
    apiTokens: [
      {
        createdAt: now,
        id: TEST_IDS.apiToken,
        name: 'integration cross-mailbox token',
        scopes: 7,
        tokenDigest: digestToken(TEST_SECOND_API_TOKEN),
        userId: TEST_IDS.secondUser,
      },
    ],
    magicLinks: [
      {
        expiresAt: now + 15 * 60 * 1_000,
        id: TEST_IDS.magicLink,
        requestedAt: oldRequestTime,
        tokenDigest: digestToken(TEST_MAGIC_TOKEN),
        userId: TEST_IDS.user,
      },
    ],
    mailboxes: [
      {
        address: TEST_ADDRESSES.mailbox,
        forwardTo: TEST_ADDRESSES.owner,
        id: TEST_IDS.mailbox,
        ownerUserId: TEST_IDS.user,
        senderAlias: 'Integration Inbox',
      },
      {
        address: TEST_ADDRESSES.secondMailbox,
        forwardTo: TEST_ADDRESSES.secondUser,
        id: TEST_IDS.secondMailbox,
        ownerUserId: TEST_IDS.secondUser,
        senderAlias: null,
      },
    ],
    now,
    users: [
      { email: TEST_ADDRESSES.owner, id: TEST_IDS.user },
      { email: TEST_ADDRESSES.secondUser, id: TEST_IDS.secondUser },
    ],
  })
}

export async function injectSyntheticInbound(
  harness: InboxTestHarness,
  raw?: string,
): Promise<void> {
  const source =
    raw ??
    (await readFile(
      resolve(repositoryRoot, 'tests/fixtures/messages/inbound-with-attachment.eml'),
      'utf8',
    ))
  const result = await harness.mail.email({
    from: TEST_ADDRESSES.inboundSender,
    raw: source,
    to: TEST_ADDRESSES.mailbox,
  })
  if (result.outcome !== 'ok') {
    throw new Error(`Synthetic email dispatch failed: ${result.rejectReason ?? 'unknown error'}`)
  }
}

export function sessionCookie(response: { headers: { get(name: string): string | null } }): string {
  const setCookie = response.headers.get('set-cookie')
  if (!setCookie) throw new Error('Expected the API to set a session cookie.')
  return setCookie.split(';', 1)[0] ?? ''
}

export function sameOriginHeaders(origin: string, cookie: string): Record<string, string> {
  return {
    cookie,
    origin,
    'sec-fetch-site': 'same-origin',
  }
}

function digestToken(token: string): string {
  return createHmac('sha256', TEST_AUTH_PEPPER).update(token).digest('hex')
}

async function locateProductionBuilds(): Promise<{ api: string; mail: string; web: string }> {
  const [api, mail, web] = await Promise.all([
    findBuiltWrangler(resolve(repositoryRoot, 'workers/api/dist'), '-api'),
    findBuiltWrangler(resolve(repositoryRoot, 'workers/mail/dist'), '-mail'),
    findBuiltWrangler(resolve(repositoryRoot, 'apps/web/dist'), '-web'),
  ])
  return { api, mail, web }
}

async function findBuiltWrangler(directory: string, expectedSuffix: string): Promise<string> {
  const candidates: string[] = []
  try {
    await access(directory)
    await collectWranglerConfigs(directory, candidates)
  } catch {
    // The actionable build error below is shared by missing and stale output.
  }
  for (const candidate of candidates.sort()) {
    const name = await readWorkerName(candidate)
    if (name.startsWith('cloudflare-inbox-replacement-local-') && name.endsWith(expectedSuffix)) {
      return candidate
    }
  }
  throw new Error(
    `A replacement local ${expectedSuffix.slice(1)} production build is required before integration tests. Run \`vp run build\`; no matching wrangler.json was found under ${directory}.`,
  )
}

async function collectWranglerConfigs(directory: string, output: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) await collectWranglerConfigs(path, output)
    else if (entry.isFile() && entry.name === 'wrangler.json') output.push(path)
  }
}

async function workerNames(buildConfigs: {
  api: string
  mail: string
  web: string
}): Promise<{ api: string; mail: string; web: string }> {
  const [api, mail, web] = await Promise.all([
    readWorkerName(buildConfigs.api),
    readWorkerName(buildConfigs.mail),
    readWorkerName(buildConfigs.web),
  ])
  return { api, mail, web }
}

async function readWorkerName(path: string): Promise<string> {
  const input = JSON.parse(await readFile(path, 'utf8')) as { name?: unknown }
  if (typeof input.name !== 'string' || input.name.length === 0) {
    throw new Error(`Built Wrangler configuration has no Worker name: ${path}`)
  }
  return input.name
}

function buildOptions(
  appOrigin: string,
  names: { api: string; mail: string; web: string },
  buildConfigs: { api: string; mail: string; web: string },
): TestHarnessOptions {
  const commonVars = {
    APP_ORIGIN: appOrigin,
    ENVIRONMENT: 'local',
  }
  return {
    root: repositoryRoot,
    workers: [
      {
        bindingOverrides: { API: names.api },
        configPath: buildConfigs.web,
        vars: commonVars,
      },
      {
        bindingOverrides: { MAIL: names.mail },
        configPath: buildConfigs.api,
        secrets: { AUTH_TOKEN_PEPPER: TEST_AUTH_PEPPER },
        vars: {
          ...commonVars,
          MAIL_DOMAIN: 'example.test',
          OWNER_EMAIL: TEST_ADDRESSES.owner,
          RAW_EMAIL_RETENTION_DAYS: '365',
          APPLICATION_RECORD_RETENTION_DAYS: '365',
          RETENTION_BATCH_SIZE: '100',
        },
      },
      {
        configPath: buildConfigs.mail,
        vars: {
          ...commonVars,
          MAIL_DOMAIN: 'example.test',
          OWNER_EMAIL: TEST_ADDRESSES.owner,
          RAW_EMAIL_RETENTION_DAYS: '365',
          APPLICATION_RECORD_RETENTION_DAYS: '365',
          RETENTION_BATCH_SIZE: '100',
        },
      },
    ],
  }
}
