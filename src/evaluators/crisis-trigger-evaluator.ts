import type { Evaluator, IAgentRuntime } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';
import { ConstitutionService } from '../services/constitution-service.js';
import { fetchMonthlyComputeCost } from '../services/nosana-compute-service.js';
import * as migrations from '../db/migrations.js';
import type { ConstitutionRule } from '../types/constitution.js';
import { executeCrisisFreeze } from '../actions/trigger-crisis-protocol.js';

type Operator = '<' | '>' | '<=' | '>=' | '==' | '!=';

interface Condition {
  metric: string;
  operator: Operator;
  value: number;
}

function _check(opA: Operator, valA: number, opB: Operator, valB: number): boolean {
  if (opA === '<' && opB === '>') return valB >= valA;
  if (opA === '<=' && opB === '>') return valB >= valA;
  if (opA === '<' && opB === '>=') return valB >= valA;
  if (opA === '<=' && opB === '>=') return valB > valA;
  if (opA === '==' && opB === '!=') return valA === valB;
  if (opA === '==' && opB === '<') return valA >= valB;
  if (opA === '==' && opB === '>') return valA <= valB;
  return false;
}

export function isContradiction(a: Condition, b: Condition): boolean {
  return _check(a.operator, a.value, b.operator, b.value) ||
         _check(b.operator, b.value, a.operator, a.value);
}

export function detectContradiction(rules: ConstitutionRule[]): { violated: boolean; summary: string } {
  const blockRules = rules.filter(r => r.action === 'block');
  for (let i = 0; i < blockRules.length; i++) {
    for (let j = i + 1; j < blockRules.length; j++) {
      const a = blockRules[i];
      const b = blockRules[j];
      if (a.condition.metric !== b.condition.metric) continue;
      if (isContradiction(a.condition, b.condition)) {
        return {
          violated: true,
          summary: `Rule #${a.id} vs Rule #${b.id}: ${a.description} conflicts with ${b.description}`,
        };
      }
    }
  }
  return { violated: false, summary: '' };
}

export const CrisisTriggerEvaluator: Evaluator = {
  name: 'CRISIS_TRIGGER',
  description: 'Detects constitutional impossibility and triggers execution freeze.',
  similes: [],
  validate: async () => false,
  handler: async (runtime: IAgentRuntime) => {
    // AC5: skip if already frozen or resolving
    const state = AgentStateService.getState();
    if (state.crisisStatus !== 'active') return;

    // No constitution → nothing to evaluate
    const db = migrations.getDb();
    const constitution = ConstitutionService.getActive(db);
    if (!constitution || constitution.rules.length === 0) return;

    const { violated, summary } = detectContradiction(constitution.rules);
    if (violated) {
      // Delegate to shared freeze function
      await executeCrisisFreeze(runtime, {
        crisisType: 'constitution',
        violationSummary: summary,
      });
      return;
    }

    // Story 6.2: Check compute budget ceiling breach
    const computeRule = constitution.rules.find((r: ConstitutionRule) => r.type === 'compute_budget');
    if (computeRule) {
      try {
        const { spentNos } = await fetchMonthlyComputeCost();
        if (spentNos >= computeRule.condition.value) {
          await executeCrisisFreeze(runtime, {
            crisisType: 'constitution',
            violationSummary: `Rule #${computeRule.id}: NOS compute spend ${spentNos.toFixed(1)} NOS meets or exceeds monthly ceiling of ${computeRule.condition.value} NOS`,
          });
          return;
        }
      } catch {
        // API failure — skip compute check, no false crisis alarms
      }
    }
  },
  examples: [],
};
