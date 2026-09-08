import sanitizeHtml from 'sanitize-html'
import { parse, serialize } from 'parse5'
import type { Attachment } from 'postal-mime'

import { ApiFault } from '../http'

const MAX_PREVIEW_BYTES = 4_000_000
const RASTER_IMAGE = /^image\/(?:png|jpeg|gif|webp|avif|bmp)$/u
const IMAGE_DATA = /^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,[a-zA-Z0-9+/=\s]+$/u

/** Defense in depth: sanitized markup is still rendered only inside an opaque-origin sandbox. */
export function renderEmailDocument(html: string, attachments: Attachment[]): string {
  const images = new Map<string, string>()
  let embeddedBytes = 0
  for (const attachment of attachments) {
    if (!attachment.contentId || !RASTER_IMAGE.test(attachment.mimeType)) continue
    const content = attachment.content
    if (!(content instanceof ArrayBuffer)) continue
    embeddedBytes += content.byteLength
    if (embeddedBytes > MAX_PREVIEW_BYTES) throw new ApiFault('request_too_large')
    images.set(
      attachment.contentId.replace(/^<|>$/gu, '').trim(),
      `data:${attachment.mimeType};base64,${Buffer.from(content).toString('base64')}`,
    )
  }

  const cleaned = sanitizeHtml(serialize(parse(html)), {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      'html',
      'head',
      'body',
      'img',
      'style',
      'font',
      'center',
    ],
    allowedAttributes: {
      '*': [
        'style',
        'class',
        'id',
        'dir',
        'lang',
        'title',
        'align',
        'valign',
        'width',
        'height',
        'bgcolor',
      ],
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height', 'style', 'class'],
      table: [
        'style',
        'class',
        'width',
        'height',
        'align',
        'bgcolor',
        'border',
        'cellpadding',
        'cellspacing',
      ],
      td: ['style', 'class', 'width', 'height', 'align', 'valign', 'bgcolor', 'colspan', 'rowspan'],
      th: ['style', 'class', 'width', 'height', 'align', 'valign', 'bgcolor', 'colspan', 'rowspan'],
      font: ['color', 'size', 'face'],
    },
    allowedSchemes: ['https', 'http', 'mailto'],
    allowedSchemesByTag: { img: ['https', 'data'] },
    allowProtocolRelative: false,
    // Email CSS stays inside the sandbox. CSP blocks scripts, imports, fonts, frames and forms.
    // No CSS parser is needed or permitted to resolve anything on the server.
    parseStyleAttributes: false,
    allowVulnerableTags: true,
    nonTextTags: [
      'script',
      'textarea',
      'option',
      'title',
      'iframe',
      'object',
      'svg',
      'math',
      'noscript',
    ],
    transformTags: {
      head: () => ({ tagName: 'head', attribs: {} }),
      a: (_tag, attributes) => {
        const href = absoluteLink(attributes['href'])
        const { href: _href, target: _target, rel: _rel, ...presentation } = attributes
        return {
          tagName: 'a',
          attribs: {
            ...presentation,
            ...(href ? { href, target: '_blank', rel: 'noopener noreferrer' } : {}),
          },
        }
      },
      img: (_tag, attributes) => {
        const source = attributes['src'] ?? ''
        const src = source.toLowerCase().startsWith('cid:')
          ? images.get(source.slice(4).replace(/^<|>$/gu, '').trim())
          : imageSource(source)
        const { src: _src, ...rest } = attributes
        return { tagName: 'img', attribs: { ...rest, ...(src ? { src } : {}) } }
      },
    },
  })
  // Keep the document's body/root styling and head CSS. Low-specificity defaults
  // precede sender styles, so presentation attributes and newsletter rules can win.
  const defaults =
    '<meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>:where(body){margin:0;overflow-wrap:anywhere;color:#111;background:#fff}:where(img){max-width:100%;height:auto}</style>'
  const document = `<!doctype html>${cleaned.replace('<head>', `<head>${defaults}`)}`
  if (new TextEncoder().encode(document).byteLength > MAX_PREVIEW_BYTES) {
    throw new ApiFault('request_too_large')
  }
  return document
}

function absoluteLink(value: string | undefined): string | undefined {
  if (!value || !/^(?:https?:\/\/|mailto:)/iu.test(value)) return undefined
  try {
    const url = new URL(value)
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}

function imageSource(value: string): string | undefined {
  if (IMAGE_DATA.test(value)) return value
  const url = absoluteLink(value)
  return url?.startsWith('https://')
    ? url
    : url?.startsWith('http://')
      ? `https://${url.slice(7)}`
      : undefined
}

/** Only this fixed helper script can execute; sender scripts and handlers are removed and blocked. */
export function htmlPreviewResponse(document: string | null, status = 200): Response {
  const nonce = crypto.randomUUID().replaceAll('-', '')
  const ok = status === 200 && document !== null
  const script = `(() => { const send = () => parent.postMessage({type:'simple-inbox-html',ok:${ok},height:document.documentElement.scrollHeight}, '*'); new ResizeObserver(send).observe(document.body); send(); })()`
  const body =
    document ??
    '<!doctype html><html><body><p>HTML is unavailable. Use the plain-text view.</p></body></html>'
  const html = body.replace(
    /<\/body><\/html>$/u,
    `<script nonce="${nonce}">${script}</script></body></html>`,
  )
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src https: data:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; upgrade-insecure-requests`,
    },
  })
}
