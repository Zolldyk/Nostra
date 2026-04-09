import type { ConstitutionRule } from '../types/constitution.js';

export interface ComplianceCheckInput {
  metric: string;   // e.g. "sol_concentration"
  value: number;    // e.g. 90
  unit: string;     // e.g. "percent"
}

export interface ComplianceResult {
  passed: boolean;
  violation?: string;
  ruleRef?: number;
}

function evaluateCondition(
  operator: ConstitutionRule['condition']['operator'],
  actual: number,
  threshold: number,
): boolean {
  switch (operator) {
    case '<':  return actual < threshold;
    case '>':  return actual > threshold;
    case '<=': return actual <= threshold;
    case '>=': return actual >= threshold;
    case '==': return actual === threshold;
    case '!=': return actual !== threshold;
  }
}

export function checkConstitutionalCompliance(
  rules: ConstitutionRule[],
  proposed: ComplianceCheckInput,
): ComplianceResult {
  for (const rule of rules) {
    // Only 'block' rules can halt execution synchronously
    if (rule.action !== 'block') continue;
    // Only evaluate rules whose metric matches the proposed action
    if (rule.condition.metric !== proposed.metric) continue;

    const violates = !evaluateCondition(rule.condition.operator, proposed.value, rule.condition.value);
    if (violates) {
      return {
        passed: false,
        violation: rule.description,
        ruleRef: rule.id,
      };
    }
  }
  return { passed: true };
}
