import { createFileRoute, redirect } from '@tanstack/react-router'

import { getServerAuthState } from '#/features/inbox/inbox-server'
import { getSetupState } from '#/features/setup/setup-server'
import { SetupWizard } from '#/features/setup/setup-wizard'

export const Route = createFileRoute('/setup')({
  loader: async () => {
    if ((await getSetupState()) === 'required') return
    if (await getServerAuthState()) {
      throw redirect({ to: '/inbox', search: { folder: 'all' }, replace: true })
    }
    throw redirect({ to: '/sign-in', replace: true })
  },
  component: SetupWizard,
  head: () => ({ meta: [{ title: 'Set up · Simple Inbox' }] }),
})
