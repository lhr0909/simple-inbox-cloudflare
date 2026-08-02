import { setResponseHeader } from '@tanstack/react-start/server'

import { readInstallationStatus } from '#/internal-services.server'

export async function readSetupState(): Promise<'complete' | 'required'> {
  setResponseHeader('cache-control', 'private, no-store')
  const status = await readInstallationStatus()
  if (status.status === 'inconsistent') {
    throw new Error('Installation state is incomplete. Restore D1 from a known-good backup.')
  }
  return status.status
}
