# Visual parity checklist

This checklist records the sanitized product behavior used to rebuild the inbox. The legacy
application and its deployment remain read-only references; no customer message, account value,
resource identifier, or legacy screenshot is committed here. Automated captures use only the
deterministic `example.test` fixture from `tests/fixtures/messages`.

## Reference viewports

| Viewport            | Required structure                                                       | Acceptance details                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop, 1440 × 900 | Full-height mailbox navigation, conversation list, and detail/reply pane | Navigation and list separators are pointer- and keyboard-resizable; the mobile Back action is hidden; each pane owns its scroll area.                            |
| Tablet, 900 × 820   | Compact mailbox header and folders above a two-column list/detail layout | The list keeps a usable minimum width, detail remains visible after selection, and desktop resize handles are absent.                                            |
| Mobile, 390 × 844   | Compact header/folders with separate list and detail screens             | Selecting a thread replaces the list with detail, Back restores the list and URL history, dialogs fit the viewport, and the document never scrolls horizontally. |

## State and interaction inventory

- Populated and unread lists show sender, subject, preview, time, workflow state, attachment count,
  and unread indication without shifting the row layout.
- All, Needs reply, Sent, and Archive expose counts and current-folder semantics; Unread is an
  independent pressed state.
- Search is visibly pending, debounced, URL-backed, and has a useful empty result without erasing
  the last successful list on refresh failure.
- Thread detail is chronological and text-first. Recipient rows, delivery uncertainty/failure,
  attachments, and authenticated raw-message access remain readable at 200% zoom.
- Reply and new-message composers expose editable To/CC/BCC, Markdown/plain-text composition,
  attachment add/remove, deterministic pending/success/failure states, and a locked uncertainty
  state that prevents accidental duplicate submission.
- Archive/read mutations update optimistically and roll back with a visible error when rejected.
- Mailbox settings have a labelled modal, predictable initial focus, Escape/Cancel behavior,
  sender alias and forwarding fields, theme selection, and sign-out.
- Empty, loading, search-empty, archived, attachment, refresh-error, and send-error states retain
  the same pane geometry rather than replacing the application shell.
- Light and dark themes preserve semantic borders, focus rings, destructive states, code blocks,
  and documentation typography.

## Verification record

`tests/e2e/inbox.e2e.ts` exercises the structural and interaction checklist at all three viewports
against the isolated multi-Worker harness. When `CLOUDFLARE_INBOX_SCREENSHOT_DIR` is set, it writes
sanitized desktop and mobile implementation captures outside the repository for manual comparison.
The tests also reject horizontal overflow and unexpected browser console/page errors.

Before any staging release, repeat the manual checks for keyboard-only compose/reply, focus return
after every dialog, reduced motion, touch scrolling, screen-reader names, 200% zoom, long subjects,
long addresses, multiple recipients, large threads, and both color themes. Real staging mail checks
remain a separate owner-authorized operation in `docs/operations.md`.
