import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as migrations from '../db/migrations.js';
import { AgentStateService } from '../services/agent-state-service.js';
import { WalletService } from '../services/wallet-service.js';
import { ConstitutionService } from '../services/constitution-service.js';
import {
  executeCrisisFreeze,
  sendCrisisBriefing,
  TriggerCrisisProtocol,
  EmergencyVote,
} from './trigger-crisis-protocol.js';

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'paper',
    onboardingState: 'complete',
    constitutionVersion: 1,
    trustLadder: 'advisor',
    crisisStatus: 'active',
    telegramChatId: 'chat-1',
    pendingCrisisVote: undefined,
    ...overrides,
  } as any;
}

function makeTelegramRuntime(useModelImpl?: () => Promise<unknown>) {
  const sentMessages: Array<{ chatId: string; text: string; options?: Record<string, unknown> }> = [];
  return {
    clients: [
      {
        type: 'telegram',
        bot: {
          telegram: {
            sendMessage: mock(async (chatId: string, text: string, options?: Record<string, unknown>) => {
              sentMessages.push({ chatId, text, options });
            }),
          },
        },
      },
    ],
    useModel: mock(useModelImpl ?? (async () => { throw new Error('LLM not available'); })),
    _sentMessages: sentMessages,
  } as any;
}

function makePrepareWithInsertId(insertId = 1) {
  return mock(() => ({
    run: mock(() => ({ lastInsertRowid: insertId })),
    get: mock(() => null),
    all: mock(() => []),
  }));
}

// ---- executeCrisisFreeze ----

