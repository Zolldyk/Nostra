import type { Provider, ProviderResult } from '@elizaos/core';

// Stub — full implementation in Story 3.1
export const PortfolioProvider: Provider = {
  name: 'PORTFOLIO',
  description: 'Provides current portfolio balances and positions.',
  get: async (): Promise<ProviderResult> => ({
    text: 'Portfolio data not yet available.',
    values: {},
    data: {},
  }),
};
