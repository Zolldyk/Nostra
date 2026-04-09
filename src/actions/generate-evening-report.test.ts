import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { IAgentRuntime } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';
import { generateEveningReport } from './generate-evening-report.js';
import * as migrations from '../db/migrations.js';

function makeState(overrides: Partial<ReturnType<typeof AgentStateService.getState>>) {
  return {
    mode: 'paper' as const,
    trustLadder: 'advisor' as const,
    crisisStatus: 'active' as const,
    constitutionVersion: 0,
    accuracyScore: 65.0,
    suggestionsSampled: 3,
    onboardingState: 'complete' as const,
    updatedAt: new Date().toISOString(),
    telegramChatId: 'chat-456',
    promotionPending: false,
    ...overrides,
  };
}

function makeMockRuntime(useModelResult?: string | Error): IAgentRuntime & { _sentMessages: Array<{ text: string; options?: Record<string, unknown> }> } {
  const sentMessages: Array<{ text: string; options?: Record<string, unknown> }> = [];
  const telegramClient = {
    type: 'telegram',
    bot: {
      telegram: {
        sendMessage: mock(async (_chatId: string, text: string, options?: Record<string, unknown>) => {
          sentMessages.push({ text, options });
        }),
      },
    },
  };
  const rt = {
    clients: [telegramClient],
    useModel: mock(async () => {
      if (useModelResult instanceof Error) throw useModelResult;
      return useModelResult ?? '🌙 Tuesday, April 8, 2026\n\nToday we held all positions as the constitution guided us. Rest well.';
    }),
    _sentMessages: sentMessages,
  } as unknown as IAgentRuntime & { _sentMessages: Array<{ text: string; options?: Record<string, unknown> }> };
  return rt;
}

interface TestDissentRow {
  id: number;
  dissent_number: number;
  reasoning: string;
  expected_outcome: string;
  rule_ref: string | null;
}

interface TestRejectedAmendmentRow {
  id: number;
  rule_id: number;
  old_description: string;
  new_description: string;
}

// Mock DB helpers
function makeDb(
  pendingCount = 0,
  memos: Array<{ action_type: string; memo_text: string }> = [],
  dissents: TestDissentRow[] = [],
  rejectedAmendments: TestRejectedAmendmentRow[] = [],
) {
  const markDissentsReadRun = mock(() => {});
  const markRejectedAmendmentsReadRun = mock(() => {});
  return {
    markDissentsReadRun,
    markRejectedAmendmentsReadRun,
    prepare: mock((sql: string) => ({
      all: mock(() => {
        if (sql.includes('on_chain_memos')) return memos;
        if (sql.includes('pending_dissents')) return dissents;
        if (sql.includes('rejected_amendments')) return rejectedAmendments;
        return [];
      }),
      get: mock(() => {
        if (sql.includes('COUNT(*)')) return { count: pendingCount };
        return undefined;
      }),
      run: sql.includes('UPDATE pending_dissents SET status = \'read\'')
        ? markDissentsReadRun
        : sql.includes('UPDATE rejected_amendments SET status = \'read\'')
          ? markRejectedAmendmentsReadRun
          : mock(() => {}),
    })),
  };
}

