import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as migrations from '../db/migrations.js';
import { AgentStateService } from '../services/agent-state-service.js';
import { FileDissent } from './file-dissent.js';

describe('FileDissent', () => {
  let state: any;
  let prepareMock: ReturnType<typeof mock>;
  let getStateSpy: ReturnType<typeof spyOn>;
  let getDbSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    state = { mode: 'live', trustLadder: 'executor', telegramChatId: 'chat-1' };
    prepareMock = mock(() => ({
      run: mock(() => {}),
      get: mock(() => ({ max_num: 0 })),
      all: mock(() => []),
    }));

    getStateSpy = spyOn(AgentStateService, 'getState').mockImplementation(() => ({ ...state }));
    getDbSpy = spyOn(migrations, 'getDb').mockReturnValue({ prepare: prepareMock } as any);
  });

  afterEach(() => {
    getStateSpy.mockRestore();
    getDbSpy.mockRestore();
  });

  describe('validate()', () => {
    it('returns true for override message in live executor mode', async () => {
      const message = { content: { text: 'override — execute anyway' } } as any;
      const result = await FileDissent.validate({} as any, message, undefined as any);
      expect(result).toBe(true);
    });

    it('returns false when mode is paper', async () => {
      state = { ...state, mode: 'paper' };
      const message = { content: { text: 'override' } } as any;
      const result = await FileDissent.validate({} as any, message, undefined as any);
      expect(result).toBe(false);
    });

    it('returns false when trustLadder is advisor', async () => {
      state = { ...state, trustLadder: 'advisor' };
      const message = { content: { text: 'override' } } as any;
      const result = await FileDissent.validate({} as any, message, undefined as any);
      expect(result).toBe(false);
    });

    it('returns false for regular non-override messages', async () => {
      const message = { content: { text: 'what is my balance?' } } as any;
      const result = await FileDissent.validate({} as any, message, undefined as any);
      expect(result).toBe(false);
    });

    it('detects "do it anyway" override intent', async () => {
      const message = { content: { text: 'do it anyway' } } as any;
      const result = await FileDissent.validate({} as any, message, undefined as any);
      expect(result).toBe(true);
    });
  });

  describe('handler()', () => {
    const mockRuntime = {
      useModel: mock(async () =>
        'REASONING: The constitution Rule #3 recommends holding during high volatility.\nEXPECTED_OUTCOME: Override may result in a suboptimal entry point.\nRULE_REF: Rule #3 — yield delta must exceed 2%',
      ),
    } as any;

    it('sends ⏳ Thinking... callback before Qwen call', async () => {
      const callback = mock(async () => {});
      const message = { content: { text: 'override' } } as any;
      await FileDissent.handler(mockRuntime, message, undefined as any, undefined, callback);
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining('⏳ Thinking...'),
      }));
    });

    it('persists dissent to pending_dissents with status pending', async () => {
      const runMock = mock(() => {});
      prepareMock.mockReturnValue({ run: runMock, get: mock(() => ({ max_num: 2 })) } as any);
      const message = { content: { text: 'override' } } as any;
      await FileDissent.handler(mockRuntime, message, undefined as any, undefined, undefined);
      expect(runMock).toHaveBeenCalled();
    });

    it('uses fallback reasoning when Qwen fails', async () => {
      const failRuntime = { useModel: mock(async () => { throw new Error('Qwen down'); }) } as any;
      const runMock = mock(() => {});
      prepareMock.mockReturnValue({ run: runMock, get: mock(() => ({ max_num: 0 })) } as any);
      const message = { content: { text: 'override' } } as any;
      await expect(
        FileDissent.handler(failRuntime, message, undefined as any, undefined, undefined),
      ).resolves.toMatchObject({ success: true });
      expect(runMock).toHaveBeenCalledWith(
        1,
        expect.stringContaining('unavailable'),
        expect.any(String),
        null,
        expect.any(String),
      );
    });
  });
});
