import type { Goal, GoalAnalysis, PlanStep, Complexity } from './types.js';

interface StepTemplate { key: string; title: string; description: string; capabilities: string[]; preferred: string[]; parallelizable?: boolean; dependsOn?: string[]; complexity?: Complexity; }

function templates(analysis: GoalAnalysis, goal: Goal): StepTemplate[] {
  const prefix = `For goal “${goal.title}”: `;
  if (analysis.category === 'software') return [
    { key: 'understand', title: 'Understand requirements', description: `${prefix}extract acceptance criteria, constraints, and affected boundaries.`, capabilities: ['analysis'], preferred: ['analyst', 'researcher'] },
    { key: 'design', title: 'Design implementation', description: `${prefix}define interfaces, dependencies, and a safe implementation approach.`, capabilities: ['architecture', 'analysis'], preferred: ['architect'], dependsOn: ['understand'] },
    { key: 'implement', title: 'Implement change', description: `${prefix}perform the bounded implementation through approved capabilities.`, capabilities: ['coding'], preferred: ['coder', 'implementation'], dependsOn: ['design'] },
    { key: 'test', title: 'Test implementation', description: `${prefix}run deterministic tests and verify acceptance criteria.`, capabilities: ['testing'], preferred: ['tester', 'validation'], dependsOn: ['implement'], parallelizable: true },
    { key: 'security-review', title: 'Review security', description: `${prefix}check authorization, secrets, injection, and policy boundaries.`, capabilities: ['security'], preferred: ['security'], dependsOn: ['implement'], parallelizable: true },
    { key: 'final-review', title: 'Complete final review', description: `${prefix}consolidate evidence and confirm delivery readiness.`, capabilities: ['review'], preferred: ['reviewer', 'quality'], dependsOn: ['test', 'security-review'] },
  ];
  if (analysis.category === 'security') return [
    { key: 'recon', title: 'Perform reconnaissance', description: `${prefix}inventory assets, trust boundaries, and relevant evidence.`, capabilities: ['security'], preferred: ['security'] },
    { key: 'analysis', title: 'Analyze threats', description: `${prefix}classify risks and identify likely causes without executing untrusted content.`, capabilities: ['security'], preferred: ['security'], dependsOn: ['recon'] },
    { key: 'validation', title: 'Validate controls', description: `${prefix}check policy, ACL, sandbox, and regression controls.`, capabilities: ['security'], preferred: ['security', 'tester'], dependsOn: ['analysis'] },
    { key: 'remediation', title: 'Plan remediation', description: `${prefix}define least-privilege corrective actions.`, capabilities: ['security'], preferred: ['security'], dependsOn: ['validation'] },
    { key: 'verification', title: 'Verify remediation', description: `${prefix}re-run bounded checks and produce evidence.`, capabilities: ['testing'], preferred: ['tester'], dependsOn: ['remediation'] },
  ];
  if (analysis.category === 'research') return [
    { key: 'collect', title: 'Collect evidence', description: `${prefix}gather relevant approved sources and record provenance.`, capabilities: ['research'], preferred: ['researcher'] },
    { key: 'classify', title: 'Classify evidence', description: `${prefix}organize evidence by source, confidence, and relevance.`, capabilities: ['research'], preferred: ['researcher'], dependsOn: ['collect'] },
    { key: 'analyze', title: 'Analyze findings', description: `${prefix}compare evidence and identify supported conclusions.`, capabilities: ['analysis'], preferred: ['analyst'] },
    { key: 'synthesize', title: 'Synthesize result', description: `${prefix}compose a traceable answer with uncertainty noted.`, capabilities: ['analysis'], preferred: ['analyst', 'researcher'], dependsOn: ['classify', 'analyze'] },
    { key: 'review', title: 'Review synthesis', description: `${prefix}check source coverage, contradictions, and completeness.`, capabilities: ['review'], preferred: ['reviewer'], dependsOn: ['synthesize'] },
  ];
  if (analysis.category === 'documentation') return [
    { key: 'understand', title: 'Understand audience', description: `${prefix}identify audience, scope, and required examples.`, capabilities: ['analysis'], preferred: ['analyst'], },
    { key: 'draft', title: 'Draft documentation', description: `${prefix}write clear, accurate documentation without exposing secrets.`, capabilities: ['documentation'], preferred: ['writer', 'documentation'], dependsOn: ['understand'] },
    { key: 'review', title: 'Review documentation', description: `${prefix}verify accuracy, links, security notes, and completeness.`, capabilities: ['review'], preferred: ['reviewer'], dependsOn: ['draft'] },
  ];
  if (analysis.category === 'operations') return [
    { key: 'assess', title: 'Assess operational state', description: `${prefix}inspect prerequisites, health, and change risk.`, capabilities: ['operations'], preferred: ['incident-responder'] },
    { key: 'execute', title: 'Execute bounded operation', description: `${prefix}perform only approved changes through existing policy controls.`, capabilities: ['operations'], preferred: ['operations'], dependsOn: ['assess'] },
    { key: 'monitor', title: 'Monitor result', description: `${prefix}observe health, events, and resource limits.`, capabilities: ['operations'], preferred: ['incident-responder', 'devops'], dependsOn: ['execute'] },
    { key: 'review', title: 'Review operation', description: `${prefix}record outcome, rollback evidence, and follow-up actions.`, capabilities: ['review'], preferred: ['reviewer'], dependsOn: ['monitor'] },
  ];
  return [
    { key: 'understand', title: 'Understand goal', description: `${prefix}convert the request into explicit requirements and constraints.`, capabilities: ['analysis'], preferred: ['analyst'] },
    { key: 'execute', title: 'Execute bounded work', description: `${prefix}perform the requested work through authorized capabilities.`, capabilities: analysis.requiredCapabilities.filter((capability) => capability !== 'review'), preferred: ['worker', 'specialist'], dependsOn: ['understand'] },
    { key: 'review', title: 'Review result', description: `${prefix}evaluate output, evidence, and goal coverage.`, capabilities: ['review'], preferred: ['reviewer'], dependsOn: ['execute'] },
  ];
}

export function decomposeGoal(goal: Goal, analysis: GoalAnalysis, limits: { maxTasks: number; maxDepth: number; maxFanout: number; maxRetriesPerStep: number }): PlanStep[] {
  const raw = templates(analysis, goal);
  if (raw.length > limits.maxTasks) throw new Error(`decomposition would create ${raw.length} tasks, above maxTasks=${limits.maxTasks}`);
  const keys = new Set(raw.map((step) => step.key));
  return raw.map((template, index) => {
    const dependencies = (template.dependsOn ?? []).filter((key) => keys.has(key));
    if (dependencies.length > limits.maxFanout) throw new Error(`step ${template.key} exceeds maxFanout=${limits.maxFanout}`);
    const depth = dependencies.length ? Math.max(...dependencies.map((dependency) => raw.findIndex((candidate) => candidate.key === dependency) + 1)) : 0;
    if (depth > limits.maxDepth) throw new Error(`step ${template.key} exceeds maxDepth=${limits.maxDepth}`);
    return { id: `step_${template.key}`, title: template.title, description: template.description, requiredCapabilities: [...new Set(template.capabilities)], priority: Math.max(1, goal.priority - Math.floor(index / 3)), dependencies: dependencies.map((dependency) => `step_${dependency}`), estimatedComplexity: template.complexity ?? analysis.complexity, preferredAgentTypes: [...template.preferred], parallelizable: template.parallelizable ?? false, maxRetries: limits.maxRetriesPerStep, depth };
  });
}