describe('executeCrisisFreeze', () => {
  let state: any;
  let prepareMock: ReturnType<typeof mock>;
  let getStateSpy: ReturnType<typeof spyOn>;
  let setStateSpy: ReturnType<typeof spyOn>;
  let setPendingCrisisVoteSpy: ReturnType<typeof spyOn>;
  let writeMemoSpy: ReturnType<typeof spyOn>;
  let getDbSpy: ReturnType<typeof spyOn>;
  let getActiveSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    state = makeState();
    prepareMock = makePrepareWithInsertId(1);

    getStateSpy = spyOn(AgentStateService, 'getState').mockImplementation(() => ({ ...state }));
    setStateSpy = spyOn(AgentStateService, 'setState').mockImplementation(async (update: Record<string, unknown>) => {
      state = { ...state, ...update };
    });
    setPendingCrisisVoteSpy = spyOn(AgentStateService, 'setPendingCrisisVote').mockImplementation(() => {});
    writeMemoSpy = spyOn(WalletService, 'writeMemo').mockResolvedValue({
      txHash: 'tx-crisis-1',
      explorerUrl: 'https://explorer.solana.com/tx/tx-crisis-1',
    } as any);
    getDbSpy = spyOn(migrations, 'getDb').mockReturnValue({ prepare: prepareMock } as any);
    getActiveSpy = spyOn(ConstitutionService.prototype ?? ConstitutionService, 'getActive' as any).mockReturnValue(null);
  });

  afterEach(() => {
    getStateSpy.mockRestore();
    setStateSpy.mockRestore();
    setPendingCrisisVoteSpy.mockRestore();
    writeMemoSpy.mockRestore();
    getDbSpy.mockRestore();
    getActiveSpy.mockRestore();
  });

  it('sets crisisStatus to frozen via AgentStateService.setState FIRST', async () => {
    const rt = makeTelegramRuntime();
    const callOrder: string[] = [];

    setStateSpy.mockImplementation(async (update: Record<string, unknown>) => {
      callOrder.push('setState');
      state = { ...state, ...update };
    });
    writeMemoSpy.mockImplementation(async () => {
      callOrder.push('writeMemo');
      return { txHash: 'tx1', explorerUrl: 'https://example.com/tx1' };
    });

    await executeCrisisFreeze(rt, { crisisType: 'constitution', violationSummary: 'Rule #1 vs Rule #2: conflict' });

    expect(setStateSpy).toHaveBeenCalledWith({ crisisStatus: 'frozen' }, expect.anything());
    expect(callOrder[0]).toBe('setState');
    expect(callOrder[1]).toBe('writeMemo');
  });

  it('writes Lamport memo with action_type CRISIS_FREEZE', async () => {
    const rt = makeTelegramRuntime();
    await executeCrisisFreeze(rt, { crisisType: 'constitution', violationSummary: 'some violation' });

    expect(writeMemoSpy).toHaveBeenCalledTimes(1);
    const allSqlCalls = prepareMock.mock.calls.map((args: unknown[]) => args[0] as string);
    const hasCrisisFreeze = allSqlCalls.some(sql => sql.includes('CRISIS_FREEZE'));
    expect(hasCrisisFreeze).toBe(true);
  });

  it('sends Telegram notification when telegramChatId is set (constitution: 2 messages)', async () => {
    const rt = makeTelegramRuntime();
    await executeCrisisFreeze(rt, { crisisType: 'constitution', violationSummary: 'Rule conflict' });

    // sendCrisisBriefing sends: ⏳ Thinking... then briefing with buttons
    expect(rt._sentMessages.length).toBeGreaterThanOrEqual(2);
    expect(rt._sentMessages[0].chatId).toBe('chat-1');
    expect(rt._sentMessages[0].text).toBe('⏳ Thinking...');
  });

  it('constitution: second message is 🚨 CRISIS BRIEFING with violation summary', async () => {
    const rt = makeTelegramRuntime();
    await executeCrisisFreeze(rt, { crisisType: 'constitution', violationSummary: 'Rule #1 conflicts with Rule #3' });

    const briefingMsg = rt._sentMessages[1];
    expect(briefingMsg.text).toContain('🚨 CRISIS BRIEFING');
    expect(briefingMsg.text).toContain('Rule #1 conflicts with Rule #3');
  });

  it('constitution: briefing starts with the required freeze sentence', async () => {
    const rt = makeTelegramRuntime();
    await executeCrisisFreeze(rt, { crisisType: 'constitution', violationSummary: 'Rule #1 conflicts with Rule #3' });

    const briefingMsg = rt._sentMessages[1];
    expect(briefingMsg.text.startsWith('I have frozen all actions.')).toBe(true);
  });

  it('constitution: briefing message has 3 inline buttons in 1 row', async () => {
    const rt = makeTelegramRuntime();
    await executeCrisisFreeze(rt, { crisisType: 'constitution', violationSummary: 'conflict' });

    const briefingMsg = rt._sentMessages[1];
    const keyboard = (briefingMsg.options as any)?.reply_markup?.inline_keyboard;
    expect(keyboard).toBeDefined();
    expect(keyboard).toHaveLength(1); // 1 row
    expect(keyboard[0]).toHaveLength(3); // 3 buttons
    expect(keyboard[0][0].callback_data).toBe('crisis_vote_a');
    expect(keyboard[0][1].callback_data).toBe('crisis_vote_b');
    expect(keyboard[0][2].callback_data).toBe('crisis_vote_c');
  });

  it('rpc_failure notification text says RPC failure, not constitutional impossibility', async () => {
    const rt = makeTelegramRuntime();
    await executeCrisisFreeze(rt, { crisisType: 'rpc_failure', violationSummary: 'Connection timeout' });

    expect(rt._sentMessages).toHaveLength(1);
    const text = rt._sentMessages[0].text;
    expect(text).toContain('RPC failure');
    expect(text).not.toContain('Constitutional impossibility');
    expect(text).not.toContain('emergency vote');
  });

  it('rpc_failure sends plain text notification — does NOT call sendCrisisBriefing (no buttons)', async () => {
    const rt = makeTelegramRuntime();
    await executeCrisisFreeze(rt, { crisisType: 'rpc_failure', violationSummary: 'timeout' });

    const msg = rt._sentMessages[0];
    expect(msg.options).toBeUndefined();
  });

  it('does NOT send Telegram when telegramChatId is not set', async () => {
    state = makeState({ telegramChatId: undefined });
    const rt = makeTelegramRuntime();
    await executeCrisisFreeze(rt, { crisisType: 'constitution', violationSummary: 'conflict' });

    expect(rt._sentMessages).toHaveLength(0);
  });

  it('memo write failure does NOT prevent state update — freeze remains effective', async () => {
    writeMemoSpy.mockRejectedValue(new Error('RPC down'));
    const rt = makeTelegramRuntime();

    await executeCrisisFreeze(rt, { crisisType: 'constitution', violationSummary: 'conflict' });

    expect(setStateSpy).toHaveBeenCalledWith({ crisisStatus: 'frozen' }, expect.anything());
    expect(state.crisisStatus).toBe('frozen');
  });

  it('memo write failure still allows Telegram notification', async () => {
    writeMemoSpy.mockRejectedValue(new Error('Network error'));
    const rt = makeTelegramRuntime();

    await executeCrisisFreeze(rt, { crisisType: 'constitution', violationSummary: 'conflict' });

    // sendCrisisBriefing still runs after memo failure
    expect(rt._sentMessages.length).toBeGreaterThanOrEqual(1);
  });
});

