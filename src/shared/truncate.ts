/** Host-side result shaping: convert mysql2 rows to plain JSON and enforce caps. */

export type JsonCell = string | number | boolean | null
export type JsonRow = Record<string, JsonCell>

export interface ShapedRows {
  columns: string[]
  rows: JsonRow[]
  rowCount: number
  truncated: boolean
  bytes: number
}

const CELL_MAX_CHARS = 4096

function plainValue(value: unknown): JsonCell {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return `(BLOB ${value.length} bytes)`
  if (ArrayBuffer.isView(value)) return `(BLOB ${(value as Uint8Array).byteLength} bytes)`
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Convert raw mysql2 row objects into JSON-safe rows with a stable column list. */
export function toPlainRows(rawRows: unknown[]): { columns: string[]; rows: JsonRow[] } {
  const columns: string[] = []
  const seen = new Set<string>()
  const rows = rawRows.map((raw) => {
    const source = (raw ?? {}) as Record<string, unknown>
    const row: JsonRow = {}
    for (const key of Object.keys(source)) {
      if (!seen.has(key)) {
        seen.add(key)
        columns.push(key)
      }
      row[key] = plainValue(source[key])
    }
    return row
  })
  return { columns, rows }
}

function rowBytes(row: JsonRow): number {
  let total = 0
  for (const value of Object.values(row)) {
    total += typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 8
  }
  return total
}

function clipRow(row: JsonRow): JsonRow {
  const clipped: JsonRow = {}
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'string' && value.length > CELL_MAX_CHARS) {
      clipped[key] = `${value.slice(0, CELL_MAX_CHARS)}…（截断，共 ${value.length} 字符）`
    } else {
      clipped[key] = value
    }
  }
  return clipped
}

/** Enforce the row-count and byte caps; clip oversized cells along the way. */
export function truncateRows(
  rows: JsonRow[],
  maxRows: number,
  maxBytes: number,
): { rows: JsonRow[]; rowCount: number; truncated: boolean; bytes: number } {
  const output: JsonRow[] = []
  let bytes = 0
  let truncated = false
  for (const raw of rows) {
    if (output.length >= maxRows) {
      truncated = true
      break
    }
    const row = clipRow(raw)
    const size = rowBytes(row)
    if (bytes + size > maxBytes && output.length > 0) {
      truncated = true
      break
    }
    output.push(row)
    bytes += size
  }
  return { rows: output, rowCount: output.length, truncated, bytes }
}
