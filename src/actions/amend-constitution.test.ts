import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as migrations from '../db/migrations.js';
import { AmendConstitution, HandleAmendmentResponse } from './amend-constitution.js';
import { AgentStateService } from '../services/agent-state-service.js';
import { ConstitutionService } from '../services/constitution-service.js';
import { WalletService } from '../services/wallet-service.js';

const mockRules = [
  {
    id: 1,
    type: 'allocation_limit',
    description: 'SOL concentration must not exceed 30%',
    condition: { metric: 'sol_concentration', operator: '<=', value: 30, unit: 'percent' },
    action: 'block',
  },
  {
    id: 2,
    type: 'yield_threshold',
    description: 'Only rotate if yield delta exceeds 2%',
    condition: { metric: 'yield_delta', operator: '>', value: 2, unit: 'apy_points' },
    action: 'require_approval',
  },
] as const;

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'paper',
    onboardingState: 'complete',
    constitutionVersion: 1,
    trustLadder: 'executor',
    telegramChatId: 'chat-1',
    pendingAmendment: undefined,
    ...overrides,
  } as any;
}

function makeTelegramRuntime(useModelImpl?: (_type: unknown, opts: { prompt: string }) => Promise<string>) {
  const sentMessages: Array<{ text: string; options?: Record<string, unknown> }> = [];
  return {
    clients: [
      {
        type: 'telegram',
        bot: {
          telegram: {
            sendMessage: mock(async (_chatId: string, text: string, options?: Record<string, unknown>) => {
              sentMessages.push({ text, options });
            }),
          },
        },
      },
    ],
    useModel: mock(
      useModelImpl ??
        (async (_type: unknown, opts: { prompt: string }) => {
          if (opts.prompt.includes('Which rule number')) return '2';
          return JSON.stringify({
            id: 2,
            type: 'yield_threshold',
            description: 'Only rotate if yield delta exceeds 3%',
            condition: { metric: 'yield_delta', operator: '>', value: 3, unit: 'apy_points' },
            action: 'require_approval',
          });
        }),
    ),
    _sentMessages: sentMessages,
  } as any;
}

