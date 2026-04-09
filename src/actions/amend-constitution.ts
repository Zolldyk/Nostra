import type { Action, ActionResult, IAgentRuntime, Memory } from '@elizaos/core';
import { ModelType } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';
import { ConstitutionService } from '../services/constitution-service.js';
import { WalletService } from '../services/wallet-service.js';
import { buildMemoText } from './log-decision-on-chain.js';
import { prependLivePrefix } from '../utils/live-prefix.js';
import { prependPaperPrefix } from '../utils/paper-prefix.js';
import type { ConstitutionRule } from '../types/constitution.js';
import type { PendingAmendment } from '../types/agent-state.js';
import * as migrations from '../db/migrations.js';

// ─── Types ───────────────────────────────────────────────────────────────────

type RuntimeWithClients = IAgentRuntime & {
  clients?: Array<{
    type?: string;
    bot?: {
      telegram?: {
        sendMessage: (chatId: string, text: string, options?: Record<string, unknown>) => Promise<unknown>;
      };
    };
  }>;
};

// ─── Constants ────────────────────────────────────────────────────────────────

// Match amendment intent that also references a rule
const AMEND_REGEX = /\b(amend|change|update|revise|modify)\b.*\brule\b|\brule\b.*\b(amend|change|update|revise|modify)\b/i;

const THINKING_TEXT = '⏳ Thinking...';
const VALID_RULE_TYPES = new Set(['allocation_limit', 'yield_threshold', 'action_gate', 'compute_budget', 'custom']);
const VALID_OPERATORS = new Set(['<', '>', '<=', '>=', '==', '!=']);
const VALID_ACTIONS = new Set(['block', 'alert', 'require_approval', 'reduce_frequency']);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function sendTelegramMessage(
  rt: IAgentRuntime,
  chatId: string,
  text: string,
  options?: Record<string, unknown>,
): Promise<void> {
  const runtimeWithClients = rt as RuntimeWithClients;
  const telegramClient = (runtimeWithClients.clients ?? []).find(c => c.type === 'telegram');
  if (telegramClient?.bot?.telegram) {
    await telegramClient.bot.telegram.sendMessage(chatId, text, options);
  }
}

function modePrefix(text: string): string {
  const state = AgentStateService.getState();
  return state.mode === 'live' ? prependLivePrefix(text) : prependPaperPrefix(text);
}

async function sendUserMessage(
  runtime: IAgentRuntime,
  callback: ((payload: { text: string; actions: string[]; source: string }) => Promise<unknown>) | undefined,
  chatId: string | undefined,
  text: string,
  actionName: string,
  options?: Record<string, unknown>,
): Promise<void> {
  if (callback) {
    await callback({ text: modePrefix(text), actions: [actionName], source: 'nostra' });
    return;
  }
  if (chatId) {
    await sendTelegramMessage(runtime, chatId, modePrefix(text), options);
  }
}

function isConstitutionRule(value: unknown): value is ConstitutionRule {
  if (!value || typeof value !== 'object') return false;
  const rule = value as Partial<ConstitutionRule>;
  const condition = rule.condition as Partial<ConstitutionRule['condition']> | undefined;
  return (
    typeof rule.description === 'string' &&
    VALID_RULE_TYPES.has(rule.type as string) &&
    typeof condition?.metric === 'string' &&
    VALID_OPERATORS.has(condition.operator as string) &&
    typeof condition.value === 'number' &&
    Number.isFinite(condition.value) &&
    typeof condition.unit === 'string' &&
    VALID_ACTIONS.has(rule.action as string)
  );
}

function buildRuleIdPrompt(rules: ConstitutionRule[], userText: string): string {
  const ruleList = rules.map(r => `Rule #${r.id}: ${r.description}`).join('\n');
  return (
    `The user wants to amend their active constitution.\n\n` +
    `Current rules:\n${ruleList}\n\n` +
    `User's amendment request: "${userText}"\n\n` +
    `Which rule number does the user want to change? Respond with JUST the number (e.g. "3") — no other text.`
  );
}

