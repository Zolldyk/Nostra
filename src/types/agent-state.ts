export interface AgentState {
  mode: 'paper' | 'live';
  trustLadder: 'advisor' | 'executor';
  crisisStatus: 'active' | 'frozen' | 'resolving';
  constitutionVersion: number;
  accuracyScore: number;        // 0–100
  suggestionsSampled: number;   // sample size for accuracy calculation
  onboardingState: 'pending' | 'disclaimer_delivered' | 'socratic_in_progress' | 'beliefs_confirmed' | 'complete';
  referralSource?: string;
  updatedAt: string;            // ISO 8601 timestamp
}
