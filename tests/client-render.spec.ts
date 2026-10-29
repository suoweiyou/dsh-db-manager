/**
 * Render-level tests for the connection card.
 *
 * Three things are pinned here:
 *   1. both tabs render the SAME card — the「项目」tab used to hand-roll a
 *      reduced row, so project connections had no「查看表」(table list /
 *      columns / indexes / DDL) and no usage details;
 *   2. the project card's「测试」button wrote its verdict into state that
 *      nothing rendered, so clicking it looked like a no-op;
 *   3. per-connection UI state is keyed by source + name, so a project
 *      connection and a global one with the same name do not share panels.
 *
 * The renderers are called directly and the element tree is flattened to text,
 * which is the closest thing to "does the user see it" without a browser.
 */
import { describe, expect, it } from 'vitest'
import { groupConnections, groupStateKey, renderBoundCard, renderCard, renderEditor, renderGroupSection, renderProjectCard, renderSshCard, stateKey, UNGROUPED_LABEL, type CardBinding } from '../src/client/Section.js'
import type { ConnectionListItem, SshProfileView, TableListItem, TestResultView, WorkspaceListItem } from '../src/client/api.js'

/** Collect every string rendered anywhere in an element tree. */
function flatten(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string') {
    out.push(node)
    return out
  }
  if (typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
    return out
  }
  if (typeof node === 'object') {
    const props = (node as { props?: { children?: unknown } }).props
    if (props !== undefined) flatten(props.children, out)
  }
  return out
}

function textOf(node: unknown): string {
  return flatten(node).join('|')
}

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const globalItem: ConnectionListItem = {
  name: 'app-dev', dialect: 'mysql', host: '10.0.0.9', port: 3306, defaultDatabase: 'app_dev',
  mode: 'readonly', scope: 'global', hasPassword: true,
}

const projectItem: ConnectionListItem = { ...globalItem, scope: 'workspace', sshProfile: 'jump-prod' }

const workspace: WorkspaceListItem = {
  path: 'D:/proj/my-app',
  configPath: 'D:/proj/my-app/.dsh/db-manager.json',
  exists: true,
  connections: [projectItem],
  warnings: [],
}

function cardHandlers(overrides: Partial<Parameters<typeof renderCard>[5]> = {}): Parameters<typeof renderCard>[5] {
  return {
    busy: false,
    confirming: false,
    onTest: () => undefined,
    onEdit: () => undefined,
    onDuplicate: () => undefined,
    onDeleteAsk: () => undefined,
    onDeleteConfirm: () => undefined,
    onDeleteCancel: () => undefined,
    onToggleUsage: () => undefined,
    onBrowse: () => undefined,
    onBrowseSelect: () => undefined,
    onBrowseBack: () => undefined,
    onBrowseClose: () => undefined,
    ...overrides,
  }
}

function tableList(): TableListItem[] {
  return [
    { name: 'orders', type: 'BASE TABLE', comment: '订单' },
    { name: 'order_view', type: 'VIEW' },
  ]
}

/* ── state keying ─────────────────────────────────────────────────────────── */

describe('stateKey — global and project connections must not share state', () => {
  it('separates the same name across sources', () => {
    expect(stateKey('global', 'app-dev')).toBe('g\u241fapp-dev')
    expect(stateKey('workspace', 'app-dev', 'D:/proj/my-app')).toBe('w\u241fD:/proj/my-app\u241fapp-dev')
    expect(stateKey('global', 'app-dev')).not.toBe(stateKey('workspace', 'app-dev', 'D:/proj/my-app'))
  })

  it('separates the same name across different projects', () => {
    expect(stateKey('workspace', 'app-dev', 'D:/a')).not.toBe(stateKey('workspace', 'app-dev', 'D:/b'))
  })
})

/* ── the shared card ──────────────────────────────────────────────────────── */

