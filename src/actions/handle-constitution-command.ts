import type { Action, ActionResult, IAgentRuntime, Memory } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';
import * as migrations from '../db/migrations.js';

const ONBOARDING_REDIRECT = "You haven't set up your constitution yet. Send `/start` to begin — it only takes a conversation.";

export const HandleConstitutionCommand: Action = {
  name: 'HANDLE_CONSTITUTION_COMMAND',
  description: 'Handle /constitution Telegram command — display active constitution rules.',
  similes: ['CONSTITUTION', 'SHOW_CONSTITUTION'],
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    try {
      const text = message.content?.text ?? '';
      return text.trim().toLowerCase().startsWith('/constitution');
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

    if (state.constitutionVersion === 0) {
      if (callback) {
        await callback({ text: "No active constitution found. Send `/start` to create one.", actions: [], source: 'nostra' });
      }
      return;
    }

    const db = migrations.getDb();
    const constitutionRow = db.prepare(
      'SELECT id, version, created_at FROM constitution WHERE active = 1 ORDER BY version DESC LIMIT 1'
    ).get() as Record<string, unknown> | undefined;

    if (!constitutionRow) {
      if (callback) {
        await callback({ text: "No active constitution found. Send `/start` to create one.", actions: [], source: 'nostra' });
      }
      return;
    }

    const constitutionId = constitutionRow['id'] as number;
    const rules = db.prepare(
      'SELECT rule_index, rule_json FROM constitution_rules WHERE constitution_id = ? ORDER BY rule_index ASC'
    ).all(constitutionId) as Array<Record<string, unknown>>;

    const ruleLines = (rules as Array<Record<string, unknown>>).map((r) => {
      const ruleData = JSON.parse(r['rule_json'] as string) as { description?: string; text?: string };
      const desc = ruleData.description ?? ruleData.text ?? String(r['rule_json']);
      return `\`Rule #${(r['rule_index'] as number) + 1}: ${desc}\``;
    });

    const createdAt = new Date(constitutionRow['created_at'] as string).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
    });

    const text = `Your Constitution — Version ${constitutionRow['version']}\n\n${ruleLines.join('\n')}\n\nAdopted ${createdAt}. Constitutional compliance: 100%.`;

    if (callback) {
      await callback({ text, actions: [], source: 'nostra' });
    }
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: '/constitution', source: 'telegram' },
      },
      {
        name: 'Nostra',
        content: {
          text: 'Your Constitution — Version 1',
          actions: ['HANDLE_CONSTITUTION_COMMAND'],
          source: 'nostra',
        },
      },
    ],
  ],
};
