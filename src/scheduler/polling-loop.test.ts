import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { IAgentRuntime } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';
import { CrisisTriggerEvaluator } from '../evaluators/crisis-trigger-evaluator.js';
import { YieldRatesProvider } from '../providers/yield-rates-provider.js';
import * as portfolioProvider from '../providers/portfolio-provider.js';
import * as migrations from '../db/migrations.js';
import { WalletService } from '../services/wallet-service.js';
import * as withRetryModule from '../utils/with-retry.js';
import type { AgentState, PendingProposal } from '../types/agent-state.js';
import * as crisisProtocol from '../actions/trigger-crisis-protocol.js';

const MOCK_PAPER_STATE: AgentState = {
  mode: 'paper',
  trustLadder: 'advisor',
  crisisStatus: 'active',
  constitutionVersion: 0,
  accuracyScore: 0,
  suggestionsSampled: 0,
  onboardingState: 'complete',
  telegramChatId: 'chat-123',
  updatedAt: new Date().toISOString(),
};

const MOCK_LIVE_STATE: AgentState = {
  ...MOCK_PAPER_STATE,
  mode: 'live',
};

const NO_YIELD_RESULT = {
  text: 'Yield: Kamino 1.00% | Marginfi 1.50% | Drift 0.80%',
  values: { kamino_apy: 1.0, marginfi_apy: 1.5, drift_apy: 0.8, failed_protocols: [] },
};

const HIGH_YIELD_RESULT = {
  text: 'Yield: Kamino 8.00% | Marginfi 3.50% | Drift 4.20%',
  values: { kamino_apy: 8.0, marginfi_apy: 3.5, drift_apy: 4.2, failed_protocols: [] },
};

const PARTIAL_FAILURE_RESULT = {
  text: 'Yield: Kamino N/A | Marginfi 3.50% | Drift 4.20%',
  values: {
    kamino_apy: 0,
    marginfi_apy: 3.5,
    drift_apy: 4.2,
    failed_protocols: ['kamino'],
    errorMessage: 'Yield API unavailable: kamino',
  },
};

