import { createServerFn } from '@tanstack/react-start'

export const getSetupState = createServerFn({ method: 'GET' }).handler(async () => {
  const { readSetupState } = await import('./setup-server-impl.server')
  return readSetupState()
})
