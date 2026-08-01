import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SetupWizard } from './setup-wizard'

describe('SetupWizard native fallback', () => {
  it('cannot serialize the setup token into a URL before hydration', () => {
    const html = renderToStaticMarkup(<SetupWizard />)
    const form = html.match(/<form\b[^>]*>/u)?.[0]
    const tokenInput = html.match(/<input\b[^>]*id="setup-token"[^>]*>/u)?.[0]

    expect(form).toBeDefined()
    expect(form).toContain('action="/setup"')
    expect(form).toContain('method="post"')
    expect(tokenInput).toBeDefined()
    expect(tokenInput).toContain('type="password"')
    expect(tokenInput).not.toMatch(/\bname=/u)
  })
})
