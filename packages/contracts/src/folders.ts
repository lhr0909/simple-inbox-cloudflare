import { z } from '@hono/zod-openapi'

import { NonNegativeIntegerSchema } from './primitives'

export const THREAD_FOLDERS = [
  'inbox',
  'starred',
  'sent',
  'all',
  'spam',
  'trash',
  'archive',
] as const
export const ThreadFolderSchema = z.enum(THREAD_FOLDERS).openapi('ThreadFolder')
export type ThreadFolder = z.infer<typeof ThreadFolderSchema>

export const ThreadFolderCountsSchema = z
  .object({
    all: NonNegativeIntegerSchema,
    unread: NonNegativeIntegerSchema,
    inbox: NonNegativeIntegerSchema,
    starred: NonNegativeIntegerSchema,
    spam: NonNegativeIntegerSchema,
    trash: NonNegativeIntegerSchema,
    sent: NonNegativeIntegerSchema,
    archive: NonNegativeIntegerSchema,
  })
  .strict()
  .openapi('ThreadFolderCounts')
export type ThreadFolderCounts = z.infer<typeof ThreadFolderCountsSchema>