function buildRuleRewritePrompt(rules: ConstitutionRule[], ruleId: number, userText: string): string {
  const existing = rules.find(r => r.id === ruleId);
  return (
    `Rewrite Rule #${ruleId} of a financial constitution based on the user's change request.\n\n` +
    `Current Rule #${ruleId}: ${existing?.description ?? '[not found]'}\n\n` +
    `User's change request: "${userText}"\n\n` +
    `Output a single JSON rule object ONLY — no other text:\n` +
    `{\n` +
    `  "id": ${ruleId},\n` +
    `  "type": "<allocation_limit | yield_threshold | action_gate | compute_budget | custom>",\n` +
    `  "description": "<plain English in user's own words>",\n` +
    `  "condition": { "metric": "...", "operator": "...", "value": 0, "unit": "..." },\n` +
    `  "action": "<block | alert | require_approval | reduce_frequency>"\n` +
    `}`
  );
}

function buildAmendmentDiffBlock(ruleId: number, oldRule: ConstitutionRule, newRule: ConstitutionRule): string {
  const fmtRule = (r: ConstitutionRule): string =>
    `description: "${r.description}"\ncondition: ${r.condition.metric} ${r.condition.operator} ${r.condition.value} ${r.condition.unit}\naction: ${r.action}`;

  return (
    `📝 Proposed Amendment\n\n` +
    `Rule #${ruleId}\n\n` +
    `BEFORE:\n\`\`\`\n${fmtRule(oldRule)}\n\`\`\`\n\n` +
    `AFTER:\n\`\`\`\n${fmtRule(newRule)}\n\`\`\``
  );
}

function buildAmendmentMemoText(ruleId: number, oldRule: ConstitutionRule, newRule: ConstitutionRule, newVersion: number): string {
  const diff = `Rule #${ruleId} amended: "${oldRule.description}" → "${newRule.description}"`;
  return buildMemoText({
    actionDescription: `AMEND_CONSTITUTION v${newVersion}: ${diff}`,
    ruleReference: `Rule #${ruleId}`,
    complianceStatus: 'Constitutional amendment approved. On-chain record: IMMUTABLE.',
  });
}

// ─── Action 1: AmendConstitution ─────────────────────────────────────────────

