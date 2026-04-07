import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Memory } from '@elizaos/core';
import type { AgentState } from '../types/agent-state.js';

type CallbackPayload = {
  text: string;
  actions: string[];
  source: string;
};

describe('SocraticOnboardingAction', () => {
  let testDb: Database;
  let state: AgentState;
  let setStateCalls: Array<Partial<AgentState>>;

  beforeEach(async () => {
    const actualMigrations = await import('../db/migrations.js');

    testDb = new Database(':memory:');
    testDb.run('PRAGMA foreign_keys = ON');
    testDb.run(`CREATE TABLE IF NOT EXISTS agent_state (
      id INTEGER PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'paper',
      trust_ladder TEXT NOT NULL DEFAULT 'advisor',
      crisis_status TEXT NOT NULL DEFAULT 'active',
      constitution_version INTEGER NOT NULL DEFAULT 0,
      accuracy_score REAL NOT NULL DEFAULT 0,
      suggestions_sampled INTEGER NOT NULL DEFAULT 0,
      onboarding_state TEXT NOT NULL DEFAULT 'pending',
      updated_at TEXT NOT NULL
    )`);
    testDb.run(`CREATE TABLE IF NOT EXISTS onboarding_session (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK(role IN ('agent', 'user')),
      content TEXT NOT NULL,
      phase TEXT NOT NULL DEFAULT 'questions',
      created_at TEXT NOT NULL
    )`);

    state = {
      mode: 'paper',
      trustLadder: 'advisor',
      crisisStatus: 'active',
      constitutionVersion: 0,
      accuracyScore: 0,
      suggestionsSampled: 0,
      onboardingState: 'pending',
      updatedAt: new Date().toISOString(),
    };
    setStateCalls = [];

    mock.module('../services/agent-state-service.js', () => ({
      AgentStateService: {
        getState: () => ({ ...state }),
        setState: async (update: Partial<AgentState>) => {
          setStateCalls.push(update);
          state = { ...state, ...update, updatedAt: new Date().toISOString() };
        },
      },
    }));

    mock.module('../db/migrations.js', () => ({
      ...actualMigrations,
      getDb: () => testDb,
      DatabaseLike: {},
    }));
  });

  afterEach(() => {
    mock.restore();
    testDb.close();
  });

  // ─── VALIDATE TESTS ───────────────────────────────────────────────────────

  it('validate — returns false for /start command', async () => {
    state.onboardingState = 'disclaimer_delivered';
    const { SocraticOnboardingAction } = await import('./socratic-onboarding.js');
    const message = { content: { text: '/start' } } as Memory;
    await expect(SocraticOnboardingAction.validate!({} as never, message)).resolves.toBe(false);
  });

  it('validate — returns false when onboardingState is pending', async () => {
    state.onboardingState = 'pending';
    const { SocraticOnboardingAction } = await import('./socratic-onboarding.js');
    const message = { content: { text: 'hello' } } as Memory;
    await expect(SocraticOnboardingAction.validate!({} as never, message)).resolves.toBe(false);
  });

  it('validate — returns true when onboardingState is disclaimer_delivered', async () => {
    state.onboardingState = 'disclaimer_delivered';
    const { SocraticOnboardingAction } = await import('./socratic-onboarding.js');
    const message = { content: { text: 'I understand, ready' } } as Memory;
    await expect(SocraticOnboardingAction.validate!({} as never, message)).resolves.toBe(true);
  });

  it('validate — returns true when onboardingState is socratic_in_progress', async () => {
    state.onboardingState = 'socratic_in_progress';
    const { SocraticOnboardingAction } = await import('./socratic-onboarding.js');
    const message = { content: { text: 'about 10% per month' } } as Memory;
    await expect(SocraticOnboardingAction.validate!({} as never, message)).resolves.toBe(true);
  });

  it('validate — returns false when onboardingState is complete', async () => {
    state.onboardingState = 'complete';
    const { SocraticOnboardingAction } = await import('./socratic-onboarding.js');
    const message = { content: { text: 'hello' } } as Memory;
    await expect(SocraticOnboardingAction.validate!({} as never, message)).resolves.toBe(false);
  });

  // ─── HANDLER TESTS ────────────────────────────────────────────────────────

  it('handler — sends FIRST_QUESTION without ⏳ on first invocation', async () => {
    state.onboardingState = 'disclaimer_delivered';
    const { SocraticOnboardingAction } = await import('./socratic-onboarding.js');

    const useModelMock = mock(async () => 'some llm question');
    const runtime = { useModel: useModelMock } as never;
    const callback = mock(async (_payload: CallbackPayload) => undefined);
    const message = { content: { text: "I'm ready to begin" } } as Memory;

    await SocraticOnboardingAction.handler!(runtime, message, undefined, undefined, callback);

    // useModel must NOT be called for the first question
    expect(useModelMock).not.toHaveBeenCalled();

    const callTexts = callback.mock.calls.map(c => (c[0] as CallbackPayload).text);
    // Should not start with ⏳
    expect(callTexts[0]).not.toBe('⏳ Thinking...');
    // Should be the fixed FIRST_QUESTION
    expect(callTexts[0]).toContain('comfortable losing');
  });

  it('handler — transitions state to socratic_in_progress from disclaimer_delivered', async () => {
    state.onboardingState = 'disclaimer_delivered';
    const { SocraticOnboardingAction } = await import('./socratic-onboarding.js');

    const runtime = { useModel: mock(async () => 'question text') } as never;
    const callback = mock(async () => undefined);
    const message = { content: { text: "I'm ready" } } as Memory;

    await SocraticOnboardingAction.handler!(runtime, message, undefined, undefined, callback);

    expect(setStateCalls).toContainEqual({ onboardingState: 'socratic_in_progress' });
  });

  it('handler — sends ⏳ Thinking... as first callback when LLM call is needed', async () => {
    state.onboardingState = 'socratic_in_progress';
    const { SocraticOnboardingAction } = await import('./socratic-onboarding.js');
    const { OnboardingService } = await import('../services/onboarding-service.js');

    // Seed DB with FIRST_QUESTION already asked — user is about to answer it
    OnboardingService.addTurn(testDb as never, 'agent', "What's the most you'd be comfortable losing?", 'questions');

    let callCount = 0;
    const useModelFn = mock(async () => {
      callCount++;
      // first call = contradiction check (skip — only 1 user answer after recording)
      // second call = question generation
      return callCount === 1 ? 'OK' : 'What is your investment time horizon?';
    });
    const runtime = { useModel: useModelFn } as never;
    const callback = mock(async (_payload: CallbackPayload) => undefined);
    const message = { content: { text: 'About 10% in a bad month' } } as Memory;

    await SocraticOnboardingAction.handler!(runtime, message, undefined, undefined, callback);

    const callTexts = callback.mock.calls.map(c => (c[0] as CallbackPayload).text);
    // First callback must be ⏳ Thinking... (before useModel for question 2)
    expect(callTexts[0]).toBe('⏳ Thinking...');
  });

  it('handler — records agent question in onboarding_session', async () => {
    state.onboardingState = 'disclaimer_delivered';
    const { SocraticOnboardingAction } = await import('./socratic-onboarding.js');
    const { OnboardingService } = await import('../services/onboarding-service.js');

    const runtime = { useModel: mock(async () => 'question') } as never;
    const callback = mock(async () => undefined);
    const message = { content: { text: "I'm ready" } } as Memory;

    await SocraticOnboardingAction.handler!(runtime, message, undefined, undefined, callback);

    const history = OnboardingService.getHistory(testDb as never);
    const agentTurns = history.filter(t => t.role === 'agent');
    expect(agentTurns.length).toBeGreaterThan(0);
  });

  it('handler — records user answer in onboarding_session', async () => {
    state.onboardingState = 'socratic_in_progress';
    const { SocraticOnboardingAction } = await import('./socratic-onboarding.js');
    const { OnboardingService } = await import('../services/onboarding-service.js');

    // Seed FIRST_QUESTION as the last agent turn
    OnboardingService.addTurn(testDb as never, 'agent', "What's the most you'd be comfortable losing?", 'questions');

    const runtime = { useModel: mock(async () => 'Question 2?') } as never;
    const callback = mock(async () => undefined);
    const message = { content: { text: 'About 10%' } } as Memory;

    const countBefore = OnboardingService.countUserAnswers(testDb as never);
    await SocraticOnboardingAction.handler!(runtime, message, undefined, undefined, callback);
    const countAfter = OnboardingService.countUserAnswers(testDb as never);

    expect(countAfter).toBe(countBefore + 1);
  });

  it('handler — skips next question and returns when contradiction is detected', async () => {
    state.onboardingState = 'socratic_in_progress';
    const { SocraticOnboardingAction } = await import('./socratic-onboarding.js');
    const { OnboardingService } = await import('../services/onboarding-service.js');

    // Seed 1 Q&A pair so contradiction check fires (updatedUserCount > 1)
    OnboardingService.addTurn(testDb as never, 'agent', "What's the most you'd be comfortable losing?", 'questions');
    OnboardingService.addTurn(testDb as never, 'user', 'Very conservative — maybe 5%', 'questions');

    const contradictionText = 'You said very conservative earlier, but wanting 100% gains implies high risk. Want to revise either one?';
    const useModelFn = mock(async () => `CONTRADICTION: ${contradictionText}`);
    const runtime = { useModel: useModelFn } as never;
    const callback = mock(async (_payload: CallbackPayload) => undefined);
    const message = { content: { text: 'But I also want 100% gains every month' } } as Memory;

    await SocraticOnboardingAction.handler!(runtime, message, undefined, undefined, callback);

    // useModel called exactly once (contradiction check only — no follow-up question)
    expect(useModelFn).toHaveBeenCalledTimes(1);

    const callTexts = callback.mock.calls.map(c => (c[0] as CallbackPayload).text);
    expect(callTexts.some(text => text.includes(contradictionText))).toBe(true);
  });

  it('handler — resumes after contradiction without skipping the next required question', async () => {
    state.onboardingState = 'socratic_in_progress';
    const { SocraticOnboardingAction } = await import('./socratic-onboarding.js');
    const { OnboardingService } = await import('../services/onboarding-service.js');

    OnboardingService.addTurn(testDb as never, 'agent', 'Question 1', 'questions');
    OnboardingService.addTurn(testDb as never, 'user', 'Answer 1', 'questions');
    OnboardingService.addTurn(testDb as never, 'agent', 'Question 2', 'questions');
    OnboardingService.addTurn(testDb as never, 'user', 'Original contradictory answer', 'questions');
    OnboardingService.addTurn(testDb as never, 'agent', 'Please resolve the contradiction', 'contradiction');

    const useModelFn = mock(async (_modelType, options: { prompt: string }) => {
      if (options.prompt.includes('Does the most recent user answer contradict')) {
        return 'OK';
      }
      return 'Question 3';
    });
    const runtime = { useModel: useModelFn } as never;
    const callback = mock(async (_payload: CallbackPayload) => undefined);
    const message = { content: { text: 'Revised answer 2' } } as Memory;

    await SocraticOnboardingAction.handler!(runtime, message, undefined, undefined, callback);

    const questionPrompt = useModelFn.mock.calls[1]?.[1] as { prompt: string };
    expect(questionPrompt.prompt).toContain('This is question 3 of 6');

    const history = OnboardingService.getHistory(testDb as never);
    const questionTurns = history.filter(t => t.role === 'agent' && t.phase === 'questions');
    expect(questionTurns.map(t => t.content)).toEqual(['Question 1', 'Question 2', 'Question 3']);
  });

  it('handler — uses the revised answer as canonical history after contradiction resolution', async () => {
    state.onboardingState = 'socratic_in_progress';
    const { SocraticOnboardingAction } = await import('./socratic-onboarding.js');
    const { OnboardingService } = await import('../services/onboarding-service.js');

    OnboardingService.addTurn(testDb as never, 'agent', 'Question 1', 'questions');
    OnboardingService.addTurn(testDb as never, 'user', 'Answer 1', 'questions');
    OnboardingService.addTurn(testDb as never, 'agent', 'Question 2', 'questions');
    OnboardingService.addTurn(testDb as never, 'user', 'Original contradictory answer', 'questions');
    OnboardingService.addTurn(testDb as never, 'agent', 'Please resolve the contradiction', 'contradiction');

    const useModelFn = mock(async (_modelType, options: { prompt: string }) => {
      if (options.prompt.includes('Does the most recent user answer contradict')) {
        return 'OK';
      }
      return 'Question 3';
    });
    const runtime = { useModel: useModelFn } as never;
    const callback = mock(async (_payload: CallbackPayload) => undefined);
    const message = { content: { text: 'Revised answer 2' } } as Memory;

    await SocraticOnboardingAction.handler!(runtime, message, undefined, undefined, callback);

    const contradictionPrompt = useModelFn.mock.calls[0]?.[1] as { prompt: string };
    expect(contradictionPrompt.prompt).toContain('A2: Revised answer 2');
    expect(contradictionPrompt.prompt).not.toContain('A2: Original contradictory answer');
    expect(contradictionPrompt.prompt).not.toContain('Please resolve the contradiction');
  });

  it('handler — sets beliefs_confirmed after user approves summary', async () => {
    state.onboardingState = 'socratic_in_progress';
    const { SocraticOnboardingAction } = await import('./socratic-onboarding.js');
    const { OnboardingService } = await import('../services/onboarding-service.js');

    // Seed 6 Q&A pairs (all questions answered)
    for (let i = 1; i <= 6; i++) {
      OnboardingService.addTurn(testDb as never, 'agent', `Question ${i}`, 'questions');
      OnboardingService.addTurn(testDb as never, 'user', `Answer ${i}`, 'questions');
    }
    // Seed the belief summary (last agent turn is summary phase)
    const summaryText = "Based on our conversation, here are the financial beliefs you've expressed: ...";
    OnboardingService.addTurn(testDb as never, 'agent', summaryText, 'summary');

    const useModelFn = mock(async () => 'APPROVED');
    const runtime = { useModel: useModelFn } as never;
    const callback = mock(async () => undefined);
    const message = { content: { text: 'Yes, that looks right' } } as Memory;

    await SocraticOnboardingAction.handler!(runtime, message, undefined, undefined, callback);

    expect(setStateCalls).toContainEqual({ onboardingState: 'beliefs_confirmed' });
  });
});
