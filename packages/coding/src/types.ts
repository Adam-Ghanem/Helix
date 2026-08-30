export type CodingSessionStatus = 'created' | 'running' | 'blocked' | 'failed' | 'completed' | 'cancelled';

export interface CodingSessionRecord {
  id: string;
  goal: string;
  cwd: string;
  adapter: string;
  status: CodingSessionStatus;
  createdAt: string;
  updatedAt: string;
  executionId?: string;
  activeTaskId?: string;
  attempt: number;
  evidenceIds: string[];
  finalVerdict?: 'accepted' | 'rejected';
  error?: string;
}

export type CodingEvidenceType = 'hook' | 'adapter-output' | 'file-change' | 'command' | 'review' | 'test' | 'judge' | 'failure';

export interface CodingEvidenceRecord {
  id: string;
  sessionId: string;
  type: CodingEvidenceType;
  createdAt: string;
  data: Record<string, unknown>;
}

export interface ReviewVerdict {
  approved: boolean;
  findings: Array<{ severity: 'info' | 'low' | 'medium' | 'high' | 'critical'; message: string; file?: string }>;
  summary: string;
}

export interface TestVerdict {
  passed: boolean;
  commands: Array<{ command: string; exitCode: number; durationMs: number }>;
  summary: string;
}

export interface JudgeVerdict {
  accepted: boolean;
  reason: string;
  requiredFixes: string[];
  confidence: number;
}
