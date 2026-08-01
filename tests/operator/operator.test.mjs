import { createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it, vi } from 'vitest'

import { apiToken } from '../../tooling/scripts/api-token.mjs'
import {
  assertBootstrapVerification,
  bootstrap,
  bootstrapSql,
  deterministicUuidV7,
} from '../../tooling/scripts/bootstrap.mjs'
import {
  assertDeploymentRedirect,
  assertFlattenedWorkerBuild,
  findFlattenedWorkerConfig,
} from '../../tooling/scripts/deployment-build.mjs'
import { deploy, deploymentCommands } from '../../tooling/scripts/deploy.mjs'
import { compareGeneratedArtifacts } from '../../tooling/scripts/check-generated.mjs'
import { migrate } from '../../tooling/scripts/migrate.mjs'
import {
  assertAccountAccess,
  assertLegacyResourcesAreDistinct,
  assertMutationTargetIdentity,
  assertRemoteReplacementTargets,
  readJsonc,
  replacementResourceNames,
} from '../../tooling/scripts/operator-lib.mjs'
import { provision } from '../../tooling/scripts/provision.mjs'
import { requireReplacementSmokeOrigin } from '../../tooling/scripts/smoke.mjs'

const ownerEmail = 'owner@replacement.invalid'
const databaseId = '11111111-2222-4333-8444-555555555555'
const accountId = 'a'.repeat(32)
const legacyDatabaseId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const plaintextToken = 'replacement_token_secret_000000000000000000000'
const pepper = 'replacement-test-pepper-000000000000000000000'

function deploymentPlan(environment = 'staging') {
  const names = replacementResourceNames(environment)
  return {
    appOrigin: `https://${names.web}.test-account.workers.dev`,
    configPaths: {
      api: `/replacement/${environment}/api/wrangler.jsonc`,
      mail: `/replacement/${environment}/mail/wrangler.jsonc`,
      web: `/replacement/${environment}/web/wrangler.jsonc`,
    },
    databaseId,
    databaseName: names.database,
    environment,
    mailCrons: ['17 3 * * *'],
    mailDomain: 'replacement.invalid',
    names,
    observability: {
      api: {
        enabled: true,
        logs: { enabled: true, invocation_logs: false },
        traces: { enabled: false },
      },
      mail: {
        enabled: true,
        logs: { enabled: true, invocation_logs: false },
        traces: { enabled: false },
      },
      web: {
        enabled: true,
        logs: { enabled: true, invocation_logs: false },
        traces: { enabled: false },
      },
    },
    ownerEmail,
    rawBucket: names.rawBucket,
    rateLimit: {
      name: 'AUTH_RATE_LIMIT',
      namespace_id: '4001',
      simple: { limit: 5, period: 60 },
    },
    retention: { applicationRecordDays: 365, batchSize: 100, rawEmailDays: 365 },
    vars: {
      api: {
        APP_ORIGIN: `https://${names.web}.test-account.workers.dev`,
        ENVIRONMENT: environment,
        MAIL_DOMAIN: 'replacement.invalid',
        OWNER_EMAIL: ownerEmail,
        RAW_EMAIL_RETENTION_DAYS: '365',
      },
      mail: {
        APP_ORIGIN: `https://${names.web}.test-account.workers.dev`,
        APPLICATION_RECORD_RETENTION_DAYS: '365',
        ENVIRONMENT: environment,
        MAIL_DOMAIN: 'replacement.invalid',
        OWNER_EMAIL: ownerEmail,
        RAW_EMAIL_RETENTION_DAYS: '365',
        RETENTION_BATCH_SIZE: '100',
      },
      web: {
        APP_ORIGIN: `https://${names.web}.test-account.workers.dev`,
        ENVIRONMENT: environment,
      },
    },
    workersDev: { api: false, mail: false, web: true },
  }
}

function noCloudflareAccess() {
  throw new Error('A dry run attempted Cloudflare access.')
}

