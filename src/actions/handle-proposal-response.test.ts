import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { IAgentRuntime, Memory } from '@elizaos/core';
import * as migrations from '../db/migrations.js';
import { WalletService } from '../services/wallet-service.js';
import { AgentStateService } from '../services/agent-state-service.js';
import * as portfolioProvider from '../providers/portfolio-provider.js';
import type { PendingProposal } from '../types/agent-state.js';
import { HandleProposalResponse } from './handle-proposal-response.js';

const MOCK_PROPOSAL: PendingProposal = {
  protocol: 'Marginfi',
  proposedApy: 7.5,
  timestamp: '2026-04-07T10:00:00.000Z',
  ruleRef: 'Rule #1',
  ruleIndex: 1,
  actionDescription: 'Yield rotation: Move allocation to Marginfi at 7.50% APY',
};

function mockMsg(text: string): Memory {
  return { content: { text, source: 'telegram' }, roomId: 'room-1' } as unknown as Memory;
}

const mockRuntime = {
  sendMessageToTarget: mock(async () => undefined),
} as unknown as IAgentRuntime;

describe('HandleProposalResponse.validate()', () => {
  it('returns true for "approve_proposal"', async () => {
    const result = await HandleProposalResponse.validate!(mockRuntime, mockMsg('approve_proposal'), undefined as never);
    expect(result).toBe(true);
  });

  it('returns true for "reject_proposal"', async () => {
    const result = await HandleProposalResponse.validate!(mockRuntime, mockMsg('reject_proposal'), undefined as never);
    expect(result).toBe(true);
  });

  it('returns false for unrelated text', async () => {
    for (const text of ['/status', 'approve', 'reject', '', 'approve_proposal_extra']) {
      const result = await HandleProposalResponse.validate!(mockRuntime, mockMsg(text), undefined as never);
      expect(result).toBe(false);
    }
  });
});

