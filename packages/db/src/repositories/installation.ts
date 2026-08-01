export interface InstallationSettings {
  applicationRecordRetentionDays: number
  appOrigin: string
  completedAt: number
  mailDomain: string
  mailboxAddress: string
  ownerEmail: string
  rawEmailRetentionDays: number
  retentionBatchSize: number
  setupVersion: 1
}

export type InstallationStatus =
  | { status: 'complete'; settings: InstallationSettings }
  | { status: 'inconsistent' }
  | { status: 'required' }

export interface CompleteInstallationInput {
  applicationRecordRetentionDays: number
  appOrigin: string
  completedAt: number
  mailDomain: string
  mailboxAddress: string
  mailboxId: string
  ownerEmail: string
  rawEmailRetentionDays: number
  retentionBatchSize: number
  userId: string
}

export interface CompleteInstallationResult {
  created: boolean
  settings: InstallationSettings
}

type InstallationRow = {
  applicationRecordRetentionDays: number
  appOrigin: string
  completedAt: number
  mailDomain: string
  mailboxAddress: string | null
  ownerEmail: string | null
  ownerMemberships: number
  rawEmailRetentionDays: number
  retentionBatchSize: number
  setupVersion: number
  totalOwners: number
}

export class InstallationStateError extends Error {
  constructor() {
    super('Installation state is incomplete or inconsistent.')
    this.name = 'InstallationStateError'
  }
}

export class InstallationConflictError extends Error {
  constructor() {
    super('Installation setup was already completed with different settings.')
    this.name = 'InstallationConflictError'
  }
}

export class InstallationRepository {
  readonly #binding: D1Database

  constructor(binding: D1Database) {
    this.#binding = binding
  }

  async getStatus(): Promise<InstallationStatus> {
    const row = await this.#binding
      .prepare(`
        SELECT
          installations.setup_version AS setupVersion,
          installations.app_origin AS appOrigin,
          installations.mail_domain AS mailDomain,
          installations.raw_email_retention_days AS rawEmailRetentionDays,
          installations.application_record_retention_days AS applicationRecordRetentionDays,
          installations.retention_batch_size AS retentionBatchSize,
          installations.completed_at AS completedAt,
          users.email AS ownerEmail,
          mailboxes.address AS mailboxAddress,
          (
            SELECT count(*)
            FROM mailbox_members
            WHERE mailbox_members.mailbox_id = installations.primary_mailbox_id
              AND mailbox_members.user_id = installations.owner_user_id
              AND mailbox_members.role = 'owner'
          ) AS ownerMemberships,
          (
            SELECT count(*)
            FROM mailbox_members
            WHERE mailbox_members.mailbox_id = installations.primary_mailbox_id
              AND mailbox_members.role = 'owner'
          ) AS totalOwners
        FROM installations
        LEFT JOIN users ON users.id = installations.owner_user_id
        LEFT JOIN mailboxes ON mailboxes.id = installations.primary_mailbox_id
        WHERE installations.id = 1
        LIMIT 1
      `)
      .first<InstallationRow>()

    if (row !== null) {
      const settings = parseInstallationRow(row)
      return settings === undefined ? { status: 'inconsistent' } : { settings, status: 'complete' }
    }

    const counts = await this.#binding
      .prepare(`
        SELECT
          (SELECT count(*) FROM users) AS users,
          (SELECT count(*) FROM mailboxes) AS mailboxes,
          (SELECT count(*) FROM mailbox_members) AS memberships
      `)
      .first<{ mailboxes: number; memberships: number; users: number }>()
    if (
      counts !== null &&
      Number(counts.users) === 0 &&
      Number(counts.mailboxes) === 0 &&
      Number(counts.memberships) === 0
    ) {
      return { status: 'required' }
    }
    return { status: 'inconsistent' }
  }

  async requireSettings(): Promise<InstallationSettings> {
    const result = await this.getStatus()
    if (result.status !== 'complete') throw new InstallationStateError()
    return result.settings
  }

