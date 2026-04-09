import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { withComplianceGate } from './with-compliance-gate.js';
import { AgentStateService } from '../services/agent-state-service.js';
import { ConstitutionService } from '../services/constitution-service.js';
import { WalletService } from '../services/wallet-service.js';
import * as migrations from '../db/migrations.js';

const baseMessage = {
  content: { text: 'test', source: 'telegram' },
  roomId: 'room1',
  userId: 'user1',
  agentId: 'agent1',
  createdAt: Date.now(),
  id: 'msg1',
};

describe('withComplianceGate', () => {
  let getStateSpy: ReturnType<typeof spyOn>;
  let getDbSpy: ReturnType<typeof spyOn>;
  let getActiveSpy: ReturnType<typeof spyOn>;
  let writeMemoSpy: ReturnType<typeof spyOn>;
  let getExplorerUrlSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue({
      crisisStatus: 'active',
      trustLadder: 'executor',
      mode: 'live',
      constitutionVersion: 0,
      accuracyScore: 85,
      suggestionsSampled: 10,
      onboardingState: 'complete',
      promotionPending: false,
      updatedAt: new Date().toISOString(),
    });
    getDbSpy = spyOn(migrations, 'getDb').mockReturnValue({
      prepare: mock(() => ({
        run: mock(() => undefined),
      })),
    } as unknown as ReturnType<typeof migrations.getDb>);
    getActiveSpy = spyOn(ConstitutionService, 'getActive').mockReturnValue(null);
  });

  afterEach(() => {
    getStateSpy.mockRestore();
    getDbSpy.mockRestore();
    getActiveSpy.mockRestore();
    writeMemoSpy?.mockRestore();
    getExplorerUrlSpy?.mockRestore();
  });

  test('passes through to handler when all gates pass', async () => {
    let handlerCalled = false;
    const handler = async () => { handlerCalled = true; };
    const wrapped = withComplianceGate(handler);
    await wrapped({} as never, baseMessage as never, undefined, undefined, undefined);
    expect(handlerCalled).toBe(true);
    expect(getActiveSpy).toHaveBeenCalledTimes(1);
  });

  test('crisis gate blocks when crisisStatus is frozen', async () => {
    getStateSpy.mockReturnValue({
      crisisStatus: 'frozen',
      trustLadder: 'executor',
      mode: 'live',
      constitutionVersion: 0,
      accuracyScore: 85,
      suggestionsSampled: 10,
      onboardingState: 'complete',
      promotionPending: false,
      updatedAt: new Date().toISOString(),
    });

    let handlerCalled = false;
    const handler = async () => { handlerCalled = true; };
    let callbackText = '';
    const callback = async (content: { text: string }) => { callbackText = content.text; };

    const wrapped = withComplianceGate(handler);
    await wrapped({} as never, baseMessage as never, undefined, undefined, callback as never);

    expect(handlerCalled).toBe(false);
    expect(callbackText).toContain('🚨');
  });

  test('advisor gate blocks when trustLadder is advisor', async () => {
    getStateSpy.mockReturnValue({
      crisisStatus: 'active',
      trustLadder: 'advisor',
      mode: 'paper',
      constitutionVersion: 0,
      accuracyScore: 60,
      suggestionsSampled: 5,
      onboardingState: 'complete',
      promotionPending: false,
      updatedAt: new Date().toISOString(),
    });

    let handlerCalled = false;
    const handler = async () => { handlerCalled = true; };
    let callbackText = '';
    const callback = async (content: { text: string }) => { callbackText = content.text; };

    const wrapped = withComplianceGate(handler);
    await wrapped({} as never, baseMessage as never, undefined, undefined, callback as never);

    expect(handlerCalled).toBe(false);
    expect(callbackText).toContain('📊');
    expect(callbackText).toContain('60.0%');
  });

  test('loads active constitution even when agent state constitutionVersion is 0 and blocks violating action', async () => {
    getActiveSpy.mockReturnValue({
      id: 1,
      version: 1,
      rules: [
        {
          id: 3,
          type: 'threshold',
          description: 'SOL concentration must stay below 50',
          action: 'block',
          condition: { metric: 'sol_concentration', operator: '<', value: 50, unit: 'percent' },
        },
      ],
    });
    writeMemoSpy = spyOn(WalletService, 'writeMemo').mockResolvedValue({
      txHash: 'blocked-tx',
      explorerUrl: 'https://explorer.solana.com/tx/blocked-tx',
    });
    getExplorerUrlSpy = spyOn(WalletService, 'getExplorerUrl').mockReturnValue('https://explorer.solana.com/tx/blocked-tx');

    let handlerCalled = false;
    const handler = async () => { handlerCalled = true; };
    let callbackText = '';
    const callback = async (content: { text: string }) => { callbackText = content.text; };

    const wrapped = withComplianceGate(handler);
    await wrapped(
      {} as never,
      {
        ...baseMessage,
        content: { text: 'swap', source: 'telegram', metric: 'sol_concentration', value: 90, unit: 'percent' },
      } as never,
      undefined,
      undefined,
      callback as never,
    );

    expect(handlerCalled).toBe(false);
    expect(getActiveSpy).toHaveBeenCalledTimes(1);
    expect(writeMemoSpy).toHaveBeenCalledTimes(1);
    expect(writeMemoSpy.mock.calls[0]?.[0]).toContain('NON_ACTION: SOL concentration must stay below 50.');
    expect(writeMemoSpy.mock.calls[0]?.[0]).toContain('Rule #3. Constitutional compliance: BLOCKED.');
    expect(callbackText).toContain('Rule #3');
  });
});
