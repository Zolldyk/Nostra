import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as migrations from '../db/migrations.js';
import { AgentStateService } from '../services/agent-state-service.js';
import { ConstitutionService } from '../services/constitution-service.js';
import * as nosanaComputeService from '../services/nosana-compute-service.js';
import * as triggerCrisisProtocol from '../actions/trigger-crisis-protocol.js';
import { CrisisTriggerEvaluator, isContradiction, detectContradiction } from './crisis-trigger-evaluator.js';

function makeRule(overrides: Record<string, unknown> = {}): any {
  return {
    id: 1,
    type: 'allocation_limit',
    description: 'Default rule',
    condition: { metric: 'sol_concentration', operator: '<=', value: 30, unit: 'percent' },
    action: 'block',
    ...overrides,
  };
}

describe('isContradiction', () => {
  it('< X AND > Y where Y >= X is a contradiction', () => {
    expect(isContradiction(
      { metric: 'm', operator: '<', value: 40 },
      { metric: 'm', operator: '>', value: 60 },
    )).toBe(true);
  });

  it('< X AND > Y where Y < X is NOT a contradiction', () => {
    expect(isContradiction(
      { metric: 'm', operator: '<', value: 60 },
      { metric: 'm', operator: '>', value: 40 },
    )).toBe(false);
  });

  it('<= X AND > Y where Y >= X is a contradiction', () => {
    expect(isContradiction(
      { metric: 'm', operator: '<=', value: 50 },
      { metric: 'm', operator: '>', value: 50 },
    )).toBe(true);
  });

  it('< X AND >= Y where Y >= X is a contradiction', () => {
    expect(isContradiction(
      { metric: 'm', operator: '<', value: 50 },
      { metric: 'm', operator: '>=', value: 50 },
    )).toBe(true);
  });

  it('<= X AND >= Y where Y > X is a contradiction', () => {
    expect(isContradiction(
      { metric: 'm', operator: '<=', value: 40 },
      { metric: 'm', operator: '>=', value: 60 },
    )).toBe(true);
  });

  it('<= X AND >= Y where Y == X is NOT a contradiction', () => {
    expect(isContradiction(
      { metric: 'm', operator: '<=', value: 50 },
      { metric: 'm', operator: '>=', value: 50 },
    )).toBe(false);
  });

  it('== X AND != X is a contradiction', () => {
    expect(isContradiction(
      { metric: 'm', operator: '==', value: 5 },
      { metric: 'm', operator: '!=', value: 5 },
    )).toBe(true);
  });

  it('== X AND != Y where Y != X is NOT a contradiction', () => {
    expect(isContradiction(
      { metric: 'm', operator: '==', value: 5 },
      { metric: 'm', operator: '!=', value: 10 },
    )).toBe(false);
  });

  it('== X AND < Y where X >= Y is a contradiction', () => {
    expect(isContradiction(
      { metric: 'm', operator: '==', value: 10 },
      { metric: 'm', operator: '<', value: 5 },
    )).toBe(true);
  });

  it('== X AND > Y where X <= Y is a contradiction', () => {
    expect(isContradiction(
      { metric: 'm', operator: '==', value: 3 },
      { metric: 'm', operator: '>', value: 5 },
    )).toBe(true);
  });

  it('symmetry: reversed argument order returns same result', () => {
    const a = { metric: 'm', operator: '<' as const, value: 40 };
    const b = { metric: 'm', operator: '>' as const, value: 60 };
    expect(isContradiction(a, b)).toBe(isContradiction(b, a));
  });

  it('< X AND < Y with same metric is NOT a contradiction', () => {
    expect(isContradiction(
      { metric: 'm', operator: '<', value: 40 },
      { metric: 'm', operator: '<', value: 60 },
    )).toBe(false);
  });
});

