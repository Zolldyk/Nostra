import { describe, expect, test } from 'bun:test';
import { checkConstitutionalCompliance } from './check-constitutional-compliance.js';
import type { ConstitutionRule } from '../types/constitution.js';

const rule: ConstitutionRule = {
  id: 1,
  type: 'allocation_limit',
  description: 'Never more than 50% in a single protocol',
  condition: { metric: 'sol_concentration', operator: '<=', value: 50, unit: 'percent' },
  action: 'block',
};

describe('checkConstitutionalCompliance', () => {
  test('passes when proposed value satisfies the rule condition', () => {
    const result = checkConstitutionalCompliance([rule], { metric: 'sol_concentration', value: 30, unit: 'percent' });
    expect(result.passed).toBe(true);
  });

  test('fails when proposed value violates a blocking rule', () => {
    const result = checkConstitutionalCompliance([rule], { metric: 'sol_concentration', value: 90, unit: 'percent' });
    expect(result.passed).toBe(false);
    expect(result.ruleRef).toBe(1);
    expect(result.violation).toBe('Never more than 50% in a single protocol');
  });

  test('passes when no rule matches the proposed metric', () => {
    const result = checkConstitutionalCompliance([rule], { metric: 'yield_delta', value: 5, unit: 'apy_points' });
    expect(result.passed).toBe(true);
  });

  test('passes for alert-only rules even if condition is violated', () => {
    const alertRule: ConstitutionRule = { ...rule, action: 'alert' };
    const result = checkConstitutionalCompliance([alertRule], { metric: 'sol_concentration', value: 90, unit: 'percent' });
    expect(result.passed).toBe(true);
  });

  test('passes when rules array is empty', () => {
    const result = checkConstitutionalCompliance([], { metric: 'sol_concentration', value: 90, unit: 'percent' });
    expect(result.passed).toBe(true);
  });

  test('returns first failing rule when multiple rules match', () => {
    const rule2: ConstitutionRule = { ...rule, id: 2, description: 'Second rule' };
    const result = checkConstitutionalCompliance([rule, rule2], { metric: 'sol_concentration', value: 90, unit: 'percent' });
    expect(result.ruleRef).toBe(1); // first blocking rule wins
  });

  test('all comparison operators work correctly', () => {
    const baseRule = (op: ConstitutionRule['condition']['operator']): ConstitutionRule => ({
      ...rule,
      condition: { ...rule.condition, operator: op, value: 50 },
    });
    expect(checkConstitutionalCompliance([baseRule('<')], { metric: 'sol_concentration', value: 30, unit: 'percent' }).passed).toBe(true);
    expect(checkConstitutionalCompliance([baseRule('<')], { metric: 'sol_concentration', value: 70, unit: 'percent' }).passed).toBe(false);
    expect(checkConstitutionalCompliance([baseRule('>=')], { metric: 'sol_concentration', value: 50, unit: 'percent' }).passed).toBe(true);
    expect(checkConstitutionalCompliance([baseRule('>=')], { metric: 'sol_concentration', value: 30, unit: 'percent' }).passed).toBe(false);
  });
});
