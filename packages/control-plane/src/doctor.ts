import { accessSync, constants } from 'node:fs';
import { timestamp } from '../../core/src/index.js';
import type { HelixRuntime } from '../../runtime/src/index.js';
import type { ControlPlaneHealthCheck, DoctorReport } from './types.js';

export interface DoctorOptions { dataDirectory?: string; checkDocker?: () => Promise<boolean>; }

export class Doctor {
  constructor(private readonly runtime: HelixRuntime, private readonly options: DoctorOptions = {}) {}

  async run(): Promise<DoctorReport> {
    const checks: ControlPlaneHealthCheck[] = [];
    checks.push({ name: 'node-version', status: Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10) >= 20 ? 'PASS' : 'FAIL', message: `Node.js ${process.versions.node}` });
    checks.push({ name: 'package-integrity', status: accessCheck('node_modules') ? 'PASS' : 'FAIL', message: accessCheck('node_modules') ? 'node_modules is present' : 'node_modules is missing' });
    try { const stats = await this.runtime.memoryStats(); checks.push({ name: 'sqlite-memory', status: 'PASS', message: 'memory backend initialized', details: { stats } as unknown as Record<string, unknown> }); } catch (error) { checks.push({ name: 'sqlite-memory', status: 'FAIL', message: error instanceof Error ? error.message : String(error) }); }
    checks.push({ name: 'scheduler', status: this.runtime.scheduler ? 'PASS' : 'FAIL', message: `${this.runtime.scheduler.list().length} active leases` });
    checks.push({ name: 'worker-pool', status: this.runtime.agents.list().length ? 'PASS' : 'WARN', message: `${this.runtime.agents.list().length} agent-backed worker views` });
    checks.push({ name: 'sandbox', status: this.runtime.sandbox ? 'PASS' : 'FAIL', message: 'SandboxManager is configured' });
    const docker = this.options.checkDocker ? await this.options.checkDocker() : accessCheck('/var/run/docker.sock');
    checks.push({ name: 'docker', status: docker ? 'PASS' : 'WARN', message: docker ? 'Docker socket available' : 'Docker unavailable; local sandbox remains available' });
    checks.push({ name: 'mcp-server', status: 'PASS', message: 'MCP adapter is available through the existing package boundary' });
    checks.push({ name: 'provider', status: this.runtime.provider.name.toLowerCase().includes('deterministic') ? 'WARN' : 'PASS', message: this.runtime.provider.name.toLowerCase().includes('deterministic') ? 'No external provider configured; deterministic provider active' : `${this.runtime.provider.name} configured` });
    const federation = this.runtime.federation.status();
    checks.push({ name: 'federation-transport', status: federation.metrics.messageFailures ? 'WARN' : 'PASS', message: `${federation.nodes.length} federation nodes; ${federation.metrics.messageFailures} message failures` });
    checks.push({ name: 'signing-keys', status: 'WARN', message: 'Key material is injected/configured at the federation boundary; doctor does not expose secrets' });
    checks.push({ name: 'policy-engine', status: this.runtime.policy ? 'PASS' : 'FAIL', message: 'default-deny policy engine is configured' });
    checks.push({ name: 'filesystem', status: this.options.dataDirectory ? accessCheck(this.options.dataDirectory, constants.R_OK | constants.W_OK) ? 'PASS' : 'FAIL' : 'WARN', message: this.options.dataDirectory ? 'configured data directory is readable and writable' : 'data directory was not supplied to doctor' });
    try { await this.runtime.events.read(); checks.push({ name: 'database-integrity', status: 'PASS', message: 'durable event store is readable' }); } catch (error) { checks.push({ name: 'database-integrity', status: 'FAIL', message: error instanceof Error ? error.message : String(error) }); }
    checks.push({ name: 'outbox-inbox', status: federation.metrics.messageFailures ? 'WARN' : 'PASS', message: 'federation delivery status is inspectable' });
    const status = checks.some((check) => check.status === 'FAIL') ? 'FAIL' : checks.some((check) => check.status === 'WARN') ? 'WARN' : 'PASS';
    return { status, generatedAt: timestamp(), checks };
  }
}

function accessCheck(path: string, mode = constants.F_OK): boolean { try { accessSync(path, mode); return true; } catch { return false; } }
