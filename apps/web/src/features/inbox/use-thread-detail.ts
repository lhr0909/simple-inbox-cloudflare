import { useCallback, useEffect, useRef, useState } from 'react'

import type { ThreadDetailResponse } from '@cloudflare-inbox/contracts/threads'

import { ApiRequestError, getThreadDetail } from './inbox-api'
import { applyOptimisticThreadStates } from './inbox-model'
import { isAbortError, LatestRequestCoordinator } from './inbox-request-coordinator'
import type { OptimisticThreadState } from './inbox-types'

type DetailState = Readonly<{
  key: string
  detail: ThreadDetailResponse | null
  error: string | null
}>

/** The list stays interactive while only the selected conversation loads. */
export function useThreadDetail(mailboxId: string, threadId: string | null) {
  const key = `${mailboxId}\u0000${threadId ?? ''}`
  const activeKey = useRef(key)
  activeKey.current = key
  const requests = useRef(new LatestRequestCoordinator())
  const [state, setState] = useState<DetailState | null>(null)
  const [revision, setRevision] = useState(0)

  const reload = useCallback(() => {
    requests.current.invalidate()
    setState((current) => (current?.error ? null : current))
    setRevision((current) => current + 1)
  }, [])

  useEffect(() => {
    const coordinator = requests.current
    const request = coordinator.begin()
    if (threadId !== null && mailboxId) {
      void getThreadDetail(threadId, request.signal)
        .then((detail) => {
          if (!request.isLatest() || activeKey.current !== key) return
          if (detail.thread.mailboxId !== mailboxId) throw new ApiRequestError(404, 'Not found')
          setState({ key, detail, error: null })
        })
        .catch((cause: unknown) => {
          if (!request.isLatest() || activeKey.current !== key || isAbortError(cause)) return
          if (cause instanceof ApiRequestError && cause.status === 401) {
            window.location.replace('/sign-in')
            return
          }
          setState({
            key,
            detail: null,
            error:
              cause instanceof ApiRequestError && cause.status === 404
                ? 'This conversation is no longer available in this mailbox.'
                : 'The conversation could not be loaded. Try again or choose another conversation.',
          })
        })
    }
    return () => coordinator.invalidate()
  }, [key, mailboxId, revision, threadId])

  const commit = useCallback((id: string, patch: OptimisticThreadState) => {
    setState((current) => {
      if (current?.detail?.thread.id !== id) return current
      const updated = applyOptimisticThreadStates(
        {
          mailboxes: [],
          threads: [],
          nextCursor: null,
          selectedThread: current.detail,
        },
        { [id]: patch },
      )
      return { ...current, detail: updated.selectedThread }
    })
  }, [])

  const current = state?.key === key ? state : null
  return {
    detail: current?.detail ?? null,
    error: current?.error ?? null,
    loading: threadId !== null && Boolean(mailboxId) && current === null,
    reload,
    commit,
  }
}
