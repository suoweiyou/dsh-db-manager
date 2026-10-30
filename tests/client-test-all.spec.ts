/**
 * Tests for the batched「全部测试」sweep (v0.22).
 *
 * Two behaviours are pinned here, because both were broken before:
 *
 *   1. `runPool` — the page drives the sweep itself (concurrency 4) so每个结果一到就
 *      落到卡片上. It must never exceed the cap, must visit every item exactly once,
 *      and must survive a worker that throws (one dead host cannot abort the batch).
 *   2. `statusMapFrom` — verdicts coming from the host cache must be keyed with
 *      `stateKey`, not the bare connection name. Before this, the host cache and the
 *      old host-side batch wrote `statuses['mydb']` while every card read
 *      `statuses['g␟mydb']`, so a sweep painted nothing.
 */
import { describe, expect, it } from 'vitest'
import { pruneStatusMap, runPool, stateKey, statusMapFrom, TEST_ALL_CONCURRENCY } from '../src/client/Section.js'
import type { TestResultView } from '../src/client/api.js'

function verdict(name: string, extra?: Partial<TestResultView>): TestResultView {
  return { name, ok: true, latencyMs: 12, testedAt: 1_700_000_000_000, ...extra }
}

describe('runPool — 「全部测试」的并发扇出', () => {
  it('上限不超过 concurrency，且每条都恰好跑一次', async () => {
    const items = Array.from({ length: 11 }, (_unused, index) => index)
    const seen: number[] = []
    let inFlight = 0
    let peak = 0
    await runPool(items, 4, async (item) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      // 让出事件循环，否则所有 lane 会串行完成，测不出并发上限
      await new Promise((resolve) => setTimeout(resolve, 1))
      seen.push(item)
      inFlight -= 1
    })
    expect(peak).toBe(4)
    expect(peak).toBeLessThanOrEqual(TEST_ALL_CONCURRENCY)
    expect([...seen].sort((a, b) => a - b)).toEqual(items)
  })

  it('某个 worker 抛错不影响其余条目', async () => {
    const done: string[] = []
    await runPool(['ok-1', 'boom', 'ok-2'], 2, async (item) => {
      if (item === 'boom') throw new Error('一条连接炸了，不该带走整批')
      done.push(item)
    })
    expect(done.sort()).toEqual(['ok-1', 'ok-2'])
  })

  it('空列表与单条都能正常收尾', async () => {
    const seen: number[] = []
    await runPool([], 4, async (item) => {
      seen.push(item as number)
    })
    expect(seen).toEqual([])
    await runPool([7], 4, async (item) => {
      seen.push(item)
    })
    expect(seen).toEqual([7])
  })

  it('concurrency 传 0 或负数时退化成串行，而不是挂死', async () => {
    const seen: number[] = []
    await runPool([1, 2, 3], 0, async (item) => {
      seen.push(item)
    })
    expect(seen).toEqual([1, 2, 3])
  })
})

describe('statusMapFrom — 状态表的 key 必须是 stateKey', () => {
  it('全局结果落到 g␟<name>，而不是裸名字', () => {
    const map = statusMapFrom([verdict('mydb', { scope: 'global' })])
    expect(Object.keys(map)).toEqual([stateKey('global', 'mydb')])
    expect(map[stateKey('global', 'mydb')]?.ok).toBe(true)
    // 裸名字必须没有条目：卡片永远按 stateKey 读，两者混用就是 v0.17~v0.21 的空点
    expect(map['mydb']).toBeUndefined()
  })

  it('同名的项目连接与全局连接各占一个 key，不会互相覆盖', () => {
    const map = statusMapFrom([
      verdict('mydb', { scope: 'global', latencyMs: 11 }),
      verdict('mydb', { scope: 'workspace', workspace: '/data/repo', latencyMs: 99 }),
    ])
    expect(Object.keys(map).sort()).toEqual([stateKey('global', 'mydb'), stateKey('workspace', 'mydb', '/data/repo')].sort())
    expect(map[stateKey('global', 'mydb')]?.latencyMs).toBe(11)
    expect(map[stateKey('workspace', 'mydb', '/data/repo')]?.latencyMs).toBe(99)
  })

  it('老宿主没带 scope 时按全局处理（升级期间的兼容）', () => {
    const map = statusMapFrom([verdict('legacy')])
    expect(Object.keys(map)).toEqual([stateKey('global', 'legacy')])
  })

  it('空缓存返回空表', () => {
    expect(statusMapFrom([])).toEqual({})
  })
})

describe('pruneStatusMap — 刷新时只丢掉已经没有卡片的结论', () => {
  it('全局连接被删除后，它的绿点不会留下来', () => {
    const map = { ...statusMapFrom([verdict('kept', { scope: 'global' }), verdict('deleted', { scope: 'global' })]) }
    const pruned = pruneStatusMap(map, ['kept'])
    expect(Object.keys(pruned)).toEqual([stateKey('global', 'kept')])
  })

  it('项目连接的结论不受全局列表刷新影响', () => {
    const wsKey = stateKey('workspace', 'mydb', '/data/repo')
    const map = { ...statusMapFrom([verdict('mydb', { scope: 'workspace', workspace: '/data/repo' })]) }
    const pruned = pruneStatusMap(map, [])
    expect(Object.keys(pruned)).toEqual([wsKey])
    expect(pruned[wsKey]?.ok).toBe(true)
  })
})
