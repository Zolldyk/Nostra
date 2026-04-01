import type { Provider, ProviderResult } from '@elizaos/core';

// Stub — full implementation in Story 3.6
export const TrustScoreProvider: Provider = {
  name: 'TRUST_SCORE',
  description: 'Provides current trust ladder level and accuracy score.',
  get: async (): Promise<ProviderResult> => ({
    text: 'Trust score not yet available.',
    values: {},
    data: {},
  }),
};
