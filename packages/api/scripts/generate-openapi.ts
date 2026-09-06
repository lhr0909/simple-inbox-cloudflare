import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { createApiApp } from '../src/index'
import { OPENAPI_CONFIGURATION } from '../src/routes/system'

const outputPath = fileURLToPath(new URL('../openapi.json', import.meta.url))
const document = createApiApp().getOpenAPI31Document(OPENAPI_CONFIGURATION)

await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
const formatted = spawnSync('vp', ['fmt', outputPath], { stdio: 'inherit' })
if (formatted.error !== undefined) throw formatted.error
if (formatted.status !== 0) {
  throw new Error(`OpenAPI formatting failed with exit code ${formatted.status ?? 'unknown'}.`)
}
process.stdout.write(`Generated ${outputPath}\n`)
