import { createServerFn } from '@tanstack/react-start'

import { MagicLinkVerifyRequestSchema } from '@cloudflare-inbox/contracts/auth'

import { parseInboxSearch } from './inbox-search'
import type { InboxSearch } from './inbox-search'
import type { InboxData } from './inbox-types'

export type InboxServerResult =
  | Readonly<{ status: 'anonymous' }>
  | Readonly<{
      status: 'ready'
      data: InboxData
      effectiveMailboxId: string
      search: InboxSearch
    }>

export const getServerAuthState = createServerFn({ method: 'GET' }).handler(async () => {
  const { readServerAuthState } = await import('./inbox-server-impl.server')
  return readServerAuthState()
})

export const verifyMagicLinkServer = createServerFn({ method: 'POST' })
  .validator((input: unknown) => MagicLinkVerifyRequestSchema.parse(input))
  .handler(async ({ data }) => {
    const { consumeMagicLink } = await import('./inbox-server-impl.server')
    return consumeMagicLink(data)
  })

export const loadInboxServer = createServerFn({ method: 'GET' })
  .validator((input: unknown) => parseInboxSearch(input))
  .handler(async ({ data }) => {
    const { loadProtectedInbox } = await import('./inbox-server-impl.server')
    return loadProtectedInbox(data)
  })