describe('detectContradiction', () => {
  it('returns violated: false for empty rules', () => {
    const result = detectContradiction([]);
    expect(result.violated).toBe(false);
  });

  it('returns violated: false when no block rules', () => {
    const rules = [
      makeRule({ action: 'alert', condition: { metric: 'm', operator: '<', value: 40 } }),
      makeRule({ id: 2, action: 'require_approval', condition: { metric: 'm', operator: '>', value: 60 } }),
    ];
    const result = detectContradiction(rules);
    expect(result.violated).toBe(false);
  });

  it('returns violated: false for non-contradictory block rules on same metric', () => {
    const rules = [
      makeRule({ id: 1, action: 'block', condition: { metric: 'sol_concentration', operator: '<', value: 40, unit: 'percent' } }),
      makeRule({ id: 2, action: 'block', condition: { metric: 'sol_concentration', operator: '<', value: 60, unit: 'percent' } }),
    ];
    const result = detectContradiction(rules);
    expect(result.violated).toBe(false);
  });

  it('returns violated: false for block rules on different metrics', () => {
    const rules = [
      makeRule({ id: 1, action: 'block', condition: { metric: 'sol_concentration', operator: '<', value: 40, unit: 'percent' } }),
      makeRule({ id: 2, action: 'block', condition: { metric: 'yield_delta', operator: '>', value: 60, unit: 'apy_points' } }),
    ];
    const result = detectContradiction(rules);
    expect(result.violated).toBe(false);
  });

  it('detects contradiction between block rules on same metric', () => {
    const rules = [
      makeRule({ id: 1, description: 'concentration below 40', action: 'block', condition: { metric: 'sol_concentration', operator: '<', value: 40, unit: 'percent' } }),
      makeRule({ id: 2, description: 'concentration above 60', action: 'block', condition: { metric: 'sol_concentration', operator: '>', value: 60, unit: 'percent' } }),
    ];
    const result = detectContradiction(rules);
    expect(result.violated).toBe(true);
    expect(result.summary).toContain('Rule #1');
    expect(result.summary).toContain('Rule #2');
  });

  it('summary includes both rule descriptions', () => {
    const rules = [
      makeRule({ id: 3, description: 'SOL must be below 30%', action: 'block', condition: { metric: 'sol_concentration', operator: '<', value: 30, unit: 'percent' } }),
      makeRule({ id: 5, description: 'SOL must be above 50%', action: 'block', condition: { metric: 'sol_concentration', operator: '>', value: 50, unit: 'percent' } }),
    ];
    const result = detectContradiction(rules);
    expect(result.violated).toBe(true);
    expect(result.summary).toContain('SOL must be below 30%');
    expect(result.summary).toContain('SOL must be above 50%');
  });
});

