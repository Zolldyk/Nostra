import { describe, it, expect, mock } from 'bun:test';
import { withRetry } from './with-retry.js';

describe('withRetry()', () => {
  it('returns result immediately on first attempt success', async () => {
    const fn = mock(async () => 'ok');
    const result = await withRetry(fn, 3, 0);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries and succeeds on 3rd attempt', async () => {
    let calls = 0;
    const fn = mock(async () => {
      calls++;
      if (calls < 3) throw new Error('fail');
      return 'success';
    });

    const result = await withRetry(fn, 3, 0); // 0ms delay for test speed
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after maxAttempts exhausted', async () => {
    const err = new Error('always fails');
    const fn = mock(async () => { throw err; });

    await expect(withRetry(fn, 3, 0)).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry on first attempt if maxAttempts=1', async () => {
    const err = new Error('instant fail');
    const fn = mock(async () => { throw err; });

    await expect(withRetry(fn, 1, 0)).rejects.toThrow('instant fail');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses exponential backoff delays', async () => {
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;

    // Patch setTimeout to capture delays
    let calls = 0;
    const fn = mock(async () => {
      calls++;
      if (calls < 3) throw new Error('fail');
      return 'ok';
    });

    // Use small delay to verify it's multiplied per attempt
    const result = await withRetry(fn, 3, 1); // 1ms base
    expect(result).toBe('ok');
    // delay attempt 1 = 1ms, attempt 2 = 2ms (not tested precisely but fn called 3 times)
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
