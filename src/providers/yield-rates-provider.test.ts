import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { WalletService } from '../services/wallet-service.js';
import { YieldRatesProvider } from './yield-rates-provider.js';

const VALID_KAMINO_RESPONSE = { apy: 5.12 };
const VALID_MARGINFI_RESPONSE = { lendingRate: 3.75 };
const VALID_DRIFT_RESPONSE = { apy: 4.20 };

function makeOkResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('YieldRatesProvider', () => {
  let writeMemoSpy: ReturnType<typeof spyOn>;
  let originalSetTimeout: typeof globalThis.setTimeout;

  beforeEach(() => {
    writeMemoSpy = spyOn(WalletService, 'writeMemo').mockResolvedValue({
      txHash: 'mock-tx',
      explorerUrl: 'https://explorer.solana.com/tx/mock-tx',
    });
    // Override setTimeout to use 0ms delay so withRetry doesn't actually wait 5s between attempts
    originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: TimerHandler, _delay?: number, ...args: unknown[]) =>
      originalSetTimeout(fn as TimerHandler, 0, ...args)) as typeof globalThis.setTimeout;
  });

  afterEach(() => {
    writeMemoSpy.mockRestore();
    globalThis.setTimeout = originalSetTimeout;
  });

  it('get() returns yield landscape text with all three APYs', async () => {
    const globalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('kamino')) return makeOkResponse(VALID_KAMINO_RESPONSE);
      if (urlStr.includes('marginfi')) return makeOkResponse(VALID_MARGINFI_RESPONSE);
      if (urlStr.includes('drift')) return makeOkResponse(VALID_DRIFT_RESPONSE);
      return makeOkResponse({});
    }) as typeof globalThis.fetch;

    const result = await YieldRatesProvider.get!(null as never, null as never, null as never);

    globalThis.fetch = globalFetch;

    expect(result.text).toContain('Kamino:');
    expect(result.text).toContain('Marginfi:');
    expect(result.text).toContain('Drift:');
    expect(typeof result.values?.['kamino_apy']).toBe('number');
    expect(typeof result.values?.['marginfi_apy']).toBe('number');
    expect(typeof result.values?.['drift_apy']).toBe('number');
    expect(result.values?.['failed_protocols']).toEqual([]);
  });

  it('get() marks protocol as N/A and sets failed_protocols when Kamino throws', async () => {
    const globalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('kamino')) throw new Error('Kamino network error');
      if (urlStr.includes('marginfi')) return makeOkResponse(VALID_MARGINFI_RESPONSE);
      if (urlStr.includes('drift')) return makeOkResponse(VALID_DRIFT_RESPONSE);
      return makeOkResponse({});
    }) as typeof globalThis.fetch;

    const result = await YieldRatesProvider.get!(null as never, null as never, null as never);

    globalThis.fetch = globalFetch;

    expect(result.values?.['failed_protocols']).toContain('kamino');
    expect(result.values?.['errorMessage']).toBe('Yield API unavailable: kamino');
    expect(result.text).toContain('N/A');
  });

  it('get() calls WalletService.writeMemo on protocol failure', async () => {
    const globalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('kamino')) throw new Error('Kamino down');
      if (urlStr.includes('marginfi')) return makeOkResponse(VALID_MARGINFI_RESPONSE);
      if (urlStr.includes('drift')) return makeOkResponse(VALID_DRIFT_RESPONSE);
      return makeOkResponse({});
    }) as typeof globalThis.fetch;

    await YieldRatesProvider.get!(null as never, null as never, null as never);

    globalThis.fetch = globalFetch;

    expect(writeMemoSpy).toHaveBeenCalledWith(expect.stringMatching(
      /^\d{4}-\d{2}-\d{2}T.* — No action taken\. Kamino API unavailable\. Rule #0\. Constitutional compliance: N\/A\.$/,
    ));
  });

  it('get() does not throw when all three protocols fail', async () => {
    const globalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      throw new Error('All APIs down');
    }) as typeof globalThis.fetch;

    const result = await YieldRatesProvider.get!(null as never, null as never, null as never);

    globalThis.fetch = globalFetch;

    expect(result).toBeDefined();
    expect(result.values?.['failed_protocols']).toHaveLength(3);
    expect(result.text).toContain('N/A');
  });

  it('get() returns partial data when only Drift fails', async () => {
    const globalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes('kamino')) return makeOkResponse(VALID_KAMINO_RESPONSE);
      if (urlStr.includes('marginfi')) return makeOkResponse(VALID_MARGINFI_RESPONSE);
      if (urlStr.includes('drift')) throw new Error('Drift down');
      return makeOkResponse({});
    }) as typeof globalThis.fetch;

    const result = await YieldRatesProvider.get!(null as never, null as never, null as never);

    globalThis.fetch = globalFetch;

    expect(typeof result.values?.['kamino_apy']).toBe('number');
    expect(typeof result.values?.['marginfi_apy']).toBe('number');
    expect(result.values?.['drift_apy']).toBe(0);
    expect(result.values?.['failed_protocols']).toEqual(['drift']);
    expect(result.values?.['errorMessage']).toBe('Yield API unavailable: drift');
  });
});
