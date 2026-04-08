import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Memory } from '@elizaos/core';
import * as migrations from '../db/migrations.js';
import * as schemas from '../db/schema.js';
import { AgentStateService } from '../services/agent-state-service.js';
import type { AgentState } from '../types/agent-state.js';

type CallbackPayload = {
  text: string;
  actions: string[];
  source: string;
};

describe('ParseConstitutionAction', () => {
  let testDb: Database;
  let state: AgentState;
  let setStateCalls: Array<Partial<AgentState>>;
  let getStateSpy: ReturnType<typeof spyOn>;
  let setStateSpy: ReturnType<typeof spyOn>;
  let getDbSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.run('PRAGMA foreign_keys = ON');
    for (const sql of schemas.ALL_SCHEMAS) {
      testDb.run(sql);
    }

    state = {
      mode: 'paper',
      trustLadder: 'advisor',
      crisisStatus: 'active',
      constitutionVersion: 0,
      accuracyScore: 0,
      suggestionsSampled: 0,
      onboardingState: 'beliefs_confirmed',
      updatedAt: new Date().toISOString(),
    };
    setStateCalls = [];

    getStateSpy = spyOn(AgentStateService, 'getState').mockImplementation(() => ({ ...state }));
    setStateSpy = spyOn(AgentStateService, 'setState').mockImplementation(async (update: Partial<AgentState>) => {
      setStateCalls.push(update);
      state = { ...state, ...update, updatedAt: new Date().toISOString() };
    });
    getDbSpy = spyOn(migrations, 'getDb').mockReturnValue(testDb as ReturnType<typeof migrations.getDb>);
  });

  afterEach(() => {
    getStateSpy.mockRestore();
    setStateSpy.mockRestore();
    getDbSpy.mockRestore();
    testDb.close();
  });

  // ─── VALIDATE TESTS ──────────────────────────────────────────────────────

  it('validate — returns false for commands', async () => {
    state.onboardingState = 'beliefs_confirmed';
    const { ParseConstitutionAction } = await import('./parse-constitution.js');
    const message = { content: { text: '/start' } } as Memory;
    await expect(ParseConstitutionAction.validate!({} as never, message)).resolves.toBe(false);
  });

  it('validate — returns false when onboardingState is pending', async () => {
    state.onboardingState = 'pending';
    const { ParseConstitutionAction } = await import('./parse-constitution.js');
    const message = { content: { text: 'hello' } } as Memory;
    await expect(ParseConstitutionAction.validate!({} as never, message)).resolves.toBe(false);
  });

  it('validate — returns false when onboardingState is complete', async () => {
    state.onboardingState = 'complete';
    const { ParseConstitutionAction } = await import('./parse-constitution.js');
    const message = { content: { text: 'hello' } } as Memory;
    await expect(ParseConstitutionAction.validate!({} as never, message)).resolves.toBe(false);
  });

  it('validate — returns true when beliefs_confirmed', async () => {
    state.onboardingState = 'beliefs_confirmed';
    const { ParseConstitutionAction } = await import('./parse-constitution.js');
    const message = { content: { text: 'yes, looks good' } } as Memory;
    await expect(ParseConstitutionAction.validate!({} as never, message)).resolves.toBe(true);
  });

  // ─── HANDLER TESTS (parse phase) ─────────────────────────────────────────

  it('handler (parse phase) — sends ⏳ Thinking... before parse', async () => {
    const { ParseConstitutionAction } = await import('./parse-constitution.js');
    const { OnboardingService } = await import('../services/onboarding-service.js');

    // Seed a belief summary turn so handler has something to parse
    OnboardingService.addTurn(testDb as never, 'agent', 'Your beliefs are: risk-averse, DeFi-curious', 'summary');

    const validRulesJson = JSON.stringify([
      {
        id: 1,
        type: 'allocation_limit',
        description: 'Never put more than 20% in a single asset',
        condition: { metric: 'sol_concentration', operator: '>', value: 20, unit: 'percent' },
        action: 'block',
      },
    ]);

    const useModelMock = mock(async () => validRulesJson);
    const runtime = { useModel: useModelMock } as never;
    const callback = mock(async (_payload: CallbackPayload) => undefined);
    const message = { content: { text: 'ready' } } as Memory;

    await ParseConstitutionAction.handler!(runtime, message, undefined, undefined, callback);

    const callTexts = callback.mock.calls.map(c => (c[0] as CallbackPayload).text);
    expect(callTexts[0]).toBe('⏳ Thinking...');
  });

  it('handler (parse phase) — calls saveDraft with parsed rules where rules[0].id === 1', async () => {
    const { ParseConstitutionAction } = await import('./parse-constitution.js');
    const { OnboardingService } = await import('../services/onboarding-service.js');
    const { ConstitutionService } = await import('../services/constitution-service.js');

    OnboardingService.addTurn(testDb as never, 'agent', 'Belief summary text', 'summary');

    const validRulesJson = JSON.stringify([
      {
        id: 99, // id will be overwritten to 1
        type: 'allocation_limit',
        description: 'Rule one',
        condition: { metric: 'sol_concentration', operator: '>', value: 30, unit: 'percent' },
        action: 'block',
      },
      {
        id: 99,
        type: 'yield_threshold',
        description: 'Rule two',
        condition: { metric: 'yield_delta', operator: '<', value: 2, unit: 'apy_points' },
        action: 'alert',
      },
    ]);

    const runtime = { useModel: mock(async () => validRulesJson) } as never;
    const callback = mock(async () => undefined);
    const message = { content: { text: 'yes' } } as Memory;

    await ParseConstitutionAction.handler!(runtime, message, undefined, undefined, callback);

    const draft = ConstitutionService.getDraft(testDb as never);
    expect(draft).not.toBeNull();
    expect(draft!.rules[0].id).toBe(1);
    expect(draft!.rules[1].id).toBe(2);
  });

  it('handler (parse phase) — displays constitution with Rule #1', async () => {
    const { ParseConstitutionAction } = await import('./parse-constitution.js');
    const { OnboardingService } = await import('../services/onboarding-service.js');

    OnboardingService.addTurn(testDb as never, 'agent', 'Belief summary', 'summary');

    const validRulesJson = JSON.stringify([
      {
        id: 1,
        type: 'allocation_limit',
        description: 'Keep SOL under 25%',
        condition: { metric: 'sol_concentration', operator: '>', value: 25, unit: 'percent' },
        action: 'block',
      },
    ]);

    const runtime = { useModel: mock(async () => validRulesJson) } as never;
    const callback = mock(async (_payload: CallbackPayload) => undefined);
    const message = { content: { text: 'yes' } } as Memory;

    await ParseConstitutionAction.handler!(runtime, message, undefined, undefined, callback);

    const callTexts = callback.mock.calls.map(c => (c[0] as CallbackPayload).text);
    const constitutionDisplay = callTexts.find(t => t.includes('Rule #1'));
    expect(constitutionDisplay).toBeDefined();
    expect(constitutionDisplay).toContain('Rule #1');
  });

  it('handler (parse phase) — display does not present compute clause as an editable rule before approval', async () => {
    const { ParseConstitutionAction } = await import('./parse-constitution.js');
    const { OnboardingService } = await import('../services/onboarding-service.js');

    OnboardingService.addTurn(testDb as never, 'agent', 'Belief summary', 'summary');

    const validRulesJson = JSON.stringify([
      {
        id: 1,
        type: 'allocation_limit',
        description: 'Keep SOL under 25%',
        condition: { metric: 'sol_concentration', operator: '>', value: 25, unit: 'percent' },
        action: 'block',
      },
    ]);

    const runtime = { useModel: mock(async () => validRulesJson) } as never;
    const callback = mock(async (_payload: CallbackPayload) => undefined);
    const message = { content: { text: 'yes' } } as Memory;

    await ParseConstitutionAction.handler!(runtime, message, undefined, undefined, callback);

    const callTexts = callback.mock.calls.map(c => (c[0] as CallbackPayload).text);
    const constitutionDisplay = callTexts.find(t => t.includes('Your First Constitution'));
    expect(constitutionDisplay).toBeDefined();
    expect(constitutionDisplay).not.toContain('default compute clause — added automatically');
    expect(constitutionDisplay).toContain('append a default compute clause');
  });

  it('handler (parse phase) — stores constitution_display turn in onboarding_session', async () => {
    const { ParseConstitutionAction } = await import('./parse-constitution.js');
    const { OnboardingService } = await import('../services/onboarding-service.js');

    OnboardingService.addTurn(testDb as never, 'agent', 'Belief summary', 'summary');

    const validRulesJson = JSON.stringify([
      {
        id: 1,
        type: 'custom',
        description: 'Stay conservative',
        condition: { metric: 'max_drawdown_pct', operator: '>', value: 10, unit: 'percent' },
        action: 'alert',
      },
    ]);

    const runtime = { useModel: mock(async () => validRulesJson) } as never;
    const callback = mock(async () => undefined);
    const message = { content: { text: 'yes' } } as Memory;

    await ParseConstitutionAction.handler!(runtime, message, undefined, undefined, callback);

    const history = OnboardingService.getHistory(testDb as never);
    const displayTurn = history.find(t => t.role === 'agent' && t.phase === 'constitution_display');
    expect(displayTurn).toBeDefined();
  });

  it('handler (parse phase) — rejects invalid parsed rules instead of saving malformed operators', async () => {
    const { ParseConstitutionAction } = await import('./parse-constitution.js');
    const { OnboardingService } = await import('../services/onboarding-service.js');
    const { ConstitutionService } = await import('../services/constitution-service.js');

    OnboardingService.addTurn(testDb as never, 'agent', 'Belief summary', 'summary');

    const invalidRulesJson = JSON.stringify([
      {
        id: 1,
        type: 'allocation_limit',
        description: 'Keep SOL under 25%',
        condition: { metric: 'sol_concentration', operator: '<<', value: 25, unit: 'percent' },
        action: 'block',
      },
    ]);

    const runtime = { useModel: mock(async () => invalidRulesJson) } as never;
    const callback = mock(async (_payload: CallbackPayload) => undefined);
    const message = { content: { text: 'yes' } } as Memory;

    await ParseConstitutionAction.handler!(runtime, message, undefined, undefined, callback);

    const draft = ConstitutionService.getDraft(testDb as never);
    const callTexts = callback.mock.calls.map(c => (c[0] as CallbackPayload).text);
    expect(draft).toBeNull();
    expect(callTexts).toContain("I had trouble organizing your beliefs. Please say 'yes' to try again.");
  });

  // ─── HANDLER TESTS (approval phase) ──────────────────────────────────────

  it('handler (approval phase) — APPROVED activates constitution and calls setState', async () => {
    const { ParseConstitutionAction } = await import('./parse-constitution.js');
    const { OnboardingService } = await import('../services/onboarding-service.js');
    const { ConstitutionService } = await import('../services/constitution-service.js');

    // Seed a draft constitution
    const rules = [
      {
        id: 1,
        type: 'allocation_limit' as const,
        description: 'Max 20% in one asset',
        condition: { metric: 'sol_concentration', operator: '>' as const, value: 20, unit: 'percent' },
        action: 'block' as const,
      },
    ];
    ConstitutionService.saveDraft(testDb as never, rules);

    // Seed a constitution_display agent turn (approval phase gate)
    OnboardingService.addTurn(testDb as never, 'agent', '📜 *Your First Constitution*\n...', 'constitution_display');

    const useModelMock = mock(async () => 'APPROVED');
    const runtime = { useModel: useModelMock } as never;
    const callback = mock(async () => undefined);
    const message = { content: { text: 'yes, I approve' } } as Memory;

    await ParseConstitutionAction.handler!(runtime, message, undefined, undefined, callback);

    expect(setStateCalls).toContainEqual(
      expect.objectContaining({ onboardingState: 'complete', constitutionVersion: 1, mode: 'paper' }),
    );
  });

  it('handler (approval phase) — APPROVED appends compute budget rule as last rule', async () => {
    const { ParseConstitutionAction } = await import('./parse-constitution.js');
    const { OnboardingService } = await import('../services/onboarding-service.js');
    const { ConstitutionService } = await import('../services/constitution-service.js');

    const rules = [
      {
        id: 1,
        type: 'allocation_limit' as const,
        description: 'Max 30% in one asset',
        condition: { metric: 'sol_concentration', operator: '>' as const, value: 30, unit: 'percent' },
        action: 'block' as const,
      },
    ];
    ConstitutionService.saveDraft(testDb as never, rules);
    OnboardingService.addTurn(testDb as never, 'agent', '📜 *Your First Constitution*\n...', 'constitution_display');

    const runtime = { useModel: mock(async () => 'APPROVED') } as never;
    const callback = mock(async () => undefined);
    const message = { content: { text: 'looks good' } } as Memory;

    await ParseConstitutionAction.handler!(runtime, message, undefined, undefined, callback);

    const active = ConstitutionService.getActive(testDb as never);
    expect(active).not.toBeNull();
    const lastRule = active!.rules[active!.rules.length - 1];
    expect(lastRule.type).toBe('compute_budget');
  });

  it('handler (approval phase) — APPROVED sends activation message containing Constitution Activated', async () => {
    const { ParseConstitutionAction } = await import('./parse-constitution.js');
    const { OnboardingService } = await import('../services/onboarding-service.js');
    const { ConstitutionService } = await import('../services/constitution-service.js');

    const rules = [
      {
        id: 1,
        type: 'yield_threshold' as const,
        description: 'Alert if yield drops below 4%',
        condition: { metric: 'yield_delta', operator: '<' as const, value: 4, unit: 'apy_points' },
        action: 'alert' as const,
      },
    ];
    ConstitutionService.saveDraft(testDb as never, rules);
    OnboardingService.addTurn(testDb as never, 'agent', '📜 *Your First Constitution*\n...', 'constitution_display');

    const runtime = { useModel: mock(async () => 'APPROVED') } as never;
    const callback = mock(async (_payload: CallbackPayload) => undefined);
    const message = { content: { text: 'yes' } } as Memory;

    await ParseConstitutionAction.handler!(runtime, message, undefined, undefined, callback);

    const callTexts = callback.mock.calls.map(c => (c[0] as CallbackPayload).text);
    const activationMsg = callTexts.find(t => t.includes('Constitution Activated'));
    expect(activationMsg).toBeDefined();
  });

  // ─── HANDLER TESTS (amendment phase) ─────────────────────────────────────

  it('handler (amendment phase) — AMEND regenerates rule and re-displays constitution', async () => {
    const { ParseConstitutionAction } = await import('./parse-constitution.js');
    const { OnboardingService } = await import('../services/onboarding-service.js');
    const { ConstitutionService } = await import('../services/constitution-service.js');

    const rules = [
      {
        id: 1,
        type: 'allocation_limit' as const,
        description: 'Rule one description',
        condition: { metric: 'sol_concentration', operator: '>' as const, value: 20, unit: 'percent' },
        action: 'block' as const,
      },
      {
        id: 2,
        type: 'yield_threshold' as const,
        description: 'Rule two description',
        condition: { metric: 'yield_delta', operator: '<' as const, value: 3, unit: 'apy_points' },
        action: 'alert' as const,
      },
    ];
    ConstitutionService.saveDraft(testDb as never, rules);
    OnboardingService.addTurn(testDb as never, 'agent', '📜 *Your First Constitution*\n...', 'constitution_display');

    const updatedRule = {
      id: 2,
      type: 'yield_threshold' as const,
      description: 'Alert if yield drops below 5%',
      condition: { metric: 'yield_delta', operator: '<' as const, value: 5, unit: 'apy_points' },
      action: 'alert' as const,
    };

    let callCount = 0;
    const useModelMock = mock(async () => {
      callCount++;
      if (callCount === 1) return 'AMEND';        // approval classification
      if (callCount === 2) return '2';            // which rule to amend
      if (callCount === 3) return JSON.stringify(updatedRule); // regenerated rule
      return 'OK';                                // contradiction check
    });

    const runtime = { useModel: useModelMock } as never;
    const callback = mock(async () => undefined);
    const message = { content: { text: 'Change rule 2 to alert at 5%' } } as Memory;

    await ParseConstitutionAction.handler!(runtime, message, undefined, undefined, callback);

    const history = OnboardingService.getHistory(testDb as never);
    const displayTurns = history.filter(t => t.role === 'agent' && t.phase === 'constitution_display');
    // A second constitution_display turn should have been added after re-display
    expect(displayTurns.length).toBe(2);
  });

  it('handler (amendment phase) — contradiction follow-up skips approval classification and keeps amending', async () => {
    const { ParseConstitutionAction } = await import('./parse-constitution.js');
    const { OnboardingService } = await import('../services/onboarding-service.js');
    const { ConstitutionService } = await import('../services/constitution-service.js');

    ConstitutionService.saveDraft(testDb as never, [
      {
        id: 1,
        type: 'allocation_limit',
        description: 'Rule one description',
        condition: { metric: 'sol_concentration', operator: '>', value: 20, unit: 'percent' },
        action: 'block',
      },
      {
        id: 2,
        type: 'yield_threshold',
        description: 'Rule two description',
        condition: { metric: 'yield_delta', operator: '<', value: 3, unit: 'apy_points' },
        action: 'alert',
      },
    ]);

    OnboardingService.addTurn(testDb as never, 'agent', '📜 *Your First Constitution*\n...', 'constitution_display');
    OnboardingService.addTurn(testDb as never, 'agent', 'Rule #1 and Rule #2 contradict because ...', 'contradiction');

    const updatedRule = {
      id: 2,
      type: 'yield_threshold' as const,
      description: 'Alert if yield drops below 5%',
      condition: { metric: 'yield_delta', operator: '<' as const, value: 5, unit: 'apy_points' },
      action: 'alert' as const,
    };

    let callCount = 0;
    const useModelMock = mock(async () => {
      callCount++;
      if (callCount === 1) return '2';
      if (callCount === 2) return JSON.stringify(updatedRule);
      return 'OK';
    });

    const runtime = { useModel: useModelMock } as never;
    const callback = mock(async () => undefined);
    const message = { content: { text: 'Change rule 2 to alert at 5%' } } as Memory;

    await ParseConstitutionAction.handler!(runtime, message, undefined, undefined, callback);

    const active = ConstitutionService.getActive(testDb as never);
    const history = OnboardingService.getHistory(testDb as never);
    const displayTurns = history.filter(t => t.role === 'agent' && t.phase === 'constitution_display');

    expect(useModelMock).toHaveBeenCalledTimes(3);
    expect(active).toBeNull();
    expect(displayTurns.length).toBe(2);
  });
});
