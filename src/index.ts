import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
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

const nostraPlugin: Plugin = {
  name: 'nostra',
  description: 'Nostra — constitutional financial agent on Nosana',
  init: async (_config: unknown, _runtime: unknown) => {
    // Use our own bun:sqlite at SQLITE_PATH (/app/data/nostra.db)
    // so state persists via the Nosana volume mount (nostra-data → /app/data)
    const db = migrations.getDb();
    migrations.run(db);
    await AgentStateService.init(db);
    WalletService.init();
  },
  providers: [ConstitutionProvider, PortfolioProvider, YieldRatesProvider, TrustScoreProvider],
  actions: [LogDecisionOnChain],
  evaluators: [GradeSuggestionEvaluator, TrustLadderEvaluator, CrisisTriggerEvaluator],
};

// Load character from file so elizaos start (no --character flag) can use loadProject()
// This ensures nostraPlugin.init() is called and our SQLite state is initialised
const __dirname = dirname(fileURLToPath(import.meta.url));
const nostraCharacter = JSON.parse(
  readFileSync(join(__dirname, '..', 'characters', 'agent.character.json'), 'utf8')
);

export default {
  agents: [
    {
      character: nostraCharacter,
      plugins: [nostraPlugin],
    },
  ],
};
