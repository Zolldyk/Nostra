import type { Action, ActionResult, IAgentRuntime, Memory } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';

const ONBOARDING_REDIRECT = "You haven't set up your constitution yet. Send `/start` to begin — it only takes a conversation.";

export const HandlePauseCommand: Action = {
  name: 'HANDLE_PAUSE_COMMAND',
  description: 'Handle /pause Telegram command — acknowledge pause request and explain Paper Treasury mode.',
  similes: ['PAUSE', 'PAUSE_AGENT'],
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    try {
      const text = message.content?.text ?? '';
      return text.trim().toLowerCase().startsWith('/pause');
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

    // Paper Treasury mode: all actions are already simulated — no live execution to pause
    // When mode === 'live', this will trigger an execution freeze (future story)
    const text = state.mode === 'live'
      ? 'Pause acknowledged. Live execution freeze is not yet implemented — it will be available in a future update.'
      : 'Pause noted. You are currently in Paper Treasury mode — all actions are simulated and no live transactions are being executed. There is nothing to pause. Your constitution and agent state remain unchanged.';

    if (callback) {
      await callback({ text, actions: [], source: 'nostra' });
    }
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: '/pause', source: 'telegram' },
      },
      {
        name: 'Nostra',
        content: {
          text: 'Pause noted.',
          actions: ['HANDLE_PAUSE_COMMAND'],
          source: 'nostra',
        },
      },
    ],
  ],
};
