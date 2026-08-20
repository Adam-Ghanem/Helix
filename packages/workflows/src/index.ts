import { TaskRecord } from '../../core/src/index.js';
import { TaskGraph } from '../../planner/src/index.js';

export interface WorkflowNode {
  id: string;
  kind: 'agent' | 'tool' | 'approval' | 'condition' | 'parallel' | 'join';
  title: string;
  description: string;
  dependsOn?: string[];
  config?: Record<string, unknown>;
}

export interface WorkflowDefinition {
  name: string;
  version: number;
  nodes: WorkflowNode[];
  policy?: { maxRuntimeMs?: number; maxCostUsd?: number };
}

export interface WorkflowResult {
  workflow: string;
  status: 'completed' | 'failed';
  nodes: TaskRecord[];
  errors: string[];
}

export class WorkflowEngine {
  validate(definition: WorkflowDefinition): void {
    if (!definition.name.trim()) throw new Error('workflow name is required');
    if (!Number.isInteger(definition.version) || definition.version < 1) throw new Error('workflow version must be a positive integer');
    const ids = new Set<string>();
    for (const node of definition.nodes) {
      if (ids.has(node.id)) throw new Error(`duplicate workflow node: ${node.id}`);
      ids.add(node.id);
    }
    for (const node of definition.nodes) for (const dependency of node.dependsOn ?? []) if (!ids.has(dependency)) throw new Error(`unknown workflow dependency: ${dependency}`);
    this.topological(definition);
  }

  compile(definition: WorkflowDefinition, executionId: string): TaskGraph {
    this.validate(definition);
    const graph = new TaskGraph();
    const ids = new Map<string, string>();
    for (const node of this.topological(definition)) {
      const dependencies = (node.dependsOn ?? []).map((dependency) => ids.get(dependency)!);
      const task = graph.addTask({ title: node.title, description: node.description, dependencies }, executionId);
      ids.set(node.id, task.id);
    }
    return graph;
  }

  async run(definition: WorkflowDefinition, executionId: string, execute: (node: WorkflowNode, task: TaskRecord) => Promise<unknown>): Promise<WorkflowResult> {
    const graph = this.compile(definition, executionId);
    const nodesByTitle = new Map(definition.nodes.map((node) => [node.title, node]));
    const errors: string[] = [];
    while (graph.all().some((task) => ['pending', 'ready'].includes(task.status))) {
      const ready = graph.ready();
      if (!ready.length) break;
      await Promise.all(ready.map(async (task) => {
        const node = nodesByTitle.get(task.title);
        if (!node) return;
        graph.setStatus(task.id, 'running');
        try {
          graph.update(task.id, { result: await execute(node, task) });
          graph.setStatus(task.id, 'completed');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(message);
          graph.update(task.id, { error: message });
          graph.setStatus(task.id, 'failed');
        }
      }));
    }
    const failed = graph.all().some((task) => task.status === 'failed');
    return { workflow: definition.name, status: failed ? 'failed' : 'completed', nodes: graph.all(), errors };
  }

  private topological(definition: WorkflowDefinition): WorkflowNode[] {
    const indegree = new Map<string, number>(definition.nodes.map((node) => [node.id, node.dependsOn?.length ?? 0]));
    const outgoing = new Map<string, string[]>();
    for (const node of definition.nodes) for (const dependency of node.dependsOn ?? []) outgoing.set(dependency, [...(outgoing.get(dependency) ?? []), node.id]);
    const queue = definition.nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
    const byId = new Map(definition.nodes.map((node) => [node.id, node]));
    const ordered: WorkflowNode[] = [];
    while (queue.length) {
      const current = queue.shift()!;
      ordered.push(byId.get(current)!);
      for (const child of outgoing.get(current) ?? []) {
        const next = (indegree.get(child) ?? 1) - 1;
        indegree.set(child, next);
        if (next === 0) queue.push(child);
      }
    }
    if (ordered.length !== definition.nodes.length) throw new Error('workflow contains a cycle');
    return ordered;
  }
}
