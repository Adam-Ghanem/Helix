import type { AgentRuntimeConfig, AgentRuntimeHost, AgentExecutionResult, AgentTaskInput, AgentToolDefinition } from './types.js';
import { AgentToolCallingLoop } from './loop.js';
import { AgentToolRegistry } from './tool-registry.js';

export class AgentRuntime {
  readonly tools = new AgentToolRegistry();
  private readonly loop: AgentToolCallingLoop;
  constructor(private readonly host: AgentRuntimeHost) { this.loop = new AgentToolCallingLoop(host, this.tools); }
  registerTool(tool: AgentToolDefinition): AgentToolDefinition { return this.tools.register(tool); }
  registerTools(tools: AgentToolDefinition[]): void { this.tools.registerMany(tools); }
  listTools(): AgentToolDefinition[] { return this.tools.list(); }
  run(input: AgentTaskInput, config: AgentRuntimeConfig = {}): Promise<AgentExecutionResult> { return this.loop.run(input, config); }
}
