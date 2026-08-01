import { describe, expect, it } from 'vitest'
import { basename } from 'node:path'

import { bootstrapSql, deterministicUuidV7 } from '../../tooling/scripts/bootstrap.mjs'
import { deploymentCommands } from '../../tooling/scripts/deploy.mjs'
import { validateEvidence } from '../../tooling/scripts/live-smoke.mjs'
import {
  removeTrailingCommas,
  replacementResourceNames,
  stripJsonComments,
} from '../../tooling/scripts/operator-lib.mjs'
import { runHttpSmoke } from '../../tooling/scripts/smoke.mjs'

describe('operator safety and deterministic commands', () => {
  it('uses replacement-only names and never includes a cutover command', () => {
    expect(replacementResourceNames('staging')).toEqual({
      api: 'cloudflare-inbox-replacement-staging-api',
      database: 'cloudflare-inbox-replacement-staging-db',
      mail: 'cloudflare-inbox-replacement-staging-mail',
      rawBucket: 'cloudflare-inbox-replacement-staging-raw',
      web: 'cloudflare-inbox-replacement-staging-web',
    })
    const commands = deploymentCommands('staging')
    const rendered = commands.flatMap((entry) => [entry.command, ...entry.arguments_]).join(' ')
    expect(rendered).not.toMatch(/(?:route|domain|dns|email.routing)/iu)
    const deploys = commands.filter(
      (entry) =>
        entry.phase === 'mutate' &&
        entry.command === 'wrangler' &&
        entry.arguments_[0] === 'deploy',
    )
    expect(deploys.map((entry) => basename(entry.cwd))).toEqual(['mail', 'api', 'web'])
    for (const deploy of deploys) {
      expect(deploy).toEqual(
        expect.objectContaining({
          arguments_: ['deploy'],
          phase: 'mutate',
          unsetEnvironmentVariables: ['CLOUDFLARE_ENV'],
        }),
      )
    }
  })

  it('parses comments and trailing commas without changing string content', () => {
    const input = `{
      // line comment
      "url": "https://example.test/a,//b",
      "nested": { "enabled": true, },
      /* block comment */
    }`
    expect(JSON.parse(removeTrailingCommas(stripJsonComments(input)))).toEqual({
      nested: { enabled: true },
      url: 'https://example.test/a,//b',
    })
  })

  it('generates repeatable UUIDv7-shaped bootstrap IDs and idempotent SQL', () => {
    const id = deterministicUuidV7('user:owner@example.test')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u)
    expect(deterministicUuidV7('user:owner@example.test')).toBe(id)
    const sql = bootstrapSql({
      ids: { mailbox: deterministicUuidV7('mailbox:inbox@example.test'), user: id },
      mailboxAddress: 'inbox@example.test',
      ownerEmail: "owner.o'connor@example.test",
      timestamp: 1_785_560_400_000,
    })
    expect(sql).toContain('CREATE TABLE __cloudflare_inbox_bootstrap_guard')
    expect(sql.match(/INSERT INTO __cloudflare_inbox_bootstrap_guard/gu)).toHaveLength(2)
    expect(sql).toContain('INSERT OR IGNORE')
    expect(sql).toContain("owner.o''connor@example.test")
    expect(sql).toContain('DROP TABLE __cloudflare_inbox_bootstrap_guard')
    expect(sql).not.toMatch(/\b(?:BEGIN|COMMIT)\b/u)
  })

  it('runs passive smoke against an injected local-only fetch port', async () => {
    const calls: string[] = []
    const fakeFetch = async (input: URL | RequestInfo) => {
      const url =
        input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url)
      calls.push(url.pathname)
      const api = url.pathname.startsWith('/api/v1/')
      let body: string
      let contentType: string
      if (url.pathname === '/api/v1/health') {
        body = JSON.stringify({ ok: true, service: 'api' })
        contentType = 'application/json'
      } else if (url.pathname === '/api/v1/openapi.json') {
        body = JSON.stringify({ openapi: '3.1.0' })
        contentType = 'application/json'
      } else if (url.pathname.startsWith('/api/')) {
        body = JSON.stringify({ ok: true })
        contentType = 'application/json'
      } else {
        body = '<html><body><main>Replacement</main></body></html>'
        contentType = 'text/html'
      }
      return new Response(body, {
        headers: {
          'content-type': contentType,
          ...(api ? { 'x-request-id': 'replacement_trace_0001' } : {}),
        },
        status: 200,
      })
    }
    await expect(runHttpSmoke('https://replacement.example.test', fakeFetch)).resolves.toHaveLength(
      6,
    )
    expect(calls).toContain('/api/v1/openapi.json')
  })

  it('requires complete owner evidence and an explicit legacy-safety attestation', () => {
    const evidence = {
      binaryAttachmentRoundTrip: true,
      environment: 'staging',
      inboundCaptured: true,
      magicLinkHttps: true,
      noLegacyResourcesTouched: true,
      outboundDelivered: true,
      replyRoundTrip: true,
      requestIds: ['replacement_trace_0001', 'replacement_trace_0002', 'replacement_trace_0003'],
      runId: 'replacement-smoke-1234',
      traceIdChain: true,
    }
    expect(() => validateEvidence(evidence, 'staging')).not.toThrow()
    expect(() =>
      validateEvidence({ ...evidence, noLegacyResourcesTouched: false }, 'staging'),
    ).toThrow(/noLegacyResourcesTouched/u)
  })
})
