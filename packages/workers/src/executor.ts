import type { TaskExecutor, WorkerTaskContext, ExecutionResult } from './types.js';
const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => { if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; } const timer = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true }); });
export class SimulatedExecutor implements TaskExecutor {
  constructor(private readonly latencyPerComplexityMs = 5) {}
  async execute({ task, signal }: WorkerTaskContext): Promise<ExecutionResult> {
    const latencyMs = Math.max(1, task.estimatedComplexity * this.latencyPerComplexityMs);
    try { await sleep(latencyMs, signal); } catch { return { success: false, quality: 0, latencyMs, tokens: task.estimatedComplexity * 10, error: 'Execution cancelled', timedOut: signal.aborted }; }
    const quality = Math.min(1, 0.82 + Math.min(task.requiredCapabilities.length, 3) * 0.03 - task.estimatedComplexity * 0.01);
    return { success: quality >= 0.75, quality, latencyMs, tokens: task.estimatedComplexity * 10 };
  }
}
