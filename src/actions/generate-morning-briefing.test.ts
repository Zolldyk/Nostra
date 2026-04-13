import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { IAgentRuntime } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';
import { ConstitutionService } from '../services/constitution-service.js';
import * as nosanaComputeService from '../services/nosana-compute-service.js';
import * as portfolioProvider from '../providers/portfolio-provider.js';
import * as yieldRatesProvider from '../providers/yield-rates-provider.js';
import * as migrations from '../db/migrations.js';
import { generateMorningBriefing } from './generate-morning-briefing.js';

function makeState(overrides: Partial<ReturnType<typeof AgentStateService.getState>>) {
  return {
    mode: 'paper' as const,
    trustLadder: 'advisor' as const,
    crisisStatus: 'active' as const,
    constitutionVersion: 0,
    accuracyScore: 0,
    suggestionsSampled: 0,
    onboardingState: 'complete' as const,
    updatedAt: new Date().toISOString(),
    telegramChatId: 'chat-123',
    ...overrides,
  };
}

function makeMockRuntime(useModelResult?: string | Error): IAgentRuntime & { _sentMessages: string[] } {
  const sentMessages: string[] = [];
  const telegramClient = {
    type: 'telegram',
    bot: {
      telegram: {
        sendMessage: mock(async (_chatId: string, text: string) => {
          sentMessages.push(text);
        }),
      },
    },
  };
  const rt = {
    clients: [telegramClient],
    useModel: mock(async () => {
      if (useModelResult instanceof Error) throw useModelResult;
      return useModelResult ?? 'LLM briefing body.\n\n🫡 Nostra';
    }),
    _sentMessages: sentMessages,
  } as unknown as IAgentRuntime & { _sentMessages: string[] };
  return rt;
}

function makeWordyBriefing(wordCount: number): string {
  return `${Array.from({ length: wordCount }, (_, index) => `word${index + 1}`).join(' ')}\n\n🫡 Nostra`;
}

