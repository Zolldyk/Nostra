import type { Plugin } from '@elizaos/core';
import * as migrations from './db/migrations.js';
import { AgentStateService } from './services/agent-state-service.js';
import { WalletService } from './services/wallet-service.js';
import { LogDecisionOnChain } from './actions/log-decision-on-chain.js';
import { ConstitutionProvider } from './providers/constitution-provider.js';
import { PortfolioProvider } from './providers/portfolio-provider.js';
import { YieldRatesProvider } from './providers/yield-rates-provider.js';
import { TrustScoreProvider } from './providers/trust-score-provider.js';
import { GradeSuggestionEvaluator } from './evaluators/grade-suggestion-evaluator.js';
import { TrustLadderEvaluator } from './evaluators/trust-ladder-evaluator.js';
import { CrisisTriggerEvaluator } from './evaluators/crisis-trigger-evaluator.js';

export const nostraPlugin: Plugin = {
  name: 'nostra',
  description: 'Nostra — constitutional financial agent on Nosana',
  init: async (_config: unknown, runtime: unknown) => {
    const rt = runtime as { db: Parameters<typeof AgentStateService.init>[0] };
    migrations.run(rt.db);
    await AgentStateService.init(rt.db);
    WalletService.init();
  },
  providers: [ConstitutionProvider, PortfolioProvider, YieldRatesProvider, TrustScoreProvider],
  actions: [LogDecisionOnChain],
  evaluators: [GradeSuggestionEvaluator, TrustLadderEvaluator, CrisisTriggerEvaluator],
};

export default nostraPlugin;
