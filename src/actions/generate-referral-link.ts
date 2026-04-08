import type { Action, ActionResult, IAgentRuntime, Memory } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';

const REFERRAL_KEYWORDS = ['referral', 'invite', 'refer a friend', 'share nostra', 'referral link', 'bring a friend'];

export const GenerateReferralLinkAction: Action = {
  name: 'GENERATE_REFERRAL_LINK',
  description: 'Generate a Telegram deep link so the user can refer a friend to Nostra.',
  similes: ['REFERRAL', 'INVITE_FRIEND', 'SHARE_NOSTRA', 'REFERRAL_LINK'],
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    try {
      const text = (message.content?.text ?? '').toLowerCase();
      if (text.startsWith('/')) return false;
      const state = AgentStateService.getState();
      if (state.constitutionVersion === 0) return false;
      return REFERRAL_KEYWORDS.some(kw => text.includes(kw));
    } catch {
      return false;
    }
  },
  handler: async (_runtime: IAgentRuntime, message: Memory, _state, _options, callback): Promise<ActionResult | void | undefined> => {
    const botUsername = process.env.TELEGRAM_BOT_USERNAME ?? 'NostraBot';
    const userId = (message as Memory & { userId?: string }).userId ?? 'unknown';
    const link = `t.me/${botUsername}?start=ref_${userId}`;

    if (callback) {
      await callback({
        text: `Here's your Paper Treasury referral link.\n\nPaper Treasury — simulate first, commit when ready.\n${link}\n\nAnyone who taps this opens Nostra directly and starts their Socratic onboarding immediately. No account. No wallet. Just a conversation.`,
        actions: [],
        source: 'nostra',
      });
    }
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Can I get a referral link?' },
      },
      {
        name: 'Nostra',
        content: {
          text: "Here's your Paper Treasury referral link.",
          actions: ['GENERATE_REFERRAL_LINK'],
          source: 'nostra',
        },
      },
    ],
  ],
};