// ---- TriggerCrisisProtocol ----

describe('TriggerCrisisProtocol', () => {
  it('validate() always returns false', async () => {
    expect(await TriggerCrisisProtocol.validate({} as any, {} as any, {} as any)).toBe(false);
  });

  it('handler calls executeCrisisFreeze and invokes callback', async () => {
    let state: any = makeState();
    const prepareMock = makePrepareWithInsertId(1);
    const getStateSpy = spyOn(AgentStateService, 'getState').mockImplementation(() => ({ ...state }));
    const setStateSpy = spyOn(AgentStateService, 'setState').mockImplementation(async (update: Record<string, unknown>) => {
      state = { ...state, ...update };
    });
    const setPendingCrisisVoteSpy = spyOn(AgentStateService, 'setPendingCrisisVote').mockImplementation(() => {});
    const writeMemoSpy = spyOn(WalletService, 'writeMemo').mockResolvedValue({ txHash: 'tx1', explorerUrl: 'https://example.com' } as any);
    const getDbSpy = spyOn(migrations, 'getDb').mockReturnValue({ prepare: prepareMock } as any);
    const getActiveSpy = spyOn(ConstitutionService.prototype ?? ConstitutionService, 'getActive' as any).mockReturnValue(null);

    const callback = mock(async () => {});
    const msg = { content: { crisisType: 'constitution', violationSummary: 'test' } } as any;
    const rt = makeTelegramRuntime();

    await TriggerCrisisProtocol.handler!(rt, msg, undefined as any, undefined, callback);

    expect(setStateSpy).toHaveBeenCalledWith({ crisisStatus: 'frozen' }, expect.anything());
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Crisis Protocol activated') }));

    getStateSpy.mockRestore();
    setStateSpy.mockRestore();
    setPendingCrisisVoteSpy.mockRestore();
    writeMemoSpy.mockRestore();
    getDbSpy.mockRestore();
    getActiveSpy.mockRestore();
  });
});

// ---- sendCrisisBriefing ----