describe('renderCard — one card for both sources', () => {
  it('labels the source so a project connection is not mistaken for a global one', () => {
    expect(textOf(renderCard(globalItem, undefined, undefined, false, undefined, cardHandlers()))).toContain('全局')
    expect(textOf(renderCard(projectItem, undefined, undefined, false, undefined, cardHandlers()))).toContain('项目')
  })

  it('offers 查看表 on both sources', () => {
    expect(textOf(renderCard(globalItem, undefined, undefined, false, undefined, cardHandlers()))).toContain('查看表')
    expect(textOf(renderCard(projectItem, undefined, undefined, false, undefined, cardHandlers()))).toContain('查看表')
  })

  it('marks the SSH jump host and an invalid record', () => {
    const text = textOf(renderCard({ ...projectItem, invalid: true }, undefined, undefined, false, undefined, cardHandlers()))
    expect(text).toContain('SSH jump-prod')
    expect(text).toContain('字段不合法')
  })

  it('hides host:port for sqlite (there is no endpoint)', () => {
    const sqlite: ConnectionListItem = { name: 'local', dialect: 'sqlite', file: 'D:/data/app.db', mode: 'readonly', scope: 'global', hasPassword: false }
    const text = textOf(renderCard(sqlite, undefined, undefined, false, undefined, cardHandlers()))
    expect(text).not.toContain('undefined')
    expect(text).toContain('D:/data/app.db')
  })

  it('shows the test verdict, including the hint', () => {
    const failed: TestResultView = { name: 'app-dev', ok: false, errorKind: 'auth', message: 'Access denied for user', hint: '检查密码', testedAt: Date.now() }
    const text = textOf(renderCard(projectItem, failed, undefined, false, undefined, cardHandlers()))
    expect(text).toContain('不可达')
    expect(text).toContain('Access denied for user')
    expect(text).toContain('检查密码')
  })

  it('shows a testing placeholder while a probe is running', () => {
    const text = textOf(renderCard(projectItem, undefined, undefined, false, undefined, cardHandlers({ busy: true })))
    expect(text).toContain('正在测试')
  })

  it('renders the table list when the browse panel is open (查看表结构)', () => {
    const browse = { phase: 'list' as const, loading: false, database: 'app_dev', tables: tableList() }
    const text = textOf(renderCard(projectItem, undefined, undefined, false, browse, cardHandlers()))
    expect(text).toContain('orders')
    expect(text).toContain('order_view')
    expect(text).toContain('收起表')
  })

  it('renders usage details when expanded', () => {
    const usage = { sessions: [{ sessionId: 'abcdef1234', cwd: 'D:/proj/my-app', lastUsedAt: Date.now(), count: 3, lastAction: 'db_query' }], workspaces: [] }
    const text = textOf(renderCard(projectItem, undefined, usage, true, undefined, cardHandlers()))
    expect(text).toContain('使用：')
    expect(text).toContain('db_query')
  })
})

describe('renderBoundCard — the binding carries the full feature set', () => {
  it('renders every action for a project-private connection', () => {
    const binding: CardBinding = {
      key: stateKey('workspace', 'app-dev', 'D:/proj/my-app'),
      item: projectItem,
      status: undefined,
      usage: undefined,
      usageOpen: false,
      browse: undefined,
      busy: false,
      confirming: false,
      onTest: () => undefined,
      onEdit: () => undefined,
      onDuplicate: () => undefined,
      onDeleteAsk: () => undefined,
      onDeleteConfirm: () => undefined,
      onDeleteCancel: () => undefined,
      onToggleUsage: () => undefined,
      onBrowse: () => undefined,
      onBrowseSelect: () => undefined,
      onBrowseBack: () => undefined,
      onBrowseClose: () => undefined,
    }
    const text = textOf(renderBoundCard(binding))
    for (const label of ['测试', '查看表', '编辑', '删除', '项目', '只读', 'MySQL']) {
      expect(text).toContain(label)
    }
  })
})

/* ── the project card delegates to the shared card ────────────────────────── */

