/// <reference types="@cloudflare/workers-types" />
/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'

const migrationUrl = new URL('../../migrations/0000_initial.sql', import.meta.url)

export class TestD1Database {
  readonly sqlite = new DatabaseSync(':memory:')

  constructor() {
    this.sqlite.exec(readFileSync(migrationUrl, 'utf8'))
  }

  asD1(): D1Database {
    return this as unknown as D1Database
  }

  prepare(query: string): TestD1Statement {
    return new TestD1Statement(this.sqlite.prepare(query))
  }

  async batch(statements: readonly TestD1Statement[]): Promise<D1Result<unknown>[]> {
    this.sqlite.exec('BEGIN IMMEDIATE')
    try {
      const results = statements.map((statement) => statement.runSync())
      this.sqlite.exec('COMMIT')
      return results
    } catch (error) {
      this.sqlite.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.sqlite.close()
  }
}

class TestD1Statement {
  readonly #statement: StatementSync
  readonly #values: SQLInputValue[]

  constructor(statement: StatementSync, values: SQLInputValue[] = []) {
    this.#statement = statement
    this.#values = values
  }

  bind(...values: unknown[]): TestD1Statement {
    return new TestD1Statement(this.#statement, values.map(toSqlInputValue))
  }

  async all<T>(): Promise<D1Result<T>> {
    const rows = this.#statement.all(...this.#values) as T[]
    return result(rows, 0)
  }

  async first<T>(columnName?: string): Promise<T | null> {
    const row = this.#statement.get(...this.#values) as Record<string, unknown> | undefined
    if (row === undefined) {
      return null
    }
    return (columnName === undefined ? row : row[columnName]) as T
  }

  async raw<T>(): Promise<T[]> {
    this.#statement.setReturnArrays(true)
    try {
      return this.#statement.all(...this.#values) as T[]
    } finally {
      this.#statement.setReturnArrays(false)
    }
  }

  async run<T>(): Promise<D1Result<T>> {
    return this.runSync() as D1Result<T>
  }

  runSync(): D1Result<unknown> {
    const execution = this.#statement.run(...this.#values)
    return result([], Number(execution.changes), Number(execution.lastInsertRowid))
  }
}

function result<T>(results: T[], changes: number, lastRowId = 0): D1Result<T> {
  return {
    meta: {
      changed_db: changes > 0,
      changes,
      duration: 0,
      last_row_id: lastRowId,
      rows_read: 0,
      rows_written: changes,
      size_after: 0,
    },
    results,
    success: true,
  }
}

function toSqlInputValue(value: unknown): SQLInputValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    value instanceof Uint8Array
  ) {
    return value
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0
  }
  throw new TypeError(`Unsupported test D1 bind value: ${typeof value}`)
}
