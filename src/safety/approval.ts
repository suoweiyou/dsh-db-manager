/**
 * Host-side human approval channel for dangerous statements.
 *
 * The DSH tools registry resolves an ApprovalService under the service id
 * 'approval' (see @deepseek-ai/dsh-user-approval): request() walks the host's
 * answerer chain and returns 'allowed-once' only when a human explicitly
 * approves. The plugin duck-types that service (it is not an npm dependency)
 * and degrades to the PRD FR-9 confirm-token loop whenever the channel is
 * unavailable — 'unavailable' never bypasses a denial.
 */
export type HostApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface HostApprovalRequest {
  agent?: unknown
  toolName: string
  callId?: string
  reason?: string
  signal?: AbortSignal
}

export type RequestHumanApproval = (request: HostApprovalRequest) => Promise<HostApprovalOutcome>
