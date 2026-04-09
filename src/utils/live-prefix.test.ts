import { describe, expect, test } from 'bun:test';
import { prependLivePrefix, isLivePrefixed, LIVE_PREFIX } from './live-prefix.js';

describe('live-prefix', () => {
  test('prependLivePrefix adds LIVE_PREFIX on first line', () => {
    const result = prependLivePrefix('Hello');
    expect(result).toBe(`${LIVE_PREFIX}\n\nHello`);
  });

  test('isLivePrefixed returns true for prefixed text', () => {
    expect(isLivePrefixed(prependLivePrefix('anything'))).toBe(true);
  });

  test('isLivePrefixed returns false for paper-prefixed text', () => {
    expect(isLivePrefixed('✈️ PAPER TREASURY SIMULATION\n\nfoo')).toBe(false);
  });

  test('isLivePrefixed returns false for plain text', () => {
    expect(isLivePrefixed('plain message')).toBe(false);
  });
});
