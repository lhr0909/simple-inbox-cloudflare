import { describe, expect, it } from 'vitest'

import { htmlPreviewResponse, renderEmailDocument } from '../src/services/html-email'

const png = Uint8Array.from([137, 80, 78, 71]).buffer

describe('isolated HTML email documents', () => {
  it('preserves email layout and resolves only raster inline images', () => {
    const html = renderEmailDocument(
      '<style>.offer{color:red}</style><table cellpadding="8"><tr><td style="background:#abc"><strong>Offer</strong><img src="cid:logo"><img src="https://images.example.test/logo.png"><img src="cid:vector"></td></tr></table>',
      [
        {
          filename: 'logo.png',
          mimeType: 'image/png',
          disposition: 'inline',
          contentId: '<logo>',
          content: png,
        },
        {
          filename: 'vector.svg',
          mimeType: 'image/svg+xml',
          disposition: 'inline',
          contentId: '<vector>',
          content: png,
        },
      ],
    )
    expect(html).toContain('<style>.offer{color:red}</style>')
    expect(html).toContain('cellpadding="8"')
    expect(html).toContain('style="background:#abc"')
    expect(html).toContain('<strong>Offer</strong>')
    expect(html).toContain('src="data:image/png;base64,iVBORw=="')
    expect(html).toContain('src="https://images.example.test/logo.png"')
    expect(html).not.toContain('cid:')
    expect(html).not.toContain('data:image/svg')
  })

  it('removes active elements, relative resources, event handlers and navigation overrides', () => {
    const html = renderEmailDocument(
      `
      <base href="https://attacker.example.test"><meta http-equiv="refresh" content="0;url=https://attacker.example.test">
      <script nonce="attacker">parent.compromised=true</script><iframe srcdoc="evil"></iframe>
      <form action="/api/v1/messages"><input autofocus onfocus="evil()"></form>
      <object data="evil"></object><svg><script>evil()</script></svg>
      <img src="/api/v1/auth/verify" onerror="evil()"><img src="data:image/svg+xml;base64,AAAA">
      <a href="javascript:evil()" target="_top">Bad</a><a href="/inbox">Relative</a>
      <a href="https://example.test/path" onclick="evil()" target="_top">Good</a>
    `,
      [],
    )
    expect(html).not.toMatch(/<(?:script|iframe|form|input|object|svg|base)\b/iu)
    expect(html).not.toContain('http-equiv="refresh"')
    expect(html).not.toMatch(/onerror|onclick|onfocus|javascript:|srcdoc|_top|\/api\/v1\/auth/iu)
    expect(html).not.toContain('src="data:image/svg')
    expect(html).toContain(
      'href="https://example.test/path" target="_blank" rel="noopener noreferrer"',
    )
  })

  it('restricts execution to the fixed sizing helper and applies sandboxing even to direct visits', async () => {
    const response = htmlPreviewResponse(
      renderEmailDocument(
        '<style>.example::after{content:"</body></html>"}</style><p>Hello</p>',
        [],
      ),
    )
    const policy = response.headers.get('content-security-policy')!
    expect(policy).toContain('sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox')
    expect(policy).not.toContain('allow-same-origin')
    expect(policy).toContain("connect-src 'none'")
    expect(policy).toContain("form-action 'none'")
    expect(policy).toContain("frame-ancestors 'self'")
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const nonce = /script-src 'nonce-([^']+)'/u.exec(policy)![1]
    const html = await response.text()
    expect(html).toContain(`<p>Hello</p><script nonce="${nonce}">`)
    expect(html.match(/<script\b/gu)).toHaveLength(1)
    expect(html).toContain("type:'simple-inbox-html',ok:true")
  })

  it('falls back for absent HTML and refuses oversized previews', async () => {
    expect(await htmlPreviewResponse(null, 404).text()).toContain('ok:false')
    expect(() => renderEmailDocument('x'.repeat(4_000_001), [])).toThrow('request_too_large')
  })
})
