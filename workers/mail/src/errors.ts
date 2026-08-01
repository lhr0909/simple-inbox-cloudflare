import type { ApiErrorCode } from '@cloudflare-inbox/contracts'

export class MailFault extends Error {
  readonly code: ApiErrorCode
  readonly details:
    | Record<string, boolean | number | string | null | Array<boolean | number | string | null>>
    | undefined
  readonly status: number

  constructor(
    code: ApiErrorCode,
    status: number,
    options: {
      cause?: unknown
      details?: MailFault['details']
      message?: string
    } = {},
  ) {
    super(options.message ?? code, { cause: options.cause })
    this.name = 'MailFault'
    this.code = code
    this.status = status
    this.details = options.details
  }
}

export function safeProviderErrorCode(error: unknown, fallback: string): string {
  if (error instanceof MailFault) return error.code.slice(0, 128)
  if (error instanceof DOMException && error.name) {
    return normalizeSafeCode(error.name, fallback)
  }
  if (error instanceof Error && error.name && error.name !== 'Error') {
    return normalizeSafeCode(error.name, fallback)
  }
  return fallback
}

function normalizeSafeCode(input: string, fallback: string): string {
  const code = input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 128)
  return code || fallback
}
