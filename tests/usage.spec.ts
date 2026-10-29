import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { UsageTracker } from '../src/usage.js'

const dirs: string[] = []
function makeTracker(): { tracker: UsageTracker; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbm-usage-'))
  dirs.push(dir)
  const file = path.join(dir, 'usage.json')
  return { tracker: new UsageTracker({ file }), file }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('UsageTracker', () => {
  it('records session and workspace usage, snapshot sorted by recency', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbm-usage-'))
    dirs.push(dir)
    let tick = 2_000_000
    const tracker = new UsageTracker({ file: path.join(dir, 'usage.json'), now: () => ++tick })
    tracker.record('conn-a', 'session-1', 'D:/proj/a', 'db_query')
    tracker.record('conn-a', 'session-1', 'D:/proj/a', 'db_query')
    tracker.record('conn-a', 'session-2', 'D:/proj/b', 'db_test_connection')
    await tracker.flush()
    const snap = tracker.snapshot()
    const a = snap['conn-a']
    expect(a.sessions).toHaveLength(2)
    expect(a.sessions[0]?.sessionId).toBe('session-2') // most recent first
    expect(a.sessions[1]?.count).toBe(2)
    expect(a.workspaces).toHaveLength(2)
    expect(a.workspaces.map((w) => w.path)).toEqual(['D:/proj/b', 'D:/proj/a'])
  })

  it('persists workspace aggregation across tracker instances', async () => {
    const { tracker, file } = makeTracker()
    tracker.record('conn-a', 'session-1', 'D:/proj/a')
    await tracker.flush()
    const revived = new UsageTracker({ file })
    const snap = revived.snapshot()
    expect(snap['conn-a']?.workspaces).toHaveLength(1)
    expect(snap['conn-a']?.workspaces[0]?.path).toBe('D:/proj/a')
    expect(snap['conn-a']?.workspaces[0]?.count).toBe(1)
    // session detail is process-local and does not survive
    expect(snap['conn-a']?.sessions).toHaveLength(0)
  })

  it('caps sessions per connection, keeping the most recent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbm-usage-'))
    dirs.push(dir)
    let tick = 1_000_000
    const tracker = new UsageTracker({ file: path.join(dir, 'usage.json'), now: () => ++tick })
    for (let i = 0; i < 40; i += 1) {
      tracker.record('conn-a', `session-${i}`, 'D:/proj/a')
    }
    await tracker.flush()
    const snap = tracker.snapshot()
    expect(snap['conn-a']?.sessions.length).toBeLessThanOrEqual(32)
    expect(snap['conn-a']?.sessions[0]?.sessionId).toBe('session-39')
    expect(snap['conn-a']?.sessions.map((s) => s.sessionId)).not.toContain('session-0')
  })

  it('starts fresh from a corrupt file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbm-usage-'))
    dirs.push(dir)
    const file = path.join(dir, 'usage.json')
    fs.writeFileSync(file, '{ not json', 'utf8')
    const tracker = new UsageTracker({ file })
    expect(tracker.snapshot()).toEqual({})
  })

  it('ignores empty connection names', async () => {
    const { tracker } = makeTracker()
    tracker.record('', 'session-1', 'D:/proj/a')
    await tracker.flush()
    expect(tracker.snapshot()).toEqual({})
  })
})