function projectHandlers(overrides: Partial<Parameters<typeof renderProjectCard>[1]> = {}): Parameters<typeof renderProjectCard>[1] {
  return {
    expanded: true,
    onToggle: () => undefined,
    onAdd: () => undefined,
    cardKeyFor: (item) => stateKey(item.scope, item.name, workspace.path),
    renderConnectionCard: (item) => renderCard(item, undefined, undefined, false, undefined, cardHandlers()),
    editorFor: () => null,
    newEditorSlot: null,
    collapsedGroups: {},
    onToggleGroup: () => undefined,
    ...overrides,
  }
}

describe('renderProjectCard — project connections get the full card', () => {
  it('renders the shared card (查看表 + source badge) inside the project', () => {
    const text = textOf(renderProjectCard(workspace, projectHandlers()))
    expect(text).toContain('查看表')
    expect(text).toContain('项目')
    expect(text).toContain('app-dev')
    expect(text).toContain('10.0.0.9:3306')
  })

  it('passes the verdict through so the result is visible', () => {
    const failed: TestResultView = { name: 'app-dev', ok: false, errorKind: 'network', message: 'connect ETIMEDOUT', testedAt: Date.now() }
    const text = textOf(renderProjectCard(workspace, projectHandlers({
      renderConnectionCard: (item) => renderCard(item, failed, undefined, false, undefined, cardHandlers()),
    })))
    expect(text).toContain('不可达')
    expect(text).toContain('connect ETIMEDOUT')
  })

  it('renders the table list for a project connection', () => {
    const browse = { phase: 'list' as const, loading: false, database: 'app_dev', tables: tableList() }
    const text = textOf(renderProjectCard(workspace, projectHandlers({
      renderConnectionCard: (item) => renderCard(item, undefined, undefined, false, browse, cardHandlers()),
    })))
    expect(text).toContain('orders')
    expect(text).toContain('order_view')
  })

  it('still renders the inline editor slots and project metadata', () => {
    const slot = { type: 'div', props: { children: 'EDITOR_SLOT' } } as unknown as ReturnType<typeof renderProjectCard>
    const text = textOf(renderProjectCard(workspace, projectHandlers({ editorFor: () => slot, newEditorSlot: slot })))
    expect(text).toContain('EDITOR_SLOT')
    expect(text).toContain('项目私有连接')
    expect(text).toContain('1 个项目私有连接')
  })
})

/* ── editor: changing a connection's owner ────────────────────────────────── */

describe('renderEditor — 「所属」 lets a connection change owner', () => {
  type OpenEditor = Extract<Parameters<typeof renderEditor>[0], { open: true }>

  function editorState(overrides: Record<string, unknown> = {}): OpenEditor {
    return {
      open: true,
      scope: 'global',
      destScope: 'global',
      originalName: 'app-dev',
      name: 'app-dev',
      dialect: 'mysql',
      host: '10.0.0.9',
      port: '3306',
      username: 'u',
      defaultDatabase: 'app_dev',
      file: '',
      mode: 'readonly',
      comment: '',
      passwordMode: 'keep',
      passwordEnv: '',
      passwordPlain: '',
      passwordEnc: '',
      sshProfile: '',
      ...overrides,
    } as OpenEditor
  }

  const handlers = { onSave: () => undefined, onCancel: () => undefined, onField: () => undefined }
  const projects = [{ path: 'D:/proj/my-app', label: 'my-app' }]

  it('offers global plus every observed project as a destination', () => {
    const text = textOf(renderEditor(editorState(), null, handlers, [], projects))
    expect(text).toContain('所属')
    expect(text).toContain('全局（所有项目共享）')
    expect(text).toContain('项目：my-app')
    expect(text).toContain('~/.dsh/db-manager/connections.json')
  })

  it('marks a cross-file edit and names the original location', () => {
    const moving = editorState({ scope: 'global', destScope: 'workspace', destWorkspace: 'D:/proj/my-app' })
    const text = textOf(renderEditor(moving, null, handlers, [], projects))
    expect(text).toContain('（将更改所属）')
    expect(text).toContain('原位置')
    expect(text).toContain('D:/proj/my-app/.dsh/db-manager.json')
    expect(text).toContain('密码等机密原样保留')
  })

  it('promoting a project connection back to global is also a move', () => {
    const promoting = editorState({ scope: 'workspace', workspace: 'D:/proj/my-app', destScope: 'global', destWorkspace: undefined })
    const text = textOf(renderEditor(promoting, null, handlers, [], projects))
    expect(text).toContain('（将更改所属）')
    expect(text).toContain('D:/proj/my-app/.dsh/db-manager.json')
  })

  it('does not claim a move when the owner is unchanged', () => {
    const text = textOf(renderEditor(editorState({ scope: 'global', destScope: 'global' }), null, handlers, [], projects))
    expect(text).not.toContain('（将更改所属）')
    expect(text).not.toContain('原位置')
  })

  it('explains an empty project list instead of showing a dead dropdown', () => {
    const text = textOf(renderEditor(editorState(), null, handlers, [], []))
    expect(text).toContain('没有可选的观测项目')
  })
})

