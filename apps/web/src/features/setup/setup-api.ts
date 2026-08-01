import { CompleteSetupRequestSchema, SetupStatusResponseSchema } from '@cloudflare-inbox/contracts'
import type { CompleteSetupRequest, SetupStatusResponse } from '@cloudflare-inbox/contracts'

export class SetupRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'SetupRequestError'
    this.status = status
  }
}

export async function completeSetup(input: CompleteSetupRequest): Promise<SetupStatusResponse> {
  const body = CompleteSetupRequestSchema.parse(input)
  const response = await fetch('/api/v1/setup', {
    body: JSON.stringify(body),
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    method: 'POST',
  })
  if (!response.ok) {
    let message = 'Setup could not be completed.'
    try {
      const envelope = (await response.json()) as { error?: { message?: string } }
      message = envelope.error?.message ?? message
    } catch {
      // A platform failure may intentionally return an empty representation.
    }
    throw new SetupRequestError(response.status, message)
  }
  return SetupStatusResponseSchema.parse(await response.json())
}
