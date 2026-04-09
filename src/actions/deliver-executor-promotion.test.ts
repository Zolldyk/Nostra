import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { DeliverExecutorPromotion } from './deliver-executor-promotion.js';
import { AgentStateService } from '../services/agent-state-service.js';
import * as migrations from '../db/migrations.js';
import type { AgentState } from '../types/agent-state.js';

const makeMessage = (text = 'hello') => ({
  content: { text, source: 'telegram' },
  roomId: 'room1', userId: 'user1', agentId: 'agent1',
  createdAt: Date.now(), id: 'msg1',
});

const baseState = (overrides: Partial<AgentState> = {}): AgentState => ({
  mode: 'paper', trustLadder: 'advisor', crisisStatus: 'active',
  constitutionVersion: 1, accuracyScore: 85, suggestionsSampled: 10,
  onboardingState: 'complete', promotionPending: true,
  telegramChatId: 'chat1', updatedAt: new Date().toISOString(),
  ...overrides,
});

describe('DeliverExecutorPromotion', () => {
  let getStateSpy: ReturnType<typeof spyOn>;
  let setStateSpy: ReturnType<typeof spyOn>;
  let getDbSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue(baseState());
    setStateSpy = spyOn(AgentStateService, 'setState').mockResolvedValue(undefined);
    getDbSpy = spyOn(migrations, 'getDb').mockReturnValue({ prepare: mock(() => ({ run: mock(() => undefined) })) } as never);
  });

  afterEach(() => {
    getStateSpy.mockRestore();
    setStateSpy.mockRestore();
    getDbSpy.mockRestore();
  });

  test('validate returns true when promotionPending=true and trustLadder=advisor', async () => {
    const result = await DeliverExecutorPromotion.validate!({} as never, makeMessage() as never, {} as never);
    expect(result).toBe(true);
  });

  test('validate returns false when promotionPending=false', async () => {
    getStateSpy.mockReturnValue(baseState({ promotionPending: false }));
    const result = await DeliverExecutorPromotion.validate!({} as never, makeMessage() as never, {} as never);
    expect(result).toBe(false);
  });

  test('validate returns false when trustLadder=executor', async () => {
    getStateSpy.mockReturnValue(baseState({ trustLadder: 'executor' }));
    const result = await DeliverExecutorPromotion.validate!({} as never, makeMessage() as never, {} as never);
    expect(result).toBe(false);
  });

  test('handler sends message with 🏆 and 🔐 prefix, sets trustLadder to executor', async () => {
    const mockRuntime = {
      useModel: async () => `🏆 You have reached the threshold after 10 suggestions at 85.0% accuracy. This was earned not given. Your constitutional discipline has proven itself in the market. Fund a Solana wallet and send me the address when ready. I will be here. Every action from this point forward is real.`,
      sendMessageToTarget: async () => {},
    };

    const messages: Array<{ text: string }> = [];
    const callback = mock(async (content: { text: string }) => { messages.push(content); });

    const result = await DeliverExecutorPromotion.handler!(
      mockRuntime as never, makeMessage() as never, undefined, undefined, callback as never,
    );

    // Last callback should be the full promotion message
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg?.text).toContain('🔐 LIVE TREASURY');
    expect(lastMsg?.text).toContain('🏆');
    expect(setStateSpy).toHaveBeenCalledWith({ trustLadder: 'executor' }, expect.anything());
    expect(result).toEqual({ success: true, data: { trustLadder: 'executor' } });
  });

  test('handler sends fallback message if Qwen fails', async () => {
    const mockRuntime = {
      useModel: async () => { throw new Error('Qwen timeout'); },
      sendMessageToTarget: async () => {},
    };

    const messages: Array<{ text: string }> = [];
    const callback = mock(async (content: { text: string }) => { messages.push(content); });

    await DeliverExecutorPromotion.handler!(
      mockRuntime as never, makeMessage() as never, undefined, undefined, callback as never,
    );

    // Fallback message should still contain the live prefix and 🏆
    const lastMsg = messages[messages.length - 1];
    expect(lastMsg?.text).toContain('🔐 LIVE TREASURY');
    expect(lastMsg?.text).toContain('🏆');
  });

  test('handler sends thinking indicator via runtime target when callback is absent', async () => {
    const sent: Array<{ text: string }> = [];
    const mockRuntime = {
      useModel: async () => `🏆 ${Array.from({ length: 210 }, (_, i) => `word${i}`).join(' ')}`,
      sendMessageToTarget: mock(async (_target, content) => {
        sent.push(content as { text: string });
        return [];
      }),
    };

    await DeliverExecutorPromotion.handler!(
      mockRuntime as never, makeMessage() as never, undefined, undefined, undefined,
    );

    expect(sent[0]?.text).toBe('⏳ Thinking...');
    expect(sent[1]?.text).toContain('🔐 LIVE TREASURY');
  });
});
