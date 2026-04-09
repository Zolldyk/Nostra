import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { HandleWalletConnection } from './handle-wallet-connection.js';
import { AgentStateService } from '../services/agent-state-service.js';
import { WalletService } from '../services/wallet-service.js';
import * as migrations from '../db/migrations.js';

const validPubkey = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

const makeMessage = (text: string) => ({
  content: { text, source: 'telegram' },
  roomId: 'room1',
  userId: 'user1',
  agentId: 'agent1',
  createdAt: Date.now(),
  id: 'msg1',
});

describe('HandleWalletConnection', () => {
  let getStateSpy: ReturnType<typeof spyOn>;
  let setStateSpy: ReturnType<typeof spyOn>;
  let getBalanceSpy: ReturnType<typeof spyOn>;
  let getDbSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue({
      crisisStatus: 'active',
      trustLadder: 'executor',
      mode: 'paper',
      constitutionVersion: 1,
      accuracyScore: 85,
      suggestionsSampled: 10,
      onboardingState: 'complete',
      promotionPending: true,
      updatedAt: new Date().toISOString(),
    });
    setStateSpy = spyOn(AgentStateService, 'setState').mockResolvedValue(undefined);
    getBalanceSpy = spyOn(WalletService, 'getBalance').mockResolvedValue({
      sol: 1.2345,
      publicKey: 'AgentPubkey1111111111111111111111111111111',
    });
    getDbSpy = spyOn(migrations, 'getDb').mockReturnValue({ prepare: mock(() => ({ run: mock(() => undefined) })) } as never);
  });

  afterEach(() => {
    getStateSpy.mockRestore();
    setStateSpy.mockRestore();
    getBalanceSpy.mockRestore();
    getDbSpy.mockRestore();
  });

  test('validate returns false when promotionPending is false', async () => {
    getStateSpy.mockReturnValue({
      crisisStatus: 'active',
      trustLadder: 'advisor',
      mode: 'paper',
      constitutionVersion: 1,
      accuracyScore: 85,
      suggestionsSampled: 10,
      onboardingState: 'complete',
      promotionPending: false,
      updatedAt: new Date().toISOString(),
    });
    const result = await HandleWalletConnection.validate!({} as never, makeMessage(validPubkey) as never, {} as never);
    expect(result).toBe(false);
  });

  test('validate returns false when message has no Solana pubkey', async () => {
    const result = await HandleWalletConnection.validate!({} as never, makeMessage('yes connect my wallet') as never, {} as never);
    expect(result).toBe(false);
  });

  test('validate returns true when promotionPending and message contains pubkey', async () => {
    const result = await HandleWalletConnection.validate!({} as never, makeMessage(validPubkey) as never, {} as never);
    expect(result).toBe(true);
  });

  test('handler switches to live mode, clears promotionPending, reads balance, and confirms with live prefix', async () => {
    const callback = mock(async () => undefined);

    const result = await HandleWalletConnection.handler!(
      {} as never,
      makeMessage(validPubkey) as never,
      undefined as never,
      undefined,
      callback,
    );

    expect(setStateSpy).toHaveBeenCalledTimes(1);
    expect(setStateSpy.mock.calls[0]?.[0]).toEqual({ mode: 'live', promotionPending: false });
    expect(getBalanceSpy).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
    const payload = callback.mock.calls[0]?.[0] as { text: string };
    expect(payload.text).toContain('🔐 LIVE TREASURY');
    expect(payload.text).toContain("Your wallet is connected. I'm switching to live mode — every action from here is real.");
    expect(payload.text).toContain('SOL balance: 1.2345 SOL');
    expect(result).toEqual({ success: true, data: { mode: 'live' } });
  });
});
