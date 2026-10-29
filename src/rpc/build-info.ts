/**
 * Stale-build detection.
 *
 * A DSH plugin is loaded into the host process at startup: after the code is
 * rebuilt, the *running* process keeps the modules it already imported. Client
 * -half changes appear on a page refresh, Host-half changes do not — which
 * makes "I changed the Host, refreshed the page, and now an RPC 404s" an easy
 * trap (it happened twice on this plugin).
 *
 * The fix is to let the page ask the host what it actually loaded: the host
 * fingerprints its own `lib/` directory once at startup and re-fingerprints it
 * on demand. A difference means "the code on disk is not the code that is
 * running" → the GUI shows a restart banner.
 *
 * Content hashes (not mtimes) are used so a mere `touch` does not cry wolf.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/** `lib/` of the running plugin (this file lives in `lib/rpc/`). */
export function runningLibDir(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)))
}

export interface ArtifactSignature {
  files: number
  bytes: number
  /** 16 hex chars over every (relative path, content) pair. */
  hash: string
  /** Newest mtime among the artifacts — informational only. */
  newestMtimeMs: number
}

export interface BuildInfo {
  /** Where the fingerprint was taken from (may not exist in exotic layouts). */
  libDir: string
  loadedAt: number
  /** Fingerprint of the code this process loaded; null when unreadable. */
  loaded: ArtifactSignature | null
}

function collectFiles(dir: string, base: string, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectFiles(full, base, out)
    } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs') || entry.name.endsWith('.cjs'))) {
      out.push(path.relative(base, full).replace(/\\/g, '/'))
    }
  }
}

/** Fingerprint every JS artifact under `dir` (sorted, content-hashed). */
export function scanArtifacts(dir: string): ArtifactSignature | null {
  const files: string[] = []
  collectFiles(dir, dir, files)
  if (files.length === 0) return null
  const digest = createHash('sha256')
  let bytes = 0
  let newestMtimeMs = 0
  for (const relative of files) {
    let content: Buffer
    let stat: fs.Stats
    try {
      content = fs.readFileSync(path.join(dir, relative))
      stat = fs.statSync(path.join(dir, relative))
    } catch {
      continue
    }
    bytes += content.length
    newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs)
    digest.update(relative)
    digest.update('\u0000')
    digest.update(content)
    digest.update('\u0000')
  }
  return { files: files.length, bytes, hash: digest.digest('hex').slice(0, 16), newestMtimeMs }
}

/** Capture the fingerprint at plugin load time. */
export function captureBuildInfo(now: () => number = Date.now): BuildInfo {
  const libDir = runningLibDir()
  return { libDir, loadedAt: now(), loaded: scanArtifacts(libDir) }
}

export interface BuildStatus extends BuildInfo {
  /** Fingerprint currently on disk. */
  current: ArtifactSignature | null
  /**
   * true when the on-disk artifacts differ from the ones this process loaded —
   * i.e. a restart is required for Host-half changes to take effect.
   */
  stale: boolean
}

export function buildStatus(info: BuildInfo): BuildStatus {
  const current = scanArtifacts(info.libDir)
  const stale = current !== null && info.loaded !== null && current.hash !== info.loaded.hash
  return { ...info, current, stale }
}
