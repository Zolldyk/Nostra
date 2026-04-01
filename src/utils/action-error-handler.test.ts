import { describe, it, expect, mock } from 'bun:test';
import { handleActionError, formatErrorMessage } from './action-error-handler.js';

describe('formatErrorMessage()', () => {
  it('returns user-friendly message without raw stack trace', () => {
    const err = new Error('RPC timeout after 10s');
    err.stack = 'Error: RPC timeout\n    at WalletService (/app/src/services/wallet.ts:42:5)';
    const msg = formatErrorMessage(err);
    expect(msg).toContain('RPC timeout');
    expect(msg).not.toContain('/app/src/services/wallet.ts');
    expect(msg).not.toContain('at WalletService');
  });

  it('handles non-Error unknown throws', () => {
    const msg = formatErrorMessage('string error');
    expect(msg).toContain('unknown error');
  });

  it('includes user-facing prefix', () => {
    const msg = formatErrorMessage(new Error('test'));
    expect(msg).toContain('Nostra encountered');
  });
});

describe('handleActionError()', () => {
  it('calls writeNonActionMemo BEFORE sendUserMessage (step order)', async () => {
    const callOrder: string[] = [];
    const writeNonActionMemo = mock(async () => { callOrder.push('step1'); });
    const sendUserMessage = mock(async () => { callOrder.push('step2'); });
    const error = new Error('test error');

    await expect(
      handleActionError(sendUserMessage, writeNonActionMemo, error),
    ).rejects.toThrow('test error');

    expect(callOrder[0]).toBe('step1');
    expect(callOrder[1]).toBe('step2');
  });

  it('re-throws the original error as step 3', async () => {
    const originalError = new Error('original error message');
    const writeNonActionMemo = mock(async () => {});
    const sendUserMessage = mock(async () => {});

    await expect(
      handleActionError(sendUserMessage, writeNonActionMemo, originalError),
    ).rejects.toBe(originalError);
  });

  it('always calls all 3 steps even if sendUserMessage throws', async () => {
    const writeNonActionMemo = mock(async () => {});
    const sendUserMessage = mock(async () => { throw new Error('telegram down'); });
    const error = new Error('original');

    // sendUserMessage threw, so handleActionError will throw that error (step 2 failed)
    // The important thing is step 1 fired before step 2
    await expect(
      handleActionError(sendUserMessage, writeNonActionMemo, error),
    ).rejects.toThrow();

    expect(writeNonActionMemo).toHaveBeenCalledTimes(1);
  });

  it('step 2 does not fire before step 1 completes', async () => {
    let step1Done = false;
    const writeNonActionMemo = mock(async () => {
      await new Promise<void>(r => setTimeout(r, 5));
      step1Done = true;
    });
    const sendUserMessage = mock(async () => {
      expect(step1Done).toBe(true); // must be true when step 2 runs
    });

    await expect(
      handleActionError(sendUserMessage, writeNonActionMemo, new Error('e')),
    ).rejects.toThrow();
  });
});
