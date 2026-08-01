export function logEvent(
  level: 'error' | 'info' | 'warn',
  event: string,
  context: {
    environment: string
    outcome: string
    requestId?: string | undefined
  },
  fields: Record<string, boolean | number | string | null | undefined> = {},
): void {
  const safeFields = Object.fromEntries(
    Object.entries(fields).filter(
      (entry): entry is [string, boolean | number | string | null] => entry[1] !== undefined,
    ),
  )
  const line = JSON.stringify({
    ...safeFields,
    environment: context.environment,
    event,
    level,
    outcome: context.outcome,
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
    service: 'mail',
    timestamp: new Date().toISOString(),
  })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.info(line)
}
