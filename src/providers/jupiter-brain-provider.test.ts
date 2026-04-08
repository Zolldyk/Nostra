import { describe, it, expect, mock, afterEach, beforeEach, spyOn } from 'bun:test';
import { WalletService } from '../services/wallet-service.js';
import { JupiterBrainProvider } from './jupiter-brain-provider.js';

const VALID_QUOTE_RESPONSE = {
  inputMint: 'So11111111111111111111111111111111111111112',
  outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  inAmount: '1000000000',
  outAmount: '23456789',
  priceImpactPct: '0.01',
  routePlan: [{ swapInfo: { ammKey: 'test' } }],
};

function makeMessage(content: Record<string, unknown>) {
  return { content } as never;
}

describe('JupiterBrainProvider', () => {
  let writeMemoSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    writeMemoSpy = spyOn(WalletService, 'writeMemo').mockResolvedValue({
      txHash: 'mock-tx',
      explorerUrl: 'https://explorer.solana.com/tx/mock-tx',
    });
  });

  afterEach(() => {
    writeMemoSpy.mockRestore();
  });

  it('get() returns route data on successful Jupiter call', async () => {
    const globalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(VALID_QUOTE_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as typeof globalThis.fetch;

    const msg = makeMessage({
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amount: 1000000000,
    });

    const result = await JupiterBrainProvider.get!(null as never, msg, null as never);

    globalThis.fetch = globalFetch;

    expect(result.values?.['available']).toBe(true);
    expect(typeof result.values?.['inAmount']).toBe('number');
    expect(typeof result.values?.['outAmount']).toBe('number');
    expect(typeof result.values?.['priceImpactPct']).toBe('number');
    expect(result.values?.['routePlan']).toBeDefined();
  });

  it('get() returns available=false on 10s timeout (AbortError)', async () => {
    const globalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_url: string | URL | Request, opts?: RequestInit) => {
      // Simulate the abort signal firing
      if (opts?.signal) {
        const abortError = new DOMException('The operation was aborted.', 'AbortError');
        throw abortError;
      }
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch;

    const msg = makeMessage({
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amount: 1000000000,
    });

    const result = await JupiterBrainProvider.get!(null as never, msg, null as never);

    globalThis.fetch = globalFetch;

    expect(result.values?.['available']).toBe(false);
    expect(result.values?.['errorMessage']).toBe('Jupiter routing unavailable — no action taken');
    expect(result.values?.['error_message']).toBe('Jupiter routing unavailable');
    expect(writeMemoSpy).toHaveBeenCalledWith(expect.stringMatching(
      /^\d{4}-\d{2}-\d{2}T.* — No action taken\. Jupiter routing unavailable\. Rule #0\. Constitutional compliance: N\/A\.$/,
    ));
  });

  it('get() returns available=false on non-OK HTTP response', async () => {
    const globalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      new Response('Too Many Requests', { status: 429 }),
    ) as typeof globalThis.fetch;

    const msg = makeMessage({
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amount: 1000000000,
    });

    const result = await JupiterBrainProvider.get!(null as never, msg, null as never);

    globalThis.fetch = globalFetch;

    expect(result.values?.['available']).toBe(false);
    expect(result.values?.['errorMessage']).toBe('Jupiter routing unavailable — no action taken');
    expect(writeMemoSpy).toHaveBeenCalled();
  });

  it('get() returns no-query result when inputMint/outputMint missing — no fetch called', async () => {
    const fetchSpy = mock(async () => new Response('{}', { status: 200 })) as typeof globalThis.fetch;
    const globalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy;

    const result = await JupiterBrainProvider.get!(null as never, makeMessage({}), null as never);

    globalThis.fetch = globalFetch;

    expect(result.values?.['available']).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
