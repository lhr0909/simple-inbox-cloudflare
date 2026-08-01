import { createHmac } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { InstallationRepository, MailboxScopedRepository } from '@cloudflare-inbox/db'
import { seedSyntheticInbox } from '@cloudflare-inbox/db/testing'
import {
  createTestHarness,
  type TestHarness,
  type TestHarnessOptions,
  type WorkerHandle,
} from 'wrangler'

export const TEST_AUTH_PEPPER = 'integration-only-auth-pepper-00000000000000000000'
export const TEST_SETUP_TOKEN = 'integration-only-setup-token-00000000000000000000'
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
  web: WorkerHandle<HarnessBindings>
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
export const repositoryRoot = resolve(moduleDirectory, '../../..')

export async function startInboxTestHarness(): Promise<InboxTestHarness> {
  const configPath = await locateProductionBuild()
  const name = await readWorkerName(configPath)
  const server = createTestHarness(buildOptions(configPath))
  const listen = await server.listen()
  const worker = server.getWorker<HarnessBindings>(name)

  return {
    api: worker,
    close: () => server.close(),
    mail: worker,
    origin: listen.url.origin,
    server,
    web: worker,
  }
}

export async function migrateAndSeedHarness(harness: InboxTestHarness): Promise<void> {
  await harness.api.applyD1Migrations('DB')
  const { DB } = await harness.api.getEnv()
  const now = Date.now()
  const oldRequestTime = now - 2 * 60 * 1_000

  await new InstallationRepository(DB).complete({
    applicationRecordRetentionDays: 365,
    appOrigin: harness.origin,
    completedAt: now,
    mailDomain: 'example.test',
    mailboxAddress: TEST_ADDRESSES.mailbox,
    mailboxId: TEST_IDS.mailbox,
    ownerEmail: TEST_ADDRESSES.owner,
    rawEmailRetentionDays: 365,
    retentionBatchSize: 100,
    userId: TEST_IDS.user,
  })

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
        address: TEST_ADDRESSES.secondMailbox,
        forwardTo: TEST_ADDRESSES.secondUser,
        id: TEST_IDS.secondMailbox,
        ownerUserId: TEST_IDS.secondUser,
        senderAlias: null,
      },
    ],
    now,
    users: [{ email: TEST_ADDRESSES.secondUser, id: TEST_IDS.secondUser }],
  })
  await new MailboxScopedRepository(DB, { userId: TEST_IDS.user }).updateMailboxSettings(
    TEST_IDS.mailbox,
    { senderAlias: 'Integration Inbox' },
    now,
  )
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

async function locateProductionBuild(): Promise<string> {
  const path = resolve(repositoryRoot, 'apps/web/dist/server/wrangler.json')
  try {
    await access(path)
  } catch {
    throw new Error(
      'A single-Worker production build is required before integration tests. Run `vp run build`.',
    )
  }
  if ((await readWorkerName(path)) !== 'simple-inbox-cf') {
    throw new Error(`The built Worker must be named simple-inbox-cf: ${path}`)
  }
  return path
}

async function readWorkerName(path: string): Promise<string> {
  const input = JSON.parse(await readFile(path, 'utf8')) as { name?: unknown }
  if (typeof input.name !== 'string' || input.name.length === 0) {
    throw new Error(`Built Wrangler configuration has no Worker name: ${path}`)
  }
  return input.name
}

function buildOptions(configPath: string): TestHarnessOptions {
  return {
    root: repositoryRoot,
    workers: [
      {
        configPath,
        secrets: {
          AUTH_TOKEN_PEPPER: TEST_AUTH_PEPPER,
          SETUP_TOKEN: TEST_SETUP_TOKEN,
        },
        vars: { ENVIRONMENT: 'local' },
      },
    ],
  }
}