export const AmendConstitution: Action = {
  name: 'AMEND_CONSTITUTION',
  description: 'Parse a user amendment request, generate a PR-style diff for a specific constitution rule, and present Approve/Reject buttons.',
  similes: ['CHANGE_RULE', 'UPDATE_CONSTITUTION', 'MODIFY_RULE', 'REVISE_RULE'],
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    try {
      const text = (message.content?.text ?? '').trim();
      if (text.startsWith('/')) return false;
      const state = AgentStateService.getState();
      return (
        state.onboardingState === 'complete' &&
        state.constitutionVersion > 0 &&
        AMEND_REGEX.test(text)
      );
    } catch {
      return false;
    }
  },
  handler: async (runtime: IAgentRuntime, message: Memory, _state, _options, callback): Promise<ActionResult | void | undefined> => {
    const agentState = AgentStateService.getState();
    const chatId = agentState.telegramChatId;
    const userText = (message.content?.text ?? '').trim().slice(0, 500);

    // Send ⏳ Thinking... (UX-DR11, NFR18) — mode-aware prefix
    if (callback) {
      await callback({ text: modePrefix(THINKING_TEXT), actions: [], source: 'nostra' });
    } else if (chatId) {
      await sendTelegramMessage(runtime, chatId, modePrefix(THINKING_TEXT));
    }

    const db = migrations.getDb();
    const active = ConstitutionService.getActive(db);

    if (!active || active.rules.length === 0) {
      await sendUserMessage(
        runtime,
        callback,
        chatId,
        'No active constitution found. Send `/start` to create one.',
        'AMEND_CONSTITUTION',
      );
      return;
    }

    // Step 1: Identify which rule to amend (Qwen call 1 of 2)
    let ruleId: number;
    try {
      const ruleIdRaw = await (runtime as any).useModel(ModelType.TEXT_LARGE, {
        prompt: buildRuleIdPrompt(active.rules, userText),
        temperature: 0.2,
        maxTokens: 10,
      }) as string;
      ruleId = parseInt(ruleIdRaw.trim().replace(/[^0-9]/g, ''), 10);
      if (isNaN(ruleId) || ruleId < 1 || ruleId > active.rules.length) throw new Error('invalid rule id');
    } catch {
      // AC7: Fallback on failure — user-facing error, no crash
      await sendUserMessage(
        runtime,
        callback,
        chatId,
        "Could you reference one of your rules by number — for example, 'Change rule 2 to...'?",
        'AMEND_CONSTITUTION',
      );
      return;
    }

    const oldRule = active.rules.find(r => r.id === ruleId)!;

    // Step 2: Generate rewritten rule (Qwen call 2 of 2)
    if (callback) {
      await callback({ text: modePrefix(THINKING_TEXT), actions: [], source: 'nostra' });
    }
    let newRule: ConstitutionRule;
    try {
      const rawJson = await (runtime as any).useModel(ModelType.TEXT_LARGE, {
        prompt: buildRuleRewritePrompt(active.rules, ruleId, userText),
        temperature: 0.3,
        maxTokens: 300,
      }) as string;
      const jsonMatch = rawJson.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch?.[0] ?? rawJson) as unknown;
      if (!isConstitutionRule(parsed)) throw new Error('invalid rule schema');
      newRule = { ...parsed as ConstitutionRule, id: ruleId };
    } catch {
      // AC7: Fallback — never crash
      await sendUserMessage(
        runtime,
        callback,
        chatId,
        "I couldn't parse the amendment. Please describe the change more specifically.",
        'AMEND_CONSTITUTION',
      );
      return;
    }

    // Build full updated ruleset (all rules with amendment applied)
    const allRules = active.rules.map(r => r.id === ruleId ? newRule : r);

    // Store pending amendment in-memory (AC2)
    const pendingAmendment: PendingAmendment = {
      ruleId,
      oldRule,
      newRule,
      constitutionId: active.id,
      currentVersion: active.version,
      allRules,
    };
    AgentStateService.setPendingAmendment(pendingAmendment);

    // Build and send Amendment Diff Block with inline keyboard (FR6, UX-DR1)
    const diffBlock = buildAmendmentDiffBlock(ruleId, oldRule, newRule);
    const prefixedDiff = modePrefix(diffBlock);

    if (chatId) {
      await sendTelegramMessage(runtime, chatId, prefixedDiff, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: 'amendment_approve' },
            { text: '❌ Reject', callback_data: 'amendment_reject' },
          ]],
        },
      });
    } else if (callback) {
      // Fallback: send without inline keyboard (non-Telegram runtime)
      await callback({ text: prefixedDiff, actions: ['AMEND_CONSTITUTION'], source: 'nostra' });
    }

    return { success: true, data: { ruleId, oldDescription: oldRule.description, newDescription: newRule.description } };
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'amend rule 2 to cap SOL at 40% instead of 30%', source: 'telegram' },
      },
      {
        name: 'Nostra',
        content: {
          text: '📝 Proposed Amendment\n\nRule #2\n\nBEFORE:\n`description: "SOL concentration must not exceed 30%"...',
          actions: ['AMEND_CONSTITUTION'],
          source: 'nostra',
        },
      },
    ],
  ],
};

// ─── Action 2: HandleAmendmentResponse ───────────────────────────────────────