describe('HandleProposalResponse.handler()', () => {
  const prepareMock = mock(() => ({ run: runMock }));
  const runMock = mock(() => undefined);
  let getDbSpy: ReturnType<typeof spyOn>;
  let writeMemoSpy: ReturnType<typeof spyOn>;
  let getStateSpy: ReturnType<typeof spyOn>;
  let setPendingProposalSpy: ReturnType<typeof spyOn>;
  let reloadCacheSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    runMock.mockClear();
    prepareMock.mockClear();
    getDbSpy = spyOn(migrations, 'getDb').mockReturnValue({
      prepare: prepareMock,
    } as unknown as ReturnType<typeof migrations.getDb>);
    setPendingProposalSpy = spyOn(AgentStateService, 'setPendingProposal').mockImplementation(() => undefined);
    reloadCacheSpy = spyOn(portfolioProvider, 'reloadPortfolioCacheFromDb').mockReturnValue([]);
  });

  afterEach(() => {
    getDbSpy.mockRestore();
    writeMemoSpy?.mockRestore();
    getStateSpy?.mockRestore();
    setPendingProposalSpy.mockRestore();
    reloadCacheSpy.mockRestore();
  });

  it('no pending proposal sends graceful fallback', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue({
      mode: 'paper', trustLadder: 'advisor', crisisStatus: 'active',
      constitutionVersion: 0, accuracyScore: 0, suggestionsSampled: 0,
      onboardingState: 'complete', updatedAt: new Date().toISOString(),
      pendingProposal: undefined,
    });

    const callback = mock(async () => undefined);
    await HandleProposalResponse.handler!(mockRuntime, mockMsg('approve_proposal'), undefined as never, undefined, callback);

    expect(callback).toHaveBeenCalledTimes(1);
    const callbackArg = callback.mock.calls[0]?.[0] as { text: string };
    expect(callbackArg.text).toContain('No pending proposal found');
    expect(writeMemoSpy).toBeUndefined();
    expect(runMock).not.toHaveBeenCalled();
  });

  it('approve path calls WalletService.writeMemo with ACTION memo containing ruleRef', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue({
      mode: 'paper', trustLadder: 'advisor', crisisStatus: 'active',
      constitutionVersion: 0, accuracyScore: 0, suggestionsSampled: 0,
      onboardingState: 'complete', updatedAt: new Date().toISOString(),
      pendingProposal: { ...MOCK_PROPOSAL },
    });
    writeMemoSpy = spyOn(WalletService, 'writeMemo').mockResolvedValue({
      txHash: 'tx-approve-1',
      explorerUrl: 'https://explorer.solana.com/tx/tx-approve-1?cluster=devnet',
    });

    // Mock paper_positions read in applyPaperRotation — returns empty so seed path runs
    prepareMock.mockImplementation((sql: string) => {
      if (sql.includes('SELECT * FROM paper_positions')) {
        return { run: runMock, all: mock(() => []) } as never;
      }
      return { run: runMock, all: mock(() => []) } as never;
    });

    const callback = mock(async () => undefined);
    await HandleProposalResponse.handler!(mockRuntime, mockMsg('approve_proposal'), undefined as never, undefined, callback);

    expect(writeMemoSpy).toHaveBeenCalledTimes(1);
    const memoArg = writeMemoSpy.mock.calls[0]?.[0] as string;
    expect(memoArg).toContain('Rule #1');
  });

  it('approve path inserts into on_chain_memos with action_type=ACTION', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue({
      mode: 'paper', trustLadder: 'advisor', crisisStatus: 'active',
      constitutionVersion: 0, accuracyScore: 0, suggestionsSampled: 0,
      onboardingState: 'complete', updatedAt: new Date().toISOString(),
      pendingProposal: { ...MOCK_PROPOSAL },
    });
    writeMemoSpy = spyOn(WalletService, 'writeMemo').mockResolvedValue({
      txHash: 'tx-approve-2',
      explorerUrl: 'https://explorer.solana.com/tx/tx-approve-2?cluster=devnet',
    });

    const actionTypeArgs: string[] = [];
    prepareMock.mockImplementation((sql: string) => {
      const r = {
        run: (...args: unknown[]) => {
          if (sql.includes('on_chain_memos')) actionTypeArgs.push(args[1] as string);
          return undefined;
        },
        all: mock(() => []),
      };
      return r as never;
    });

    await HandleProposalResponse.handler!(mockRuntime, mockMsg('approve_proposal'), undefined as never, undefined, mock(async () => undefined));

    expect(actionTypeArgs).toContain('ACTION');
  });

  it('approve path inserts into trust_ladder_log with status=pending and user_grade=0', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue({
      mode: 'paper', trustLadder: 'advisor', crisisStatus: 'active',
      constitutionVersion: 0, accuracyScore: 0, suggestionsSampled: 0,
      onboardingState: 'complete', updatedAt: new Date().toISOString(),
      pendingProposal: { ...MOCK_PROPOSAL },
    });
    writeMemoSpy = spyOn(WalletService, 'writeMemo').mockResolvedValue({
      txHash: 'tx-approve-3',
      explorerUrl: 'https://explorer.solana.com/tx/tx-approve-3?cluster=devnet',
    });

    const trustLadderCalls: { sql: string; args: unknown[] }[] = [];
    prepareMock.mockImplementation((sql: string) => {
      const r = {
        run: (...args: unknown[]) => {
          if (sql.includes('trust_ladder_log')) trustLadderCalls.push({ sql, args });
          return undefined;
        },
        all: mock(() => []),
      };
      return r as never;
    });

    await HandleProposalResponse.handler!(mockRuntime, mockMsg('approve_proposal'), undefined as never, undefined, mock(async () => undefined));

    expect(trustLadderCalls.length).toBeGreaterThan(0);
    const { sql, args } = trustLadderCalls[0]!;
    // suggestion_id is the first run() param
    expect(args[0]).toBe(MOCK_PROPOSAL.timestamp);
    // user_grade=0 and status='pending' are hardcoded in the SQL
    expect(sql).toContain('user_grade');
    expect(sql).toContain("'pending'");
  });

  it('approve path clears pendingProposal via setPendingProposal(undefined)', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue({
      mode: 'paper', trustLadder: 'advisor', crisisStatus: 'active',
      constitutionVersion: 0, accuracyScore: 0, suggestionsSampled: 0,
      onboardingState: 'complete', updatedAt: new Date().toISOString(),
      pendingProposal: { ...MOCK_PROPOSAL },
    });
    writeMemoSpy = spyOn(WalletService, 'writeMemo').mockResolvedValue({
      txHash: 'tx-approve-4',
      explorerUrl: 'https://explorer.solana.com/tx/tx-approve-4?cluster=devnet',
    });
    prepareMock.mockImplementation((_sql: string) => ({ run: runMock, all: mock(() => []) } as never));

    await HandleProposalResponse.handler!(mockRuntime, mockMsg('approve_proposal'), undefined as never, undefined, mock(async () => undefined));

    expect(setPendingProposalSpy).toHaveBeenCalledWith(undefined);
  });

  it('reject path calls WalletService.writeMemo with NON_ACTION memo containing "User rejected"', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue({
      mode: 'paper', trustLadder: 'advisor', crisisStatus: 'active',
      constitutionVersion: 0, accuracyScore: 0, suggestionsSampled: 0,
      onboardingState: 'complete', updatedAt: new Date().toISOString(),
      pendingProposal: { ...MOCK_PROPOSAL },
    });
    writeMemoSpy = spyOn(WalletService, 'writeMemo').mockResolvedValue({
      txHash: 'tx-reject-1',
      explorerUrl: 'https://explorer.solana.com/tx/tx-reject-1?cluster=devnet',
    });

    const callback = mock(async () => undefined);
    await HandleProposalResponse.handler!(mockRuntime, mockMsg('reject_proposal'), undefined as never, undefined, callback);

    expect(writeMemoSpy).toHaveBeenCalledTimes(1);
    const memoArg = writeMemoSpy.mock.calls[0]?.[0] as string;
    expect(memoArg).toContain('User rejected');
  });

  it('reject path inserts into on_chain_memos with action_type=NON_ACTION', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue({
      mode: 'paper', trustLadder: 'advisor', crisisStatus: 'active',
      constitutionVersion: 0, accuracyScore: 0, suggestionsSampled: 0,
      onboardingState: 'complete', updatedAt: new Date().toISOString(),
      pendingProposal: { ...MOCK_PROPOSAL },
    });
    writeMemoSpy = spyOn(WalletService, 'writeMemo').mockResolvedValue({
      txHash: 'tx-reject-2',
      explorerUrl: 'https://explorer.solana.com/tx/tx-reject-2?cluster=devnet',
    });

    const actionTypeArgs: string[] = [];
    prepareMock.mockImplementation((sql: string) => {
      const r = {
        run: (...args: unknown[]) => {
          if (sql.includes('on_chain_memos')) actionTypeArgs.push(args[1] as string);
          return undefined;
        },
        all: mock(() => []),
      };
      return r as never;
    });

    await HandleProposalResponse.handler!(mockRuntime, mockMsg('reject_proposal'), undefined as never, undefined, mock(async () => undefined));

    expect(actionTypeArgs).toContain('NON_ACTION');
  });

  it('reject path inserts into trust_ladder_log with status=pending', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue({
      mode: 'paper', trustLadder: 'advisor', crisisStatus: 'active',
      constitutionVersion: 0, accuracyScore: 0, suggestionsSampled: 0,
      onboardingState: 'complete', updatedAt: new Date().toISOString(),
      pendingProposal: { ...MOCK_PROPOSAL },
    });
    writeMemoSpy = spyOn(WalletService, 'writeMemo').mockResolvedValue({
      txHash: 'tx-reject-3',
      explorerUrl: 'https://explorer.solana.com/tx/tx-reject-3?cluster=devnet',
    });

    const trustLadderCalls: { sql: string; args: unknown[] }[] = [];
    prepareMock.mockImplementation((sql: string) => {
      const r = {
        run: (...args: unknown[]) => {
          if (sql.includes('trust_ladder_log')) trustLadderCalls.push({ sql, args });
          return undefined;
        },
        all: mock(() => []),
      };
      return r as never;
    });

    await HandleProposalResponse.handler!(mockRuntime, mockMsg('reject_proposal'), undefined as never, undefined, mock(async () => undefined));

    expect(trustLadderCalls.length).toBeGreaterThan(0);
    const { sql } = trustLadderCalls[0]!;
    expect(sql).toContain("'pending'");
  });

  it('approve path callback delivers 3-line Lamport Reveal Message', async () => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue({
      mode: 'paper', trustLadder: 'advisor', crisisStatus: 'active',
      constitutionVersion: 0, accuracyScore: 0, suggestionsSampled: 0,
      onboardingState: 'complete', updatedAt: new Date().toISOString(),
      pendingProposal: { ...MOCK_PROPOSAL },
    });
    writeMemoSpy = spyOn(WalletService, 'writeMemo').mockResolvedValue({
      txHash: 'tx-reveal-1',
      explorerUrl: 'https://explorer.solana.com/tx/tx-reveal-1?cluster=devnet',
    });
    prepareMock.mockImplementation((_sql: string) => ({ run: runMock, all: mock(() => []) } as never));

    const callback = mock(async () => undefined);
    await HandleProposalResponse.handler!(mockRuntime, mockMsg('approve_proposal'), undefined as never, undefined, callback);

    expect(callback).toHaveBeenCalledTimes(1);
    const callbackArg = callback.mock.calls[0]?.[0] as { text: string };
    // Remove PAPER prefix (first 2 lines + blank) then check 3 lines remain
    const withoutPrefix = callbackArg.text.split('\n\n').slice(1).join('\n\n');
    const lines = withoutPrefix.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('🔗');
  });
});
