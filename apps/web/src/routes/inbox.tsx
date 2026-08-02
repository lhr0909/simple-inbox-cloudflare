import { createFileRoute, redirect, useRouterState } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { MailboxSettings, PatchMailboxRequest } from '@cloudflare-inbox/contracts/mailboxes'
import type { SendResponse } from '@cloudflare-inbox/contracts/send'

import {
  ApiRequestError,
  listThreadPage,
  markThreadRead,
  sendNewMessage,
  sendReply,
  setThreadArchived,
  signOut,
  updateMailboxSettings,
} from '#/features/inbox/inbox-api'
import { appendThreadPage, applyOptimisticThreadStates } from '#/features/inbox/inbox-model'
import { LatestRequestCoordinator, isAbortError } from '#/features/inbox/inbox-request-coordinator'
import {
  inboxQueryFromSearch,
  inboxListSearchKey,
  inboxSearchKey,
  parseInboxSearch,
  sameInboxSearch,
  updateInboxSearch,
} from '#/features/inbox/inbox-search'
import type { InboxSearch } from '#/features/inbox/inbox-search'
import { loadInboxServer } from '#/features/inbox/inbox-server'
import type { InboxServerResult } from '#/features/inbox/inbox-server'
import { InboxShell } from '#/features/inbox/inbox-shell'
import { getSetupState } from '#/features/setup/setup-server'
import type {
  InboxData,
  InboxQuery,
  NewMessageDraft,
  OptimisticThreadState,
  ReplyDraft,
} from '#/features/inbox/inbox-types'

type ReadyInbox = Extract<InboxServerResult, { status: 'ready' }>

type RefreshedSnapshot = Readonly<{
  data: InboxData
  effectiveMailboxId: string
  listKey: string
  selectionKey: string
}>

export const Route = createFileRoute('/inbox')({
  validateSearch: parseInboxSearch,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }): Promise<ReadyInbox> => {
    if ((await getSetupState()) === 'required') {
      throw redirect({ to: '/setup', replace: true })
    }
    const result = await loadInboxServer({ data: deps })
    if (result.status === 'anonymous') {
      throw redirect({ to: '/sign-in', replace: true })
    }
    if (!sameInboxSearch(deps, result.search)) {
      throw redirect({ to: '/inbox', search: result.search, replace: true })
    }
    return result
  },
  component: Inbox,
  head: () => ({ meta: [{ title: 'Inbox · Simple Inbox' }] }),
})

