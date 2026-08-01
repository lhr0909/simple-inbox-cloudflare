export type MailCoreErrorCode =
  | 'invalid_address'
  | 'invalid_header'
  | 'invalid_idempotency_input'
  | 'invalid_message_id'
  | 'invalid_storage_key_input'
  | 'limit_exceeded'
  | 'missing_crypto'

export class MailCoreError extends Error {
  readonly code: MailCoreErrorCode

  constructor(code: MailCoreErrorCode, message: string) {
    super(message)
    this.name = 'MailCoreError'
    this.code = code
  }
}