describe('polling-loop', () => {
  let getStateSpy: ReturnType<typeof spyOn>;
  let crisisHandlerSpy: ReturnType<typeof spyOn>;
  let yieldGetSpy: ReturnType<typeof spyOn>;
  let portfolioSnapshotSpy: ReturnType<typeof spyOn>;
  let setPendingProposalSpy: ReturnType<typeof spyOn>;
  let executeCrisisFreezeSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    crisisHandlerSpy = spyOn(CrisisTriggerEvaluator, 'handler').mockResolvedValue(undefined as never);
    yieldGetSpy = spyOn(YieldRatesProvider, 'get').mockResolvedValue(NO_YIELD_RESULT as never);
    portfolioSnapshotSpy = spyOn(portfolioProvider, 'getPaperPortfolioSnapshot').mockReturnValue([]);
    setPendingProposalSpy = spyOn(AgentStateService, 'setPendingProposal').mockImplementation((_proposal: PendingProposal | undefined) => undefined);
    executeCrisisFreezeSpy = spyOn(crisisProtocol, 'executeCrisisFreeze').mockResolvedValue(undefined);
  });

  afterEach(() => {
    getStateSpy?.mockRestore();
    crisisHandlerSpy.mockRestore();
    yieldGetSpy.mockRestore();
    portfolioSnapshotSpy.mockRestore();
    setPendingProposalSpy.mockRestore();
    executeCrisisFreezeSpy.mockRestore();
  });

  it('startPollingLoop returns an interval handle', async () => {
    const { startPollingLoop } = await import('./polling-loop.js');
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue({ ...MOCK_PAPER_STATE });
    const handle = startPollingLoop({} as IAgentRuntime);
    expect(handle).toBeDefined();
    clearInterval(handle);
  });

  it('polling tick still runs CrisisTriggerEvaluator in live mode', async () => {
    const { runPollingTick } = await import('./polling-loop.js');
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue({ ...MOCK_LIVE_STATE });
    await runPollingTick({} as IAgentRuntime);
    expect(crisisHandlerSpy).toHaveBeenCalledTimes(1);
    expect(yieldGetSpy).not.toHaveBeenCalled();
  });

  it('polling tick calls CrisisTriggerEvaluator.handler in paper mode', async () => {
    const { runPollingTick } = await import('./polling-loop.js');
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue({ ...MOCK_PAPER_STATE });
    await runPollingTick({} as IAgentRuntime);
    expect(crisisHandlerSpy).toHaveBeenCalledTimes(1);
  });

  it('polling tick does not throw when providers fail', async () => {
    const { runPollingTick } = await import('./polling-loop.js');
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue({ ...MOCK_PAPER_STATE });
    yieldGetSpy.mockRejectedValue(new Error('Provider network failure'));
    // Mock withRetry to avoid real delays and mock crisis freeze deps
    const withRetrySpy = spyOn(withRetryModule, 'withRetry').mockImplementation(async (fn: () => Promise<unknown>) => fn());
    const setStateSpy = spyOn(AgentStateService, 'setState').mockResolvedValue(undefined);
    const getDbSpy = spyOn(migrations, 'getDb').mockReturnValue({ prepare: () => ({ run: () => {} }) } as any);
    const writeMemoSpy = spyOn(WalletService, 'writeMemo').mockResolvedValue({ txHash: 'tx1', explorerUrl: 'url1' } as any);

    await expect(runPollingTick({} as IAgentRuntime)).resolves.toBeUndefined();

    withRetrySpy.mockRestore();
    setStateSpy.mockRestore();
    getDbSpy.mockRestore();
    writeMemoSpy.mockRestore();
  });

  it('polling tick does not send duplicate proposals for same opportunity', async () => {
    const { runPollingTick, clearPendingProposal } = await import('./polling-loop.js');

    // Build a mock runtime with a Telegram client spy
    const sendMessageMock = spyOn({ sendMessage: async () => {} }, 'sendMessage').mockResolvedValue(undefined as never);
    const mockRuntime = {
      clients: [
        {
          type: 'telegram',
          bot: { telegram: { sendMessage: sendMessageMock } },
        },
      ],
    } as unknown as IAgentRuntime;

    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue({ ...MOCK_PAPER_STATE });
    yieldGetSpy.mockResolvedValue(HIGH_YIELD_RESULT as never);
    let currentPendingProposal: PendingProposal | undefined;
    setPendingProposalSpy.mockImplementation((proposal: PendingProposal | undefined) => {
      currentPendingProposal = proposal;
    });
    getStateSpy.mockImplementation(() => ({ ...MOCK_PAPER_STATE, pendingProposal: currentPendingProposal }));

    // Clear any leftover pending proposal from prior tests
    clearPendingProposal();

    // First tick — should detect opportunity and send proposal
    await runPollingTick(mockRuntime);
    // Second tick — opportunity still above threshold but pendingProposal already set → no duplicate
    await runPollingTick(mockRuntime);

    // First tick sends 2 messages: "⏳ Thinking..." + the full proposal
    // Second tick sends 0 (pendingProposal already set — no duplicate)
    expect(sendMessageMock).toHaveBeenCalledTimes(2);

    // Cleanup
    clearPendingProposal();
  });

  it('runPollingTick — clears expired proposal and writes timeout memo', async () => {
    const { runPollingTick } = await import('./polling-loop.js');

    const expiredTimestamp = new Date(Date.now() - 90_000_000).toISOString(); // 25h ago
    const expiredProposal: PendingProposal = {
      protocol: 'Kamino',
      proposedApy: 6.0,
      timestamp: expiredTimestamp,
      ruleRef: 'Rule #1',
      ruleIndex: 1,
      actionDescription: 'Yield rotation: Move allocation to Kamino at 6.00% APY',
    };

    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue({
      ...MOCK_PAPER_STATE,
      pendingProposal: expiredProposal,
    });

    const writeMemoSpy = spyOn(WalletService, 'writeMemo').mockResolvedValue({
      txHash: 'timeout-tx',
      explorerUrl: 'https://explorer.solana.com/tx/timeout-tx?cluster=devnet',
    });
    const prepareMock = spyOn(migrations, 'getDb').mockReturnValue({
      prepare: () => ({ run: () => undefined }),
    } as unknown as ReturnType<typeof migrations.getDb>);

    await runPollingTick({} as IAgentRuntime);

    expect(writeMemoSpy).toHaveBeenCalledTimes(1);
    const memoArg = writeMemoSpy.mock.calls[0]?.[0] as string;
    expect(memoArg).toContain('did not respond within 24 hours');
    expect(setPendingProposalSpy).toHaveBeenCalledWith(undefined);

    writeMemoSpy.mockRestore();
    prepareMock.mockRestore();
  });

  it('runPollingTick — does NOT expire active proposal under 24h', async () => {
    const { runPollingTick } = await import('./polling-loop.js');

    const activeTimestamp = new Date().toISOString(); // just now
    const activeProposal: PendingProposal = {
      protocol: 'Kamino',
      proposedApy: 6.0,
      timestamp: activeTimestamp,
      ruleRef: 'Rule #1',
      ruleIndex: 1,
      actionDescription: 'Yield rotation: Move allocation to Kamino at 6.00% APY',
    };

    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue({
      ...MOCK_PAPER_STATE,
      pendingProposal: activeProposal,
    });

    const writeMemoSpy = spyOn(WalletService, 'writeMemo').mockResolvedValue({
      txHash: 'should-not-be-called',
      explorerUrl: 'https://explorer.solana.com/tx/should-not-be-called',
    });

    await runPollingTick({} as IAgentRuntime);

    expect(writeMemoSpy).not.toHaveBeenCalled();

    writeMemoSpy.mockRestore();
  });

  it('polling tick sends provider failure notifications in paper mode', async () => {
    const { runPollingTick } = await import('./polling-loop.js');
    const sendMessageMock = spyOn({ sendMessage: async () => {} }, 'sendMessage').mockResolvedValue(undefined as never);
    const mockRuntime = {
      clients: [
        {
          type: 'telegram',
          bot: { telegram: { sendMessage: sendMessageMock } },
        },
      ],
    } as unknown as IAgentRuntime;

    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue({ ...MOCK_PAPER_STATE });
    yieldGetSpy.mockResolvedValue(PARTIAL_FAILURE_RESULT as never);

    await runPollingTick(mockRuntime);

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0]?.[1]).toContain('✈️ PAPER TREASURY SIMULATION');
    expect(sendMessageMock.mock.calls[0]?.[1]).toContain('Yield API unavailable: kamino');
  });

  it('polling tick triggers rpc_failure freeze even when telegramChatId is missing', async () => {
    const { runPollingTick } = await import('./polling-loop.js');
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue({
      ...MOCK_PAPER_STATE,
      telegramChatId: undefined,
    });
    const withRetrySpy = spyOn(withRetryModule, 'withRetry').mockRejectedValue(new Error('RPC exhausted'));

    await runPollingTick({} as IAgentRuntime);

    expect(executeCrisisFreezeSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ crisisType: 'rpc_failure' }),
    );

    withRetrySpy.mockRestore();
  });
});
