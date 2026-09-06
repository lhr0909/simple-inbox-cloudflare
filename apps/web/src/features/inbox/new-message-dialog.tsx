import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import CheckCircleIcon from 'lucide-react/dist/esm/icons/circle-check.mjs'
import PaperclipIcon from 'lucide-react/dist/esm/icons/paperclip.mjs'
import SendIcon from 'lucide-react/dist/esm/icons/send.mjs'
import XIcon from 'lucide-react/dist/esm/icons/x.mjs'

import type { ComposeStatus } from './inbox-types'

import { Button } from '#/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '#/components/ui/field'
import { Input } from '#/components/ui/input'
import { Textarea } from '#/components/ui/textarea'

import { attachmentLimitError } from './inbox-model'
import type { InboxData } from './inbox-types'

import type { InboxShellProps } from './inbox-shell-types'

export function NewMessageDialog({
  mailbox,
  open,
  onCompose,
  onOpenChange,
}: Readonly<{
  mailbox: InboxData['mailboxes'][number] | null
  open: boolean
  onCompose?: InboxShellProps['onCompose']
  onOpenChange: (open: boolean) => void
}>) {
  const dialog = useRef<HTMLDialogElement>(null)
  const id = useId()
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [attachments, setAttachments] = useState<readonly File[]>([])
  const [attachmentError, setAttachmentError] = useState('')
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const [status, setStatus] = useState<ComposeStatus>('idle')
  const [statusMessage, setStatusMessage] = useState('')
  const uncertain = status === 'uncertain'
  const locked = status === 'sending' || uncertain

  useEffect(() => {
    const element = dialog.current
    if (element === null) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
  }, [open])

  function draftChanged(): void {
    if (status === 'accepted' || status === 'error') setIdempotencyKey(crypto.randomUUID())
    if (status !== 'sending' && status !== 'uncertain') {
      setStatus('idle')
      setStatusMessage('')
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (
      mailbox === null ||
      onCompose === undefined ||
      locked ||
      attachmentError ||
      !to.trim() ||
      !body.trim()
    ) {
      return
    }

    setStatus('sending')
    setStatusMessage('Sending your message…')
    try {
      const result = await onCompose(mailbox.id, {
        to,
        cc,
        bcc,
        subject,
        body,
        attachments,
        idempotencyKey,
      })
      if (result.state === 'unknown') {
        setStatus('uncertain')
        setStatusMessage(
          'Delivery status is unknown. The full draft is retained; check Sent before resending.',
        )
        return
      }
      if (result.state === 'failed') {
        setIdempotencyKey(crypto.randomUUID())
        setStatus('error')
        setStatusMessage('The message failed. The full draft is available for a new retry.')
        return
      }

      setStatus('accepted')
      setStatusMessage(
        result.state === 'sent' ? 'Message sent.' : 'Message accepted and still processing.',
      )
      setTo('')
      setCc('')
      setBcc('')
      setSubject('')
      setBody('')
      setAttachments([])
      setAttachmentError('')
      setIdempotencyKey(crypto.randomUUID())
    } catch {
      setStatus('error')
      setStatusMessage(
        'The message was not accepted. The full draft is retained and an unchanged retry reuses its request key.',
      )
    }
  }

  return (
    <dialog
      aria-describedby={`${id}-description`}
      aria-labelledby={`${id}-title`}
      className="m-auto max-h-[92dvh] w-[min(94vw,42rem)] rounded-2xl border bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/40"
      onCancel={(event) => {
        event.preventDefault()
        if (!locked) onOpenChange(false)
      }}
      onClose={() => onOpenChange(false)}
      ref={dialog}
    >
      <form
        className="max-h-[92dvh] overflow-y-auto p-5 sm:p-6"
        onSubmit={(event) => void submit(event)}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold" id={`${id}-title`}>
              New message
            </h2>
            <p className="mt-1 text-sm text-muted-foreground" id={`${id}-description`}>
              Sending as {mailbox?.senderAlias ?? mailbox?.address ?? 'the selected mailbox'}.
            </p>
          </div>
          <Button
            aria-label="Close new message"
            disabled={locked}
            onClick={() => onOpenChange(false)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <XIcon aria-hidden="true" className="size-4" />
          </Button>
        </div>

        <FieldGroup className="mt-5 gap-3">
          <Field orientation="responsive">
            <FieldLabel className="w-16 shrink-0" htmlFor={`${id}-to`}>
              To
            </FieldLabel>
            <Input
              autoFocus
              disabled={locked}
              id={`${id}-to`}
              onChange={(event) => {
                setTo(event.currentTarget.value)
                draftChanged()
              }}
              placeholder="recipient@example.com"
              required
              value={to}
            />
          </Field>
          <Field orientation="responsive">
            <FieldLabel className="w-16 shrink-0" htmlFor={`${id}-cc`}>
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
            <FieldLabel className="w-16 shrink-0" htmlFor={`${id}-bcc`}>
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
          <Field orientation="responsive">
            <FieldLabel className="w-16 shrink-0" htmlFor={`${id}-subject`}>
              Subject
            </FieldLabel>
            <Input
              disabled={locked}
              id={`${id}-subject`}
              maxLength={998}
              onChange={(event) => {
                setSubject(event.currentTarget.value)
                draftChanged()
              }}
              value={subject}
            />
          </Field>
          <Field>
            <FieldLabel className="sr-only" htmlFor={`${id}-body`}>
              Message
            </FieldLabel>
            <Textarea
              className="min-h-48 resize-y"
              disabled={locked}
              id={`${id}-body`}
              onChange={(event) => {
                setBody(event.currentTarget.value)
                draftChanged()
              }}
              placeholder="Write a message… Markdown is supported."
              required
              value={body}
            />
          </Field>
          <Field>
            <FieldLabel className="sr-only" htmlFor={`${id}-attachments`}>
              Add attachments
            </FieldLabel>
            <Input
              disabled={locked}
              id={`${id}-attachments`}
              multiple
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? [])
                if (files.length > 0) {
                  const next = [...attachments, ...files]
                  const limitError = attachmentLimitError(next)
                  if (limitError === null) {
                    setAttachments(next)
                    setAttachmentError('')
                    draftChanged()
                  } else {
                    setAttachmentError(limitError)
                  }
                }
                event.currentTarget.value = ''
              }}
              type="file"
            />
          </Field>
        </FieldGroup>

        {attachments.length > 0 ? (
          <ul aria-label="Attachments" className="mt-3 space-y-1">
            {attachments.map((file, index) => (
              <li
                className="flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs"
                key={`${file.name}-${file.size}-${index}`}
              >
                <PaperclipIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                <Button
                  aria-label={`Remove ${file.name}`}
                  disabled={locked}
                  onClick={() => {
                    setAttachments((current) =>
                      current.filter((_, itemIndex) => itemIndex !== index),
                    )
                    setAttachmentError('')
                    draftChanged()
                  }}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <XIcon aria-hidden="true" className="size-3" />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center gap-2 border-t pt-4">
          <Button
            disabled={
              mailbox === null || locked || Boolean(attachmentError) || !to.trim() || !body.trim()
            }
            type="submit"
          >
            <SendIcon aria-hidden="true" className="size-4" />
            {status === 'sending' ? 'Sending…' : 'Send message'}
          </Button>
          <Button
            disabled={locked}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="ghost"
          >
            Close
          </Button>
          <span
            aria-live="polite"
            className="ml-auto inline-flex max-w-sm items-center gap-1 text-right text-xs text-muted-foreground"
          >
            {status === 'accepted' ? (
              <CheckCircleIcon aria-hidden="true" className="size-3.5 shrink-0" />
            ) : null}
            {attachmentError || statusMessage}
          </span>
        </div>
      </form>
    </dialog>
  )
}