/* ── SSH card ─────────────────────────────────────────────────────────────── */

const sshProfile: SshProfileView = {
  name: 'jump-prod', scope: 'global', host: '10.0.0.5', port: 22, username: 'deploy',
  authMethod: 'password', hasPassword: true,
}

function sshHandlers(): Parameters<typeof renderSshCard>[3] {
  return {
    confirming: false,
    onTest: () => undefined,
    onEdit: () => undefined,
    onDeleteAsk: () => undefined,
    onDeleteConfirm: () => undefined,
    onDeleteCancel: () => undefined,
  }
}

describe('renderSshCard — test affordance and verdict', () => {
  it('offers a test button and shows 未测试 initially', () => {
    const text = textOf(renderSshCard(sshProfile, undefined, false, sshHandlers()))
    expect(text).toContain('测试连接')
    expect(text).toContain('未测试')
    // Secrets are never echoed — only their presence.
    expect(text).toContain('已配置机密')
  })

  it('shows a testing state while busy', () => {
    const text = textOf(renderSshCard(sshProfile, undefined, true, sshHandlers()))
    expect(text).toContain('测试中')
    expect(text).toContain('正在建立 SSH 连接')
  })

  it('shows an authentication failure with its hint', () => {
    const failed: TestResultView = {
      name: 'jump-prod', ok: false, errorKind: 'auth', message: 'SSH 认证失败（All configured authentication methods failed）',
      hint: '检查密码', testedAt: Date.now(),
    }
    const text = textOf(renderSshCard(sshProfile, failed, false, sshHandlers()))
    expect(text).toContain('不可达')
    expect(text).toContain('SSH 认证失败')
    expect(text).toContain('检查密码')
  })

  it('shows the latency on success', () => {
    const ok: TestResultView = { name: 'jump-prod', ok: true, latencyMs: 120, testedAt: Date.now() }
    const text = textOf(renderSshCard(sshProfile, ok, false, sshHandlers()))
    expect(text).toContain('可达')
    expect(text).toContain('120ms')
  })
})

/* ── v0.21: duplicate button ──────────────────────────────────────────────── */

describe('renderCard — the duplicate action', () => {
  it('offers 复制 next to 编辑 and disables it while busy', () => {
    const idle = textOf(renderCard(globalItem, undefined, undefined, false, undefined, cardHandlers()))
    expect(idle).toContain('复制')
    const busy = textOf(renderCard(globalItem, undefined, undefined, false, undefined, cardHandlers({ busy: true })))
    expect(busy).toContain('复制中…')
  })

  it('does not put 复制 on the SSH profile card', () => {
    // Copying an SSH profile is not a feature — the button must not leak there.
    const text = textOf(renderSshCard(sshProfile, undefined, false, sshHandlers()))
    expect(text).not.toContain('复制')
  })
})

/* ── v0.21: grouping ──────────────────────────────────────────────────────── */