function Inbox() {
  const loaded = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const routePending = useRouterState({ select: (state) => state.isLoading })
  const reloadInbox = useServerFn(loadInboxServer)
  const [refreshed, setRefreshed] = useState<RefreshedSnapshot | null>(null)
  const [optimistic, setOptimistic] = useState<Readonly<Record<string, OptimisticThreadState>>>({})
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [operationCount, setOperationCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const snapshotRequests = useRef(new LatestRequestCoordinator())
  const pageRequests = useRef(new LatestRequestCoordinator())

  const currentKey = inboxSearchKey(search)
  const currentListKey = inboxListSearchKey(search)
  const activeSearchKey = useRef(currentKey)
  activeSearchKey.current = currentKey
  const source = useMemo(() => {
    if (refreshed?.listKey !== currentListKey) return loaded
    return {
      data: {
        ...refreshed.data,
        selectedThread:
          refreshed.selectionKey === currentKey
            ? refreshed.data.selectedThread
            : loaded.data.selectedThread,
      },
      effectiveMailboxId: refreshed.effectiveMailboxId,
    }
  }, [currentKey, currentListKey, loaded, refreshed])
  const query = inboxQueryFromSearch(search, source.effectiveMailboxId)
  const data = useMemo(
    () =>
      applyOptimisticThreadStates(source.data, optimistic, {
        folder: query.folder,
        unreadOnly: query.unreadOnly,
      }),
    [optimistic, query.folder, query.unreadOnly, source.data],
  )
  const operationPending = operationCount > 0

  useEffect(() => {
    snapshotRequests.current.invalidate()
    pageRequests.current.invalidate()
    setRefreshing(false)
    setLoadingMore(false)
  }, [currentKey])

  useEffect(
    () => () => {
      snapshotRequests.current.invalidate()
      pageRequests.current.invalidate()
    },
    [],
  )

  const fetchSnapshot = useCallback(
    async (targetSearch: InboxSearch, visiblePending: boolean): Promise<boolean> => {
      const targetKey = inboxSearchKey(targetSearch)
      pageRequests.current.invalidate()
      const request = snapshotRequests.current.begin()
      setLoadingMore(false)
      setRefreshing(visiblePending)
      setError(null)
      try {
        const result = await reloadInbox({ data: targetSearch })
        if (!request.isLatest() || activeSearchKey.current !== targetKey) return false
        if (result.status === 'anonymous') {
          window.location.replace('/sign-in')
          return false
        }
        setRefreshed({
          data: result.data,
          effectiveMailboxId: result.effectiveMailboxId,
          listKey: inboxListSearchKey(result.search),
          selectionKey: inboxSearchKey(result.search),
        })
        setOptimistic({})
        return true
      } catch (cause) {
        if (!request.isLatest() || activeSearchKey.current !== targetKey || isAbortError(cause)) {
          return false
        }
        setError('The inbox could not be refreshed. Your current view is still available.')
        return false
      } finally {
        if (visiblePending && request.isLatest()) setRefreshing(false)
      }
    },
    [reloadInbox],
  )

  const navigateSearch = useCallback(
    (nextSearch: InboxSearch, replace = false) => {
      snapshotRequests.current.invalidate()
      pageRequests.current.invalidate()
      setRefreshing(false)
      setLoadingMore(false)
      return navigate({ search: nextSearch, replace, resetScroll: false })
    },
    [navigate],
  )

  const changeQuery = useCallback(
    (update: Partial<InboxQuery>, options?: Readonly<{ replace?: boolean }>) => {
      const nextSearch = updateInboxSearch(search, update)
      return navigateSearch(nextSearch, options?.replace ?? false)
    },
    [navigateSearch, search],
  )

  function setThreadOptimistic(threadId: string, state: OptimisticThreadState | null): void {
    setOptimistic((current) => {
      if (state !== null) return { ...current, [threadId]: state }
      const next = { ...current }
      delete next[threadId]
      return next
    })
  }

  const commitThreadState = useCallback(
    (threadId: string, state: OptimisticThreadState) => {
      setRefreshed((current) => {
        const base = current?.listKey === currentListKey ? current : source
        return {
          data: applyOptimisticThreadStates(base.data, { [threadId]: state }),
          effectiveMailboxId: base.effectiveMailboxId,
          listKey: currentListKey,
          selectionKey: currentKey,
        }
      })
      setThreadOptimistic(threadId, null)
    },
    [currentKey, currentListKey, source],
  )

  function beginOperation(): void {
    setOperationCount((count) => count + 1)
  }

  function finishOperation(): void {
    setOperationCount((count) => Math.max(0, count - 1))
  }

  function redirectIfAnonymous(cause: unknown): boolean {
    if (cause instanceof ApiRequestError && cause.status === 401) {
      window.location.replace('/sign-in')
      return true
    }
    return false
  }

  const attemptedRead = useRef<string | null>(null)
  const selectedThread = data.selectedThread?.thread ?? null

  useEffect(() => {
    if (selectedThread === null) {
      attemptedRead.current = null
      return
    }
    if (selectedThread.unreadCount === 0 || attemptedRead.current === selectedThread.id) return

    const threadId = selectedThread.id
    const readAt = new Date().toISOString()
    attemptedRead.current = threadId
    setThreadOptimistic(threadId, { readAt, unreadCount: 0 })
    void markThreadRead(threadId)
      .then(() => commitThreadState(threadId, { readAt, unreadCount: 0 }))
      .catch((cause: unknown) => {
        setThreadOptimistic(threadId, null)
        if (!redirectIfAnonymous(cause)) {
          setError('The conversation opened, but its read state could not be saved.')
        }
      })
  }, [commitThreadState, selectedThread])

  async function selectThread(threadId: string): Promise<void> {
    setError(null)
    try {
      await navigateSearch(updateInboxSearch(search, { threadId }))
    } catch {
      setError('The conversation could not be opened. The current list is still available.')
    }
  }

  async function archiveThread(threadId: string, archived: boolean): Promise<void> {
    const archivedAt = archived ? new Date().toISOString() : null
    const currentThread =
      data.threads.find((thread) => thread.id === threadId) ??
      (data.selectedThread?.thread.id === threadId ? data.selectedThread.thread : undefined)
    setThreadOptimistic(threadId, {
      archivedAt,
      ...(currentThread === undefined ? {} : { unreadCount: currentThread.unreadCount }),
    })
    beginOperation()
    setError(null)
    try {
      await setThreadArchived(threadId, archived)
      commitThreadState(threadId, {
        archivedAt,
        ...(currentThread === undefined ? {} : { unreadCount: currentThread.unreadCount }),
      })
    } catch (cause) {
      setThreadOptimistic(threadId, null)
      if (!redirectIfAnonymous(cause)) {
        setError(
          archived
            ? 'The conversation could not be archived. The previous state was restored.'
            : 'The conversation could not be restored. The previous state was restored.',
        )
      }
    } finally {
      finishOperation()
    }
  }

  async function reply(threadId: string, draft: ReplyDraft): Promise<SendResponse> {
    beginOperation()
    setError(null)
    try {
      const result = await sendReply(threadId, draft)
      await fetchSnapshot(search, false)
      return result
    } catch (cause) {
      if (redirectIfAnonymous(cause)) throw cause
      setError('The reply was not accepted. Your draft is still available.')
      throw cause
    } finally {
      finishOperation()
    }
  }

  async function compose(mailboxId: string, draft: NewMessageDraft): Promise<SendResponse> {
    beginOperation()
    setError(null)
    try {
      const result = await sendNewMessage(mailboxId, draft)
      await fetchSnapshot(search, false)
      return result
    } catch (cause) {
      if (redirectIfAnonymous(cause)) throw cause
      setError('The message was not accepted. Your draft is still available.')
      throw cause
    } finally {
      finishOperation()
    }
  }

  async function loadMore(): Promise<void> {
    const cursor = data.nextCursor
    if (cursor === null || loadingMore) return
    const targetKey = currentKey
    const request = pageRequests.current.begin()
    setLoadingMore(true)
    setError(null)
    try {
      const page = await listThreadPage(query, cursor, request.signal)
      if (!request.isLatest() || activeSearchKey.current !== targetKey) return
      setRefreshed((current) => {
        const base = current?.listKey === currentListKey ? current : source
        return {
          data: appendThreadPage(base.data, page),
          effectiveMailboxId: base.effectiveMailboxId,
          listKey: currentListKey,
          selectionKey: currentKey,
        }
      })
    } catch (cause) {
      if (!request.isLatest() || activeSearchKey.current !== targetKey || isAbortError(cause))
        return
      if (!redirectIfAnonymous(cause)) {
        setError('More conversations could not be loaded. The current page is still available.')
      }
    } finally {
      if (request.isLatest()) setLoadingMore(false)
    }
  }

  async function saveMailboxSettings(
    mailboxId: string,
    patch: PatchMailboxRequest,
  ): Promise<MailboxSettings> {
    beginOperation()
    setError(null)
    try {
      const result = await updateMailboxSettings(mailboxId, patch)
      setRefreshed((current) => {
        const base = current?.listKey === currentListKey ? current : source
        return {
          data: {
            ...base.data,
            mailboxes: base.data.mailboxes.map((mailbox) =>
              mailbox.id === mailboxId
                ? {
                    ...mailbox,
                    forwardTo: result.forwardTo,
                    senderAlias: result.senderAlias,
                    updatedAt: result.updatedAt,
                  }
                : mailbox,
            ),
          },
          effectiveMailboxId: base.effectiveMailboxId,
          listKey: currentListKey,
          selectionKey: currentKey,
        }
      })
      return result
    } catch (cause) {
      if (!redirectIfAnonymous(cause)) {
        setError('Mailbox settings could not be saved. No changes were applied.')
      }
      throw cause
    } finally {
      finishOperation()
    }
  }

  async function logout(): Promise<void> {
    beginOperation()
    setError(null)
    try {
      await signOut()
      window.location.replace('/sign-in')
    } catch (cause) {
      if (!redirectIfAnonymous(cause)) setError('Sign out failed. Please try again.')
      finishOperation()
    }
  }

  return (
    <InboxShell
      busy={operationPending || routePending}
      data={data}
      error={error}
      loadingMore={loadingMore}
      onArchiveThread={archiveThread}
      onBack={() => changeQuery({ threadId: null }, { replace: true })}
      onCompose={compose}
      onLoadMore={loadMore}
      onQueryChange={changeQuery}
      onRefresh={() => fetchSnapshot(search, true)}
      onReply={reply}
      onSelectThread={selectThread}
      onSignOut={logout}
      onUpdateMailbox={saveMailboxSettings}
      query={query}
      refreshing={refreshing}
    />
  )
}
