import { ApprovalRequest, AgentId, Id, PolicyAction, PolicyDecision, PolicyRule, ToolRequest, id, timestamp } from '../../core/src/index.js';

export interface PolicyContext {
  subject: AgentId;
  approvedIds?: Set<Id>;
  now?: Date;
}

export class PolicyEngine {
  private readonly approvals = new Map<Id, ApprovalRequest>();
  private readonly rules: PolicyRule[];

  constructor(rules: PolicyRule[] = []) {
    this.rules = [...rules];
  }

  decide(request: ToolRequest, context: PolicyContext): PolicyDecision {
    const matching = [...this.rules].reverse().find((rule) => this.matches(rule, request, context.subject));
    if (!matching) return { action: 'deny', reason: 'default-deny: no matching policy rule' };
    if (matching.action === 'approval') {
      const approvalId = id('approval');
      const approval: ApprovalRequest = {
        id: approvalId,
        executionId: request.executionId,
        requestedBy: request.agentId,
        resource: request.tool,
        summary: `Agent ${request.agentId} requests ${request.tool}`,
        status: 'pending',
        createdAt: timestamp(),
      };
      this.approvals.set(approvalId, approval);
      return { action: 'approval', reason: 'human approval required by policy', approvalId, rule: matching };
    }
    if (matching.action === 'allow' && request.risk === 'high') return { action: 'deny', reason: 'high-risk requests require an explicit approval rule', rule: matching };
    return { action: matching.action, reason: `matched policy for ${matching.resource}`, rule: matching };
  }

  approve(approvalId: Id, decidedBy: string): ApprovalRequest {
    return this.decideApproval(approvalId, 'approved', decidedBy);
  }

  deny(approvalId: Id, decidedBy: string): ApprovalRequest {
    return this.decideApproval(approvalId, 'denied', decidedBy);
  }

  listApprovals(status?: ApprovalRequest['status']): ApprovalRequest[] {
    return [...this.approvals.values()].filter((approval) => !status || approval.status === status).map((approval) => structuredClone(approval));
  }

  addRule(rule: PolicyRule): void {
    this.rules.push({ ...rule, ...(rule.subjects ? { subjects: [...rule.subjects] } : {}) });
  }

  getRules(): PolicyRule[] {
    return this.rules.map((rule) => ({ ...rule, ...(rule.subjects ? { subjects: [...rule.subjects] } : {}) }));
  }

  private decideApproval(approvalId: Id, status: 'approved' | 'denied', decidedBy: string): ApprovalRequest {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new Error(`Unknown approval: ${approvalId}`);
    if (approval.status !== 'pending') throw new Error(`Approval ${approvalId} is already ${approval.status}`);
    approval.status = status;
    approval.decidedAt = timestamp();
    approval.decidedBy = decidedBy;
    return structuredClone(approval);
  }

  private matches(rule: PolicyRule, request: ToolRequest, subject: AgentId): boolean {
    return (rule.resource === '*' || rule.resource === request.tool) && (!rule.subjects || rule.subjects.includes('*') || rule.subjects.includes(subject));
  }
}

export const secureDefaultRules: PolicyRule[] = [
  { resource: 'filesystem.read', action: 'allow', subjects: ['*'] },
  { resource: 'filesystem.write', action: 'approval', subjects: ['*'] },
  { resource: 'shell.execute', action: 'deny', subjects: ['*'] },
  { resource: 'network.request', action: 'deny', subjects: ['*'] },
];
