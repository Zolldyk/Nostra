import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { ExecuteRotation } from './execute-rotation.js';
import { AgentStateService } from '../services/agent-state-service.js';
import { WalletService } from '../services/wallet-service.js';
import * as migrations from '../db/migrations.js';
import * as retryUtils from '../utils/with-retry.js';
import type { AgentState } from '../types/agent-state.js';

const executorState = (): AgentState => ({
  mode: 'live', trustLadder: 'executor', crisisStatus: 'active',
  constitutionVersion: 1, accuracyScore: 85, suggestionsSampled: 10,
  onboardingState: 'complete', promotionPending: false,
  telegramChatId: 'chat1', updatedAt: new Date().toISOString(),
});

const makeSwapMessage = () => ({
  content: {
    text: 'execute rotation',
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    amount: 1000000,
    slippageBps: 50,
    source: 'telegram',
  },
  roomId: 'room1', userId: 'user1', agentId: 'agent1',
  createdAt: Date.now(), id: 'msg1',
});

describe('ExecuteRotation', () => {
  let getStateSpy: ReturnType<typeof spyOn>;
  let getDbSpy: ReturnType<typeof spyOn>;
  let getBalanceSpy: ReturnType<typeof spyOn>;
  let signAndSubmitSpy: ReturnType<typeof spyOn>;
  let writeMemoSpy: ReturnType<typeof spyOn>;
  let withRetrySpy: ReturnType<typeof spyOn>;
  let originalFetch: typeof globalThis.fetch | undefined;
  const runMock = mock(() => undefined);

  beforeEach(() => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(executorState());
    getDbSpy = spyOn(migrations, 'getDb').mockReturnValue({
      prepare: mock(() => ({ run: runMock })),
    } as never);
    getBalanceSpy = spyOn(WalletService, 'getBalance').mockResolvedValue({
      sol: 1.5,
      publicKey: 'AgentPubkey1111111111111111111111111111111',
    });
    signAndSubmitSpy = spyOn(WalletService, 'signAndSubmit').mockResolvedValue({
      txHash: 'swap-tx-123',
      explorerUrl: 'https://explorer.solana.com/tx/swap-tx-123',
    });
    writeMemoSpy = spyOn(WalletService, 'writeMemo').mockResolvedValue({
      txHash: 'memo-tx-999',
      explorerUrl: 'https://explorer.solana.com/tx/memo-tx-999',
    });
    withRetrySpy = spyOn(retryUtils, 'withRetry').mockImplementation(async (fn: () => Promise<unknown>) => fn());
    runMock.mockClear();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    getStateSpy.mockRestore();
    getDbSpy.mockRestore();
    getBalanceSpy.mockRestore();
    signAndSubmitSpy.mockRestore();
    writeMemoSpy.mockRestore();
    withRetrySpy.mockRestore();
    globalThis.fetch = originalFetch!;
  });

  test('validate returns true when trustLadder=executor and mode=live', async () => {
    const result = await ExecuteRotation.validate!({} as never, makeSwapMessage() as never, {} as never);
    expect(result).toBe(true);
  });

  test('validate returns false when trustLadder=advisor', async () => {
    getStateSpy.mockReturnValue({ ...executorState(), trustLadder: 'advisor' });
    const result = await ExecuteRotation.validate!({} as never, makeSwapMessage() as never, {} as never);
    expect(result).toBe(false);
  });

  test('validate returns false when mode=paper', async () => {
    getStateSpy.mockReturnValue({ ...executorState(), mode: 'paper' });
    const result = await ExecuteRotation.validate!({} as never, makeSwapMessage() as never, {} as never);
    expect(result).toBe(false);
  });

  test('handler exits with notice on devnet (Jupiter unavailable)', async () => {
    const originalNetwork = process.env.SOLANA_NETWORK;
    process.env.SOLANA_NETWORK = 'devnet';

    const messages: Array<{ text: string }> = [];
    const callback = mock(async (content: { text: string }) => { messages.push(content); });

    await ExecuteRotation.handler!(
      {} as never, makeSwapMessage() as never, undefined, undefined, callback as never,
    );

    expect(messages[0]?.text).toContain('mainnet');
    process.env.SOLANA_NETWORK = originalNetwork;
  });

  test('handler executes Jupiter swap flow and persists Lamport memo transaction on success', async () => {
    const originalNetwork = process.env.SOLANA_NETWORK;
    process.env.SOLANA_NETWORK = 'mainnet-beta';

    globalThis.fetch = mock(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/swap')) {
        expect(init?.method).toBe('POST');
        return {
          ok: true,
          json: async () => ({ swapTransaction: Buffer.from([1, 2, 3]).toString('base64') }),
        } as Response;
      }
      if (url.includes('/quote')) {
        return {
          ok: true,
          json: async () => ({ routePlan: [{ swapInfo: { ammKey: 'amm-1' } }] }),
        } as Response;
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    const deserializeSpy = spyOn((await import('@solana/web3.js')).VersionedTransaction, 'deserialize')
      .mockReturnValue({} as never);

    const messages: Array<{ text: string }> = [];
    const callback = mock(async (content: { text: string }) => { messages.push(content); });

    const result = await ExecuteRotation.handler!(
      {} as never, makeSwapMessage() as never, undefined, undefined, callback as never,
    );

    expect(getBalanceSpy).toHaveBeenCalledTimes(1);
    expect(signAndSubmitSpy).toHaveBeenCalledTimes(1);
    expect(writeMemoSpy).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith(
      'memo-tx-999',
      expect.stringContaining('EXECUTE_ROTATION:'),
      'https://explorer.solana.com/tx/memo-tx-999',
      expect.any(String),
    );
    expect(messages[0]?.text).toContain('🔐 LIVE TREASURY');
    expect(messages[0]?.text).toContain('https://explorer.solana.com/tx/swap-tx-123');
    expect(result).toEqual({ success: true, data: { txHash: 'swap-tx-123', explorerUrl: 'https://explorer.solana.com/tx/swap-tx-123' } });

    deserializeSpy.mockRestore();
    process.env.SOLANA_NETWORK = originalNetwork;
  });

  test('handler follows 3-step error pattern when Jupiter quote fails', async () => {
    const originalNetwork = process.env.SOLANA_NETWORK;
    process.env.SOLANA_NETWORK = 'mainnet-beta';

    globalThis.fetch = mock(async () => {
      return {
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
      } as Response;
    }) as typeof fetch;

    const messages: Array<{ text: string }> = [];
    const callback = mock(async (content: { text: string }) => { messages.push(content); });

    await expect(
      ExecuteRotation.handler!({} as never, makeSwapMessage() as never, undefined, undefined, callback as never),
    ).rejects.toThrow('Jupiter quote failed: 502 Bad Gateway');

    expect(writeMemoSpy).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith(
      'memo-tx-999',
      expect.stringContaining('NON_ACTION: Jupiter quote failed: 502 Bad Gateway'),
      'https://explorer.solana.com/tx/memo-tx-999',
      expect.any(String),
    );
    expect(messages[0]?.text).toContain('⚠️ Swap could not be completed');

    process.env.SOLANA_NETWORK = originalNetwork;
  });
});
