import { escapeHtml, type RenderedMessageContent } from './render'

export const EMAIL_FONT = 'Arial, Helvetica, sans-serif'
export const EMAIL_PREVIEW_CSS = `:where(body){margin:0;padding:20px;font-family:${EMAIL_FONT};font-size:15px;line-height:1.6;overflow-wrap:anywhere;color:#202124;background:#fff}:where(img){max-width:100%;height:auto}:where(p){margin:0 0 1em}:where(blockquote){margin:1em 0;padding-left:1em;border-left:2px solid #dadce0}:where(pre){white-space:pre-wrap;overflow-wrap:anywhere}:where(a){color:#2563eb}`

export function presentEmailHtml(html: string): string {
  return `<div style="font-family:${EMAIL_FONT};font-size:15px;line-height:1.6;color:#202124;overflow-wrap:anywhere">${html}</div>`
}

export interface EmailAttachmentLink {
  filename: string
  size: number
  url: string
}
export function appendEmailAttachmentLinks(
  content: RenderedMessageContent,
  files: readonly EmailAttachmentLink[],
): RenderedMessageContent {
  if (!files.length) return content
  return {
    text: `${content.text}\n\nAttachments\n${files.map((file) => `${file.filename} (${file.size.toLocaleString('en-US')} bytes): ${file.url}`).join('\n')}`,
    html: `${content.html}<div style="margin-top:24px;padding:16px;border:1px solid #ddd;border-radius:8px"><p style="margin:0 0 12px;font-weight:bold">Attachments</p>${files.map((file) => `<p style="margin:8px 0"><a href="${escapeHtml(file.url)}" style="color:#2563eb">${escapeHtml(file.filename)}</a> <span style="color:#666">(${file.size.toLocaleString('en-US')} bytes)</span></p>`).join('')}</div>`,
  }
}
