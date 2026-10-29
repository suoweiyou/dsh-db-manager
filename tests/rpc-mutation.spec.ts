import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigStore } from '../src/config/store.js'
import { deleteConnection, saveConnection } from '../src/config/mutate.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function makeStore(fileContent?: string): { store: ConfigStore; globalPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbm-rpc-'))
  dirs.push(dir)
  const globalPath = path.join(dir, 'connections.json')
  if (fileContent !== undefined) fs.writeFileSync(globalPath, fileContent, 'utf8')
  return { store: new ConfigStore({ globalConfigPath: globalPath }), globalPath }
}

const GOOD_SAVE_BODY = {
  connection: { name: 'new-conn', host: 'h', username: 'u', passwordMode: 'env', passwordEnv: 'MYSQL_PW' },
}

describe('config mutation guards for corrupt global files (audit M5)', () => {
  it('refuses to save and leaves the file untouched when it is not valid JSON', () => {
    const corrupt = '{ "connections": [ { "name": "a" },'
    const { store, globalPath } = makeStore(corrupt)
    const outcome = saveConnection(store, GOOD_SAVE_BODY)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('不是合法 JSON')
    expect(outcome.error).toContain('丢失现有连接')
    expect(fs.readFileSync(globalPath, 'utf8')).toBe(corrupt)
  })

  it('refuses to delete when the file cannot be parsed', () => {
    const corrupt = 'not-json-at-all'
    const { store, globalPath } = makeStore(corrupt)
    const outcome = deleteConnection(store, 'a')
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('不是合法 JSON')
    expect(fs.readFileSync(globalPath, 'utf8')).toBe(corrupt)
  })

  it('still saves normally when the file is missing or valid', () => {
    const { store, globalPath } = makeStore(undefined)
    const outcome = saveConnection(store, GOOD_SAVE_BODY)
    expect(outcome.ok).toBe(true)
    expect(outcome.name).toBe('new-conn')
    const saved = JSON.parse(fs.readFileSync(globalPath, 'utf8')) as { connections: Array<{ name: string; password: string }> }
    expect(saved.connections).toHaveLength(1)
    expect(saved.connections[0]!.password).toBe('$ENV:MYSQL_PW')

    const removed = deleteConnection(store, 'new-conn')
    expect(removed.ok).toBe(true)
    expect((JSON.parse(fs.readFileSync(globalPath, 'utf8')) as { connections: unknown[] }).connections).toHaveLength(0)
  })
})
