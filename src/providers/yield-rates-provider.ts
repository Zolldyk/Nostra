import type { Provider, ProviderResult } from '@elizaos/core';

// Stub — full implementation in Story 3.1
export const YieldRatesProvider: Provider = {
  name: 'YIELD_RATES',
  description: 'Provides current DeFi yield rates for monitored protocols.',
  get: async (): Promise<ProviderResult> => ({
    text: 'Yield rates not yet available.',
    values: {},
    data: {},
  }),
};
