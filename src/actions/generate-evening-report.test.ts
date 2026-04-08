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

// Mock DB helpers
function makeDb(pendingCount = 0, memos: Array<{ action_type: string; memo_text: string }> = []) {
  return {
    prepare: mock((sql: string) => ({
      all: mock(() => {
        if (sql.includes('on_chain_memos')) return memos;
        return [];
      }),
      get: mock(() => {
        if (sql.includes('COUNT(*)')) return { count: pendingCount };
        return undefined;
      }),
      run: mock(() => {}),
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
