#!/usr/bin/env node
/**
 * db-manager-encrypt — offline helper that turns one plaintext password into
 * the `enc:v1:...` ciphertext form accepted by dsh-db-manager config files.
 *
 * Usage:
 *   node bin/encrypt.js                 # interactive (visible input) or pipe via stdin
 *   echo -n "secret" | node bin/encrypt.js
 *   node bin/encrypt.js --key <path>    # custom key file (default: <DSH_HOME|~/.dsh>/db-manager/secret.key)
 *
 * Run this in YOUR terminal, never through an AI conversation, so the
 * plaintext never enters model context.
 */
import { createCipheriv, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const ENC_PREFIX = 'enc:v1:'

function parseArgs(argv) {
  const args = { key: undefined }
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--key') {
      args.key = argv[i + 1]
      i += 1
    }
  }
  return args
}

function defaultKeyPath() {
  const base = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(base, 'db-manager', 'secret.key')
}

function loadOrCreateKey(keyPath) {
  let existing
  try {
    existing = fs.readFileSync(keyPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error(`无法读取密钥文件 ${keyPath}：${error?.message ?? error}`)
      process.exit(1)
    }
  }
  if (existing !== undefined) {
    if (existing.length === 32) return existing
    // Audit N6 (2nd round): never overwrite an existing file with a fresh
    // key — a wrong --key path would silently destroy it.
    console.error(`密钥文件已存在但长度不是 32 字节（实际 ${existing.length}）：${keyPath}`)
    console.error('为避免覆盖已有文件，已拒绝继续。确认该文件可弃置后请手动删除，或用 --key 指定其他路径。')
    process.exit(1)
  }
  const key = randomBytes(32)
  fs.mkdirSync(path.dirname(keyPath), { recursive: true })
  try {
    fs.writeFileSync(keyPath, key, { mode: 0o600 })
  } catch {
    fs.writeFileSync(keyPath, key)
  }
  return key
}

function encrypt(plain, keyPath) {
  const key = loadOrCreateKey(keyPath)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${ENC_PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${data.toString('base64url')}`
}

async function readPipedStdin() {
  if (process.stdin.isTTY) return undefined
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}

async function promptVisible(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise((resolve) => rl.question(question, resolve))
    return answer
  } finally {
    rl.close()
  }
}

async function main() {
  const args = parseArgs(process.argv)
  const keyPath = args.key ?? defaultKeyPath()
  let plain = await readPipedStdin()
  if (plain === undefined || plain.length === 0) {
    console.error('提示：输入将回显在终端（无隐藏输入）。若担心，可改用管道：echo -n "secret" | node bin/encrypt.js')
    plain = await promptVisible('请输入要加密的密码：')
  }
  if (plain === undefined || plain.length === 0) {
    console.error('未提供任何输入。')
    process.exit(1)
  }
  const cipherText = encrypt(plain, keyPath)
  console.log(cipherText)
  console.error(`\n已用密钥文件：${keyPath}`)
  console.error('把上面第一行整体粘贴到配置文件的 password 字段。注意：密文绑定生成它的这台机器（密钥文件在本机）。跨机器请改用 "$ENV:VAR" 形式。')
}

main().catch((error) => {
  console.error('加密失败：', error?.message ?? error)
  process.exit(1)
})
