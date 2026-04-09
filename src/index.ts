import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Plugin } from '@elizaos/core';
import * as migrations from './db/migrations.js';
import { AgentStateService } from './services/agent-state-service.js';
import { WalletService } from './services/wallet-service.js';
import { LogDecisionOnChain } from './actions/log-decision-on-chain.js';
import { HandleStartCommand } from './actions/handle-start-command.js';
import { HandleConstitutionCommand } from './actions/handle-constitution-command.js';
import { HandleStatusCommand } from './actions/handle-status-command.js';
import { HandleHistoryCommand } from './actions/handle-history-command.js';
import { HandlePauseCommand } from './actions/handle-pause-command.js';
import { SocraticOnboardingAction } from './actions/socratic-onboarding.js';
import { ParseConstitutionAction } from './actions/parse-constitution.js';
import { GenerateReferralLinkAction } from './actions/generate-referral-link.js';
import { HandleProposalResponse } from './actions/handle-proposal-response.js';
import { HandleWalletConnection } from './actions/handle-wallet-connection.js';
import { DeliverExecutorPromotion } from './actions/deliver-executor-promotion.js';
import { ExecuteRotation } from './actions/execute-rotation.js';
import { FileDissent } from './actions/file-dissent.js';
import { AmendConstitution, HandleAmendmentResponse } from './actions/amend-constitution.js';
import { withComplianceGate } from './gates/with-compliance-gate.js';
import { ConstitutionProvider } from './providers/constitution-provider.js';
import { PortfolioProvider, warmPortfolioCache } from './providers/portfolio-provider.js';
import { YieldRatesProvider } from './providers/yield-rates-provider.js';
import { JupiterBrainProvider } from './providers/jupiter-brain-provider.js';
import { TrustScoreProvider } from './providers/trust-score-provider.js';
import { GradeSuggestionEvaluator } from './evaluators/grade-suggestion-evaluator.js';
import { TrustLadderEvaluator } from './evaluators/trust-ladder-evaluator.js';
import { CrisisTriggerEvaluator } from './evaluators/crisis-trigger-evaluator.js';
import { startPollingLoop } from './scheduler/polling-loop.js';
import { startBriefingScheduler } from './scheduler/briefing-scheduler.js';

const nostraPlugin: Plugin = {
  name: 'nostra',
  description: 'Nostra — constitutional financial agent on Nosana',
  init: async (_config: unknown, _runtime: unknown) => {
    // Use our own bun:sqlite at SQLITE_PATH (/app/data/nostra.db)
    // so state persists via the Nosana volume mount (nostra-data → /app/data)
    const db = migrations.getDb();
    migrations.run(db);
    await AgentStateService.init(db);
    warmPortfolioCache();
    WalletService.init();
    // IAgentRuntime is available as _runtime — do NOT await (returns interval handle, not a Promise)
    startPollingLoop(_runtime);
    // Cron-based scheduled briefings — node-cron fires at wall-clock time (NFR5)
    startBriefingScheduler(_runtime);
  },
  providers: [ConstitutionProvider, PortfolioProvider, YieldRatesProvider, JupiterBrainProvider, TrustScoreProvider],
  actions: [
    HandleStartCommand,
    HandleConstitutionCommand,
    HandleStatusCommand,
    HandleHistoryCommand,
    HandlePauseCommand,
    SocraticOnboardingAction,
    ParseConstitutionAction,
    GenerateReferralLinkAction,
    LogDecisionOnChain,
    HandleProposalResponse,
    DeliverExecutorPromotion,
    HandleWalletConnection,
    withComplianceGate(ExecuteRotation),
    FileDissent,
    AmendConstitution,
    HandleAmendmentResponse,
  ],
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