  async complete(input: CompleteInstallationInput): Promise<CompleteInstallationResult> {
    validateInput(input)
    const before = await this.getStatus()
    if (before.status === 'inconsistent') throw new InstallationStateError()
    if (before.status === 'complete') {
      if (!sameSettings(before.settings, input)) throw new InstallationConflictError()
      return { created: false, settings: before.settings }
    }

    const installationAbsent = 'NOT EXISTS (SELECT 1 FROM installations WHERE id = 1)'
    await this.#binding.batch([
      this.#binding
        .prepare(`
          INSERT INTO users (id, email, created_at, disabled_at)
          SELECT ?, ?, ?, NULL
          WHERE ${installationAbsent}
          ON CONFLICT(email) DO NOTHING
        `)
        .bind(input.userId, input.ownerEmail, input.completedAt),
      this.#binding
        .prepare(`
          INSERT INTO mailboxes (id, address, sender_alias, forward_to, created_at, updated_at)
          SELECT ?, ?, NULL, ?, ?, ?
          WHERE ${installationAbsent}
          ON CONFLICT(address) DO NOTHING
        `)
        .bind(
          input.mailboxId,
          input.mailboxAddress,
          input.ownerEmail,
          input.completedAt,
          input.completedAt,
        ),
      this.#binding
        .prepare(`
          INSERT INTO mailbox_members (mailbox_id, user_id, role, created_at)
          SELECT mailboxes.id, users.id, 'owner', ?
          FROM users, mailboxes
          WHERE ${installationAbsent}
            AND users.email = ?
            AND mailboxes.address = ?
            AND NOT EXISTS (
              SELECT 1
              FROM mailbox_members AS existing_owner
              WHERE existing_owner.mailbox_id = mailboxes.id
                AND existing_owner.role = 'owner'
                AND existing_owner.user_id <> users.id
            )
          ON CONFLICT(mailbox_id, user_id) DO NOTHING
        `)
        .bind(input.completedAt, input.ownerEmail, input.mailboxAddress),
      this.#binding
        .prepare(`
          INSERT INTO installations (
            id,
            setup_version,
            app_origin,
            mail_domain,
            owner_user_id,
            primary_mailbox_id,
            raw_email_retention_days,
            application_record_retention_days,
            retention_batch_size,
            completed_at
          )
          SELECT 1, 1, ?, ?, users.id, mailboxes.id, ?, ?, ?, ?
          FROM users
          JOIN mailboxes ON mailboxes.address = ?
          JOIN mailbox_members
            ON mailbox_members.mailbox_id = mailboxes.id
           AND mailbox_members.user_id = users.id
           AND mailbox_members.role = 'owner'
          WHERE ${installationAbsent}
            AND users.email = ?
            AND NOT EXISTS (
              SELECT 1
              FROM mailbox_members AS other_owner
              WHERE other_owner.mailbox_id = mailboxes.id
                AND other_owner.role = 'owner'
                AND other_owner.user_id <> users.id
            )
        `)
        .bind(
          input.appOrigin,
          input.mailDomain,
          input.rawEmailRetentionDays,
          input.applicationRecordRetentionDays,
          input.retentionBatchSize,
          input.completedAt,
          input.mailboxAddress,
          input.ownerEmail,
        ),
    ])

    const after = await this.getStatus()
    if (after.status !== 'complete') throw new InstallationStateError()
    if (!sameSettings(after.settings, input)) throw new InstallationConflictError()
    return { created: true, settings: after.settings }
  }
}

function parseInstallationRow(row: InstallationRow): InstallationSettings | undefined {
  if (
    Number(row.setupVersion) !== 1 ||
    row.ownerEmail === null ||
    row.mailboxAddress === null ||
    Number(row.ownerMemberships) !== 1 ||
    Number(row.totalOwners) !== 1
  ) {
    return undefined
  }

  const settings = {
    applicationRecordRetentionDays: Number(row.applicationRecordRetentionDays),
    appOrigin: row.appOrigin,
    completedAt: Number(row.completedAt),
    mailDomain: row.mailDomain,
    mailboxAddress: row.mailboxAddress,
    ownerEmail: row.ownerEmail,
    rawEmailRetentionDays: Number(row.rawEmailRetentionDays),
    retentionBatchSize: Number(row.retentionBatchSize),
    setupVersion: 1 as const,
  }
  try {
    validateSettings(settings)
    return settings
  } catch {
    return undefined
  }
}

function validateInput(input: CompleteInstallationInput): void {
  if (!input.userId || !input.mailboxId) throw new TypeError('Setup IDs are required.')
  validateSettings({ ...input, setupVersion: 1 })
}

function validateSettings(
  input: Omit<InstallationSettings, 'setupVersion'> & { setupVersion: number },
): void {
  if (input.setupVersion !== 1) throw new RangeError('Unsupported installation version.')
  assertOrigin(input.appOrigin)
  assertDomain(input.mailDomain)
  assertNormalizedEmail(input.ownerEmail)
  assertNormalizedEmail(input.mailboxAddress)
  if (input.mailboxAddress.slice(input.mailboxAddress.lastIndexOf('@') + 1) !== input.mailDomain) {
    throw new TypeError('Mailbox address must use the configured mail domain.')
  }
  assertBoundedInteger(input.rawEmailRetentionDays, 1, 3_650, 'Raw email retention')
  assertBoundedInteger(
    input.applicationRecordRetentionDays,
    input.rawEmailRetentionDays,
    3_650,
    'Application record retention',
  )
  assertBoundedInteger(input.retentionBatchSize, 1, 100, 'Retention batch size')
  assertBoundedInteger(input.completedAt, 0, Number.MAX_SAFE_INTEGER, 'Completion time')
}

function sameSettings(
  current: InstallationSettings,
  requested: CompleteInstallationInput,
): boolean {
  return (
    current.applicationRecordRetentionDays === requested.applicationRecordRetentionDays &&
    current.appOrigin === requested.appOrigin &&
    current.mailDomain === requested.mailDomain &&
    current.mailboxAddress === requested.mailboxAddress &&
    current.ownerEmail === requested.ownerEmail &&
    current.rawEmailRetentionDays === requested.rawEmailRetentionDays &&
    current.retentionBatchSize === requested.retentionBatchSize
  )
}

function assertOrigin(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError('Application origin must be a valid URL origin.')
  }
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  ) {
    throw new TypeError('Application origin must be HTTPS, except on local loopback.')
  }
}

function assertDomain(value: string): void {
  if (
    value.length < 1 ||
    value.length > 253 ||
    value !== value.trim() ||
    value !== value.toLowerCase() ||
    value.endsWith('.') ||
    value.includes('..') ||
    !value
      .split('.')
      .every(
        (label) =>
          label.length >= 1 &&
          label.length <= 63 &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
      )
  ) {
    throw new TypeError('Mail domain must be a normalized domain name.')
  }
}

function assertNormalizedEmail(value: string): void {
  if (
    value.length < 3 ||
    value.length > 320 ||
    value !== value.trim() ||
    value !== value.toLowerCase() ||
    !/^\S+@\S+$/u.test(value)
  ) {
    throw new TypeError('Email address must be normalized before setup.')
  }
}

function assertBoundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}.`)
  }
}