describe('sendCrisisBriefing', () => {
  let state: any;
  let prepareMock: ReturnType<typeof mock>;
  let getStateSpy: ReturnType<typeof spyOn>;
  let setPendingCrisisVoteSpy: ReturnType<typeof spyOn>;
  let writeMemoSpy: ReturnType<typeof spyOn>;
  let getDbSpy: ReturnType<typeof spyOn>;
  let getActiveSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    state = makeState();
    prepareMock = makePrepareWithInsertId(42);

    getStateSpy = spyOn(AgentStateService, 'getState').mockImplementation(() => ({ ...state }));
    setPendingCrisisVoteSpy = spyOn(AgentStateService, 'setPendingCrisisVote').mockImplementation(() => {});
    writeMemoSpy = spyOn(WalletService, 'writeMemo').mockResolvedValue({
      txHash: 'tx-resolution-1',
      explorerUrl: 'https://explorer.solana.com/tx/tx-resolution-1',
    } as any);
    getDbSpy = spyOn(migrations, 'getDb').mockReturnValue({ prepare: prepareMock } as any);
    getActiveSpy = spyOn(ConstitutionService.prototype ?? ConstitutionService, 'getActive' as any).mockReturnValue(null);
  });

  afterEach(() => {
    getStateSpy.mockRestore();
    setPendingCrisisVoteSpy.mockRestore();
    writeMemoSpy.mockRestore();
    getDbSpy.mockRestore();
    getActiveSpy.mockRestore();
  });

  it('sends ⏳ Thinking... before the LLM call', async () => {
    const callOrder: string[] = [];
    const rt = makeTelegramRuntime(async () => {
      callOrder.push('useModel');
      throw new Error('LLM error');
    });
    rt.clients[0].bot.telegram.sendMessage = mock(async (chatId: string, text: string) => {
      callOrder.push(`send:${text}`);
      rt._sentMessages.push({ chatId, text });
    });

    await sendCrisisBriefing(rt, 'chat-1', 'test violation');

    expect(callOrder[0]).toBe('send:⏳ Thinking...');
    expect(callOrder[1]).toBe('useModel');
  });

  it('calls useModel(ModelType.TEXT_LARGE, ...) exactly once', async () => {
    const rt = makeTelegramRuntime();
    await sendCrisisBriefing(rt, 'chat-1', 'test violation');

    expect(rt.useModel).toHaveBeenCalledTimes(1);
  });

  it('inserts a crisis_episodes row with status=open before sending briefing', async () => {
    const rt = makeTelegramRuntime();
    await sendCrisisBriefing(rt, 'chat-1', 'some violation');

    const allSqlCalls = prepareMock.mock.calls.map((args: unknown[]) => args[0] as string);
    const insertCall = allSqlCalls.find(sql => sql.includes('INSERT INTO crisis_episodes'));
    expect(insertCall).toBeDefined();
    expect(insertCall).toContain("'open'");
  });

  it('calls setPendingCrisisVote with the parsed options and crisisEpisodeId', async () => {
    const rt = makeTelegramRuntime();
    await sendCrisisBriefing(rt, 'chat-1', 'violation summary');

    expect(setPendingCrisisVoteSpy).toHaveBeenCalledTimes(1);
    const callArg = (setPendingCrisisVoteSpy.mock.calls[0] as any[])[0];
    expect(callArg).toHaveProperty('violationSummary', 'violation summary');
    expect(callArg).toHaveProperty('crisisEpisodeId', 42);
    expect(callArg).toHaveProperty('options');
    expect(callArg.options).toHaveProperty('a');
    expect(callArg.options).toHaveProperty('b');
    expect(callArg.options).toHaveProperty('c');
  });

  it('sends Telegram message with reply_markup.inline_keyboard containing 3 buttons in 1 row', async () => {
    const rt = makeTelegramRuntime();
    await sendCrisisBriefing(rt, 'chat-1', 'violation');

    // Second message is the briefing with buttons (first is ⏳ Thinking...)
    const briefingMsg = rt._sentMessages[1];
    expect(briefingMsg).toBeDefined();
    const keyboard = (briefingMsg.options as any)?.reply_markup?.inline_keyboard;
    expect(keyboard).toBeDefined();
    expect(keyboard).toHaveLength(1);
    expect(keyboard[0]).toHaveLength(3);
    expect(keyboard[0][0].callback_data).toBe('crisis_vote_a');
    expect(keyboard[0][1].callback_data).toBe('crisis_vote_b');
    expect(keyboard[0][2].callback_data).toBe('crisis_vote_c');
  });

  it('uses fallback options when Qwen returns invalid JSON (AC5)', async () => {
    const rt = makeTelegramRuntime(async () => 'not valid json at all');
    await sendCrisisBriefing(rt, 'chat-1', 'violation');

    // Fallback options are used — first button text matches fallback label
    const briefingMsg = rt._sentMessages[1];
    const keyboard = (briefingMsg.options as any)?.reply_markup?.inline_keyboard;
    expect(keyboard[0][0].text).toBe('A — Hold until rules amended');
    expect(keyboard[0][1].text).toBe('B — Suspend conflicting rule');
    expect(keyboard[0][2].text).toBe('C — Accept current state');
  });

  it('fallback briefing still starts with "I have frozen all actions." (AC5)', async () => {
    const rt = makeTelegramRuntime();
    await sendCrisisBriefing(rt, 'chat-1', 'violation');

    const briefingMsg = rt._sentMessages[1];
    expect(briefingMsg.text.startsWith('I have frozen all actions.')).toBe(true);
  });

  it('sends ⏳ Thinking... as first message', async () => {
    const rt = makeTelegramRuntime();
    await sendCrisisBriefing(rt, 'chat-1', 'violation');

    expect(rt._sentMessages[0].text).toBe('⏳ Thinking...');
    expect(rt._sentMessages[0].chatId).toBe('chat-1');
  });

  it('briefing message starts with 🚨', async () => {
    const rt = makeTelegramRuntime();
    await sendCrisisBriefing(rt, 'chat-1', 'violation');

    expect(rt._sentMessages[1].text).toContain('🚨');
  });

  it('successful briefing preserves the required first line even with LLM output', async () => {
    const validLlmResponse = JSON.stringify({
      briefing: 'I have frozen all actions. The crisis is severe but containable.',
      options: {
        a: { label: 'A — Hold positions', tradeoff: 'Low risk trade.' },
        b: { label: 'B — Partial exit', tradeoff: 'Medium risk trade.' },
        c: { label: 'C — Full exit', tradeoff: 'High risk trade.' },
      },
    });
    const rt = makeTelegramRuntime(async () => validLlmResponse);

    await sendCrisisBriefing(rt, 'chat-1', 'violation');

    const briefingMsg = rt._sentMessages[1];
    expect(briefingMsg.text.startsWith('I have frozen all actions.')).toBe(true);
  });

  it('updates crisis_episodes with LLM-generated labels on success', async () => {
    const validLlmResponse = JSON.stringify({
      briefing: 'I have frozen all actions. The crisis is severe.',
      options: {
        a: { label: 'A — Hold positions', tradeoff: 'Low risk trade.' },
        b: { label: 'B — Partial exit', tradeoff: 'Medium risk trade.' },
        c: { label: 'C — Full exit', tradeoff: 'High risk trade.' },
      },
    });
    const rt = makeTelegramRuntime(async () => validLlmResponse);
    await sendCrisisBriefing(rt, 'chat-1', 'violation');

    const allSqlCalls = prepareMock.mock.calls.map((args: unknown[]) => args[0] as string);
    const updateCall = allSqlCalls.find(sql => sql.includes('UPDATE crisis_episodes') && sql.includes('option_a_label'));
    expect(updateCall).toBeDefined();
  });
});

