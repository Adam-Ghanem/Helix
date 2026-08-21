import { PathValidator, SafeExecutionOptions, SafeExecutionResult, SafeExecutor } from '../../security/src/index.js';

export interface SandboxOptions {
  workspace: string;
  allowedCommands: string[];
  timeoutMs?: number;
}

export class LocalSandbox {
  readonly security: PathValidator;
  private readonly executor: SafeExecutor;

  constructor(private readonly options: SandboxOptions) {
    this.security = new PathValidator(options.workspace);
    this.executor = new SafeExecutor(this.security);
  }

  execute(command: string, args: string[], cwd = '.', environment: Record<string, string> = {}): Promise<SafeExecutionResult> {
    const execution: SafeExecutionOptions = { cwd, allowedCommands: this.options.allowedCommands, ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}), environment, allowedEnvironmentKeys: [] };
    return this.executor.run(command, args, execution);
  }

  note(): string {
    return 'LocalSandbox provides path and command safety controls; OS/container isolation must be supplied by the deployment runtime.';
  }
}