describe('generateEveningReport', () => {
  let getStateSpy: ReturnType<typeof spyOn>;
  let getDbSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    getDbSpy = spyOn(migrations, 'getDb').mockReturnValue(makeDb() as any);
  });

  afterEach(() => {
    getStateSpy?.mockRestore();
    getDbSpy.mockRestore();
  });

  it('exits silently when mode is not "paper"', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(
      makeState({ mode: 'live' as any })
    );
    const rt = makeMockRuntime();
    await generateEveningReport(rt);
    expect(rt._sentMessages).toHaveLength(0);
  });

  it('exits silently when telegramChatId is falsy', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(
      makeState({ telegramChatId: undefined })
    );
    const rt = makeMockRuntime();
    await generateEveningReport(rt);
    expect(rt._sentMessages).toHaveLength(0);
  });

  it('sends ⏳ Thinking... as first message before LLM call', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const rt = makeMockRuntime();
    await generateEveningReport(rt);
    expect(rt._sentMessages.length).toBeGreaterThanOrEqual(1);
    expect(rt._sentMessages[0]!.text).toContain('⏳ Thinking...');
  });

  it('first message includes ✈️ PAPER TREASURY SIMULATION prefix', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const rt = makeMockRuntime();
    await generateEveningReport(rt);
    expect(rt._sentMessages[0]!.text).toContain('✈️ PAPER TREASURY SIMULATION');
  });

  it('report message includes ✈️ PAPER TREASURY SIMULATION prefix', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const rt = makeMockRuntime();
    await generateEveningReport(rt);
    expect(rt._sentMessages).toHaveLength(2);
    expect(rt._sentMessages[1]!.text).toContain('✈️ PAPER TREASURY SIMULATION');
  });

  it('report message starts with 🌙', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const rt = makeMockRuntime('🌙 Tuesday night, all held.\n\nRest well.');
    await generateEveningReport(rt);
    const reportMsg = rt._sentMessages[1]!.text;
    expect(reportMsg).toContain('🌙 Bedtime Report —');
  });

  it('sends fallback report (no crash) when useModel throws', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const rt = makeMockRuntime(new Error('Qwen unavailable'));
    await expect(generateEveningReport(rt)).resolves.toBeUndefined();
    expect(rt._sentMessages).toHaveLength(2);
    expect(rt._sentMessages[1]!.text).toContain('AI report unavailable');
  });

  it('marks pending dissents as read only after they are injected into a successful report', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const db = makeDb(0, [], [
      {
        id: 7,
        dissent_number: 3,
        reasoning: 'We should have held the position.',
        expected_outcome: 'Override may reduce treasury efficiency.',
        rule_ref: 'Rule #4',
      },
    ]);
    getDbSpy.mockReturnValue(db as any);
    const rt = makeMockRuntime();

    await generateEveningReport(rt);

    expect(rt._sentMessages[1]!.text).toContain('📋 Filed Dissent #3');
    expect(db.markDissentsReadRun).toHaveBeenCalledWith(7);
  });

  it('does not mark pending dissents as read when the fallback report is sent', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const db = makeDb(0, [], [
      {
        id: 9,
        dissent_number: 4,
        reasoning: 'We should have waited for better routing.',
        expected_outcome: 'Override may increase slippage.',
        rule_ref: 'Rule #2',
      },
    ]);
    getDbSpy.mockReturnValue(db as any);
    const rt = makeMockRuntime(new Error('Qwen unavailable'));

    await generateEveningReport(rt);

    expect(rt._sentMessages[1]!.text).toContain('AI report unavailable');
    expect(rt._sentMessages[1]!.text).not.toContain('📋 Filed Dissent #4');
    expect(db.markDissentsReadRun).not.toHaveBeenCalled();
  });

  it('injects rejected amendments into the successful bedtime report and marks them read', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const db = makeDb(1, [], [], [
      {
        id: 12,
        rule_id: 2,
        old_description: 'Only rotate if yield delta exceeds 2%',
        new_description: 'Only rotate if yield delta exceeds 3%',
      },
    ]);
    getDbSpy.mockReturnValue(db as any);
    const rt = makeMockRuntime();

    await generateEveningReport(rt);

    expect(rt._sentMessages[1]!.text).toContain('📋 Rejected Amendment — Rule #2');
    expect(rt._sentMessages[1]!.text).toContain('You chose not to apply this amendment.');
    expect((rt._sentMessages[1]!.options as any)?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data).toBe('grade_good');
    expect(db.markRejectedAmendmentsReadRun).toHaveBeenCalledWith(12);
  });

  it('does not mark rejected amendments as read when the fallback report is sent', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const db = makeDb(0, [], [], [
      {
        id: 15,
        rule_id: 1,
        old_description: 'SOL concentration must not exceed 30%',
        new_description: 'SOL concentration must not exceed 40%',
      },
    ]);
    getDbSpy.mockReturnValue(db as any);
    const rt = makeMockRuntime(new Error('Qwen unavailable'));

    await generateEveningReport(rt);

    expect(rt._sentMessages[1]!.text).toContain('AI report unavailable');
    expect(rt._sentMessages[1]!.text).not.toContain('📋 Rejected Amendment');
    expect(db.markRejectedAmendmentsReadRun).not.toHaveBeenCalled();
  });

  it('includes ✅/❌ inline buttons when pending trust_ladder_log entry exists', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    getDbSpy.mockReturnValue(makeDb(1) as any);
    const rt = makeMockRuntime();
    await generateEveningReport(rt);
    const reportMsg = rt._sentMessages[1]!;
    expect(reportMsg.options).toBeDefined();
    const replyMarkup = (reportMsg.options as any)?.reply_markup;
    expect(replyMarkup).toBeDefined();
    expect(replyMarkup.inline_keyboard[0]).toHaveLength(2);
    expect(replyMarkup.inline_keyboard[0][0].callback_data).toBe('grade_good');
    expect(replyMarkup.inline_keyboard[0][1].callback_data).toBe('grade_bad');
  });

  it('does NOT include inline buttons when no pending entry', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    getDbSpy.mockReturnValue(makeDb(0) as any);
    const rt = makeMockRuntime();
    await generateEveningReport(rt);
    const reportMsg = rt._sentMessages[1]!;
    expect(reportMsg.options).toBeUndefined();
  });
});
