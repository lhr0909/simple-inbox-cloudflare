import { OpenAPIHono } from '@hono/zod-openapi'
import { describe, expect, it } from 'vitest'

import { INTERNAL_MAIL_ROUTES, PUBLIC_API_ROUTES } from '../src/routes'

describe('OpenAPI route registry', () => {
  it('has unique public method/path and operation IDs', () => {
    const endpoints = PUBLIC_API_ROUTES.map((route) => `${route.method}:${route.path}`)
    const operationIds = PUBLIC_API_ROUTES.map((route) => route.operationId)

    expect(new Set(endpoints).size).toBe(endpoints.length)
    expect(new Set(operationIds).size).toBe(operationIds.length)
    expect(
      PUBLIC_API_ROUTES.every((route) => route.path === '/health' || route.path.startsWith('/v1/')),
    ).toBe(true)
  })

  it('keeps the mail contract under the internal namespace', () => {
    expect(INTERNAL_MAIL_ROUTES.every((route) => route.path.startsWith('/internal/'))).toBe(true)

    const app = new OpenAPIHono()
    const contractOnlyHandler = () => new Response(null, { status: 204 })
    for (const route of INTERNAL_MAIL_ROUTES) {
      app.openapi(route as never, contractOnlyHandler as never)
    }
    const document = app.getOpenAPIDocument({
      openapi: '3.1.0',
      info: { title: 'Synthetic internal contract', version: 'v1' },
    })
    const serialized = JSON.stringify(document)
    expect(document.paths['/internal/v1/send']).toHaveProperty('post')
    expect(serialized).toContain('InternalSendForm')
    expect(serialized).toContain('binary')
  })

  it('generates an OpenAPI document from the registered schemas', () => {
    const app = new OpenAPIHono()
    const contractOnlyHandler = () => new Response(null, { status: 204 })

    for (const route of PUBLIC_API_ROUTES) {
      app.openapi(route as never, contractOnlyHandler as never)
    }

    const document = app.getOpenAPIDocument({
      openapi: '3.1.0',
      info: { title: 'Synthetic contract', version: 'v1' },
    })
    const expectedPaths = new Set(PUBLIC_API_ROUTES.map((route) => route.path))

    expect(Object.keys(document.paths)).toHaveLength(expectedPaths.size)
    expect(document.paths['/v1/threads']).toHaveProperty('get')
    expect(document.paths['/v1/messages']).toHaveProperty('post')
    expect(document.paths['/v1/messages']?.post?.responses).toHaveProperty('502')
    expect(document.paths['/v1/threads/{threadId}/messages']?.post?.responses).toHaveProperty('502')
    expect(document.paths['/v1/auth/session']?.get?.responses).toHaveProperty('503')
    expect(document.paths['/v1/mailboxes']?.get?.responses).toHaveProperty('503')

    const serialized = JSON.stringify(document)
    expect(serialized).toContain('idempotency-key')
    expect(serialized).toContain('multipart/form-data')
    expect(serialized).toContain('binary')
  })
})
