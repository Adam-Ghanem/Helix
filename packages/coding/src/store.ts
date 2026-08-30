import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { id, timestamp } from '../../core/src/index.js';
import { CodingEvidenceRecord, CodingEvidenceType, CodingSessionRecord } from './types.js';

interface CodingState {
  version: 1;
  sessions: CodingSessionRecord[];
  evidence: CodingEvidenceRecord[];
}

export class CodingSessionStore {
  private readonly sessions = new Map<string, CodingSessionRecord>();
  private readonly evidence = new Map<string, CodingEvidenceRecord>();
  private readonly stateFile: string;
  private initialized = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: { stateFile: string }) {
    this.stateFile = options.stateFile;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(dirname(this.stateFile), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8')) as CodingState;
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions) || !Array.isArray(parsed.evidence)) throw new Error('Unsupported coding session state');
      for (const session of parsed.sessions) this.sessions.set(session.id, session);
      for (const record of parsed.evidence) this.evidence.set(record.id, record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.initialized = true;
  }

  async createSession(input: { goal: string; cwd: string; adapter: string; executionId?: string }): Promise<CodingSessionRecord> {
    await this.init();
    if (!input.goal.trim()) throw new Error('Coding session goal is required');
    if (!input.cwd.trim()) throw new Error('Coding session cwd is required');
    if (!input.adapter.trim()) throw new Error('Coding session adapter is required');
    const now = timestamp();
    const session: CodingSessionRecord = {
      id: id('code'),
      goal: input.goal,
      cwd: input.cwd,
      adapter: input.adapter,
      status: 'created',
      createdAt: now,
      updatedAt: now,
      attempt: 1,
      evidenceIds: [],
      ...(input.executionId ? { executionId: input.executionId } : {}),
    };
    this.sessions.set(session.id, session);
    await this.persist();
    return structuredClone(session);
  }

  async getSession(sessionId: string): Promise<CodingSessionRecord | undefined> {
    await this.init();
    const session = this.sessions.get(sessionId);
    return session ? structuredClone(session) : undefined;
  }

  async listSessions(): Promise<CodingSessionRecord[]> {
    await this.init();
    return [...this.sessions.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map((session) => structuredClone(session));
  }

  async updateSession(sessionId: string, patch: Partial<Omit<CodingSessionRecord, 'id' | 'createdAt' | 'evidenceIds'>>): Promise<CodingSessionRecord> {
    await this.init();
    const session = this.requireSession(sessionId);
    Object.assign(session, structuredClone(patch), { updatedAt: timestamp() });
    await this.persist();
    return structuredClone(session);
  }

  async appendEvidence(sessionId: string, input: { type: CodingEvidenceType; data: Record<string, unknown> }): Promise<CodingEvidenceRecord> {
    await this.init();
    const session = this.requireSession(sessionId);
    const record: CodingEvidenceRecord = { id: id('evidence'), sessionId, type: input.type, createdAt: timestamp(), data: structuredClone(input.data) };
    this.evidence.set(record.id, record);
    session.evidenceIds.push(record.id);
    session.updatedAt = timestamp();
    try {
      await this.persist();
    } catch (error) {
      this.evidence.delete(record.id);
      session.evidenceIds = session.evidenceIds.filter((candidate) => candidate !== record.id);
      throw error;
    }
    return structuredClone(record);
  }

  async evidenceForSession(sessionId: string): Promise<CodingEvidenceRecord[]> {
    await this.init();
    const session = this.requireSession(sessionId);
    return session.evidenceIds.map((recordId) => this.evidence.get(recordId)).filter((record): record is CodingEvidenceRecord => Boolean(record)).map((record) => structuredClone(record));
  }

  private requireSession(sessionId: string): CodingSessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown coding session: ${sessionId}`);
    return session;
  }

  private persist(): Promise<void> {
    const next = async () => {
      const state: CodingState = { version: 1, sessions: [...this.sessions.values()], evidence: [...this.evidence.values()] };
      const temp = `${this.stateFile}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await rename(temp, this.stateFile);
    };
    this.writeChain = this.writeChain.then(next, next);
    return this.writeChain;
  }
}
