/** Resolve the current session workspace cwd from a tool execution context. */
export function resolveWorkspaceCwd(exec: unknown): string | undefined {
  return resolveSessionInfo(exec).cwd
}

/** Resolve session id + workspace cwd from a tool execution context (defensive). */
export function resolveSessionInfo(exec: unknown): { sessionId?: string; cwd?: string } {
  try {
    const candidate = exec as {
      agent?: {
        id?: unknown
        session?: { id?: unknown; header?: { cwd?: unknown } }
        header?: { cwd?: unknown }
      }
    }
    const agent = candidate?.agent
    let sessionId: string | undefined
    if (typeof agent?.id === 'string' && agent.id.length > 0) sessionId = agent.id
    else if (typeof agent?.session?.id === 'string' && agent.session.id.length > 0) sessionId = agent.session.id
    const fromSession = agent?.session?.header?.cwd
    const fromSessionCwd = typeof fromSession === 'string' && fromSession.length > 0 ? fromSession : undefined
    const fromAgent = agent?.header?.cwd
    const fromAgentCwd = typeof fromAgent === 'string' && fromAgent.length > 0 ? fromAgent : undefined
    const cwd = fromSessionCwd ?? fromAgentCwd
    return {
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(cwd === undefined ? {} : { cwd }),
    }
  } catch {
    return {}
  }
}
