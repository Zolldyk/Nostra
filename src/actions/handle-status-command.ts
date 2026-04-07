import type { Action, ActionResult, IAgentRuntime, Memory } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';

const ONBOARDING_REDIRECT = "You haven't set up your constitution yet. Send `/start` to begin — it only takes a conversation.";

export const HandleStatusCommand: Action = {
  name: 'HANDLE_STATUS_COMMAND',
  description: 'Handle /status Telegram command — display current agent state summary.',
  similes: ['STATUS', 'AGENT_STATUS'],
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    try {
      const text = message.content?.text ?? '';
      return text.trim().toLowerCase().startsWith('/status');
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

    const modeLabel = state.mode === 'paper' ? 'Paper Treasury' : 'Live';
    const ladderLabel = state.trustLadder === 'advisor' ? 'Advisor' : 'Executor';

    const text = [
      'Nostra — Agent Status',
      '',
      `Mode: ${modeLabel}`,
      `Trust Ladder: ${ladderLabel}`,
      `Constitution: v${state.constitutionVersion}`,
      `Accuracy Score: ${state.accuracyScore}%`,
      `Suggestions Sampled: ${state.suggestionsSampled}`,
    ].join('\n');

    if (callback) {
      await callback({ text, actions: [], source: 'nostra' });
    }
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: '/status', source: 'telegram' },
      },
      {
        name: 'Nostra',
        content: {
          text: 'Nostra — Agent Status',
          actions: ['HANDLE_STATUS_COMMAND'],
          source: 'nostra',
        },
      },
    ],
  ],
};
