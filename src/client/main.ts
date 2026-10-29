/**
 * db-manager client half: registers the「数据库」settings page.
 * Bundled as `window.__ModuleLoader__.load({ id, factory })` by tsup; react /
 * react-dom stay external and are provided by the page's module loader.
 */
import { DbManagerSection } from './Section.js'

type ClientContext = {
  slots: {
    inject(slot: string, callback: () => () => void): void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
}

const inject = ['slots']

function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => {
    const dispose = ctx.slots.register(
      { name: 'settings.section', id: 'db-manager', order: 60, label: '数据库' },
      DbManagerSection,
    )
    return () => {
      dispose()
    }
  })
}

export { apply, inject }
