import type { Evaluator } from '@elizaos/core';

// Stub — full implementation in Story 5.1
export const CrisisTriggerEvaluator: Evaluator = {
  name: 'CRISIS_TRIGGER',
  description: 'Detects crisis conditions and triggers execution freeze.',
  similes: [],
  validate: async () => false,
  handler: async () => {},
  examples: [],
};
