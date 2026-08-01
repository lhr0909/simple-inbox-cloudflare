import { createFileRoute, redirect } from '@tanstack/react-router'

import { getServerAuthState } from '#/features/inbox/inbox-server'

export const Route = createFileRoute('/')({
  loader: async () => {
    const authenticated = await getServerAuthState()
    throw redirect({
      to: authenticated ? '/inbox' : '/sign-in',
      replace: true,
    })
  },
  component: HomeRedirect,
  head: () => ({ meta: [{ title: 'Cloudflare Inbox' }] }),
})

function HomeRedirect() {
  return null
}
