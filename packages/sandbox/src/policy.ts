import { realpath } from 'node:fs/promises';
import { isAbsolute, normalize, relative, resolve } from 'node:path';
import { SandboxCommand, SandboxPolicy } from './types.js';

async function canonicalPath(candidate: string): Promise<string> {
  try { return await realpath(candidate); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return normalize(resolve(candidate));
    throw error;
  }
}

function under(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === '' || (!remainder.startsWith('..') && !isAbsolute(remainder));
}

export async function validatePath(candidate: string, policy: SandboxPolicy): Promise<string> {
  let decoded = candidate;
  try { decoded = decodeURIComponent(candidate); } catch { throw new Error(`Sandbox path is not valid URI text: ${candidate}`); }
  const resolved = await canonicalPath(decoded);
  const allowedRoots = await Promise.all(policy.allowedPaths.map(canonicalPath));
  const deniedRoots = await Promise.all(policy.deniedPaths.map(canonicalPath));
  if (deniedRoots.some((root) => under(root, resolved))) throw new Error(`Sandbox path is denied: ${candidate}`);
  if (!allowedRoots.some((root) => under(root, resolved))) throw new Error(`Sandbox path escapes allowed workspace: ${candidate}`);
  return resolved;
}

export async function validateCommand(command: SandboxCommand, policy: SandboxPolicy): Promise<SandboxCommand> {
  if (!policy.allowedExecutables.includes(command.command)) throw new Error(`Sandbox executable is not allowlisted: ${command.command}`);
  if (!policy.allowChildProcesses && command.args.some((arg) => arg === '--fork' || arg === '--child-process')) throw new Error('Sandbox child-process execution is disabled');
  const cwd = await validatePath(resolve(policy.workspacePath, command.cwd), policy);
  const args = [...command.args];
  for (const arg of args) {
    if (arg.startsWith('/') || arg.startsWith('./') || arg.startsWith('../') || arg.includes('/')) await validatePath(resolve(cwd, arg), policy);
  }
  const env = Object.fromEntries(Object.entries(command.env).filter(([key]) => policy.environmentAllowlist.includes(key)));
  if (command.timeoutMs !== undefined && (!Number.isFinite(command.timeoutMs) || command.timeoutMs <= 0)) throw new Error('Sandbox timeout must be positive');
  return { command: command.command, args, cwd, env, ...(command.stdin !== undefined ? { stdin: command.stdin } : {}), ...(command.timeoutMs !== undefined ? { timeoutMs: Math.min(command.timeoutMs, policy.timeoutMs) } : {}) };
}
