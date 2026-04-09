import type { Action, ActionResult, IAgentRuntime, Memory } from '@elizaos/core';
import { ModelType } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';
import { prependLivePrefix } from '../utils/live-prefix.js';
import * as migrations from '../db/migrations.js';

const THINKING_TEXT = '⏳ Thinking...';
const MIN_WORDS = 200;
const MAX_WORDS = 350;

function buildPromotionPrompt(accuracyScore: number, suggestionsSampled: number): string {
  return `You are Nostra, a constitutional financial agent. Write a Trust Ladder promotion message for a user who has just earned Executor Mode.

Requirements:
- 200–350 words
- Open with 🏆 on the first line
- Ceremonial and warm — unmistakably different from routine messages
- Explicitly name the accuracy score: ${accuracyScore.toFixed(1)}% across ${suggestionsSampled} suggestions
- Convey that this was earned, not given — the user's constitutional discipline built this
- End by instructing them to fund a Solana wallet and send the wallet address when ready
- NO bullet points — flowing prose only
- Do NOT use ✈️ anywhere

Tone: earned achievement, gravity, warmth — like a mentor marking a rite of passage.`;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).length;
}

export const DeliverExecutorPromotion: Action = {
  name: 'DELIVER_EXECUTOR_PROMOTION',
  description: 'Deliver the ceremonial 🏆 Executor Mode promotion message when the 80% Trust Ladder threshold is crossed.',
  similes: ['EXECUTOR_PROMOTION', 'TRUST_LADDER_PROMOTION', 'PROMOTION_MESSAGE'],
  validate: async (_runtime: IAgentRuntime, _message: Memory): Promise<boolean> => {
    try {
      const state = AgentStateService.getState();
      return state.promotionPending === true && state.trustLadder === 'advisor';
    } catch {
      return false;
    }
  },
  handler: async (runtime: IAgentRuntime, message: Memory, _state, _options, callback): Promise<ActionResult | void | undefined> => {
    const db = migrations.getDb();
    const agentState = AgentStateService.getState();
    const chatId = agentState.telegramChatId;

    // Send thinking indicator before Qwen call (UX-DR11, NFR18)
    if (callback) {
      await callback({ text: THINKING_TEXT, actions: [], source: 'nostra' });
    } else if (chatId) {
      await runtime.sendMessageToTarget(
        { source: 'telegram', roomId: message.roomId ?? chatId },
        { text: THINKING_TEXT, actions: [], source: 'nostra' },
      );
    }

    let promotionBody: string;
    try {
      promotionBody = await (runtime as any).useModel(ModelType.TEXT_LARGE, {
        prompt: buildPromotionPrompt(agentState.accuracyScore, agentState.suggestionsSampled),
        temperature: 0.6,
      }) as string;

      const wordCount = countWords(promotionBody);
      if (wordCount < MIN_WORDS || wordCount > MAX_WORDS) {
        throw new Error(`Promotion message out of bounds: ${wordCount} words`);
      }
    } catch {
      // Fallback: static ceremonial message — never silent skip
      promotionBody = `🏆 You have crossed the threshold.\n\nAfter ${agentState.suggestionsSampled} graded suggestions, your accuracy stands at ${agentState.accuracyScore.toFixed(1)}%. That number was built decision by decision, constitution rule by constitution rule. It was not given — it was earned.\n\nEvery time you graded a suggestion, you were teaching me what your values look like in practice. The constitution you wrote was abstract until the market tested it. Now we have evidence: your constitutional discipline produces better outcomes than intuition alone.\n\nThis is what Executor Mode means. I no longer suggest and wait. When a constitutional threshold is met and the compliance gate passes, I act. Real assets, real transactions, permanent on-chain record. The 🔐 prefix will replace ✈️ from this moment forward.\n\nThe weight of this is intentional. You should feel the difference between simulation and live execution. The Lamport Conscience — every transaction permanently written to Solana — is your audit trail and your protection.\n\nWhen you are ready, fund a Solana wallet with the assets you want me to manage and send me the wallet address. I will confirm the connection and we will begin.\n\nI am ready when you are.`;
    }

    const fullMessage = prependLivePrefix(promotionBody);

    if (callback) {
      await callback({ text: fullMessage, actions: ['DELIVER_EXECUTOR_PROMOTION'], source: 'nostra' });
    } else if (chatId) {
      await runtime.sendMessageToTarget(
        { source: 'telegram', roomId: message.roomId ?? chatId },
        { text: fullMessage, actions: ['DELIVER_EXECUTOR_PROMOTION'], source: 'nostra' },
      );
    }

    // Switch trustLadder to executor — user's message is the acknowledgment trigger (AC1)
    await AgentStateService.setState({ trustLadder: 'executor' }, db);

    return { success: true, data: { trustLadder: 'executor' } };
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'what now?', source: 'telegram' },
      },
      {
        name: 'Nostra',
        content: {
          text: '🔐 LIVE TREASURY\n\n🏆 You have crossed the threshold...',
          actions: ['DELIVER_EXECUTOR_PROMOTION'],
          source: 'nostra',
        },
      },
    ],
  ],
};
