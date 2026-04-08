import type { Action, ActionResult, IAgentRuntime, Memory } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';
import * as migrations from '../db/migrations.js';

const DISCLAIMER = `Welcome. I'm Nostra — The Sovereign Kid.

Before we go any further, here's what I am and am not:

I am not a financial advisor. Nothing I say is financial advice. I don't know your circumstances, your risk tolerance, or your life situation — and even after we talk, I never will, not completely.

What I am: a constitutional agent. You write the rules. I follow them, prove I followed them on Solana's blockchain, and tell you when I disagree. Your rules govern me — not the other way around.

Your money. Your rules. Your responsibility. I'm here to help you execute your own decisions with precision and transparency.

If you're ready to write your first constitution, say so and we'll begin. No wallet needed. No account. Just a conversation.`;

export const HandleStartCommand: Action = {
  name: 'HANDLE_START_COMMAND',
  description: 'Handle /start Telegram command — welcome message and disclaimer.',
  similes: ['START', 'ONBOARD'],
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    try {
      const text = message.content?.text ?? '';
      return text.trim().toLowerCase().startsWith('/start');
    } catch {
      return false;
    }
  },
  handler: async (_runtime: IAgentRuntime, message: Memory, _state, _options, callback): Promise<ActionResult | void | undefined> => {
    const db = migrations.getDb();
    const text = (message.content?.text ?? '').trim();
    const state = AgentStateService.getState();
    const telegramChatId = message.roomId ? String(message.roomId) : undefined;

    // Parse referral parameter: "/start ref_12345678"
    const refMatch = text.match(/^\/start\s+ref_(\S+)/i);
    const referrerId = refMatch?.[1] ?? null;

    if (state.constitutionVersion > 0) {
      if (!state.telegramChatId && telegramChatId) {
        await AgentStateService.setState({ telegramChatId }, db);
      }
      // AC3: existing constitution — greet and summarise, do NOT restart onboarding, ignore referral param
      if (callback) {
        await callback({
          text: `Welcome back.\n\nYour Constitution v${state.constitutionVersion} is active. You're in ${state.mode} mode with a Trust Ladder accuracy of ${state.accuracyScore}%.\n\nWhat would you like to do? You can use /status for a full summary, /constitution to review your rules, or just talk.`,
          actions: [],
          source: 'nostra',
        });
      }
    } else {
      // new user — persist referral source if present
      if (referrerId) {
        await AgentStateService.setState({ referralSource: referrerId }, db);
      }
      // AC1: send disclaimer and record state
      if (callback) {
        await callback({
          text: DISCLAIMER,
          actions: [],
          source: 'nostra',
        });
      }
      await AgentStateService.setState({ onboardingState: 'disclaimer_delivered' }, db);
      // Persist chat ID for polling loop proactive messages — idempotent (skip if already set)
      const currentState = AgentStateService.getState();
      if (!currentState.telegramChatId && telegramChatId) {
        await AgentStateService.setState({ telegramChatId }, db);
      }
    }
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: '/start', source: 'telegram' },
      },
      {
        name: 'Nostra',
        content: {
          text: "Welcome. I'm Nostra — The Sovereign Kid.",
          actions: ['HANDLE_START_COMMAND'],
          source: 'nostra',
        },
      },
    ],
  ],
};
