import type { Evaluator, IAgentRuntime } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';
import * as migrations from '../db/migrations.js';

const MIN_SAMPLE_FOR_PROMOTION = 5;

interface GradedRow {
  user_grade: number;
}

export async function recomputeTrustLadder(_runtime: IAgentRuntime): Promise<void> {
  const db = migrations.getDb();

  const gradedRows = db.prepare(
    `SELECT user_grade FROM trust_ladder_log WHERE status = 'graded'`
  ).all() as GradedRow[];

  const total = gradedRows.length;
  const correct = gradedRows.filter(r => r.user_grade === 1).length;
  const accuracyScore = total > 0 ? (correct / total) * 100 : 0;

  const update: Record<string, unknown> = {
    accuracyScore,
    suggestionsSampled: total,
  };

  // Threshold: >= 80% accuracy with at least MIN_SAMPLE_FOR_PROMOTION graded entries
  if (accuracyScore >= 80 && total >= MIN_SAMPLE_FOR_PROMOTION) {
    const state = AgentStateService.getState();
    if (!state.promotionPending) {
      update['promotionPending'] = true;
    }
  }

  await AgentStateService.setState(update as Parameters<typeof AgentStateService.setState>[0], migrations.getDb());
}

// ElizaOS Evaluator — runs passively; logic is invoked directly by GradeSuggestionEvaluator
export const TrustLadderEvaluator: Evaluator = {
  name: 'TRUST_LADDER',
  description: 'Recomputes Trust Ladder accuracy score and detects promotion threshold.',
  similes: [],
  validate: async () => false, // Not triggered by message routing — called directly
  handler: async (_runtime: IAgentRuntime) => {},
  examples: [],
};
