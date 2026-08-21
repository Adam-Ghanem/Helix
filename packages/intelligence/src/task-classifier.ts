import type { GoalAnalysis, GoalCategory, PlanStep } from './types.js';

export interface TaskClassification { taskType: string; category: GoalCategory; capabilities: string[]; risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; rationale: string[]; }

export function classifyTask(step: PlanStep, analysis: GoalAnalysis): TaskClassification {
  const taskType = step.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'general-task';
  const risk = analysis.risk;
  return { taskType, category: analysis.category, capabilities: [...new Set(step.requiredCapabilities)], risk, rationale: [`title=${step.title}`, `category=${analysis.category}`, `requiredCapabilities=${step.requiredCapabilities.join(',') || 'none'}`, `risk=${risk}`] };
}