function legacyGuardEnvironment(overrides = {}) {
  return {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_INBOX_LEGACY_API_WORKER: 'synthetic-legacy-api',
    CLOUDFLARE_INBOX_LEGACY_D1_DATABASE_ID: legacyDatabaseId,
    CLOUDFLARE_INBOX_LEGACY_MAIL_WORKER: 'synthetic-legacy-mail',
    CLOUDFLARE_INBOX_LEGACY_R2_BUCKET: 'synthetic-legacy-raw',
    CLOUDFLARE_INBOX_LEGACY_WEB_WORKER: 'synthetic-legacy-web',
    ...overrides,
  }
}

describe('replacement operator safety', () => {
  it('refuses any replacement plan that reuses a declared legacy resource', () => {
    const plan = deploymentPlan()
    expect(() =>
      assertLegacyResourcesAreDistinct(plan, {
        CLOUDFLARE_INBOX_LEGACY_D1_DATABASE_ID: databaseId,
      }),
    ).toThrow(/Refusing to use legacy Cloudflare Inbox resource/u)
    expect(() =>
      assertLegacyResourcesAreDistinct(plan, {
        CLOUDFLARE_INBOX_LEGACY_API_WORKER: plan.names.api,
      }),
    ).toThrow(/Refusing to use legacy Cloudflare Inbox resource/u)
  })

  it('rejects the committed account placeholder before invoking Wrangler', async () => {
    const runner = vi.fn()
    await expect(
      assertAccountAccess({
        environmentVariables: { CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32) },
        runner,
      }),
    ).rejects.toThrow(/placeholder/u)
    expect(runner).not.toHaveBeenCalled()
  })

  it('rejects a masked wrong D1 UUID with no legacy guards before any account lookup', async () => {
    const runner = vi.fn()
    const plan = { ...deploymentPlan(), databaseId: '22222222-3333-4444-8555-666666666666' }
    await expect(
      assertMutationTargetIdentity(plan, {
        environmentVariables: { CLOUDFLARE_ACCOUNT_ID: accountId },
        runner,
      }),
    ).rejects.toThrow(/every explicit legacy resource guard/u)
    expect(runner).not.toHaveBeenCalled()
  })

  it('remotely resolves the exact replacement D1, R2, and Worker targets', async () => {
    const plan = deploymentPlan()
    const runner = vi.fn((_command, arguments_) => {
      if (arguments_[0] === 'whoami') {
        return { status: 0, stderr: '', stdout: JSON.stringify({ accounts: [{ id: accountId }] }) }
      }
      if (arguments_[0] === 'd1' && arguments_[1] === 'list') {
        return {
          status: 0,
          stderr: '',
          stdout: JSON.stringify([{ name: plan.databaseName, uuid: plan.databaseId }]),
        }
      }
      if (arguments_[0] === 'r2' && arguments_[2] === 'info') {
        return {
          status: 0,
          stderr: '',
          stdout: JSON.stringify({ name: plan.rawBucket }),
        }
      }
      if (arguments_[0] === 'deployments' && arguments_[1] === 'list') {
        return { status: 0, stderr: '', stdout: '[]' }
      }
      throw new Error(`Unexpected synthetic Wrangler call: ${arguments_.join(' ')}`)
    })

    await expect(
      assertMutationTargetIdentity(plan, {
        environmentVariables: legacyGuardEnvironment(),
        runner,
      }),
    ).resolves.toMatchObject({
      database: { id: plan.databaseId, name: plan.databaseName },
      rawBucket: plan.rawBucket,
      workers: { api: 'present', mail: 'present', web: 'present' },
    })
    expect(
      runner.mock.calls
        .filter(([, arguments_]) => arguments_[0] === 'deployments')
        .map(([, arguments_]) => arguments_[arguments_.indexOf('--name') + 1]),
    ).toEqual([plan.names.mail, plan.names.api, plan.names.web])
  })

  it('fails closed when R2 or Worker identity resolution is not exact', async () => {
    const plan = deploymentPlan()
    const d1Result = {
      status: 0,
      stderr: '',
      stdout: JSON.stringify([{ name: plan.databaseName, uuid: plan.databaseId }]),
    }
    const wrongBucketRunner = vi.fn((_command, arguments_) => {
      if (arguments_[0] === 'd1') return d1Result
      if (arguments_[0] === 'r2') {
        return { status: 0, stderr: '', stdout: JSON.stringify({ name: 'synthetic-other-raw' }) }
      }
      throw new Error(`Unexpected synthetic Wrangler call: ${arguments_.join(' ')}`)
    })
    await expect(
      assertRemoteReplacementTargets(plan, { runner: wrongBucketRunner }),
    ).rejects.toThrow(/R2 bucket.*did not resolve exactly/u)
    expect(
      wrongBucketRunner.mock.calls.some(([, arguments_]) => arguments_[0] === 'deployments'),
    ).toBe(false)

    const workerFailureRunner = vi.fn((_command, arguments_) => {
      if (arguments_[0] === 'd1') return d1Result
      if (arguments_[0] === 'r2') {
        return { status: 0, stderr: '', stdout: JSON.stringify({ name: plan.rawBucket }) }
      }
      if (arguments_[0] === 'deployments') {
        return { status: 1, stderr: 'synthetic permission failure [code: 9109]', stdout: '' }
      }
      throw new Error(`Unexpected synthetic Wrangler call: ${arguments_.join(' ')}`)
    })
    await expect(
      assertRemoteReplacementTargets(plan, { runner: workerFailureRunner }),
    ).rejects.toThrow(/Could not resolve configured replacement Worker/u)
  })

  it('rejects a wrong configured D1 UUID before migration despite the replacement name', async () => {
    const plan = { ...deploymentPlan(), databaseId: '22222222-3333-4444-8555-666666666666' }
    const runner = vi.fn((_command, arguments_) => {
      if (arguments_[0] === 'whoami') {
        return { status: 0, stderr: '', stdout: JSON.stringify({ accounts: [{ id: accountId }] }) }
      }
      if (arguments_[0] === 'd1' && arguments_[1] === 'list') {
        return {
          status: 0,
          stderr: '',
          stdout: JSON.stringify([{ name: plan.databaseName, uuid: databaseId }]),
        }
      }
      throw new Error(`Unexpected synthetic Wrangler call: ${arguments_.join(' ')}`)
    })

    await expect(
      migrate(['--env', 'staging', '--confirm-migrate'], {
        assertCleanWorkspace: () => undefined,
        environmentVariables: legacyGuardEnvironment(),
        loadDeploymentPlan: async () => plan,
        runner,
      }),
    ).rejects.toThrow(/does not resolve exactly/u)
    expect(
      runner.mock.calls.some(
        ([, arguments_]) => arguments_[0] === 'd1' && arguments_[1] === 'migrations',
      ),
    ).toBe(false)
  })

  it('disables provider invocation logs and automatic traces in every Worker config', async () => {
    for (const path of [
      'apps/web/wrangler.jsonc',
      'workers/api/wrangler.jsonc',
      'workers/mail/wrangler.jsonc',
    ]) {
      const config = await readJsonc(join(process.cwd(), path))
      expect(config.observability).toMatchObject({
        enabled: true,
        logs: { enabled: true, invocation_logs: false },
        traces: { enabled: false },
      })
    }
  })

  it('requires an explicit production confirmation before loading a plan or using a runner', async () => {
    const loadDeploymentPlan = vi.fn()
    const runner = vi.fn()

    await expect(provision(['--env', 'production'], { runner })).rejects.toThrow(
      /--confirm-production/u,
    )
    await expect(
      bootstrap(['--env', 'production', '--dry-run'], { loadDeploymentPlan, runner }),
    ).rejects.toThrow(/--confirm-production/u)
    await expect(
      deploy(['--env', 'production', '--dry-run'], { loadDeploymentPlan, runner }),
    ).rejects.toThrow(/--confirm-production/u)
    await expect(
      apiToken(['list', '--env', 'production', '--owner-email', ownerEmail], {
        loadDeploymentPlan,
        runner,
      }),
    ).rejects.toThrow(/--confirm-production/u)

    expect(loadDeploymentPlan).not.toHaveBeenCalled()
    expect(runner).not.toHaveBeenCalled()
  })

  it('keeps plan and dry-run modes non-mutating', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await expect(
        provision(['--env', 'staging'], { runner: noCloudflareAccess }),
      ).resolves.toMatchObject({ applied: false })
      await expect(
        bootstrap(['--env', 'staging', '--dry-run'], {
          assertAccountAccess: noCloudflareAccess,
          assertRequiredSecrets: noCloudflareAccess,
          loadDeploymentPlan: async () => deploymentPlan(),
          now: () => 1_785_560_400_000,
          runner: noCloudflareAccess,
        }),
      ).resolves.toMatchObject({ dryRun: true })

      const calls = []
      await expect(
        deploy(['--env', 'staging', '--dry-run'], {
          environmentVariables: {
            SMOKE_BASE_URL: 'https://simple-inbox-cf-staging-web.test-account.workers.dev',
          },
          loadDeploymentPlan: async () => deploymentPlan(),
          runner(command, arguments_, options) {
            calls.push({ arguments_, command, options })
            return { status: 0, stderr: '', stdout: '' }
          },
        }),
      ).resolves.toMatchObject({ dryRun: true })
      expect(calls).toHaveLength(deploymentCommands('staging').length)
      expect(calls.every((call) => call.options.dryRun === true)).toBe(true)
    } finally {
      output.mockRestore()
    }
  })

  it('creates a digest-only token, lists metadata only, and owner-scopes revocation', async () => {
    const writes = []
    const output = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => (writes.push(String(chunk)), true))
    const sqlCommands = []
    const now = 1_785_560_400_000
    const digest = createHmac('sha256', pepper).update(plaintextToken).digest('hex')
    const tokenId = deterministicUuidV7(`api-token:${digest}`)
    const runner = vi.fn((_command, arguments_) => {
      const sql = arguments_[arguments_.indexOf('--command') + 1]
      sqlCommands.push(sql)
      if (sql.includes('INSERT INTO api_tokens')) {
        return d1Rows({
          createdAt: now,
          expiresAt: null,
          id: tokenId,
          lastUsedAt: null,
          name: 'ci replacement',
          revokedAt: null,
          scopes: 3,
          tokenDigest: digest,
        })
      }
      if (sql.includes('UPDATE api_tokens')) {
        return d1Rows({
          createdAt: now,
          expiresAt: null,
          id: tokenId,
          lastUsedAt: null,
          name: 'ci replacement',
          revokedAt: now,
          scopes: 3,
          tokenDigest: digest,
        })
      }
      return d1Rows({
        createdAt: now,
        expiresAt: null,
        id: tokenId,
        lastUsedAt: null,
        name: 'ci replacement',
        plaintext: plaintextToken,
        revokedAt: null,
        scopes: 3,
        tokenDigest: digest,
      })
    })
    const options = {
      assertAccountAccess: async () => undefined,
      assertRequiredSecrets: async () => undefined,
      environmentVariables: { CLOUDFLARE_INBOX_AUTH_TOKEN_PEPPER: pepper },
      generatePlaintextToken: () => plaintextToken,
      loadDeploymentPlan: async () => deploymentPlan(),
      now: () => now,
      runner,
    }

    try {
      const created = await apiToken(
        [
          'create',
          '--env',
          'staging',
          '--owner-email',
          ownerEmail,
          '--name',
          'ci replacement',
          '--scope',
          'read',
          '--scope',
          'send',
        ],
        options,
      )
      expect(created).toEqual({
        createdAt: now,
        expiresAt: null,
        id: tokenId,
        lastUsedAt: null,
        name: 'ci replacement',
        revokedAt: null,
        scopes: ['read', 'send'],
      })
      expect(sqlCommands[0]).toContain(digest)
      expect(sqlCommands[0]).not.toContain(plaintextToken)
      expect(writes.join('').match(new RegExp(plaintextToken, 'gu'))).toHaveLength(1)

      writes.length = 0
      const listed = await apiToken(
        ['list', '--env', 'staging', '--owner-email', ownerEmail],
        options,
      )
      expect(listed).toEqual([created])
      expect(writes.join('')).not.toContain(plaintextToken)
      expect(writes.join('')).not.toContain(digest)

      writes.length = 0
      const revoked = await apiToken(
        [
          'revoke',
          '--env',
          'staging',
          '--owner-email',
          ownerEmail,
          '--token-id',
          tokenId,
          '--confirm-revoke',
        ],
        options,
      )
      expect(revoked.revokedAt).toBe(now)
      expect(sqlCommands.at(-1)).toContain(`WHERE id = '${tokenId}'`)
      expect(sqlCommands.at(-1)).toContain(`email = '${ownerEmail}'`)
      expect(writes.join('')).not.toContain(plaintextToken)
      expect(writes.join('')).not.toContain(digest)
    } finally {
      output.mockRestore()
    }
  })

  it('orders checks before migration, deploys mail before API before web, then smokes', () => {
    const commands = deploymentCommands('staging')
    const rendered = commands.map(({ arguments_, command }) => [command, ...arguments_].join(' '))
    const find = (fragment) => rendered.findIndex((line) => line.includes(fragment))
    const environmentBuilds = commands.filter(({ phase }) => phase === 'environment-build')
    const deploys = commands.filter(
      ({ arguments_, command }) => command === 'wrangler' && arguments_[0] === 'deploy',
    )
    const migration = commands.find(({ arguments_ }) => arguments_[0] === 'd1')

    expect(environmentBuilds).toHaveLength(3)
    expect(
      environmentBuilds.every(
        (command) =>
          command.command === 'vp' &&
          command.arguments_.join(' ') === 'build' &&
          command.environmentVariables.CLOUDFLARE_ENV === 'staging',
      ),
    ).toBe(true)
    expect(deploys.map(({ arguments_ }) => arguments_)).toEqual([
      ['deploy'],
      ['deploy'],
      ['deploy'],
    ])
    expect(migration.arguments_).toEqual(
      expect.arrayContaining(['--env', 'staging', '--remote', '--yes']),
    )
    expect(find('check:generated')).toBeLessThan(find('d1 migrations apply'))
    expect(find('test:e2e')).toBeLessThan(find('d1 migrations apply'))
    expect(find('d1 migrations apply')).toBeLessThan(find('bootstrap.mjs'))
    expect(find('bootstrap.mjs')).toBeLessThan(
      commands.findIndex(
        ({ arguments_, command, cwd }) =>
          command === 'wrangler' && arguments_[0] === 'deploy' && cwd.endsWith('/workers/mail'),
      ),
    )
    expect(deploys[0].cwd).toMatch(/workers\/mail$/u)
    expect(deploys[1].cwd).toMatch(/workers\/api$/u)
    expect(deploys[2].cwd).toMatch(/apps\/web$/u)
    expect(commands.indexOf(deploys[2])).toBeLessThan(find('smoke.mjs'))
    expect(deploys.flatMap(({ arguments_ }) => arguments_)).not.toContain('--env')
    expect(deploys.flatMap(({ arguments_ }) => arguments_)).not.toContain('--config')
    expect(rendered.join(' ')).not.toMatch(/(?:route|custom-domain|dns|email.routing)/iu)
  })

  it('requires an explicit replacement workers.dev smoke origin and rejects legacy hosts', () => {
    const plan = deploymentPlan()
    const expected = plan.appOrigin
    expect(() => requireReplacementSmokeOrigin(plan, undefined, {})).toThrow(
      /APP_ORIGIN is never probed implicitly/u,
    )
    expect(() => requireReplacementSmokeOrigin(plan, 'https://legacy.example.com', {})).toThrow(
      /must target simple-inbox-cf-staging-web/u,
    )
    expect(() =>
      requireReplacementSmokeOrigin(plan, expected, {
        CLOUDFLARE_INBOX_LEGACY_HOSTS: new URL(expected).hostname,
      }),
    ).toThrow(/declared legacy host/u)
    expect(() =>
      requireReplacementSmokeOrigin(
        { ...plan, appOrigin: 'https://inbox.replacement.invalid' },
        expected,
        {},
      ),
    ).toThrow(/APP_ORIGIN must exactly match SMOKE_BASE_URL/u)
    expect(requireReplacementSmokeOrigin(plan, undefined, { SMOKE_BASE_URL: expected })).toBe(
      expected,
    )
  })

  it('fails bootstrap closed on deterministic-ID collisions and an existing different owner', () => {
    const mailboxAddress = 'inbox@replacement.invalid'
    const ids = {
      mailbox: deterministicUuidV7(`mailbox:${mailboxAddress}`),
      user: deterministicUuidV7(`user:${ownerEmail}`),
    }
    const sql = bootstrapSql({ ids, mailboxAddress, ownerEmail, timestamp: 1_785_560_400_000 })
    expect(sql).not.toMatch(/\b(?:BEGIN|COMMIT)\b/u)

    const idCollision = bootstrapDatabase()
    idCollision
      .prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)')
      .run('00000000-0000-7000-8000-000000000001', ownerEmail, 1)
    expect(() => idCollision.exec(sql)).toThrow(/CHECK constraint failed/u)
    expect(idCollision.prepare('SELECT count(*) AS count FROM mailboxes').get().count).toBe(0)
    idCollision.close()

    const ownerCollision = bootstrapDatabase()
    const otherUser = '00000000-0000-7000-8000-000000000002'
    ownerCollision
      .prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)')
      .run(otherUser, 'other@replacement.invalid', 1)
    ownerCollision
      .prepare(
        'INSERT INTO mailboxes (id, address, forward_to, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(ids.mailbox, mailboxAddress, ownerEmail, 1, 1)
    ownerCollision
      .prepare(
        "INSERT INTO mailbox_members (mailbox_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
      )
      .run(ids.mailbox, otherUser, 1)
    expect(() => ownerCollision.exec(sql)).toThrow(/CHECK constraint failed/u)
    expect(
      ownerCollision.prepare('SELECT count(*) AS count FROM users WHERE id = ?').get(ids.user)
        .count,
    ).toBe(0)
    ownerCollision.close()

    expect(() =>
      assertBootstrapVerification(
        d1Rows({
          addressMailboxes: 1,
          desiredOwners: 1,
          emailUsers: 1,
          exactMailboxes: 1,
          exactUsers: 1,
          totalOwners: 2,
        }).stdout,
      ),
    ).toThrow(/exactly one total owner/u)
  })

  it('executes idempotent and collision-safe bootstrap SQL through pinned Wrangler local D1', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cloudflare-inbox-bootstrap-d1-test-'))
    const configPath = join(directory, 'wrangler.jsonc')
    const schemaPath = join(directory, 'schema.sql')
    const bootstrapPath = join(directory, 'bootstrap.sql')
    const persistencePath = join(directory, 'state')
    const logPath = join(directory, 'wrangler.log')
    const mailboxAddress = 'inbox@replacement.invalid'
    const ids = {
      mailbox: deterministicUuidV7(`mailbox:${mailboxAddress}`),
      user: deterministicUuidV7(`user:${ownerEmail}`),
    }
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          compatibility_date: '2026-08-01',
          d1_databases: [
            {
              binding: 'DB',
              database_id: databaseId,
              database_name: 'bootstrap-local-test',
            },
          ],
          main: 'index.js',
          name: 'bootstrap-local-test',
        }),
      )
      await writeFile(join(directory, 'index.js'), 'export default {}\n')
      await writeFile(schemaPath, bootstrapSchemaSql())
      await writeFile(
        bootstrapPath,
        bootstrapSql({ ids, mailboxAddress, ownerEmail, timestamp: 1_785_560_400_000 }),
      )
      const runD1 = (arguments_) =>
        execFileSync(
          resolve(process.cwd(), 'node_modules/.bin/wrangler'),
          [
            'd1',
            'execute',
            'DB',
            '--config',
            configPath,
            '--local',
            '--persist-to',
            persistencePath,
            '--yes',
            ...arguments_,
          ],
          {
            cwd: directory,
            encoding: 'utf8',
            env: { ...process.env, WRANGLER_LOG_PATH: logPath },
          },
        )

      runD1(['--file', schemaPath])
      runD1([
        '--command',
        `INSERT INTO users (id, email, created_at) VALUES ('00000000-0000-7000-8000-000000000001', '${ownerEmail}', 1)`,
      ])
      expect(() => runD1(['--file', bootstrapPath])).toThrow()
      const afterCollision = runD1([
        '--command',
        "SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM mailboxes) AS mailboxes, (SELECT count(*) FROM sqlite_master WHERE name = '__cloudflare_inbox_bootstrap_guard') AS guards",
        '--json',
      ])
      expect(d1ResultRow(afterCollision)).toMatchObject({ guards: 0, mailboxes: 0, users: 1 })

      runD1(['--command', 'DELETE FROM users'])
      runD1(['--file', bootstrapPath])
      runD1(['--file', bootstrapPath])
      const verified = runD1([
        '--command',
        `SELECT (SELECT count(*) FROM users WHERE id = '${ids.user}' AND email = '${ownerEmail}') AS exactUsers, (SELECT count(*) FROM users WHERE email = '${ownerEmail}') AS emailUsers, (SELECT count(*) FROM mailboxes WHERE id = '${ids.mailbox}' AND address = '${mailboxAddress}') AS exactMailboxes, (SELECT count(*) FROM mailboxes WHERE address = '${mailboxAddress}') AS addressMailboxes, (SELECT count(*) FROM mailbox_members WHERE mailbox_id = '${ids.mailbox}' AND user_id = '${ids.user}' AND role = 'owner') AS desiredOwners, (SELECT count(*) FROM mailbox_members WHERE mailbox_id = '${ids.mailbox}' AND role = 'owner') AS totalOwners`,
        '--json',
      ])
      expect(() => assertBootstrapVerification(verified)).not.toThrow()
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  }, 60_000)

  it('accepts only the environment-flattened Vite output and its deployment redirect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cloudflare-inbox-deploy-build-test-'))
    const plan = deploymentPlan()
    const packageRoot = join(directory, 'workers/api')
    const configPath = join(
      packageRoot,
      'dist',
      plan.names.api.replaceAll('-', '_'),
      'wrangler.json',
    )
    const redirectPath = join(packageRoot, '.wrangler/deploy/config.json')
    const config = {
      d1_databases: [
        {
          binding: 'DB',
          database_id: plan.databaseId,
          database_name: plan.databaseName,
        },
      ],
      main: 'index.js',
      name: plan.names.api,
      observability: plan.observability.api,
      r2_buckets: [{ binding: 'RAW_EMAILS', bucket_name: plan.rawBucket }],
      ratelimits: [plan.rateLimit],
      send_email: [],
      services: [{ binding: 'MAIL', service: plan.names.mail }],
      vars: plan.vars.api,
      workers_dev: false,
    }
    try {
      await mkdir(dirname(configPath), { recursive: true })
      await mkdir(dirname(redirectPath), { recursive: true })
      await writeFile(join(dirname(configPath), 'index.js'), 'export default {}\n')
      await writeFile(configPath, JSON.stringify(config))
      await writeFile(
        redirectPath,
        JSON.stringify({
          auxiliaryWorkers: [],
          configPath: `../../dist/${plan.names.api.replaceAll('-', '_')}/wrangler.json`,
        }),
      )

      await expect(findFlattenedWorkerConfig(plan, 'api', { root: directory })).resolves.toBe(
        configPath,
      )
      await expect(assertFlattenedWorkerBuild(configPath, plan, 'api')).resolves.toMatchObject({
        name: plan.names.api,
      })
      await expect(assertDeploymentRedirect(configPath, 'api', { root: directory })).resolves.toBe(
        redirectPath,
      )

      await writeFile(
        configPath,
        JSON.stringify({
          ...config,
          services: [{ binding: 'MAIL', service: 'simple-inbox-cf-local-mail' }],
        }),
      )
      await expect(assertFlattenedWorkerBuild(configPath, plan, 'api')).rejects.toThrow(
        /do not match the reviewed deployment plan/u,
      )
      await writeFile(configPath, JSON.stringify({ ...config, name: 'simple-inbox-cf-local-api' }))
      await expect(findFlattenedWorkerConfig(plan, 'api', { root: directory })).rejects.toThrow(
        /CLOUDFLARE_ENV=staging/u,
      )
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('detects stale output across every generated artifact class without changing the source', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cloudflare-inbox-generated-test-'))
    const source = join(directory, 'source')
    const generated = join(directory, 'generated')
    const fixtures = [
      'apps/web/src/routeTree.gen.ts',
      'apps/web/worker-configuration.d.ts',
      'workers/api/worker-configuration.d.ts',
      'workers/mail/worker-configuration.d.ts',
      'workers/api/openapi.json',
      'packages/db/migrations/0000_initial.sql',
      'packages/db/migrations/meta/0000_snapshot.json',
      'packages/db/migrations/meta/_journal.json',
    ]
    try {
      for (const path of fixtures) {
        const target = join(source, path)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, `current:${path}\n`)
      }
      await cp(source, generated, { recursive: true })
      for (const path of fixtures) await writeFile(join(generated, path), `fresh:${path}\n`)
      await writeFile(join(generated, 'packages/db/migrations/0001_next.sql'), 'fresh migration\n')
      await writeFile(
        join(generated, 'packages/db/migrations/meta/0001_snapshot.json'),
        '{"fresh":true}\n',
      )

      const differences = await compareGeneratedArtifacts(source, generated)
      expect(differences).toEqual(
        expect.arrayContaining([
          expect.stringContaining('TanStack route tree'),
          expect.stringContaining('web Cloudflare binding types'),
          expect.stringContaining('API Cloudflare binding types'),
          expect.stringContaining('mail Cloudflare binding types'),
          expect.stringContaining('API OpenAPI document'),
          expect.stringContaining('packages/db/migrations/0000_initial.sql'),
          expect.stringContaining('packages/db/migrations/0001_next.sql'),
          expect.stringContaining('packages/db/migrations/meta/0000_snapshot.json'),
          expect.stringContaining('packages/db/migrations/meta/0001_snapshot.json'),
          expect.stringContaining('packages/db/migrations/meta/_journal.json'),
        ]),
      )
      await expect(readFile(join(source, fixtures[0]), 'utf8')).resolves.toBe(
        `current:${fixtures[0]}\n`,
      )
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})

function d1Rows(row) {
  return { status: 0, stderr: '', stdout: JSON.stringify([{ results: [row] }]) }
}

function bootstrapDatabase() {
  const database = new DatabaseSync(':memory:')
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY NOT NULL,
      email TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      disabled_at INTEGER
    );
    CREATE TABLE mailboxes (
      id TEXT PRIMARY KEY NOT NULL,
      address TEXT NOT NULL UNIQUE,
      sender_alias TEXT,
      forward_to TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE mailbox_members (
      mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (mailbox_id, user_id)
    );
  `)
  return database
}

function bootstrapSchemaSql() {
  return `
    CREATE TABLE users (
      id TEXT PRIMARY KEY NOT NULL,
      email TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      disabled_at INTEGER
    );
    CREATE TABLE mailboxes (
      id TEXT PRIMARY KEY NOT NULL,
      address TEXT NOT NULL UNIQUE,
      sender_alias TEXT,
      forward_to TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE mailbox_members (
      mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (mailbox_id, user_id)
    );
  `
}

function d1ResultRow(source) {
  const parsed = JSON.parse(source)
  return parsed.find((entry) => Array.isArray(entry.results))?.results?.[0]
}
