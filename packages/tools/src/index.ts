import { ToolRequest, Id, id } from '../../core/src/index.js';

export type JsonType = 'string' | 'number' | 'boolean' | 'object' | 'array';

export interface ToolSchema {
  required?: string[];
  properties?: Record<string, JsonType>;
}

export interface ToolDefinition {
  id: Id;
  name: string;
  description: string;
  risk: 'low' | 'medium' | 'high';
  permissions: string[];
  inputSchema: ToolSchema;
  source: 'builtin' | 'plugin' | 'mcp' | 'provider';
  handler?: (input: Record<string, unknown>) => Promise<unknown>;
}

export type PublicToolDefinition = Omit<ToolDefinition, 'handler'>;

export interface ToolValidation {
  valid: boolean;
  errors: string[];
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(input: Omit<ToolDefinition, 'id'>): PublicToolDefinition {
    if (this.tools.has(input.name)) throw new Error(`Tool already registered: ${input.name}`);
    const definition: ToolDefinition = { ...input, id: id('tool'), permissions: [...new Set(input.permissions)] };
    this.tools.set(definition.name, definition);
    return structuredClone({ ...definition, handler: undefined });
  }

  list(): PublicToolDefinition[] {
    return [...this.tools.values()].map((tool) => structuredClone({ ...tool, handler: undefined }));
  }

  get(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool;
  }

  validate(name: string, input: Record<string, unknown>): ToolValidation {
    const tool = this.get(name);
    const errors: string[] = [];
    for (const required of tool.inputSchema.required ?? []) if (!(required in input)) errors.push(`missing required field: ${required}`);
    for (const [field, type] of Object.entries(tool.inputSchema.properties ?? {})) {
      if (!(field in input)) continue;
      const actual = Array.isArray(input[field]) ? 'array' : typeof input[field];
      if (actual !== type) errors.push(`field ${field} must be ${type}`);
    }
    return { valid: errors.length === 0, errors };
  }

  request(name: string, executionId: string, agentId: string, input: Record<string, unknown>): ToolRequest {
    const tool = this.get(name);
    const validation = this.validate(name, input);
    if (!validation.valid) throw new Error(`Invalid input for ${name}: ${validation.errors.join('; ')}`);
    return { id: tool.id, executionId, agentId, tool: name, input: structuredClone(input), risk: tool.risk };
  }

  async executeAuthorized(request: ToolRequest, authorized: (request: ToolRequest) => Promise<boolean>): Promise<unknown> {
    const tool = this.get(request.tool);
    if (!tool.handler) throw new Error(`Tool ${request.tool} has no local handler; use its declared adapter boundary`);
    if (!(await authorized(request))) throw new Error(`Tool execution denied by policy: ${request.tool}`);
    return tool.handler(request.input);
  }
}
