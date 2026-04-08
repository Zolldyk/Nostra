import type { Provider, ProviderResult } from '@elizaos/core';
import { withRetry } from '../utils/with-retry.js';
import { WalletService } from '../services/wallet-service.js';
import { buildMemoText } from '../actions/log-decision-on-chain.js';

const PROTOCOL_LABELS = {
  kamino: 'Kamino',
  marginfi: 'Marginfi',
  drift: 'Drift',
} as const;

type ProtocolName = keyof typeof PROTOCOL_LABELS;

async function fetchKaminoApy(): Promise<number> {
  return withRetry(async () => {
    const res = await fetch('https://api.kamino.finance/v2/lending/rates', {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Kamino HTTP ${res.status}`);
    const data = await res.json() as { apy?: number; data?: Array<{ apy?: number }> };
    if (Array.isArray(data)) {
      const arr = data as Array<{ apy?: number }>;
      return arr[0]?.apy ?? 0;
    }
    if (Array.isArray(data.data)) {
      return data.data[0]?.apy ?? 0;
    }
    return data.apy ?? 0;
  }, 3, 5000);
}

async function fetchMarginfiApy(): Promise<number> {
  return withRetry(async () => {
    const res = await fetch('https://api.marginfi.com/v1/banks', {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Marginfi HTTP ${res.status}`);
    const data = await res.json() as { data?: Array<{ lendingRate?: number }>; lendingRate?: number };
    if (Array.isArray(data)) {
      const arr = data as Array<{ lendingRate?: number }>;
      return arr[0]?.lendingRate ?? 0;
    }
    if (Array.isArray(data.data)) {
      return data.data[0]?.lendingRate ?? 0;
    }
    return data.lendingRate ?? 0;
  }, 3, 5000);
}

async function fetchDriftApy(): Promise<number> {
  return withRetry(async () => {
    const res = await fetch(
      'https://drift-public.s3.eu-west-1.amazonaws.com/drift-protocol-market-data.json',
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) throw new Error(`Drift HTTP ${res.status}`);
    const data = await res.json() as { apy?: number; depositRate?: number; marketData?: Array<{ depositRate?: number }> };
    if (Array.isArray(data)) {
      const arr = data as Array<{ apy?: number; depositRate?: number }>;
      return arr[0]?.apy ?? arr[0]?.depositRate ?? 0;
    }
    if (Array.isArray(data.marketData)) {
      return data.marketData[0]?.depositRate ?? 0;
    }
    return data.apy ?? data.depositRate ?? 0;
  }, 3, 5000);
}

async function writeUnavailableMemo(protocol: ProtocolName): Promise<void> {
  const memo = buildMemoText({
    actionDescription: `No action taken. ${PROTOCOL_LABELS[protocol]} API unavailable.`,
    ruleReference: 'Rule #0',
    complianceStatus: 'Constitutional compliance: N/A.',
  });
  await WalletService.writeMemo(memo);
}

export const YieldRatesProvider: Provider = {
  name: 'YIELD_RATES',
  description: 'Provides current DeFi yield rates for Kamino, Marginfi, and Drift.',
  get: async (_runtime, _message, _state): Promise<ProviderResult> => {
    const results: Record<string, number | null> = {};
    const errors: ProtocolName[] = [];

    const fetchers: Array<[ProtocolName, () => Promise<number>]> = [
      ['kamino', fetchKaminoApy],
      ['marginfi', fetchMarginfiApy],
      ['drift', fetchDriftApy],
    ];

    for (const [name, fetcher] of fetchers) {
      try {
        results[name] = await fetcher();
      } catch (err) {
        results[name] = null;
        errors.push(name);
        try {
          await writeUnavailableMemo(name);
        } catch {
          // memo write failure must not crash provider
        }
      }
    }

    const fmt = (v: number | null) => (v !== null ? `${v.toFixed(2)}%` : 'N/A');
    const text = `☀️ Yield Landscape\nKamino: ${fmt(results['kamino'])} APY\nMarginfi: ${fmt(results['marginfi'])} APY\nDrift: ${fmt(results['drift'])} APY`;

    return {
      text,
      values: {
        kamino_apy: results['kamino'] ?? 0,
        marginfi_apy: results['marginfi'] ?? 0,
        drift_apy: results['drift'] ?? 0,
        failed_protocols: errors,
        errorMessage: errors.length > 0 ? `Yield API unavailable: ${errors.join(', ')}` : '',
        error_message: errors.length > 0 ? `Yield API unavailable: ${errors.join(', ')}` : '',
      },
      data: { raw: results },
    };
  },
};