describe('AmendConstitution', () => {
  let state: any;
  let prepareMock: ReturnType<typeof mock>;
  let getStateSpy: ReturnType<typeof spyOn>;
  let setStateSpy: ReturnType<typeof spyOn>;
  let setPendingAmendmentSpy: ReturnType<typeof spyOn>;
  let getActiveSpy: ReturnType<typeof spyOn>;
  let amendAndActivateSpy: ReturnType<typeof spyOn>;
  let writeMemoSpy: ReturnType<typeof spyOn>;
  let getDbSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    state = makeState();
    prepareMock = mock(() => ({
      run: mock(() => {}),
      get: mock(() => null),
      all: mock(() => []),
    }));

    getStateSpy = spyOn(AgentStateService, 'getState').mockImplementation(() => ({ ...state }));
    setStateSpy = spyOn(AgentStateService, 'setState').mockImplementation(async (update: Record<string, unknown>) => {
      state = { ...state, ...update };
    });
    setPendingAmendmentSpy = spyOn(AgentStateService, 'setPendingAmendment').mockImplementation((amendment: unknown) => {
      state = { ...state, pendingAmendment: amendment };
    });
    getActiveSpy = spyOn(ConstitutionService, 'getActive').mockReturnValue({ id: 1, version: 1, rules: [...mockRules] } as any);
    amendAndActivateSpy = spyOn(ConstitutionService, 'amendAndActivate').mockReturnValue(2);
    writeMemoSpy = spyOn(WalletService, 'writeMemo').mockResolvedValue({
      txHash: 'tx123',
      explorerUrl: 'https://explorer.solana.com/tx/tx123',
    } as any);
    getDbSpy = spyOn(migrations, 'getDb').mockReturnValue({ prepare: prepareMock } as any);
  });

  afterEach(() => {
    getStateSpy.mockRestore();
    setStateSpy.mockRestore();
    setPendingAmendmentSpy.mockRestore();
    getActiveSpy.mockRestore();
    amendAndActivateSpy.mockRestore();
    writeMemoSpy.mockRestore();
    getDbSpy.mockRestore();
  });

  describe('validate()', () => {
    it('returns true for amendment intent with "rule" keyword', async () => {
      const msg = { content: { text: 'amend rule 2 to require 3% yield delta' } } as any;
      expect(await AmendConstitution.validate(makeTelegramRuntime(), msg, undefined as any)).toBe(true);
    });

    it('returns false when onboardingState is not complete', async () => {
      state = makeState({ onboardingState: 'pending' });
      const msg = { content: { text: 'amend rule 2' } } as any;
      expect(await AmendConstitution.validate(makeTelegramRuntime(), msg, undefined as any)).toBe(false);
    });

    it('returns false when constitutionVersion is 0', async () => {
      state = makeState({ constitutionVersion: 0 });
      const msg = { content: { text: 'amend rule 2' } } as any;
      expect(await AmendConstitution.validate(makeTelegramRuntime(), msg, undefined as any)).toBe(false);
    });

    it('returns false for non-amendment text', async () => {
      const msg = { content: { text: 'what is my balance?' } } as any;
      expect(await AmendConstitution.validate(makeTelegramRuntime(), msg, undefined as any)).toBe(false);
    });

    it('returns false for amendment text without "rule" keyword', async () => {
      const msg = { content: { text: 'change my strategy to more conservative' } } as any;
      expect(await AmendConstitution.validate(makeTelegramRuntime(), msg, undefined as any)).toBe(false);
    });

    it('returns false for slash commands', async () => {
      const msg = { content: { text: '/constitution' } } as any;
      expect(await AmendConstitution.validate(makeTelegramRuntime(), msg, undefined as any)).toBe(false);
    });
  });

  describe('handler()', () => {
    it('sends ⏳ Thinking... before Qwen call', async () => {
      const callback = mock(async () => {});
      const msg = { content: { text: 'amend rule 2 to require 3%' } } as any;
      await AmendConstitution.handler(makeTelegramRuntime(), msg, undefined as any, undefined, callback);
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining('⏳ Thinking...'),
      }));
    });

    it('calls setPendingAmendment with correct ruleId', async () => {
      const msg = { content: { text: 'amend rule 2 to require 3%' } } as any;
      await AmendConstitution.handler(makeTelegramRuntime(), msg, undefined as any, undefined, undefined);
      expect(setPendingAmendmentSpy).toHaveBeenCalledWith(
        expect.objectContaining({ ruleId: 2 }),
      );
    });

    it('sends the invalid rule-id fallback through Telegram when callback is absent', async () => {
      const runtime = makeTelegramRuntime(async () => 'not a number');
      const msg = { content: { text: 'amend rule x' } } as any;

      await AmendConstitution.handler(runtime, msg, undefined as any, undefined, undefined);

      expect(runtime._sentMessages.at(-1)?.text).toContain('Could you reference one of your rules');
    });

    it('sends the invalid rule JSON fallback through Telegram when callback is absent', async () => {
      const runtime = makeTelegramRuntime(async (_type: unknown, opts: { prompt: string }) => {
        if (opts.prompt.includes('Which rule number')) return '2';
        return 'not valid json at all';
      });
      const msg = { content: { text: 'amend rule 2 to something' } } as any;

      await AmendConstitution.handler(runtime, msg, undefined as any, undefined, undefined);

      expect(runtime._sentMessages.at(-1)?.text).toContain("I couldn't parse the amendment");
    });
  });
});

