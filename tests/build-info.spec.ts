/**
 * Stale-build detection: the host fingerprints the artifacts it loaded, and the
 * page compares that with what is on disk. This is what turns "an RPC 404s
 * after a rebuild" into an explicit "restart DSH" banner.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildStatus, captureBuildInfo, scanArtifacts, type BuildInfo } from '../src/rpc/build-info.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function libDirWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbm-build-'))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content, 'utf8')
  }
  return dir
}

describe('scanArtifacts — content-addressed fingerprint', () => {
  it('returns null when there is nothing to fingerprint', () => {
    expect(scanArtifacts(libDirWith({}))).toBeNull()
    expect(scanArtifacts(path.join(os.tmpdir(), 'dbm-does-not-exist-xyz'))).toBeNull()
  })

  it('fingerprints nested JS artifacts and ignores non-JS files', () => {
    const dir = libDirWith({ 'index.js': 'a', 'rpc/routes.js': 'b', 'readme.md': 'c', 'types.d.ts': 'd' })
    const signature = scanArtifacts(dir)
    expect(signature?.files).toBe(2)
    expect(signature?.bytes).toBe(2)
    expect(signature?.hash).toHaveLength(16)
  })

  it('is stable across calls and insensitive to a mere touch (mtime only)', () => {
    const dir = libDirWith({ 'index.js': 'same', 'rpc/x.js': 'same2' })
    const first = scanArtifacts(dir)
    // Rewrite identical content (new mtime) — the fingerprint must not move,
    // otherwise every editor save would cry wolf.
    fs.writeFileSync(path.join(dir, 'index.js'), 'same', 'utf8')
    const second = scanArtifacts(dir)
    expect(second?.hash).toBe(first?.hash)
  })

  it('changes when content changes anywhere in the tree', () => {
    const dir = libDirWith({ 'index.js': 'v1', 'rpc/x.js': 'v1' })
    const before = scanArtifacts(dir)
    fs.writeFileSync(path.join(dir, 'rpc', 'x.js'), 'v2', 'utf8')
    const after = scanArtifacts(dir)
    expect(after?.hash).not.toBe(before?.hash)
  })

  it('changes when a file is added or removed', () => {
    const dir = libDirWith({ 'index.js': 'x' })
    const before = scanArtifacts(dir)
    fs.writeFileSync(path.join(dir, 'extra.js'), 'y', 'utf8')
    const added = scanArtifacts(dir)
    expect(added?.hash).not.toBe(before?.hash)
    fs.rmSync(path.join(dir, 'extra.js'))
    expect(scanArtifacts(dir)?.hash).toBe(before?.hash)
  })
})

describe('buildStatus — what the GUI banner is driven by', () => {
  function snapshot(dir: string): BuildInfo {
    return { libDir: dir, loadedAt: Date.now(), loaded: scanArtifacts(dir) }
  }

  it('reports stale=false when the disk still matches what was loaded', () => {
    const dir = libDirWith({ 'index.js': 'v1' })
    const status = buildStatus(snapshot(dir))
    expect(status.stale).toBe(false)
    expect(status.current?.hash).toBe(status.loaded?.hash)
  })

  it('reports stale=true after a rebuild changes the artifacts', () => {
    const dir = libDirWith({ 'index.js': 'v1' })
    const info = snapshot(dir)
    // Simulate `node scripts/build-sandbox.mjs` rewriting lib/.
    fs.writeFileSync(path.join(dir, 'index.js'), 'v2', 'utf8')
    const status = buildStatus(info)
    expect(status.stale).toBe(true)
    expect(status.current?.hash).not.toBe(status.loaded?.hash)
  })

  it('stays quiet when nothing is readable (no false alarm)', () => {
    const info: BuildInfo = { libDir: path.join(os.tmpdir(), 'dbm-absent-xyz'), loadedAt: Date.now(), loaded: null }
    expect(buildStatus(info).stale).toBe(false)
  })

  it('captureBuildInfo fingerprints the directory this module was loaded from', () => {
    const info = captureBuildInfo()
    expect(path.isAbsolute(info.libDir)).toBe(true)
    // The derived directory must be the one holding this very module
    // (`<plugin>/lib/rpc/build-info.js` in production).
    expect(fs.existsSync(path.join(info.libDir, 'rpc', 'build-info.js'))).toBe(true)
    expect(info.loaded === null || info.loaded.files > 0).toBe(true)
    // A freshly captured snapshot is by definition not stale.
    expect(buildStatus(info).stale).toBe(false)
  })
})
