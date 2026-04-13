import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { IAgentRuntime } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';
import { generateStorytellerChapter } from './generate-storyteller-chapter.js';
import * as migrations from '../db/migrations.js';

function makeState(overrides: Partial<ReturnType<typeof AgentStateService.getState>>) {
  return {
    mode: 'paper' as const,
    trustLadder: 'advisor' as const,
    crisisStatus: 'active' as const,
    constitutionVersion: 0,
    accuracyScore: 75.0,
    suggestionsSampled: 4,
    onboardingState: 'complete' as const,
    updatedAt: new Date().toISOString(),
    telegramChatId: 'chat-123',
    promotionPending: false,
    ...overrides,
  };
}

function makeMockRuntime(useModelResult?: string | Error): IAgentRuntime & { _sentMessages: Array<{ text: string }> } {
  const sentMessages: Array<{ text: string }> = [];
  const telegramClient = {
    type: 'telegram',
    bot: {
      telegram: {
        sendMessage: mock(async (_chatId: string, text: string) => {
          sentMessages.push({ text });
        }),
      },
    },
  };
  const rt = {
    clients: [telegramClient],
    useModel: mock(async () => {
      if (useModelResult instanceof Error) throw useModelResult;
      return useModelResult ?? '📖 Chapter 1: The First Week\n\nIn the beginning, the treasury held its positions steadfast.\n\nConstitutional compliance this week: 100%.';
    }),
    _sentMessages: sentMessages,
  } as unknown as IAgentRuntime & { _sentMessages: Array<{ text: string }> };
  return rt;
}

function makeDb(
  memos: Array<{ action_type: string; memo_text: string }> = [],
  grades: Array<{ user_grade: number }> = [],
  crisisEpisodes: Array<{ violation_summary: string; status: string }> = [],
  maxChapterNum: number | null = null,
) {
  const insertRun = mock((..._args: unknown[]) => {});
  return {
    insertRun,
    prepare: mock((sql: string) => ({
      all: mock(() => {
        if (sql.includes('on_chain_memos')) return memos;
        if (sql.includes('trust_ladder_log')) return grades;
        if (sql.includes('crisis_episodes')) return crisisEpisodes;
        return [];
      }),
      get: mock(() => {
        if (sql.includes('MAX(chapter_num)')) return { max_num: maxChapterNum };
        return undefined;
      }),
      run: sql.includes('INSERT INTO storyteller_chapters')
        ? insertRun
        : mock((..._args: unknown[]) => {}),
    })),
  };
}

describe('generateStorytellerChapter', () => {
  let getStateSpy: ReturnType<typeof spyOn>;
  let getDbSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    getDbSpy = spyOn(migrations, 'getDb').mockReturnValue(makeDb() as any);
  });

  afterEach(() => {
    getStateSpy?.mockRestore();
    getDbSpy.mockRestore();
  });

  it('exits silently when telegramChatId is falsy', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(
      makeState({ telegramChatId: undefined })
    );
    const rt = makeMockRuntime();
    await generateStorytellerChapter(rt);
    expect(rt._sentMessages).toHaveLength(0);
  });

  it('sends ⏳ Thinking... as first message before LLM call', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const rt = makeMockRuntime();
    await generateStorytellerChapter(rt);
    expect(rt._sentMessages.length).toBeGreaterThanOrEqual(1);
    expect(rt._sentMessages[0]!.text).toContain('⏳ Thinking...');
  });

  it('first message includes ✈️ PAPER TREASURY SIMULATION prefix', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({ mode: 'paper' }));
    const rt = makeMockRuntime();
    await generateStorytellerChapter(rt);
    expect(rt._sentMessages[0]!.text).toContain('✈️ PAPER TREASURY SIMULATION');
  });

  it('does not prepend the paper prefix in live mode', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({ mode: 'live' }));
    const rt = makeMockRuntime();
    await generateStorytellerChapter(rt);
    expect(rt._sentMessages[0]!.text).toBe('⏳ Thinking...');
    expect(rt._sentMessages[1]!.text).not.toContain('✈️ PAPER TREASURY SIMULATION');
  });

  it('chapter message starts with 📖 Chapter', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const rt = makeMockRuntime('📖 Chapter 1: The First Week\n\nNarrative body here.\n\nConstitutional compliance this week: 100%.');
    await generateStorytellerChapter(rt);
    expect(rt._sentMessages).toHaveLength(2);
    expect(rt._sentMessages[1]!.text).toContain('📖 Chapter');
  });

  it('falls back when the LLM chapter is missing the required compliance summary line', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const db = makeDb();
    getDbSpy.mockReturnValue(db as any);
    const rt = makeMockRuntime('📖 Chapter 1: The First Week\n\nNarrative body here without the final compliance line.');
    await generateStorytellerChapter(rt);
    expect(rt._sentMessages).toHaveLength(2);
    expect(rt._sentMessages[1]!.text).toContain('AI narrative unavailable');
    expect(db.insertRun).not.toHaveBeenCalled();
  });

  it('sends fallback chapter (no crash) when useModel throws', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const rt = makeMockRuntime(new Error('Qwen unavailable'));
    await expect(generateStorytellerChapter(rt)).resolves.toBeUndefined();
    expect(rt._sentMessages).toHaveLength(2);
    expect(rt._sentMessages[1]!.text).toContain('AI narrative unavailable');
  });

  it('does not call recordChapter when fallback is sent', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const db = makeDb();
    getDbSpy.mockReturnValue(db as any);
    const rt = makeMockRuntime(new Error('Qwen unavailable'));
    await generateStorytellerChapter(rt);
    expect(db.insertRun).not.toHaveBeenCalled();
  });

  it('chapter number increments correctly when previous chapters exist', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const db = makeDb([], [], [], 3);
    getDbSpy.mockReturnValue(db as any);
    const rt = makeMockRuntime('📖 Chapter 4: The Fourth Week\n\nNarrative body.\n\nConstitutional compliance this week: 100%.');
    await generateStorytellerChapter(rt);
    expect(rt._sentMessages[1]!.text).toContain('Chapter 4');
  });

  it('chapter number is 1 when no previous chapters exist', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const db = makeDb([], [], [], null);
    getDbSpy.mockReturnValue(db as any);
    const rt = makeMockRuntime('📖 Chapter 1: The Beginning\n\nNarrative body.\n\nConstitutional compliance this week: 100%.');
    await generateStorytellerChapter(rt);
    expect(rt._sentMessages[1]!.text).toContain('Chapter 1');
  });
});
