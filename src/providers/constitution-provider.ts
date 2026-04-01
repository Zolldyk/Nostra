import type { Provider, ProviderResult } from '@elizaos/core';

// Stub — full implementation in Story 2.3
export const ConstitutionProvider: Provider = {
  name: 'CONSTITUTION',
  description: 'Provides the active financial constitution rules to the agent.',
  get: async (): Promise<ProviderResult> => ({
    text: 'Constitution not yet configured.',
    values: {},
    data: {},
  }),
};