// ---- EmergencyVote ----

describe('EmergencyVote', () => {
  describe('validate()', () => {
    let state: any;
    let getStateSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      state = makeState({ crisisStatus: 'frozen', pendingCrisisVote: { violationSummary: 'x', crisisEpisodeId: 1, options: { a: { label: 'A', tradeoff: 'ta' }, b: { label: 'B', tradeoff: 'tb' }, c: { label: 'C', tradeoff: 'tc' } } } });
      getStateSpy = spyOn(AgentStateService, 'getState').mockImplementation(() => ({ ...state }));
    });

    afterEach(() => {
      getStateSpy.mockRestore();
    });

    it('returns false when text is not crisis_vote_a/b/c', async () => {
      const msg = { content: { text: 'some_other_text' } } as any;
      expect(await EmergencyVote.validate({} as any, msg, {} as any)).toBe(false);
    });

    it('returns false when crisisStatus !== frozen (AC6 — blocks double-tap in resolving state)', async () => {
      state = { ...state, crisisStatus: 'resolving' };
      const msg = { content: { text: 'crisis_vote_a' } } as any;
      expect(await EmergencyVote.validate({} as any, msg, {} as any)).toBe(false);
    });

    it('returns false when crisisStatus is active', async () => {
      state = { ...state, crisisStatus: 'active' };
      const msg = { content: { text: 'crisis_vote_b' } } as any;
      expect(await EmergencyVote.validate({} as any, msg, {} as any)).toBe(false);
    });

    it('returns false when pendingCrisisVote is undefined', async () => {
      state = { ...state, pendingCrisisVote: undefined };
      const msg = { content: { text: 'crisis_vote_a' } } as any;
      expect(await EmergencyVote.validate({} as any, msg, {} as any)).toBe(false);
    });

    it('returns true when text is crisis_vote_a, crisisStatus=frozen, and pendingCrisisVote is set', async () => {
      const msg = { content: { text: 'crisis_vote_a' } } as any;
      expect(await EmergencyVote.validate({} as any, msg, {} as any)).toBe(true);
    });

    it('returns true for crisis_vote_b', async () => {
      const msg = { content: { text: 'crisis_vote_b' } } as any;
      expect(await EmergencyVote.validate({} as any, msg, {} as any)).toBe(true);
    });

    it('returns true for crisis_vote_c', async () => {
      const msg = { content: { text: 'crisis_vote_c' } } as any;
      expect(await EmergencyVote.validate({} as any, msg, {} as any)).toBe(true);
    });
  });

  describe('handler()', () => {
    let state: any;
    let pendingVote: any;
    let prepareMock: ReturnType<typeof mock>;
    let getStateSpy: ReturnType<typeof spyOn>;
    let setStateSpy: ReturnType<typeof spyOn>;
    let setPendingCrisisVoteSpy: ReturnType<typeof spyOn>;
    let writeMemoSpy: ReturnType<typeof spyOn>;
    let getDbSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      pendingVote = {
        violationSummary: 'Rule #1 conflicts with Rule #2',
        crisisEpisodeId: 7,
        options: {
          a: { label: 'A — Hold positions', tradeoff: 'Low risk.' },
          b: { label: 'B — Partial exit', tradeoff: 'Medium risk.' },
          c: { label: 'C — Full exit', tradeoff: 'High risk.' },
        },
      };
      state = makeState({ crisisStatus: 'frozen', pendingCrisisVote: pendingVote });
      prepareMock = makePrepareWithInsertId(1);

      getStateSpy = spyOn(AgentStateService, 'getState').mockImplementation(() => ({ ...state }));
      setStateSpy = spyOn(AgentStateService, 'setState').mockImplementation(async (update: Record<string, unknown>) => {
        state = { ...state, ...update };
      });
      setPendingCrisisVoteSpy = spyOn(AgentStateService, 'setPendingCrisisVote').mockImplementation(() => {});
      writeMemoSpy = spyOn(WalletService, 'writeMemo').mockResolvedValue({
        txHash: 'tx-resolution-1',
        explorerUrl: 'https://explorer.solana.com/tx/tx-resolution-1',
      } as any);
      getDbSpy = spyOn(migrations, 'getDb').mockReturnValue({ prepare: prepareMock } as any);
    });

    afterEach(() => {
      getStateSpy.mockRestore();
      setStateSpy.mockRestore();
      setPendingCrisisVoteSpy.mockRestore();
      writeMemoSpy.mockRestore();
      getDbSpy.mockRestore();
    });

    it('sets crisisStatus = resolving BEFORE writing any memo or Telegram message (FR32 ordering)', async () => {
      const callOrder: string[] = [];
      setStateSpy.mockImplementation(async (update: Record<string, unknown>) => {
        const key = `setState:${JSON.stringify(update)}`;
        callOrder.push(key);
        state = { ...state, ...update };
      });
      writeMemoSpy.mockImplementation(async () => {
        callOrder.push('writeMemo');
        return { txHash: 'tx1', explorerUrl: 'https://example.com' };
      });
      const rt = makeTelegramRuntime();
      const msg = { content: { text: 'crisis_vote_a' } } as any;

      await EmergencyVote.handler!(rt, msg, undefined as any, undefined, undefined);

      const resolvingIdx = callOrder.findIndex(c => c.includes('"resolving"'));
      const memoIdx = callOrder.findIndex(c => c === 'writeMemo');
      expect(resolvingIdx).toBeGreaterThanOrEqual(0);
      expect(resolvingIdx).toBeLessThan(memoIdx);
    });

    it('calls setPendingCrisisVote(undefined) to clear state', async () => {
      const rt = makeTelegramRuntime();
      const msg = { content: { text: 'crisis_vote_b' } } as any;

      await EmergencyVote.handler!(rt, msg, undefined as any, undefined, undefined);

      expect(setPendingCrisisVoteSpy).toHaveBeenCalledWith(undefined);
    });

    it('persists chosen_option to crisis_episodes table', async () => {
      const rt = makeTelegramRuntime();
      const msg = { content: { text: 'crisis_vote_a' } } as any;

      await EmergencyVote.handler!(rt, msg, undefined as any, undefined, undefined);

      const allSqlCalls = prepareMock.mock.calls.map((args: unknown[]) => args[0] as string);
      const updateCall = allSqlCalls.find(sql => sql.includes('UPDATE crisis_episodes') && sql.includes('chosen_option'));
      expect(updateCall).toBeDefined();
    });

    it('writes Lamport memo with action_type CRISIS_RESOLUTION', async () => {
      const rt = makeTelegramRuntime();
      const msg = { content: { text: 'crisis_vote_c' } } as any;

      await EmergencyVote.handler!(rt, msg, undefined as any, undefined, undefined);

      expect(writeMemoSpy).toHaveBeenCalledTimes(1);
      const allSqlCalls = prepareMock.mock.calls.map((args: unknown[]) => args[0] as string);
      const memoInsert = allSqlCalls.find(sql => sql.includes('CRISIS_RESOLUTION'));
      expect(memoInsert).toBeDefined();
    });

    it('option B lifts the freeze after memo write', async () => {
      const rt = makeTelegramRuntime();
      const msg = { content: { text: 'crisis_vote_b' } } as any;

      await EmergencyVote.handler!(rt, msg, undefined as any, undefined, undefined);

      const activeCalls = setStateSpy.mock.calls.filter(
        (args: unknown[]) => (args[0] as Record<string, unknown>)?.crisisStatus === 'active'
      );
      expect(activeCalls).toHaveLength(1);
      expect(state.crisisStatus).toBe('active');
    });

    it('option A keeps the treasury frozen after the vote', async () => {
      const rt = makeTelegramRuntime();
      const msg = { content: { text: 'crisis_vote_a' } } as any;

      await EmergencyVote.handler!(rt, msg, undefined as any, undefined, undefined);

      expect(state.crisisStatus).toBe('frozen');
      expect(rt._sentMessages[0].text).toContain('treasury remains frozen');
    });

    it('sends resolution message containing "✅ Crisis resolved" for freeze-lifting options', async () => {
      const rt = makeTelegramRuntime();
      const msg = { content: { text: 'crisis_vote_b' } } as any;

      await EmergencyVote.handler!(rt, msg, undefined as any, undefined, undefined);

      expect(rt._sentMessages).toHaveLength(1);
      expect(rt._sentMessages[0].text).toContain('✅ Crisis resolved');
    });

    it('updates crisis_episodes row with status=resolved and resolved_at', async () => {
      const rt = makeTelegramRuntime();
      const msg = { content: { text: 'crisis_vote_a' } } as any;

      await EmergencyVote.handler!(rt, msg, undefined as any, undefined, undefined);

      const allSqlCalls = prepareMock.mock.calls.map((args: unknown[]) => args[0] as string);
      const resolvedUpdate = allSqlCalls.find(sql => sql.includes('resolved_at') && sql.includes('crisis_episodes'));
      expect(resolvedUpdate).toBeDefined();
      expect(resolvedUpdate).toContain("'resolved'");
    });

    it('memo write failure does NOT prevent option B from lifting the freeze', async () => {
      writeMemoSpy.mockRejectedValue(new Error('Network error'));
      const rt = makeTelegramRuntime();
      const msg = { content: { text: 'crisis_vote_b' } } as any;

      await EmergencyVote.handler!(rt, msg, undefined as any, undefined, undefined);

      expect(state.crisisStatus).toBe('active');
    });

    it('memo write failure does NOT prevent the outcome message being sent', async () => {
      writeMemoSpy.mockRejectedValue(new Error('Network error'));
      const rt = makeTelegramRuntime();
      const msg = { content: { text: 'crisis_vote_a' } } as any;

      await EmergencyVote.handler!(rt, msg, undefined as any, undefined, undefined);

      expect(rt._sentMessages).toHaveLength(1);
      expect(rt._sentMessages[0].text).toContain('You chose:');
    });

    it('uses callback when no telegramChatId is set', async () => {
      state = makeState({ crisisStatus: 'frozen', telegramChatId: undefined, pendingCrisisVote: pendingVote });
      const rt = makeTelegramRuntime();
      const callback = mock(async () => {});
      const msg = { content: { text: 'crisis_vote_a' } } as any;

      await EmergencyVote.handler!(rt, msg, undefined as any, undefined, callback);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('treasury remains frozen') })
      );
    });

    it('uses callback with "No pending crisis vote" message when voteData is missing', async () => {
      state = makeState({ crisisStatus: 'frozen', pendingCrisisVote: undefined });
      const rt = makeTelegramRuntime();
      const callback = mock(async () => {});
      const msg = { content: { text: 'crisis_vote_a' } } as any;

      await EmergencyVote.handler!(rt, msg, undefined as any, undefined, callback);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('No pending crisis vote') })
      );
    });

    it('option C sets crisisStatus to resolving → active in order', async () => {
      const stateTransitions: string[] = [];
      setStateSpy.mockImplementation(async (update: Record<string, unknown>) => {
        if (update.crisisStatus) stateTransitions.push(update.crisisStatus as string);
        state = { ...state, ...update };
      });
      const rt = makeTelegramRuntime();
      const msg = { content: { text: 'crisis_vote_c' } } as any;

      await EmergencyVote.handler!(rt, msg, undefined as any, undefined, undefined);

      expect(stateTransitions[0]).toBe('resolving');
      expect(stateTransitions[1]).toBe('active');
    });

    it('option A sets crisisStatus to resolving → frozen in order', async () => {
      const stateTransitions: string[] = [];
      setStateSpy.mockImplementation(async (update: Record<string, unknown>) => {
        if (update.crisisStatus) stateTransitions.push(update.crisisStatus as string);
        state = { ...state, ...update };
      });
      const rt = makeTelegramRuntime();
      const msg = { content: { text: 'crisis_vote_a' } } as any;

      await EmergencyVote.handler!(rt, msg, undefined as any, undefined, undefined);

      expect(stateTransitions[0]).toBe('resolving');
      expect(stateTransitions[1]).toBe('frozen');
    });
  });
});
