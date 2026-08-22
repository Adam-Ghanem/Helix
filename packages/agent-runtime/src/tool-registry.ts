import type { ToolSchema } from '../../tools/src/index.js';
import type { AgentToolDefinition } from './types.js';

export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentToolDefinition>();
  register(input: AgentToolDefinition): AgentToolDefinition { if (this.tools.has(input.name)) throw new Error(`Agent tool already registered: ${input.name}`); const definition = { ...input, permissions: [...new Set(input.permissions)], ...(input.metadata ? { metadata: { ...input.metadata } } : {}) }; this.tools.set(definition.name, definition); return publicTool(definition); }
  registerMany(inputs: AgentToolDefinition[]): void { for (const input of inputs) this.register(input); }
  get(name: string): AgentToolDefinition { const tool = this.tools.get(name); if (!tool) throw new Error(`Unknown agent tool: ${name}`); return tool; }
  list(): AgentToolDefinition[] { return [...this.tools.values()].map(publicTool); }
  validate(name: string, input: Record<string, unknown>): string[] { const tool = this.get(name); return validateSchema(tool.inputSchema, input); }
}

function validateSchema(schema: ToolSchema, input: Record<string, unknown>): string[] { const errors: string[] = []; for (const required of schema.required ?? []) if (!(required in input)) errors.push(`missing required field: ${required}`); for (const [field, type] of Object.entries(schema.properties ?? {})) { if (!(field in input)) continue; const actual = Array.isArray(input[field]) ? 'array' : typeof input[field]; if (actual !== type) errors.push(`field ${field} must be ${type}`); } return errors; }
function publicTool(tool: AgentToolDefinition): AgentToolDefinition { return { ...tool, permissions: [...tool.permissions], ...(tool.metadata ? { metadata: { ...tool.metadata } } : {}) }; }
