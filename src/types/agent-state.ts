import type { ConstitutionRule } from './constitution.js';

export interface CrisisOption {
  label: string;       // e.g., "A — Hold positions until rules amended"
  tradeoff: string;    // plain-English risk/values explanation in message body
}

export interface PendingCrisisVote {
  violationSummary: string;
  crisisEpisodeId: number;  // DB id of the crisis_episodes row (written at briefing time)
  options: {
    a: CrisisOption;
    b: CrisisOption;
    c: CrisisOption;
  };
}

export interface PendingAmendment {
  ruleId: number;               // 1-indexed rule id being amended
  oldRule: ConstitutionRule;    // original rule
  newRule: ConstitutionRule;    // proposed replacement
  constitutionId: number;       // DB id of the currently active constitution row
  currentVersion: number;       // version number of the currently active constitution
  allRules: ConstitutionRule[]; // full updated ruleset (old rules with amendment applied)
}

export interface PendingProposal {
  protocol: string;
  proposedApy: number;
  timestamp: string;
  ruleRef: string;         // e.g. "Rule #3" — used verbatim in Lamport memo
  ruleIndex: number;       // 1-indexed rule id (matches ConstitutionRule.id)
  actionDescription: string; // plain-English action for memo Line 1 + buildMemoText()
}

export interface AgentState {
  mode: 'paper' | 'live';
  trustLadder: 'advisor' | 'executor';
  crisisStatus: 'active' | 'frozen' | 'resolving';
  constitutionVersion: number;
  accuracyScore: number;        // 0–100
  suggestionsSampled: number;   // sample size for accuracy calculation
  onboardingState: 'pending' | 'disclaimer_delivered' | 'socratic_in_progress' | 'beliefs_confirmed' | 'complete';
  referralSource?: string;
  promotionPending?: boolean;   // Set by TrustLadderEvaluator when 80% threshold crossed; cleared after Story 4.2 promotion
  telegramChatId?: string;      // Persisted on first /start — used by polling loop for proactive messages
  pendingProposal?: PendingProposal; // In-memory only — dedupe across polling ticks, never persisted
  pendingAmendment?: PendingAmendment; // In-memory only — never persisted to SQLite
  pendingCrisisVote?: PendingCrisisVote;  // In-memory only — never persisted to SQLite
  updatedAt: string;            // ISO 8601 timestamp
}
