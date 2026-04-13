import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { fetchMonthlyComputeCost } from './nosana-compute-service.js';

describe('fetchMonthlyComputeCost', () => {
  const originalApiKey = process.env.NOSANA_API_KEY;

  beforeEach(() => {
    process.env.NOSANA_API_KEY = 'test-api-key';
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.NOSANA_API_KEY;
    } else {
      process.env.NOSANA_API_KEY = originalApiKey;
    }
  });

  it('throws when NOSANA_API_KEY is not set', async () => {
    delete process.env.NOSANA_API_KEY;

    await expect(fetchMonthlyComputeCost()).rejects.toThrow('NOSANA_API_KEY not configured');
  });

  it('throws the explicit integration-not-available error until a real Nosana cost source is wired', async () => {
    await expect(fetchMonthlyComputeCost()).rejects.toThrow('Nosana compute cost integration not available yet');
  });
});
