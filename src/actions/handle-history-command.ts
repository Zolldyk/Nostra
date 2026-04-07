import type { Action, ActionResult, IAgentRuntime, Memory } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';
import * as migrations from '../db/migrations.js';

const ONBOARDING_REDIRECT = "You haven't set up your constitution yet. Send `/start` to begin — it only takes a conversation.";

export const HandleHistoryCommand: Action = {
  name: 'HANDLE_HISTORY_COMMAND',
  description: 'Handle /history Telegram command — display recent on-chain memo history.',
  similes: ['HISTORY', 'ON_CHAIN_HISTORY'],
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    try {
      const text = message.content?.text ?? '';
      return text.trim().toLowerCase().startsWith('/history');
    } catch {
      return false;
    }
  },
  handler: async (_runtime: IAgentRuntime, _message: Memory, _state, _options, callback): Promise<ActionResult | void | undefined> => {
    const state = AgentStateService.getState();

    if (state.onboardingState !== 'complete') {
      if (callback) {
        await callback({ text: ONBOARDING_REDIRECT, actions: [], source: 'nostra' });
      }
      return;
    }

    const db = migrations.getDb();
    const memos = db.prepare(
      'SELECT tx_hash, memo_text, explorer_url, created_at FROM on_chain_memos ORDER BY created_at DESC LIMIT 5'
    ).all() as Array<Record<string, unknown>>;

    if (!memos || memos.length === 0) {
      if (callback) {
        await callback({ text: 'No on-chain history yet. Decisions recorded on Solana will appear here.', actions: [], source: 'nostra' });
      }
      return;
    }

    const lines = memos.map((m) => {
      const iso = new Date(m['created_at'] as string).toISOString();
      return `\`${iso}\` — ${m['memo_text']}\n${m['explorer_url']}`;
    });

    const text = `Recent On-Chain History\n\n${lines.join('\n\n')}`;

    if (callback) {
      await callback({ text, actions: [], source: 'nostra' });
    }
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: '/history', source: 'telegram' },
      },
      {
        name: 'Nostra',
        content: {
          text: 'Recent On-Chain History',
          actions: ['HANDLE_HISTORY_COMMAND'],
          source: 'nostra',
        },
      },
    ],
  ],
};