describe('HandleAmendmentResponse', () => {
  const mockAmendment = {
    ruleId: 2,
    oldRule: mockRules[1],
    newRule: { ...mockRules[1], description: 'Only rotate if yield delta exceeds 3%', condition: { ...mockRules[1].condition, value: 3 } },
    constitutionId: 1,
    currentVersion: 1,
    allRules: [...mockRules],
  };

  let state: any;
  let prepareMock: ReturnType<typeof mock>;
  let getStateSpy: ReturnType<typeof spyOn>;
  let setStateSpy: ReturnType<typeof spyOn>;
  let setPendingAmendmentSpy: ReturnType<typeof spyOn>;
  let amendAndActivateSpy: ReturnType<typeof spyOn>;
  let writeMemoSpy: ReturnType<typeof spyOn>;
  let getDbSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    state = makeState();
    prepareMock = mock(() => ({
      run: mock(() => {}),
      get: mock(() => null),
      all: mock(() => []),
    }));

    getStateSpy = spyOn(AgentStateService, 'getState').mockImplementation(() => ({ ...state }));
    setStateSpy = spyOn(AgentStateService, 'setState').mockImplementation(async (update: Record<string, unknown>) => {
      state = { ...state, ...update };
    });
    setPendingAmendmentSpy = spyOn(AgentStateService, 'setPendingAmendment').mockImplementation((amendment: unknown) => {
      state = { ...state, pendingAmendment: amendment };
    });
    amendAndActivateSpy = spyOn(ConstitutionService, 'amendAndActivate').mockReturnValue(2);
    writeMemoSpy = spyOn(WalletService, 'writeMemo').mockResolvedValue({
      txHash: 'tx123',
      explorerUrl: 'https://explorer.solana.com/tx/tx123',
    } as any);
    getDbSpy = spyOn(migrations, 'getDb').mockReturnValue({ prepare: prepareMock } as any);
  });

  afterEach(() => {
    getStateSpy.mockRestore();
    setStateSpy.mockRestore();
    setPendingAmendmentSpy.mockRestore();
    amendAndActivateSpy.mockRestore();
    writeMemoSpy.mockRestore();
    getDbSpy.mockRestore();
  });

  describe('validate()', () => {
    it('returns true for amendment_approve with pending amendment', async () => {
      state = makeState({ pendingAmendment: mockAmendment });
      const msg = { content: { text: 'amendment_approve' } } as any;
      expect(await HandleAmendmentResponse.validate(makeTelegramRuntime(), msg, undefined as any)).toBe(true);
    });

    it('returns true for amendment_reject with pending amendment', async () => {
      state = makeState({ pendingAmendment: mockAmendment });
      const msg = { content: { text: 'amendment_reject' } } as any;
      expect(await HandleAmendmentResponse.validate(makeTelegramRuntime(), msg, undefined as any)).toBe(true);
    });

    it('returns false when no pending amendment exists', async () => {
      const msg = { content: { text: 'amendment_approve' } } as any;
      expect(await HandleAmendmentResponse.validate(makeTelegramRuntime(), msg, undefined as any)).toBe(false);
    });

    it('returns false for unrelated text', async () => {
      const msg = { content: { text: 'approve_proposal' } } as any;
      expect(await HandleAmendmentResponse.validate(makeTelegramRuntime(), msg, undefined as any)).toBe(false);
    });
  });

  describe('handler() — approve', () => {
    it('calls amendAndActivate and updates constitutionVersion', async () => {
      state = makeState({ pendingAmendment: mockAmendment });
      const msg = { content: { text: 'amendment_approve' } } as any;
      await HandleAmendmentResponse.handler(makeTelegramRuntime(), msg, undefined as any, undefined, undefined);
      expect(amendAndActivateSpy).toHaveBeenCalledWith(
        expect.anything(), 1, 1, mockAmendment.allRules,
      );
      expect(setStateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ constitutionVersion: 2 }),
        expect.anything(),
      );
    });

    it('clears pending amendment regardless of outcome', async () => {
      state = makeState({ pendingAmendment: mockAmendment });
      const msg = { content: { text: 'amendment_approve' } } as any;
      await HandleAmendmentResponse.handler(makeTelegramRuntime(), msg, undefined as any, undefined, undefined);
      expect(setPendingAmendmentSpy).toHaveBeenCalledWith(undefined);
    });

    it('sends approval confirmation through Telegram when callback is absent', async () => {
      state = makeState({ pendingAmendment: mockAmendment });
      const runtime = makeTelegramRuntime();
      const msg = { content: { text: 'amendment_approve' } } as any;

      await HandleAmendmentResponse.handler(runtime, msg, undefined as any, undefined, undefined);

      expect(runtime._sentMessages.at(-1)?.text).toContain('Amendment approved');
      expect(runtime._sentMessages.at(-1)?.text).toContain('Constitution version: 2');
    });
  });

  describe('handler() — reject', () => {
    it('inserts into rejected_amendments on rejection', async () => {
      state = makeState({ pendingAmendment: mockAmendment });
      const runMock = mock(() => {});
      prepareMock.mockReturnValue({ run: runMock, get: mock(() => null), all: mock(() => []) } as any);
      const msg = { content: { text: 'amendment_reject' } } as any;
      const callback = mock(async () => {});
      await HandleAmendmentResponse.handler(makeTelegramRuntime(), msg, undefined as any, undefined, callback);
      expect(runMock).toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining('rejected'),
      }));
    });

    it('sends rejection acknowledgement through Telegram when callback is absent', async () => {
      state = makeState({ pendingAmendment: mockAmendment });
      const runtime = makeTelegramRuntime();
      const msg = { content: { text: 'amendment_reject' } } as any;

      await HandleAmendmentResponse.handler(runtime, msg, undefined as any, undefined, undefined);

      expect(runtime._sentMessages.at(-1)?.text).toContain('Amendment rejected');
    });
  });
});
