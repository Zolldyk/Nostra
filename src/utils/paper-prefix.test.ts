import { describe, expect, it } from 'bun:test';
import { PAPER_PREFIX, isPaperPrefixed, prependPaperPrefix } from './paper-prefix.js';

describe('paper-prefix utilities', () => {
  it('prependPaperPrefix() places ✈️ PAPER TREASURY SIMULATION on line 1', () => {
    const result = prependPaperPrefix('some message');
    expect(result.split('\n')[0]).toBe(PAPER_PREFIX);
  });

  it('prependPaperPrefix() preserves original text after double newline', () => {
    const original = 'original content here';
    const result = prependPaperPrefix(original);
    expect(result).toContain('\n\n' + original);
  });

  it('isPaperPrefixed() returns true for prefixed text and false otherwise', () => {
    expect(isPaperPrefixed(prependPaperPrefix('hello'))).toBe(true);
    expect(isPaperPrefixed('hello')).toBe(false);
    expect(isPaperPrefixed('')).toBe(false);
  });
});
