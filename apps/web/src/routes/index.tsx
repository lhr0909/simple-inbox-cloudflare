import { createFileRoute, redirect } from '@tanstack/react-router'

import { getServerAuthState } from '#/features/inbox/inbox-server'
import { getSetupState } from '#/features/setup/setup-server'

export const Route = createFileRoute('/')({
  loader: async () => {
    if ((await getSetupState()) === 'required') {
      throw redirect({ to: '/setup', replace: true })
    }
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
