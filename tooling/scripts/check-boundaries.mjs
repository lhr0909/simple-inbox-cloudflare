#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const INTERNAL_SCOPE = '@cloudflare-inbox/'
const WORKSPACE_DIRECTORIES = ['apps', 'workers', 'packages', 'tooling', 'tests']
const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx'])
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.output',
  '.source',
  '.tanstack',
  '.wrangler',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
])
const GENERATED_FILES = new Set(['routeTree.gen.ts', 'worker-configuration.d.ts'])
const GENERATED_CHECK_COMMAND = 'vp run check:generated'
const GENERATED_MUTATION_COMMANDS = [
  'generate-routes',
  'cf-typegen',
  'generate-openapi',
  'db:generate',
  'drizzle-kit generate',
]

const ALLOWED_INTERNAL_DEPENDENCIES = new Map([
  [
    `${INTERNAL_SCOPE}web`,
    new Set([
      `${INTERNAL_SCOPE}api`,
      `${INTERNAL_SCOPE}contracts`,
      `${INTERNAL_SCOPE}db`,
      `${INTERNAL_SCOPE}mail`,
    ]),
  ],
  [
    `${INTERNAL_SCOPE}api`,
    new Set([`${INTERNAL_SCOPE}contracts`, `${INTERNAL_SCOPE}db`, `${INTERNAL_SCOPE}mail-core`]),
  ],
  [
    `${INTERNAL_SCOPE}mail`,
    new Set([`${INTERNAL_SCOPE}contracts`, `${INTERNAL_SCOPE}db`, `${INTERNAL_SCOPE}mail-core`]),
  ],
  [`${INTERNAL_SCOPE}contracts`, new Set()],
  [`${INTERNAL_SCOPE}db`, new Set([`${INTERNAL_SCOPE}contracts`])],
  [`${INTERNAL_SCOPE}mail-core`, new Set([`${INTERNAL_SCOPE}contracts`])],
])

const LOCKFILE_NAMES = new Set([
  'bun.lock',
  'bun.lockb',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
])

function toPosix(path) {
  return path.split(sep).join('/')
}

function compareStrings(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function findWorkspacePackages(root) {
  const packages = []

  for (const workspaceDirectory of WORKSPACE_DIRECTORIES) {
    const parent = join(root, workspaceDirectory)
    if (!existsSync(parent)) continue

    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue

      const packageRoot = join(parent, entry.name)
      const manifestPath = join(packageRoot, 'package.json')
      if (!existsSync(manifestPath)) continue

      const manifest = readJson(manifestPath)
      packages.push({
        manifest,
        manifestPath,
        name: manifest.name,
        relativeRoot: toPosix(relative(root, packageRoot)),
        root: packageRoot,
      })
    }
  }

  return packages.sort((left, right) => left.relativeRoot.localeCompare(right.relativeRoot))
}

function walk(directory, visitor) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    visitor(path, entry)
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue

    if (entry.isDirectory()) {
      walk(path, visitor)
    }
  }
}

function sourceFiles(packageRoot) {
  const files = []
  walk(packageRoot, (path, entry) => {
    if (!entry.isFile()) return
    if (!SOURCE_EXTENSIONS.has(extname(entry.name))) return
    if (GENERATED_FILES.has(entry.name)) return
    files.push(path)
  })
  return files.sort(compareStrings)
}

function moduleSpecifiers(source) {
  const specifiers = []
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/gu,
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
  ]

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier) specifiers.push({ index: match.index, specifier })
    }
  }

  return specifiers
}

function dependencyMap(manifest) {
  return {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  }
}

function exportedSubpaths(manifest) {
  if (typeof manifest.exports === 'string' || Array.isArray(manifest.exports)) {
    return new Set(['.'])
  }

  if (!manifest.exports || typeof manifest.exports !== 'object') return new Set()

  const keys = Object.keys(manifest.exports)
  if (keys.some((key) => key.startsWith('.'))) return new Set(keys)
  return new Set(['.'])
}

