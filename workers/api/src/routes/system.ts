import {
  CapabilitiesResponseSchema,
  getCapabilitiesRoute,
  getOpenApiRoute,
  healthRoute,
} from '@cloudflare-inbox/contracts'
import type { OpenAPIHono } from '@hono/zod-openapi'

import type { ApiEnv } from '../types'

export const OPENAPI_CONFIGURATION = {
  info: {
    description: 'Cloudflare Inbox public API. Internal Worker topology is intentionally omitted.',
    title: 'Cloudflare Inbox API',
    version: '1.0.0',
  },
  openapi: '3.1.0',
} as const

export function registerSystemRoutes(app: OpenAPIHono<ApiEnv>): void {
  app.openapi(healthRoute, (context) => context.json({ ok: true, service: 'api' }, 200))

  app.openapi(getCapabilitiesRoute, (context) => {
    const body = CapabilitiesResponseSchema.parse({
      ai: false,
      apiVersion: 'v1',
      publicApiTokens: true,
      queues: false,
      sanitizedHtml: false,
      turnstile: false,
    })
    return context.json(body, 200)
  })

  app.openapi(getOpenApiRoute, (context) => {
    const document = app.getOpenAPI31Document(OPENAPI_CONFIGURATION)
    return context.json(document, 200)
  })
}
