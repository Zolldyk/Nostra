import type { Action, ActionResult, IAgentRuntime, Memory } from '@elizaos/core';
import { ModelType } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';
import { prependLivePrefix } from '../utils/live-prefix.js';
import * as migrations from '../db/migrations.js';

// Override intent — user explicitly bypassing agent recommendation
const OVERRIDE_REGEX = /\b(override|ignore.*\brecommend|do it anyway|execute anyway|just do it|proceed anyway|regardless)\b/i;

const THINKING_TEXT = '⏳ Thinking...';
const FALLBACK_REASONING = 'I obeyed the override. Dissent reasoning unavailable — LLM call failed.';
const FALLBACK_OUTCOME = 'Outcome unknown — dissent draft failed.';

interface DissentDraft {
  reasoning: string;
  expectedOutcome: string;
  ruleRef: string | null;
}

function buildDissentPrompt(overrideText: string): string {
  return (
    `You are Nostra, a constitutional financial agent. A user has overridden your recommendation.\n\n` +
    `User override message: "${overrideText}"\n\n` +
    `Draft a written dissent for the record (60–120 words maximum). Requirements:\n` +
    `- Tone: respectful, collegial, professional — never accusatory\n` +
    `- Do NOT use phrases like "I must object", "I strongly disagree", or "this is a mistake"\n` +
    `- Structured as exactly 3 lines (label: content):\n` +
    `  REASONING: [why you recommended differently — one clear sentence]\n` +
    `  EXPECTED_OUTCOME: [what outcome you expect from this override — one sentence]\n` +
    `  RULE_REF: [cite a specific constitutional rule if relevant, or "none" if purely advisory]\n` +
    `- Each section is plain prose — no bullet points inside sections\n` +
    `- The dissent will appear in the next Bedtime Report — it is a permanent record`
  );
}

function parseDissentResponse(raw: string): DissentDraft {
  const reasoningMatch = raw.match(/REASONING:\s*(.+?)(?=\nEXPECTED_OUTCOME:|$)/is);
  const outcomeMatch = raw.match(/EXPECTED_OUTCOME:\s*(.+?)(?=\nRULE_REF:|$)/is);
  const ruleMatch = raw.match(/RULE_REF:\s*(.+)/i);

  const reasoning = reasoningMatch?.[1]?.trim() ?? FALLBACK_REASONING;
  const expectedOutcome = outcomeMatch?.[1]?.trim() ?? FALLBACK_OUTCOME;
  const ruleRaw = ruleMatch?.[1]?.trim() ?? '';
  const ruleRef = ruleRaw.toLowerCase() === 'none' || ruleRaw === '' ? null : ruleRaw;

  return { reasoning, expectedOutcome, ruleRef };
}

export const FileDissent: Action = {
  name: 'FILE_DISSENT',
  description: 'File a written dissent when the user overrides an agent recommendation. Stored silently and surfaced in the next Bedtime Report.',
  similes: ['OVERRIDE_DISSENT', 'RECORD_DISAGREEMENT', 'FILE_OVERRIDE'],
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    try {
      const state = AgentStateService.getState();
      if (state.mode !== 'live' || state.trustLadder !== 'executor') return false;
      const text = (message.content?.text ?? '').trim();
      return OVERRIDE_REGEX.test(text);
    } catch {
      return false;
    }
  },
  handler: async (runtime: IAgentRuntime, message: Memory, _state, _options, callback): Promise<ActionResult | void | undefined> => {
    const db = migrations.getDb();

    // Send thinking indicator before Qwen call (UX-DR11, NFR18)
    if (callback) {
      await callback({ text: prependLivePrefix(THINKING_TEXT), actions: [], source: 'nostra' });
    }

    const overrideText = (message.content?.text ?? '').trim().slice(0, 300); // cap for prompt safety

    // Get next dissent number
    const maxRow = db.prepare(`SELECT COALESCE(MAX(dissent_number), 0) AS max_num FROM pending_dissents`).get() as { max_num: number };
    const dissentNumber = maxRow.max_num + 1;

    let draft: DissentDraft;
    try {
      const raw = await (runtime as any).useModel(ModelType.TEXT_LARGE, {
        prompt: buildDissentPrompt(overrideText),
        temperature: 0.4,
      }) as string;
      draft = parseDissentResponse(raw);
    } catch {
      // AC6: Fallback — never crash, never silent skip (NFR19)
      draft = {
        reasoning: FALLBACK_REASONING,
        expectedOutcome: FALLBACK_OUTCOME,
        ruleRef: null,
      };
    }

    // Persist to pending_dissents (status = 'pending' — will be included in next Bedtime Report)
    db.prepare(
      `INSERT INTO pending_dissents (dissent_number, reasoning, expected_outcome, rule_ref, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    ).run(
      dissentNumber,
      draft.reasoning,
      draft.expectedOutcome,
      draft.ruleRef ?? null,
      new Date().toISOString(),
    );

    // No standalone user-facing dissent message — it appears in the next Bedtime Report (AC1, UX-DR7)
    // The callback above already sent ⏳ Thinking... which is sufficient

    return { success: true, data: { dissentNumber } };
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'override — execute the swap anyway', source: 'telegram' },
      },
      {
        name: 'Nostra',
        content: {
          text: '🔐 LIVE TREASURY\n\n⏳ Thinking...',
          actions: ['FILE_DISSENT'],
          source: 'nostra',
        },
      },
    ],
  ],
};