export const HandleAmendmentResponse: Action = {
  name: 'HANDLE_AMENDMENT_RESPONSE',
  description: 'Process user approval or rejection of a proposed constitution amendment.',
  similes: ['APPROVE_AMENDMENT', 'REJECT_AMENDMENT'],
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    try {
      const text = (message.content?.text ?? '').trim();
      if (text !== 'amendment_approve' && text !== 'amendment_reject') return false;
      // Only fire if there is actually a pending amendment
      const state = AgentStateService.getState();
      return state.pendingAmendment !== undefined;
    } catch {
      return false;
    }
  },
  handler: async (runtime: IAgentRuntime, message: Memory, _state, _options, callback): Promise<ActionResult | void | undefined> => {
    const text = (message.content?.text ?? '').trim();
    const isApprove = text === 'amendment_approve';
    const db = migrations.getDb();
    const agentState = AgentStateService.getState();
    const amendment = agentState.pendingAmendment;

    if (!amendment) {
      await sendUserMessage(
        runtime,
        callback,
        agentState.telegramChatId,
        'No pending amendment found — it may have already been decided.',
        'HANDLE_AMENDMENT_RESPONSE',
      );
      return;
    }

    // Clear pending amendment immediately to prevent double-fire
    AgentStateService.setPendingAmendment(undefined);

    if (isApprove) {
      // AC3: Activate new constitution version in DB (FR7)
      const newVersion = ConstitutionService.amendAndActivate(
        db,
        amendment.constitutionId,
        amendment.currentVersion,
        amendment.allRules,
      );

      // Update AgentStateService.constitutionVersion (FR7)
      await AgentStateService.setState({ constitutionVersion: newVersion }, db);

      // Write on-chain amendment memo with before/after diff (FR8, FR25)
      const memoText = buildAmendmentMemoText(amendment.ruleId, amendment.oldRule, amendment.newRule, newVersion);
      let explorerUrl = '';
      try {
        const memoResult = await WalletService.writeMemo(memoText);
        explorerUrl = memoResult.explorerUrl;
        try {
          db.prepare(
            `INSERT OR IGNORE INTO on_chain_memos (tx_hash, action_type, memo_text, explorer_url, status, created_at)
             VALUES (?, 'AMEND_CONSTITUTION', ?, ?, 'confirmed', ?)`,
          ).run(memoResult.txHash, memoText, explorerUrl, new Date().toISOString());
        } catch {
          // DB write in success path — never block user notification
        }
      } catch {
        // Memo write failure must never block the state update (amendment is already active in DB)
      }

      const confirmText =
        `✅ Amendment approved.\n\n` +
        `Rule #${amendment.ruleId} updated. Constitution version: ${newVersion}.\n\n` +
        (explorerUrl ? `On-chain record: ${explorerUrl}` : 'On-chain memo pending — will be written on next sync.');

      await sendUserMessage(
        runtime,
        callback,
        agentState.telegramChatId,
        confirmText,
        'HANDLE_AMENDMENT_RESPONSE',
      );

      return { success: true, data: { newVersion, ruleId: amendment.ruleId } };

    } else {
      // AC4: Rejected — store for Bedtime Report (not as dissent)
      try {
        db.prepare(
          `INSERT INTO rejected_amendments (rule_id, old_description, new_description, status, created_at)
           VALUES (?, ?, ?, 'pending', ?)`,
        ).run(
          amendment.ruleId,
          amendment.oldRule.description,
          amendment.newRule.description,
          new Date().toISOString(),
        );
      } catch {
        // DB write failure in rejection path — log but never crash
      }

      const rejectText = `Amendment rejected. Rule #${amendment.ruleId} remains unchanged. I'll note this in tonight's Bedtime Report.`;
      await sendUserMessage(
        runtime,
        callback,
        agentState.telegramChatId,
        rejectText,
        'HANDLE_AMENDMENT_RESPONSE',
      );

      return { success: true, data: { rejected: true, ruleId: amendment.ruleId } };
    }
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'amendment_approve', source: 'telegram' },
      },
      {
        name: 'Nostra',
        content: {
          text: '✅ Amendment approved.\n\nRule #2 updated. Constitution version: 2.',
          actions: ['HANDLE_AMENDMENT_RESPONSE'],
          source: 'nostra',
        },
      },
    ],
  ],
};