describe('CrisisTriggerEvaluator handler', () => {
  let state: any;
  let prepareMock: ReturnType<typeof mock>;
  let getStateSpy: ReturnType<typeof spyOn>;
  let getActiveSpy: ReturnType<typeof spyOn>;
  let getDbSpy: ReturnType<typeof spyOn>;
  let executeCrisisFreezeSpy: ReturnType<typeof spyOn>;
  let fetchMonthlyComputeCostSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    state = {
      crisisStatus: 'active',
      telegramChatId: 'chat-1',
    };
    prepareMock = mock(() => ({ run: mock(() => {}), get: mock(() => null), all: mock(() => []) }));
    getStateSpy = spyOn(AgentStateService, 'getState').mockImplementation(() => ({ ...state }));
    getActiveSpy = spyOn(ConstitutionService, 'getActive').mockReturnValue(null);
    getDbSpy = spyOn(migrations, 'getDb').mockReturnValue({ prepare: prepareMock } as any);
    executeCrisisFreezeSpy = spyOn(triggerCrisisProtocol, 'executeCrisisFreeze').mockResolvedValue(undefined);
    fetchMonthlyComputeCostSpy = spyOn(nosanaComputeService, 'fetchMonthlyComputeCost').mockResolvedValue({
      spentNos: 12.5,
      monthLabel: 'April 2026',
    });
  });

  afterEach(() => {
    getStateSpy.mockRestore();
    getActiveSpy.mockRestore();
    getDbSpy.mockRestore();
    executeCrisisFreezeSpy.mockRestore();
    fetchMonthlyComputeCostSpy.mockRestore();
  });

  it('returns early when crisisStatus is frozen (AC5)', async () => {
    state = { ...state, crisisStatus: 'frozen' };
    await CrisisTriggerEvaluator.handler({} as any, undefined as any, undefined as any, {}, undefined);

    expect(executeCrisisFreezeSpy).not.toHaveBeenCalled();
    expect(getActiveSpy).not.toHaveBeenCalled();
  });

  it('returns early when crisisStatus is resolving (AC5)', async () => {
    state = { ...state, crisisStatus: 'resolving' };
    await CrisisTriggerEvaluator.handler({} as any, undefined as any, undefined as any, {}, undefined);

    expect(executeCrisisFreezeSpy).not.toHaveBeenCalled();
  });

  it('returns early when no active constitution', async () => {
    getActiveSpy.mockReturnValue(null);
    await CrisisTriggerEvaluator.handler({} as any, undefined as any, undefined as any, {}, undefined);

    expect(executeCrisisFreezeSpy).not.toHaveBeenCalled();
  });

  it('returns early when constitution has no rules', async () => {
    getActiveSpy.mockReturnValue({ id: 1, version: 1, rules: [] });
    await CrisisTriggerEvaluator.handler({} as any, undefined as any, undefined as any, {}, undefined);

    expect(executeCrisisFreezeSpy).not.toHaveBeenCalled();
  });

  it('does NOT call executeCrisisFreeze when no contradiction exists', async () => {
    getActiveSpy.mockReturnValue({
      id: 1, version: 1,
      rules: [
        makeRule({ id: 1, action: 'block', condition: { metric: 'sol_concentration', operator: '<', value: 60, unit: 'percent' } }),
        makeRule({ id: 2, action: 'block', condition: { metric: 'sol_concentration', operator: '<', value: 40, unit: 'percent' } }),
      ],
    });

    await CrisisTriggerEvaluator.handler({} as any, undefined as any, undefined as any, {}, undefined);

    expect(executeCrisisFreezeSpy).not.toHaveBeenCalled();
  });

  it('calls executeCrisisFreeze with crisisType constitution when contradiction detected', async () => {
    getActiveSpy.mockReturnValue({
      id: 1, version: 1,
      rules: [
        makeRule({ id: 1, description: 'below 40', action: 'block', condition: { metric: 'sol_concentration', operator: '<', value: 40, unit: 'percent' } }),
        makeRule({ id: 2, description: 'above 60', action: 'block', condition: { metric: 'sol_concentration', operator: '>', value: 60, unit: 'percent' } }),
      ],
    });

    const rt = {} as any;
    await CrisisTriggerEvaluator.handler(rt, undefined as any, undefined as any, {}, undefined);

    expect(executeCrisisFreezeSpy).toHaveBeenCalledWith(rt, expect.objectContaining({ crisisType: 'constitution' }));
    expect(executeCrisisFreezeSpy.mock.calls[0][1].violationSummary).toContain('Rule #1');
    expect(executeCrisisFreezeSpy.mock.calls[0][1].violationSummary).toContain('Rule #2');
  });

  it('fires crisis when compute spend meets budget ceiling (spentNos >= ceiling)', async () => {
    getActiveSpy.mockReturnValue({
      id: 1,
      version: 1,
      rules: [
        makeRule({
          id: 8,
          type: 'compute_budget',
          action: 'alert',
          description: 'Monthly Nosana compute spend must not exceed 50 NOS',
          condition: { metric: 'compute_cost_nos', operator: '<', value: 50, unit: 'nos_tokens' },
        }),
      ],
    });
    fetchMonthlyComputeCostSpy.mockResolvedValue({ spentNos: 50, monthLabel: 'April 2026' });

    const rt = {} as any;
    await CrisisTriggerEvaluator.handler(rt, undefined as any, undefined as any, {}, undefined);

    expect(executeCrisisFreezeSpy).toHaveBeenCalledWith(
      rt,
      expect.objectContaining({
        crisisType: 'constitution',
        violationSummary: expect.stringContaining('Rule #8'),
      }),
    );
    expect(executeCrisisFreezeSpy.mock.calls[0][1].violationSummary).toContain('50.0 NOS');
  });

  it('does NOT fire crisis when compute spend is below ceiling', async () => {
    getActiveSpy.mockReturnValue({
      id: 1,
      version: 1,
      rules: [
        makeRule({
          id: 8,
          type: 'compute_budget',
          action: 'alert',
          description: 'Monthly Nosana compute spend must not exceed 50 NOS',
          condition: { metric: 'compute_cost_nos', operator: '<', value: 50, unit: 'nos_tokens' },
        }),
      ],
    });
    fetchMonthlyComputeCostSpy.mockResolvedValue({ spentNos: 49.9, monthLabel: 'April 2026' });

    await CrisisTriggerEvaluator.handler({} as any, undefined as any, undefined as any, {}, undefined);

    expect(executeCrisisFreezeSpy).not.toHaveBeenCalled();
  });

  it('does NOT fire crisis when Nosana API throws (fail-safe — no false alarms)', async () => {
    getActiveSpy.mockReturnValue({
      id: 1,
      version: 1,
      rules: [
        makeRule({
          id: 8,
          type: 'compute_budget',
          action: 'alert',
          description: 'Monthly Nosana compute spend must not exceed 50 NOS',
          condition: { metric: 'compute_cost_nos', operator: '<', value: 50, unit: 'nos_tokens' },
        }),
      ],
    });
    fetchMonthlyComputeCostSpy.mockRejectedValue(new Error('Nosana unavailable'));

    await CrisisTriggerEvaluator.handler({} as any, undefined as any, undefined as any, {}, undefined);

    expect(executeCrisisFreezeSpy).not.toHaveBeenCalled();
  });

  it('skips compute check when no compute_budget rule in constitution', async () => {
    getActiveSpy.mockReturnValue({
      id: 1,
      version: 1,
      rules: [
        makeRule({
          id: 1,
          type: 'yield_threshold',
          action: 'alert',
          condition: { metric: 'yield_delta', operator: '>=', value: 3, unit: 'apy_points' },
        }),
      ],
    });

    await CrisisTriggerEvaluator.handler({} as any, undefined as any, undefined as any, {}, undefined);

    expect(fetchMonthlyComputeCostSpy).not.toHaveBeenCalled();
  });
});

describe('CrisisTriggerEvaluator metadata', () => {
  it('has correct name', () => {
    expect(CrisisTriggerEvaluator.name).toBe('CRISIS_TRIGGER');
  });

  it('validate() always returns false', async () => {
    expect(await CrisisTriggerEvaluator.validate({} as any, {} as any, {} as any)).toBe(false);
  });
});