function packageForSpecifier(specifier, packagesByName) {
  const matches = [...packagesByName.keys()]
    .filter((name) => specifier === name || specifier.startsWith(`${name}/`))
    .sort((left, right) => right.length - left.length)
  const name = matches[0]
  return name ? packagesByName.get(name) : undefined
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length
}

function violation(root, code, file, message, line = 1) {
  return {
    code,
    file: toPosix(relative(root, file)),
    line,
    message,
  }
}

function inspectManifest(root, workspacePackage, packagesByName) {
  const violations = []
  const dependencies = dependencyMap(workspacePackage.manifest)
  const allowed = ALLOWED_INTERNAL_DEPENDENCIES.get(workspacePackage.name)

  for (const [dependency, version] of Object.entries(dependencies)) {
    if (!packagesByName.has(dependency)) continue

    if (typeof version !== 'string' || !version.startsWith('workspace:')) {
      violations.push(
        violation(
          root,
          'workspace-version',
          workspacePackage.manifestPath,
          `${dependency} must use the workspace: protocol`,
        ),
      )
    }

    if (allowed && !allowed.has(dependency)) {
      violations.push(
        violation(
          root,
          'forbidden-dependency',
          workspacePackage.manifestPath,
          `${workspacePackage.name} may not depend on ${dependency}`,
        ),
      )
    }
  }

  return violations
}

function inspectImport(root, workspacePackage, packagesByName, source, file, imported) {
  const violations = []
  const { index, specifier } = imported
  const line = lineNumber(source, index)
  const target = packageForSpecifier(specifier, packagesByName)

  if (specifier.startsWith(INTERNAL_SCOPE) && !target) {
    violations.push(
      violation(
        root,
        'unknown-workspace-import',
        file,
        `${specifier} does not resolve to a workspace package`,
        line,
      ),
    )
    return violations
  }

  if (target && target.name !== workspacePackage.name) {
    const dependencies = dependencyMap(workspacePackage.manifest)
    if (!Object.hasOwn(dependencies, target.name)) {
      violations.push(
        violation(
          root,
          'undeclared-workspace-import',
          file,
          `${target.name} must be declared in ${workspacePackage.relativeRoot}/package.json`,
          line,
        ),
      )
    }

    const allowed = ALLOWED_INTERNAL_DEPENDENCIES.get(workspacePackage.name)
    if (allowed && !allowed.has(target.name)) {
      violations.push(
        violation(
          root,
          'forbidden-dependency',
          file,
          `${workspacePackage.name} may not import ${target.name}`,
          line,
        ),
      )
    }

    const exportKey = specifier === target.name ? '.' : `.${specifier.slice(target.name.length)}`
    if (!exportedSubpaths(target.manifest).has(exportKey)) {
      violations.push(
        violation(
          root,
          'workspace-deep-import',
          file,
          `${specifier} is not a declared export of ${target.name}`,
          line,
        ),
      )
    }
  }

  if (
    [`${INTERNAL_SCOPE}contracts`, `${INTERNAL_SCOPE}mail-core`].includes(workspacePackage.name) &&
    (specifier === 'react' || specifier.startsWith('react/') || specifier.startsWith('cloudflare:'))
  ) {
    violations.push(
      violation(
        root,
        'runtime-leak',
        file,
        `${workspacePackage.name} must remain independent of ${specifier}`,
        line,
      ),
    )
  }

  if (
    [`${INTERNAL_SCOPE}contracts`, `${INTERNAL_SCOPE}mail-core`].includes(workspacePackage.name) &&
    /(?:cloudflare-types|(?:^|\/)bindings?(?:\/|$))/u.test(specifier)
  ) {
    violations.push(
      violation(
        root,
        'binding-leak',
        file,
        `${workspacePackage.name} may not import concrete Cloudflare bindings`,
        line,
      ),
    )
  }

  return violations
}

