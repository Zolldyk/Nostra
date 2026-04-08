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
  updatedAt: string;            // ISO 8601 timestamp
}
