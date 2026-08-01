import { z } from '@hono/zod-openapi'

import { type ThreadFolder, ThreadFolderSchema } from './folders'
import { type Cursor, CursorSchema, type MailboxId, MailboxIdSchema, ThreadIdSchema } from './ids'

export const MAX_THREAD_PAGE_SIZE = 50
export const DEFAULT_THREAD_PAGE_SIZE = 25

export const SearchQuerySchema = z.string().trim().min(1).max(200)

const PageSizeQuerySchema = z
  .string()
  .regex(/^(?:[1-9]|[1-4][0-9]|50)$/, 'Page size must be between 1 and 50')

export const ThreadListQuerySchema = z
  .object({
    mailboxId: MailboxIdSchema,
    folder: ThreadFolderSchema.optional(),
    unread: z.enum(['0', '1']).optional(),
    q: SearchQuerySchema.optional(),
    cursor: CursorSchema.optional(),
    limit: PageSizeQuerySchema.optional(),
  })
  .strict()
  .openapi('ThreadListQuery')
export type ThreadListQuery = z.infer<typeof ThreadListQuerySchema>

export type NormalizedThreadListQuery = Readonly<{
  mailboxId: MailboxId
  folder: ThreadFolder
  unreadOnly: boolean
  search?: string
  cursor?: Cursor
  limit: number
}>

export function normalizeThreadListQuery(input: unknown): NormalizedThreadListQuery {
  const query = ThreadListQuerySchema.parse(input)
  const common = {
    mailboxId: query.mailboxId,
    folder: query.folder ?? 'all',
    unreadOnly: query.unread === '1',
    limit: query.limit === undefined ? DEFAULT_THREAD_PAGE_SIZE : Number.parseInt(query.limit, 10),
  } satisfies Omit<NormalizedThreadListQuery, 'search' | 'cursor'>

  return {
    ...common,
    ...(query.q === undefined ? {} : { search: query.q }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  }
}

export const InboxSearchParamsSchema = z
  .object({
    mailbox: MailboxIdSchema.optional(),
    folder: ThreadFolderSchema.optional(),
    unread: z.literal('1').optional(),
    q: SearchQuerySchema.optional(),
    thread: ThreadIdSchema.optional(),
  })
  .strict()
  .openapi('InboxSearchParams')
export type InboxSearchParams = z.infer<typeof InboxSearchParamsSchema>