function inspectSource(root, workspacePackage, packagesByName, file) {
  const violations = []
  const source = readFileSync(file, 'utf8')
  const relativeFile = toPosix(relative(root, file))
  const isTest = /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:spec|test)\.[^.]+$/u.test(
    relativeFile,
  )

  for (const imported of moduleSpecifiers(source)) {
    violations.push(
      ...inspectImport(root, workspacePackage, packagesByName, source, file, imported),
    )
  }

  const checks = []
  if (relativeFile.startsWith('workers/')) {
    checks.push({
      code: 'worker-process-env',
      pattern: /\bprocess\s*\.\s*env\b/gu,
      message: 'Worker code must receive generated bindings through env, not process.env',
    })
  }

  if (!isTest && !/(?:^|\/)(?:logger|logging)(?:\.[^/]+)?$/u.test(relativeFile)) {
    checks.push({
      code: 'console-log',
      pattern: /\bconsole\s*\.\s*log\s*\(/gu,
      message: 'Use the structured logger instead of console.log',
    })
  }

  if (relativeFile.startsWith('apps/web/')) {
    checks.push({
      code: 'radix-as-child',
      pattern: /\basChild(?:\s*=|\s|>)/gu,
      message: 'Base UI components use render; do not copy Radix asChild patterns',
    })
  }

  if (!relativeFile.startsWith('packages/db/')) {
    checks.push(
      {
        code: 'raw-sql-outside-db',
        pattern: /\bsql(?:\s*<[^>]+>)?\s*`/gu,
        message: 'Raw SQL belongs in packages/db migrations or repositories',
      },
      {
        code: 'raw-sql-outside-db',
        pattern:
          /\.prepare\s*\(\s*['"`]\s*(?:ALTER|CREATE|DELETE|DROP|INSERT|PRAGMA|SELECT|UPDATE)\b/giu,
        message: 'Raw SQL belongs in packages/db migrations or repositories',
      },
    )
  }

  if (/(?:^|\/)routes?(?:\/|$)/u.test(relativeFile)) {
    checks.push({
      code: 'sql-in-route',
      pattern: /\bD1Database\b|\.prepare\s*\(|\.exec\s*\(/gu,
      message: 'Route handlers must call repositories instead of D1 or raw SQL',
    })
  }

  if (/(?:^|\/)repositories?(?:\/|$)/u.test(relativeFile)) {
    checks.push({
      code: 'http-in-repository',
      pattern: /\b(?:Context|Response)\b/gu,
      message: 'Repositories must not construct or depend on HTTP responses',
    })
  }

  const isApiMailClient = /^workers\/api\/src\/(?:clients|services)\/mail-client(?:\.|\/)/u.test(
    relativeFile,
  )
  if (!isApiMailClient) {
    checks.push({
      code: 'direct-mail-fetch',
      pattern: /\bMAIL\s*\.\s*fetch\s*\(/gu,
      message: 'Only the API mail client may call the MAIL Service Binding directly',
    })
  }

  if (
    [`${INTERNAL_SCOPE}contracts`, `${INTERNAL_SCOPE}mail-core`].includes(workspacePackage.name)
  ) {
    checks.push(
      {
        code: 'hono-context-leak',
        pattern: /\b(?:Context|MiddlewareHandler)\b/gu,
        message: `${workspacePackage.name} may not depend on Hono request context types`,
      },
      {
        code: 'binding-leak',
        pattern:
          /\b(?:CloudflareBindings|D1Database|ExecutionContext|ExportedHandler|R2Bucket)\b/gu,
        message: `${workspacePackage.name} may not depend on concrete Cloudflare bindings`,
      },
    )
  }

  for (const check of checks) {
    for (const match of source.matchAll(check.pattern)) {
      violations.push(
        violation(root, check.code, file, check.message, lineNumber(source, match.index)),
      )
    }
  }

  return violations
}

function inspectWorkspaceHygiene(root, workspacePackage) {
  const violations = []
  walk(workspacePackage.root, (path, entry) => {
    if (entry.isDirectory() && entry.name === '.git') {
      violations.push(
        violation(
          root,
          'nested-git-directory',
          path,
          'Workspace packages may not contain nested .git directories',
        ),
      )
    }
    if (entry.isFile() && LOCKFILE_NAMES.has(entry.name)) {
      violations.push(
        violation(
          root,
          'nested-lockfile',
          path,
          'The pnpm workspace uses only the root pnpm-lock.yaml',
        ),
      )
    }
  })
  return violations
}

function inspectCiGeneratedDriftOrder(root) {
  const workflow = join(root, '.github/workflows/ci.yml')
  if (!existsSync(workflow)) return []

  const source = readFileSync(workflow, 'utf8')
  const checkIndex = source.indexOf(GENERATED_CHECK_COMMAND)
  if (checkIndex === -1) {
    return [
      violation(
        root,
        'missing-generated-drift-check',
        workflow,
        `CI must run ${GENERATED_CHECK_COMMAND} against the pristine checkout`,
      ),
    ]
  }

  const maskingCommand = GENERATED_MUTATION_COMMANDS.find((command) => {
    const index = source.indexOf(command)
    return index !== -1 && index < checkIndex
  })
  if (maskingCommand === undefined) return []

  return [
    violation(
      root,
      'generated-drift-masked',
      workflow,
      `${maskingCommand} mutates generated artifacts before ${GENERATED_CHECK_COMMAND}`,
      lineNumber(source, source.indexOf(maskingCommand)),
    ),
  ]
}

export function inspectWorkspace(rootDirectory) {
  const root = resolve(rootDirectory)
  const packages = findWorkspacePackages(root)
  const packagesByName = new Map()
  const violations = [...inspectCiGeneratedDriftOrder(root)]

  for (const workspacePackage of packages) {
    if (typeof workspacePackage.name !== 'string' || !workspacePackage.name) {
      violations.push(
        violation(
          root,
          'missing-package-name',
          workspacePackage.manifestPath,
          'Workspace package needs a name',
        ),
      )
      continue
    }
    if (packagesByName.has(workspacePackage.name)) {
      violations.push(
        violation(
          root,
          'duplicate-package-name',
          workspacePackage.manifestPath,
          `Duplicate workspace package name: ${workspacePackage.name}`,
        ),
      )
    }
    packagesByName.set(workspacePackage.name, workspacePackage)
  }

  for (const workspacePackage of packages) {
    violations.push(...inspectManifest(root, workspacePackage, packagesByName))
    violations.push(...inspectWorkspaceHygiene(root, workspacePackage))
    for (const file of sourceFiles(workspacePackage.root)) {
      violations.push(...inspectSource(root, workspacePackage, packagesByName, file))
    }
  }

  return violations.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.code.localeCompare(right.code),
  )
}

function parseArguments(arguments_) {
  const options = { json: false, root: process.cwd() }
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--json') {
      options.json = true
    } else if (argument === '--root') {
      const root = arguments_[index + 1]
      if (!root) throw new Error('--root requires a directory')
      options.root = root
      index += 1
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return options
}

export function main(arguments_ = process.argv.slice(2)) {
  const options = parseArguments(arguments_)
  const violations = inspectWorkspace(options.root)

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ violations }, null, 2)}\n`)
  } else if (violations.length === 0) {
    process.stdout.write('Workspace boundaries are valid.\n')
  } else {
    process.stderr.write(`Workspace boundary check found ${violations.length} violation(s):\n`)
    for (const item of violations) {
      process.stderr.write(`${item.file}:${item.line} [${item.code}] ${item.message}\n`)
    }
  }

  return violations.length === 0 ? 0 : 1
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  try {
    process.exitCode = main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Workspace boundary check failed: ${message}\n`)
    process.exitCode = 2
  }
}