describe('generateMorningBriefing', () => {
  let getStateSpy: ReturnType<typeof spyOn>;
  let getSnapshotSpy: ReturnType<typeof spyOn>;
  let yieldGetSpy: ReturnType<typeof spyOn>;
  let getActiveSpy: ReturnType<typeof spyOn>;
  let getDbSpy: ReturnType<typeof spyOn>;
  let fetchMonthlyComputeCostSpy: ReturnType<typeof spyOn>;

  const MOCK_YIELD_RESULT = {
    values: { kamino_apy: 6.5, marginfi_apy: 7.25, drift_apy: 5.0 },
  };

  beforeEach(() => {
    getSnapshotSpy = spyOn(portfolioProvider, 'getPaperPortfolioSnapshot').mockReturnValue([]);
    yieldGetSpy = spyOn(yieldRatesProvider.YieldRatesProvider, 'get').mockResolvedValue(MOCK_YIELD_RESULT as any);
    getDbSpy = spyOn(migrations, 'getDb').mockReturnValue({} as any);
    getActiveSpy = spyOn(ConstitutionService, 'getActive').mockReturnValue(null);
    fetchMonthlyComputeCostSpy = spyOn(nosanaComputeService, 'fetchMonthlyComputeCost').mockResolvedValue({
      spentNos: 12.5,
      monthLabel: 'April 2026',
    });
  });

  afterEach(() => {
    getStateSpy?.mockRestore();
    getSnapshotSpy.mockRestore();
    yieldGetSpy.mockRestore();
    getActiveSpy.mockRestore();
    getDbSpy.mockRestore();
    fetchMonthlyComputeCostSpy.mockRestore();
  });

  it('exits silently when mode is not "paper"', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(
      makeState({ mode: 'live' as any, telegramChatId: 'chat-123' })
    );
    const rt = makeMockRuntime();
    await generateMorningBriefing(rt);
    expect(rt._sentMessages).toHaveLength(0);
  });

  it('exits silently when telegramChatId is falsy', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(
      makeState({ telegramChatId: undefined })
    );
    const rt = makeMockRuntime();
    await generateMorningBriefing(rt);
    expect(rt._sentMessages).toHaveLength(0);
  });

  it('sends ⏳ Thinking... as the first message before LLM call', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const rt = makeMockRuntime();
    await generateMorningBriefing(rt);
    expect(rt._sentMessages.length).toBeGreaterThanOrEqual(1);
    expect(rt._sentMessages[0]).toContain('⏳ Thinking...');
  });

  it('first message includes ✈️ PAPER TREASURY SIMULATION prefix', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const rt = makeMockRuntime();
    await generateMorningBriefing(rt);
    expect(rt._sentMessages[0]).toContain('✈️ PAPER TREASURY SIMULATION');
  });

  it('briefing message includes ✈️ PAPER TREASURY SIMULATION prefix', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const rt = makeMockRuntime();
    await generateMorningBriefing(rt);
    // The second message is the full briefing
    expect(rt._sentMessages).toHaveLength(2);
    expect(rt._sentMessages[1]).toContain('✈️ PAPER TREASURY SIMULATION');
  });

  it('briefing message starts with ☀️ State of the Treasury', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const rt = makeMockRuntime();
    await generateMorningBriefing(rt);
    // Strip prefix (first two lines + blank) and check briefing body starts with ☀️
    const briefingMsg = rt._sentMessages[1]!;
    expect(briefingMsg).toContain('☀️ State of the Treasury');
  });

  it('sends fallback briefing (no crash) when useModel throws', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const rt = makeMockRuntime(new Error('Qwen unavailable'));
    await expect(generateMorningBriefing(rt)).resolves.toBeUndefined();
    expect(rt._sentMessages).toHaveLength(2);
  });

  it('fallback briefing includes portfolio positions and yield rates', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    getSnapshotSpy.mockReturnValue([
      { id: 1, protocol: 'Kamino', symbol: 'USDC', amount_usd: 5000, percentage: 50, last_updated: '' },
    ]);
    const rt = makeMockRuntime(new Error('Qwen unavailable'));
    await generateMorningBriefing(rt);
    const fallbackMsg = rt._sentMessages[1]!;
    // Should contain portfolio info
    expect(fallbackMsg).toContain('Kamino');
    // Should contain yield rates
    expect(fallbackMsg).toContain('7.25');
    // Should contain Nostra sign-off
    expect(fallbackMsg).toContain('🫡 Nostra');
  });

  it('sends fallback briefing when yield provider throws before LLM generation', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    yieldGetSpy.mockRejectedValue(new Error('Yield provider unavailable'));
    const rt = makeMockRuntime();

    await expect(generateMorningBriefing(rt)).resolves.toBeUndefined();

    expect(rt._sentMessages).toHaveLength(2);
    expect(rt._sentMessages[1]).toContain('AI briefing unavailable');
    expect(rt._sentMessages[1]).toContain('yield data temporarily unavailable');
  });

  it('falls back when LLM briefing body is outside the 100-200 word range', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    const rt = makeMockRuntime(makeWordyBriefing(40));

    await expect(generateMorningBriefing(rt)).resolves.toBeUndefined();

    expect(rt._sentMessages).toHaveLength(2);
    expect(rt._sentMessages[1]).toContain('AI briefing unavailable');
    expect(rt._sentMessages[1]).toContain('Yield Landscape');
  });

  it('includes compute cost line in briefing prompt when compute_budget rule is active and API succeeds', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    getActiveSpy.mockReturnValue({
      id: 1,
      version: 1,
      rules: [
        {
          id: 4,
          type: 'compute_budget',
          description: 'Monthly Nosana compute spend must not exceed 50 NOS',
          condition: { metric: 'compute_cost_nos', operator: '<', value: 50, unit: 'nos_tokens' },
          action: 'alert',
        },
      ],
    } as any);
    const rt = makeMockRuntime(makeWordyBriefing(120));

    await generateMorningBriefing(rt);

    const resolvedPrompt = (rt.useModel as any).mock.calls[0][1].prompt as string;
    expect(resolvedPrompt).toContain('NOS compute (April 2026): 12.5 / 50 NOS (25%)');
  });

  it('includes ⚠️ warning when NOS usage exceeds 80% of budget ceiling', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    getActiveSpy.mockReturnValue({
      id: 1,
      version: 1,
      rules: [
        {
          id: 4,
          type: 'compute_budget',
          description: 'Monthly Nosana compute spend must not exceed 50 NOS',
          condition: { metric: 'compute_cost_nos', operator: '<', value: 50, unit: 'nos_tokens' },
          action: 'alert',
        },
      ],
    } as any);
    fetchMonthlyComputeCostSpy.mockResolvedValue({ spentNos: 45, monthLabel: 'April 2026' });
    const rt = makeMockRuntime(makeWordyBriefing(120));

    await generateMorningBriefing(rt);

    expect(rt._sentMessages[1]).toContain('NOS compute (April 2026): 45.0 / 50 NOS (90%)');
    expect(rt._sentMessages[1]).toContain('⚠️ NOS compute approaching ceiling: 90% used');
  });

  it('injects the compute cost line into the delivered briefing body when API succeeds', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    getActiveSpy.mockReturnValue({
      id: 1,
      version: 1,
      rules: [
        {
          id: 4,
          type: 'compute_budget',
          description: 'Monthly Nosana compute spend must not exceed 50 NOS',
          condition: { metric: 'compute_cost_nos', operator: '<', value: 50, unit: 'nos_tokens' },
          action: 'alert',
        },
      ],
    } as any);
    const rt = makeMockRuntime(makeWordyBriefing(120));

    await generateMorningBriefing(rt);

    expect(rt._sentMessages[1]).toContain('NOS compute (April 2026): 12.5 / 50 NOS (25%)');
  });

  it('sends cost-unavailable notification and delivers briefing without cost line when API throws (AC2)', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    getActiveSpy.mockReturnValue({
      id: 1,
      version: 1,
      rules: [
        {
          id: 4,
          type: 'compute_budget',
          description: 'Monthly Nosana compute spend must not exceed 50 NOS',
          condition: { metric: 'compute_cost_nos', operator: '<', value: 50, unit: 'nos_tokens' },
          action: 'alert',
        },
      ],
    } as any);
    fetchMonthlyComputeCostSpy.mockRejectedValue(new Error('Nosana unavailable'));
    const rt = makeMockRuntime(makeWordyBriefing(120));

    await generateMorningBriefing(rt);

    expect(rt._sentMessages).toHaveLength(3);
    expect(rt._sentMessages[1]).toContain('⚠️ NOS compute cost unavailable');
    expect(rt._sentMessages[2]).not.toContain('NOS compute (');
  });

  it('skips compute cost entirely when no compute_budget rule exists in active constitution', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(makeState({}));
    getActiveSpy.mockReturnValue({
      id: 1,
      version: 1,
      rules: [
        {
          id: 1,
          type: 'yield_threshold',
          description: 'Require a 3% APY delta',
          condition: { metric: 'yield_delta', operator: '>=', value: 3, unit: 'apy_points' },
          action: 'alert',
        },
      ],
    } as any);
    const rt = makeMockRuntime(makeWordyBriefing(120));

    await generateMorningBriefing(rt);

    expect(fetchMonthlyComputeCostSpy).not.toHaveBeenCalled();
  });
});
