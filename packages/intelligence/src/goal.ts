import { id, timestamp } from '../../core/src/index.js';
import type { Goal, GoalAnalysis, GoalCategory, GoalConstraints, GoalRisk, PlanTopology, Complexity } from './types.js';

const capabilityRules: Array<{ capability: string; terms: string[] }> = [
  { capability: 'coding', terms: ['build', 'implement', 'code', 'feature', 'module', 'refactor', 'api'] },
  { capability: 'testing', terms: ['test', 'testing', 'verify', 'validation', 'regression'] },
  { capability: 'security', terms: ['security', 'secure', 'auth', 'jwt', 'vulnerability', 'threat', 'permission', 'secret'] },
  { capability: 'research', terms: ['research', 'investigate', 'survey', 'compare', 'literature', 'collect'] },
  { capability: 'analysis', terms: ['analyze', 'analysis', 'debug', 'diagnose', 'classify', 'understand'] },
  { capability: 'review', terms: ['review', 'audit', 'inspect', 'critique', 'quality'] },
  { capability: 'documentation', terms: ['document', 'documentation', 'readme', 'guide', 'explain'] },
  { capability: 'performance', terms: ['performance', 'benchmark', 'latency', 'optimize', 'scale', 'throughput'] },
  { capability: 'operations', terms: ['deploy', 'operate', 'monitor', 'migration', 'incident', 'schedule'] },
];

function normalized(text: string): string { return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function hasAny(text: string, terms: string[]): boolean { return terms.some((term) => text.includes(term)); }

export function inferCategory(text: string): GoalCategory {
  if (hasAny(text, ['security', 'vulnerability', 'auth', 'jwt', 'threat', 'permission', 'secret'])) return 'security';
  if (hasAny(text, ['research', 'survey', 'literature', 'investigate'])) return 'research';
  if (hasAny(text, ['document', 'readme', 'guide', 'documentation'])) return 'documentation';
  if (hasAny(text, ['deploy', 'monitor', 'operate', 'incident', 'migration'])) return 'operations';
  if (hasAny(text, ['build', 'implement', 'code', 'feature', 'module', 'refactor'])) return 'software';
  if (hasAny(text, ['analyze', 'analysis', 'debug', 'diagnose', 'classify'])) return 'analysis';
  return 'general';
}

export function inferRisk(text: string, constraints: GoalConstraints = {}): GoalRisk {
  if (constraints.requireApproval || hasAny(text, ['privileged', 'root', 'system operation', 'destructive'])) return 'CRITICAL';
  if (hasAny(text, ['security', 'network', 'auth', 'credential', 'secret', 'production'])) return 'HIGH';
  if (hasAny(text, ['implement', 'build', 'modify', 'deploy', 'migration'])) return 'MEDIUM';
  return 'LOW';
}

export function inferCapabilities(text: string, explicit: string[] = []): string[] {
  const values = new Set(explicit.map((value) => value.trim().toLowerCase()).filter(Boolean));
  for (const rule of capabilityRules) if (hasAny(text, rule.terms)) values.add(rule.capability);
  if (!values.size) values.add('analysis');
  return [...values];
}

export function inferComplexity(text: string, constraints: GoalConstraints = {}): { complexity: Complexity; score: number } {
  const words = text.split(/\s+/).filter(Boolean).length;
  const signals = [
    words > 25,
    words > 60,
    hasAny(text, ['multiple', 'integrate', 'distributed', 'migration', 'production', 'security']),
    (constraints.maxTasks ?? 0) > 8,
    (constraints.maxAgents ?? 0) > 4,
  ].filter(Boolean).length;
  const score = Math.min(1, 0.15 + words / 160 + signals * 0.14);
  if (score >= 0.82) return { complexity: 'very-high', score };
  if (score >= 0.58) return { complexity: 'high', score };
  if (score >= 0.32) return { complexity: 'medium', score };
  return { complexity: 'low', score };
}

export function inferTopology(category: GoalCategory, complexity: Complexity, risk: GoalRisk, text: string, requiredCapabilities: string[]): PlanTopology {
  if (risk === 'CRITICAL' || risk === 'HIGH') return 'hierarchical';
  if (hasAny(text, ['parallel', 'independent', 'many', 'batch'])) return 'parallel';
  if (category === 'software' && requiredCapabilities.includes('testing')) return 'pipeline';
  if (category === 'research') return complexity === 'very-high' ? 'mesh' : 'pipeline';
  if (complexity === 'very-high') return 'adaptive';
  if (complexity === 'high') return 'pipeline';
  return 'sequential';
}

export function createGoal(input: { title: string; description?: string; constraints?: GoalConstraints; requiredCapabilities?: string[]; priority?: number; urgency?: number; risk?: GoalRisk; expectedOutcome?: string }): Goal {
  const title = input.title.trim();
  if (!title) throw new Error('goal title is required');
  const description = (input.description ?? title).trim();
  if (!description) throw new Error('goal description is required');
  const constraints = structuredClone(input.constraints ?? {});
  const text = normalized(`${title} ${description}`);
  const priority = input.priority ?? 5;
  const urgency = input.urgency ?? 5;
  if (!Number.isInteger(priority) || priority < 1 || priority > 10) throw new Error('goal priority must be an integer from 1 to 10');
  if (!Number.isInteger(urgency) || urgency < 1 || urgency > 10) throw new Error('goal urgency must be an integer from 1 to 10');
  return { id: id('goal'), title, description, constraints, requiredCapabilities: inferCapabilities(text, input.requiredCapabilities), priority, urgency, risk: input.risk ?? inferRisk(text, constraints), expectedOutcome: input.expectedOutcome?.trim() || `Complete: ${title}`, createdAt: timestamp() };
}

export function analyzeGoal(goal: Goal): GoalAnalysis {
  const text = normalized(`${goal.title} ${goal.description}`);
  const category = inferCategory(text);
  const { complexity, score } = inferComplexity(text, goal.constraints);
  const requiredCapabilities = inferCapabilities(text, goal.requiredCapabilities);
  const risk = goal.risk ?? inferRisk(text, goal.constraints);
  const likelyTopology = goal.constraints.requiredTopology ?? inferTopology(category, complexity, risk, text, requiredCapabilities);
  const dependencyHints = category === 'software' ? ['requirements', 'implementation', 'verification'] : category === 'security' ? ['reconnaissance', 'analysis', 'remediation', 'verification'] : category === 'research' ? ['collection', 'classification', 'synthesis', 'review'] : ['understanding', 'execution', 'review'];
  const expectedAgents = Math.max(1, Math.min(goal.constraints.maxAgents ?? 8, Math.ceil(1 + score * 5 + (risk === 'HIGH' || risk === 'CRITICAL' ? 1 : 0))));
  return { goalId: goal.id, category, requiredCapabilities, complexity, complexityScore: Number(score.toFixed(4)), dependencies: dependencyHints, risk, likelyTopology, expectedAgents, rationale: [`category=${category}`, `complexity=${complexity}`, `risk=${risk}`, `topology=${likelyTopology}`, `capabilities=${requiredCapabilities.join(',')}`, `expectedAgents=${expectedAgents}`], deterministic: true };
}
