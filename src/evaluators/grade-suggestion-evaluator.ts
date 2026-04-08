import type { Evaluator, IAgentRuntime, Memory } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';
import { prependPaperPrefix } from '../utils/paper-prefix.js';
import { recomputeTrustLadder } from './trust-ladder-evaluator.js';
import * as migrations from '../db/migrations.js';

interface PendingRow {
  id: number;
  suggestion_id: string;
}

export const GradeSuggestionEvaluator: Evaluator = {
  name: 'GRADE_SUGGESTION',
  description: 'Records ✅/❌ grading from Bedtime Report and updates Trust Ladder accuracy.',
  similes: [],
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = (message.content?.text ?? '').trim();
    return text === 'grade_good' || text === 'grade_bad';
  },
  handler: async (runtime: IAgentRuntime, message: Memory): Promise<void> => {
    const text = (message.content?.text ?? '').trim();
    const isGood = text === 'grade_good';

    const db = migrations.getDb();

    // Find most recent pending suggestion
    const pending = db.prepare(
      `SELECT id, suggestion_id FROM trust_ladder_log WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1`
    ).get() as PendingRow | undefined;

    if (!pending) {
      // No pending suggestion — grade was tapped with no pending entry; silently ignore
      return;
    }

    // Record grade: user_grade=1 for ✅, user_grade=0 for ❌
    db.prepare(
      `UPDATE trust_ladder_log SET user_grade = ?, status = 'graded' WHERE id = ?`
    ).run(isGood ? 1 : 0, pending.id);

    // Recompute accuracy + check promotion threshold
    await recomputeTrustLadder(runtime);

    // Send confirmation
    const state = AgentStateService.getState();
    const chatId = state.telegramChatId;
    if (!chatId) return;

    const gradeLabel = isGood ? '✅' : '❌';
    const promotionNote = state.promotionPending
      ? '\n\n🏆 You have reached the 80% accuracy threshold. More to follow...'
      : '';

    await runtime.sendMessageToTarget(
      { source: 'telegram', roomId: message.roomId ?? chatId },
      {
        text: prependPaperPrefix(
          `${gradeLabel} Grade recorded.\nAccuracy: ${state.accuracyScore.toFixed(1)}% across ${state.suggestionsSampled} suggestion${state.suggestionsSampled !== 1 ? 's' : ''}.${promotionNote}`
        ),
        actions: [],
        source: 'nostra',
      },
    );
  },
  examples: [],
};