describe('groupConnections — bucketing by the display label', () => {
  it('sorts named groups, keeps the ungrouped bucket last', () => {
    const items: ConnectionListItem[] = [
      { ...globalItem, name: 'zeta', group: '生产库' },
      { ...globalItem, name: 'loose' },
      { ...globalItem, name: 'alpha', group: '开发库' },
      { ...globalItem, name: 'beta', group: '生产库' },
    ]
    const groups = groupConnections(items)
    expect(groups.map((g) => g.label)).toEqual(['开发库', '生产库', null])
    // Order inside a bucket is the caller's (already name-sorted) order.
    expect(groups[1].items.map((i) => i.name)).toEqual(['zeta', 'beta'])
    expect(groups[2].items.map((i) => i.name)).toEqual(['loose'])
  })

  it('treats blank/whitespace labels as ungrouped and returns one flat bucket when unused', () => {
    const groups = groupConnections([{ ...globalItem, group: '   ' }, { ...globalItem, name: 'b' }])
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBeNull()
    expect(groups[0].items).toHaveLength(2)
  })

  it('scopes the collapse key to the source so two projects do not share it', () => {
    // stateKey uses the scope only as the g/w discriminator, so the label lives
    // in the name half — under its own `group:` namespace, which keeps a group
    // from colliding with a connection of the same name.
    expect(groupStateKey('生产库')).toBe('g\u241fgroup:生产库')
    expect(groupStateKey(null)).toBe('g\u241fgroup:__ungrouped__')
    expect(groupStateKey('生产库', 'D:/proj/a')).toBe('w\u241fD:/proj/a\u241fgroup:生产库')
    expect(groupStateKey('生产库', 'D:/proj/a')).not.toBe(groupStateKey('生产库', 'D:/proj/b'))
    // The whole point of the namespace: a connection called 生产库 keeps its own key.
    expect(groupStateKey('生产库')).not.toBe(stateKey('global', '生产库'))
  })
})

describe('renderGroupSection — collapsing a group', () => {
  const body = [renderCard(globalItem, undefined, undefined, false, undefined, cardHandlers())]

  it('expanded: shows the label, the count and the cards', () => {
    const text = textOf(renderGroupSection('k', '生产库', 3, false, () => undefined, body))
    expect(text).toContain('生产库')
    expect(text).toContain('3')
    expect(text).toContain('收起')
    expect(text).toContain(globalItem.name)
  })

  it('collapsed: keeps the header, drops the cards', () => {
    const text = textOf(renderGroupSection('k', '生产库', 3, true, () => undefined, body))
    expect(text).toContain('生产库')
    expect(text).toContain('已收起')
    expect(text).not.toContain(globalItem.name)
  })

  it('labels the ungrouped bucket in words', () => {
    const text = textOf(renderGroupSection('k', null, 1, false, () => undefined, body))
    expect(text).toContain(UNGROUPED_LABEL)
  })
})

describe('renderProjectCard — a project with several databases groups them', () => {
  it('renders one collapsible section per group', () => {
    const ws: WorkspaceListItem = {
      ...workspace,
      connections: [
        { ...projectItem, name: 'app-dev', group: '10.0.0.5' },
        { ...projectItem, name: 'app-test', group: '10.0.0.5' },
        { ...projectItem, name: 'scratch' },
      ],
    }
    const text = textOf(renderProjectCard(ws, projectHandlers({ collapsedGroups: {} })))
    expect(text).toContain('10.0.0.5')
    expect(text).toContain(UNGROUPED_LABEL)
    expect(text).toContain('app-dev')
    expect(text).toContain('scratch')
  })

  it('honours a collapsed section from the caller state', () => {
    const ws: WorkspaceListItem = {
      ...workspace,
      connections: [
        { ...projectItem, name: 'app-dev', group: '10.0.0.5' },
        { ...projectItem, name: 'scratch' },
      ],
    }
    const key = groupStateKey('10.0.0.5', ws.path)
    const text = textOf(renderProjectCard(ws, projectHandlers({ collapsedGroups: { [key]: true } })))
    expect(text).toContain('10.0.0.5')
    expect(text).not.toContain('app-dev')
    // The ungrouped bucket is unaffected by the collapsed group.
    expect(text).toContain('scratch')
  })
})
