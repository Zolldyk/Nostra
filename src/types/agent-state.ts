export interface AgentState {
  mode: 'paper' | 'live';
  trustLadder: 'advisor' | 'executor';
  crisisStatus: 'active' | 'frozen' | 'resolving';
  constitutionVersion: number;
  accuracyScore: number;        // 0–100
  suggestionsSampled: number;   // sample size for accuracy calculation
  updatedAt: string;            // ISO 8601 timestamp
}
