import { AttachmentPicker, useAttachmentUploads } from './attachment-picker'
import { useContext, useId, useState } from 'react'
import type { FormEvent } from 'react'
import CheckCircleIcon from 'lucide-react/dist/esm/icons/circle-check.mjs'
import SendIcon from 'lucide-react/dist/esm/icons/send.mjs'

import { HydratedTimeContext, formatTime } from './inbox-primitives'

import { Button } from '#/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '#/components/ui/field'
import { Input } from '#/components/ui/input'
import { Textarea } from '#/components/ui/textarea'

import { defaultReplyRecipients, inboundReplyTargets, replySubject } from './inbox-model'
import type { InboxData } from './inbox-types'

import type { InboxShellProps } from './inbox-shell-types'

import type { ComposeStatus } from './inbox-types'

export function ReplyComposer({
  detail,
  onCancel,
  onReply,
}: Readonly<{
  detail: NonNullable<InboxData['selectedThread']>
  onCancel: () => void
  onReply?: InboxShellProps['onReply']
}>) {
  const id = useId()
  const localTimesReady = useContext(HydratedTimeContext)
  const inboundTargets = inboundReplyTargets(detail.messages)
  const latestInbound = inboundTargets.at(-1)
  const [targetMessageId, setTargetMessageId] = useState(latestInbound?.id ?? '')
  const [to, setTo] = useState(latestInbound ? defaultReplyRecipients(latestInbound) : '')
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  const [showCopies, setShowCopies] = useState(false)
  const [body, setBody] = useState('')
  const uploads = useAttachmentUploads()
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const [status, setStatus] = useState<ComposeStatus>('idle')
  const [statusMessage, setStatusMessage] = useState('')
  const uncertain = status === 'uncertain'
  const locked = status === 'sending' || uncertain

  function draftChanged(): void {
    if (status === 'accepted' || status === 'error') setIdempotencyKey(crypto.randomUUID())
    if (status !== 'sending' && status !== 'uncertain') {
      setStatus('idle')
      setStatusMessage('')
    }
  }

  function chooseReplyTarget(messageId: string): void {
    const message = inboundTargets.find((item) => item.id === messageId)
    setTargetMessageId(messageId)
    if (message !== undefined) setTo(defaultReplyRecipients(message))
    draftChanged()
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (locked || uploads.blocked || !body.trim() || !to.trim() || onReply === undefined) return
    setStatus('sending')
    setStatusMessage('Sending your reply…')
    try {
      const result = await onReply(detail.thread.id, {
        to,
        cc,
        bcc,
        subject: replySubject(detail.thread.subject),
        body,
        attachments: uploads.files,
        linkedAttachmentIds: uploads.ids,
        idempotencyKey,
        targetMessageId: targetMessageId || null,
      })
      if (result.state === 'unknown') {
        setStatus('uncertain')
        setStatusMessage(
          'Delivery status is unknown. Keep this draft and check the thread before resending.',
        )
        return
      }
      if (result.state === 'failed') {
        setIdempotencyKey(crypto.randomUUID())
        setStatus('error')
        setStatusMessage('The reply failed. Your draft is available for a new retry.')
        return
      }

      setStatus('accepted')
      setStatusMessage(
        result.state === 'sent' ? 'Reply sent.' : 'Reply accepted and still processing.',
      )
      setBody('')
      uploads.clear()
      setIdempotencyKey(crypto.randomUUID())
    } catch {
      setStatus('error')
      setStatusMessage(
        'The reply was not accepted. Retrying unchanged content reuses the safe request key.',
      )
    }
  }

  return (
    <form
      className="rounded-xl border bg-background p-4 shadow-xs"
      onSubmit={(event) => void submit(event)}
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Reply</h3>
          <p className="text-xs text-muted-foreground">
            Sending as this mailbox’s configured alias.
          </p>
        </div>
        <Button
          disabled={locked}
          onClick={() => setShowCopies((current) => !current)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cc / Bcc
        </Button>
      </div>
      <FieldGroup className="gap-3">
        {inboundTargets.length > 1 ? (
          <Field orientation="responsive">
            <FieldLabel className="w-24 shrink-0" htmlFor={`${id}-target`}>
              Reply to
            </FieldLabel>
            <select
              className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              disabled={locked}
              id={`${id}-target`}
              onChange={(event) => chooseReplyTarget(event.currentTarget.value)}
              value={targetMessageId}
            >
              {inboundTargets.map((message) => (
                <option key={message.id} value={message.id}>
                  {message.from.displayName ?? message.from.address} ·{' '}
                  {formatTime(message.sentAt, 'date', localTimesReady)}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field orientation="responsive">
          <FieldLabel className="w-24 shrink-0" htmlFor={`${id}-to`}>
            To
          </FieldLabel>
          <Input
            disabled={locked}
            id={`${id}-to`}
            onChange={(event) => {
              setTo(event.currentTarget.value)
              draftChanged()
            }}
            required
            value={to}
          />
        </Field>
        {showCopies ? (
          <>
            <Field orientation="responsive">
              <FieldLabel className="w-24 shrink-0" htmlFor={`${id}-cc`}>
                Cc
              </FieldLabel>
              <Input
                disabled={locked}
                id={`${id}-cc`}
                onChange={(event) => {
                  setCc(event.currentTarget.value)
                  draftChanged()
                }}
                value={cc}
              />
            </Field>
            <Field orientation="responsive">
              <FieldLabel className="w-24 shrink-0" htmlFor={`${id}-bcc`}>
                Bcc
              </FieldLabel>
              <Input
                disabled={locked}
                id={`${id}-bcc`}
                onChange={(event) => {
                  setBcc(event.currentTarget.value)
                  draftChanged()
                }}
                value={bcc}
              />
            </Field>
          </>
        ) : null}
        <Field>
          <FieldLabel className="sr-only" htmlFor={`${id}-body`}>
            Message
          </FieldLabel>
          <Textarea
            className="min-h-32 resize-y"
            autoFocus
            disabled={locked}
            id={`${id}-body`}
            onChange={(event) => {
              setBody(event.currentTarget.value)
              draftChanged()
            }}
            placeholder="Write a reply… Markdown is supported."
            required
            value={body}
          />
        </Field>
        <AttachmentPicker uploads={uploads} disabled={locked} onChange={draftChanged} />
      </FieldGroup>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button disabled={locked || uploads.blocked || !body.trim() || !to.trim()} type="submit">
          <SendIcon aria-hidden="true" className="size-4" />
          {status === 'sending' ? 'Sending…' : 'Send reply'}
        </Button>
        <Button disabled={locked} onClick={onCancel} type="button" variant="ghost">
          Cancel
        </Button>
        <span
          aria-live="polite"
          className="ml-auto inline-flex max-w-sm items-center gap-1 text-right text-xs text-muted-foreground"
        >
          {status === 'accepted' ? (
            <CheckCircleIcon aria-hidden="true" className="size-3.5 shrink-0" />
          ) : null}
          {statusMessage}
        </span>
      </div>
    </form>
  )
}
