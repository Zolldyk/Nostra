import type { Action, ActionResult, HandlerCallback, IAgentRuntime, Memory } from '@elizaos/core';
import { ModelType } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';
import { ConstitutionService } from '../services/constitution-service.js';
import { OnboardingService } from '../services/onboarding-service.js';
import type { OnboardingTurn } from '../services/onboarding-service.js';
import * as migrations from '../db/migrations.js';
import type { ConstitutionRule } from '../types/constitution.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_COMPUTE_RULE: Omit<ConstitutionRule, 'id'> = {
  type: 'compute_budget',
  description: 'Monthly Nosana compute cost must not exceed 50 NOS tokens.',
  condition: {
    metric: 'compute_cost_nos',
    operator: '<=',
    value: 50,
    unit: 'nos_tokens',
  },
  action: 'alert',
};

const VALID_RULE_TYPES = new Set<ConstitutionRule['type']>([
  'allocation_limit',
  'yield_threshold',
  'action_gate',
  'compute_budget',
  'custom',
]);

const VALID_OPERATORS = new Set<ConstitutionRule['condition']['operator']>([
  '<',
  '>',
  '<=',
  '>=',
  '==',
  '!=',
]);

const VALID_ACTIONS = new Set<ConstitutionRule['action']>([
  'block',
  'alert',
  'require_approval',
  'reduce_frequency',
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractJson(text: string): string {
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) return arrayMatch[0];
  return text;
}

function isConstitutionRule(value: unknown): value is ConstitutionRule {
  if (!value || typeof value !== 'object') return false;

  const rule = value as Partial<ConstitutionRule>;
  const condition = rule.condition as Partial<ConstitutionRule['condition']> | undefined;

  return (
    typeof rule.description === 'string' &&
    VALID_RULE_TYPES.has(rule.type as ConstitutionRule['type']) &&
    typeof condition?.metric === 'string' &&
    VALID_OPERATORS.has(condition.operator as ConstitutionRule['condition']['operator']) &&
    typeof condition.value === 'number' &&
    Number.isFinite(condition.value) &&
    typeof condition.unit === 'string' &&
    VALID_ACTIONS.has(rule.action as ConstitutionRule['action'])
  );
}

// ─── Prompt Builders ─────────────────────────────────────────────────────────

function buildParsePrompt(beliefSummary: string, qaHistory: string): string {
  return `You are Nostra, a constitutional financial agent. The user has completed a Socratic interview and confirmed their financial beliefs.

Confirmed belief summary:
${beliefSummary}

Full Q&A conversation:
${qaHistory}

Parse these beliefs into structured constitutional rules. Output a JSON array ONLY — no other text.

Each rule must follow this exact schema:
{
  "id": <1-indexed integer>,
  "type": "<allocation_limit | yield_threshold | action_gate | compute_budget | custom>",
  "description": "<plain English, in the user's own words>",
  "condition": {
    "metric": "<e.g. sol_concentration, yield_delta, max_drawdown_pct>",
    "operator": "< | > | <= | >= | == | !=",
    "value": <number>,
    "unit": "<e.g. percent, apy_points, usd>"
  },
  "action": "<block | alert | require_approval | reduce_frequency>"
}

Rules:
- Generate 5–7 rules
- Use the user's own words verbatim in the description
- Choose the most specific metric and operator
- Use "custom" type if no other type fits
- Output valid JSON array only — no markdown, no explanation`;
}

function buildApprovalPrompt(userText: string): string {
  return `The user was shown their First Constitution and responded. Are they approving it or requesting a change?

User response: "${userText}"

Respond with EXACTLY "APPROVED" or "AMEND" — no other text.`;
}

function buildAmendmentRuleIdPrompt(rules: ConstitutionRule[], userText: string): string {
  const ruleList = rules.map(r => `Rule #${r.id}: ${r.description}`).join('\n');
  return `The user wants to amend their First Constitution.

Current rules:
${ruleList}

User's amendment request: "${userText}"

Which rule number does the user want to change? Respond with JUST the number (e.g. "3") — no other text.`;
}

function buildRuleRegenerationPrompt(
  rules: ConstitutionRule[],
  ruleId: number,
  userRequest: string,
): string {
  const existing = rules.find(r => r.id === ruleId);
  return `Rewrite Rule #${ruleId} of a financial constitution based on the user's change request.

Current Rule #${ruleId}: ${existing?.description ?? '[not found]'}

User's change request: "${userRequest}"

Output a single JSON rule object ONLY — no other text:
{
  "id": ${ruleId},
  "type": "<allocation_limit | yield_threshold | action_gate | compute_budget | custom>",
  "description": "<plain English in user's own words>",
  "condition": { "metric": "...", "operator": "...", "value": 0, "unit": "..." },
  "action": "<block | alert | require_approval | reduce_frequency>"
}`;
}

function buildRulesetContradictionPrompt(rules: ConstitutionRule[]): string {
  const ruleList = rules.map(r => `Rule #${r.id}: ${r.description}`).join('\n');
  return `Review these financial constitution rules for contradictions.

Rules:
${ruleList}

Do any rules contradict each other or make the ruleset mathematically impossible to satisfy?

Rules:
- If YES: respond with EXACTLY "CONTRADICTION: Rule #X and Rule #Y contradict because [reason]. Would you like to revise either one?"
- If NO: respond with exactly "OK"
- Respond with ONLY one of those two formats — no other text.`;
}

// ─── Display Builders ────────────────────────────────────────────────────────

function buildConstitutionDisplayText(rules: ConstitutionRule[]): string {
  const ruleLines = rules.map(r => `*Rule #${r.id}* \`${r.description}\``).join('\n');
  return `📜 *Your First Constitution*

You've answered the questions. These are the rules you've written — in your own words — that will govern your treasury.

${ruleLines}

These rules are yours. I will enforce every one before surfacing any proposal to you. Nothing moves without passing this constitution.

When you approve this draft, I will also append a default compute clause that caps monthly Nosana compute cost at 50 NOS tokens and alerts you if it is exceeded.

Before I make them active, I want to make sure every word is right.

Do these accurately reflect what you believe? You can ask me to change any drafted rule by number — for example, _"Change rule 3 to..."_ — or say *yes* to activate your First Constitution.`;
}

function buildActivationMessage(rules: ConstitutionRule[]): string {
  const ruleLines = rules.map(r => `*Rule #${r.id}* \`${r.description}\``).join('\n');
  return `✅ *Constitution Activated — Version 1*

Your First Constitution is now active. ${rules.length} rules are in effect — including the default compute clause at Rule #${rules.length}.

${ruleLines}

From this moment, I will validate every proposal against your constitution before surfacing it to you. No action reaches you without first passing these rules.

You are now in Paper Treasury mode. I'll monitor real yield data across Kamino, Marginfi, and Drift, and bring you constitution-compliant rotation proposals. You'll see exactly how your rules perform — safely, with simulated positions — before anything is ever live.

Send \`/constitution\` to review your rules at any time.
Send \`/status\` to check your treasury state.

Welcome to constitutional finance. Your rules. Your treasury.`;
}

// ─── Approval Handler ────────────────────────────────────────────────────────

async function handleConstitutionResponse(
  runtime: IAgentRuntime,
  userText: string,
  db: ReturnType<typeof migrations.getDb>,
  _history: OnboardingTurn[],
  callback: HandlerCallback | undefined,
  options: { skipApprovalCheck?: boolean } = {},
): Promise<void> {
  const draft = ConstitutionService.getDraft(db);
  if (!draft) {
    if (callback)
      await callback({
        text: 'Something went wrong. Please send /start to begin again.',
        actions: [],
        source: 'nostra',
      });
    return;
  }

  if (!options.skipApprovalCheck) {
    if (callback) await callback({ text: '⏳ Thinking...', actions: [], source: 'nostra' });

    const approvalResult = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: buildApprovalPrompt(userText),
      temperature: 0.2,
      maxTokens: 20,
    });

    if (approvalResult.trim().toUpperCase().startsWith('APPROVED')) {
      const computeRule: ConstitutionRule = {
        id: draft.rules.length + 1,
        ...DEFAULT_COMPUTE_RULE,
      };
      ConstitutionService.appendDraftRule(db, draft.id, computeRule);
      ConstitutionService.activateDraft(db, draft.id);

      await AgentStateService.setState(
        { constitutionVersion: 1, mode: 'paper', onboardingState: 'complete' },
        db,
      );

      const active = ConstitutionService.getActive(db);
      const activationMsg = buildActivationMessage(active?.rules ?? [...draft.rules, computeRule]);
      if (callback) await callback({ text: activationMsg, actions: [], source: 'nostra' });
      return;
    }
  }

  if (callback) await callback({ text: '⏳ Thinking...', actions: [], source: 'nostra' });

  const amendRuleIdRaw = await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt: buildAmendmentRuleIdPrompt(draft.rules, userText),
    temperature: 0.2,
    maxTokens: 10,
  });

  const ruleId = parseInt(amendRuleIdRaw.trim().replace(/[^0-9]/g, ''), 10);
  if (isNaN(ruleId) || ruleId < 1 || ruleId > draft.rules.length) {
    if (callback)
      await callback({
        text: "Could you reference one of the drafted rules by number — for example, 'Change rule 2 to...'?",
        actions: [],
        source: 'nostra',
      });
    return;
  }

  if (callback) await callback({ text: '⏳ Thinking...', actions: [], source: 'nostra' });

  const regeneratedJson = await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt: buildRuleRegenerationPrompt(draft.rules, ruleId, userText),
    temperature: 0.3,
    maxTokens: 300,
  });

  let updatedRule: ConstitutionRule;
  try {
    const jsonMatch = regeneratedJson.match(/\{[\s\S]*\}/);
    const parsedRule = JSON.parse(jsonMatch?.[0] ?? regeneratedJson) as unknown;
    if (!isConstitutionRule(parsedRule)) throw new Error('invalid constitution rule');
    updatedRule = { ...parsedRule, id: ruleId };
  } catch {
    if (callback)
      await callback({
        text: "I couldn't parse the amendment. Please describe the change more specifically.",
        actions: [],
        source: 'nostra',
      });
    return;
  }

  ConstitutionService.updateDraftRule(db, draft.id, ruleId - 1, updatedRule);

  // Contradiction check on updated ruleset
  const updatedDraft = ConstitutionService.getDraft(db);
  if (!updatedDraft) return;

  if (callback) await callback({ text: '⏳ Thinking...', actions: [], source: 'nostra' });

  const contradictionResult = await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt: buildRulesetContradictionPrompt(updatedDraft.rules),
    temperature: 0.3,
    maxTokens: 200,
  });

  if (contradictionResult.trim().toUpperCase().startsWith('CONTRADICTION:')) {
    const contradictionMsg = contradictionResult.replace(/^CONTRADICTION:\s*/i, '').trim();
    if (callback) await callback({ text: contradictionMsg, actions: [], source: 'nostra' });
    return;
  }

  // Re-display the updated constitution
  const redisplayText = buildConstitutionDisplayText(updatedDraft.rules);
  if (callback) await callback({ text: redisplayText, actions: [], source: 'nostra' });
  OnboardingService.addTurn(db, 'agent', redisplayText, 'constitution_display');
}

function getLatestAgentPhase(history: OnboardingTurn[]): OnboardingTurn['phase'] | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'agent') return history[i].phase;
  }

  return null;
}

// ─── Action ──────────────────────────────────────────────────────────────────

export const ParseConstitutionAction: Action = {
  name: 'PARSE_CONSTITUTION',
  description: 'Parse confirmed beliefs into a First Constitution, present for approval, and activate on approval.',
  similes: ['CREATE_CONSTITUTION', 'FIRST_CONSTITUTION', 'CONSTITUTION_APPROVAL'],
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    try {
      const text = message.content?.text ?? '';
      if (text.trim().startsWith('/')) return false;
      return AgentStateService.getState().onboardingState === 'beliefs_confirmed';
    } catch {
      return false;
    }
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    _options,
    callback,
  ): Promise<ActionResult | void | undefined> => {
    const db = migrations.getDb();
    const history = OnboardingService.getHistory(db);
    const userText = (message.content?.text ?? '').trim();

    const latestAgentPhase = getLatestAgentPhase(history);

    if (latestAgentPhase === 'constitution_display' || latestAgentPhase === 'contradiction') {
      await handleConstitutionResponse(runtime, userText, db, history, callback, {
        skipApprovalCheck: latestAgentPhase === 'contradiction',
      });
      return;
    }

    // ── PARSE PHASE (first invocation) ──────────────────────────────────────
    if (callback) await callback({ text: '⏳ Thinking...', actions: [], source: 'nostra' });

    const beliefSummary = [...history].reverse()
      .find(t => t.role === 'agent' && t.phase === 'summary')?.content ?? '';
    const qaHistory = history
      .filter(t => t.phase === 'questions')
      .map(t => `${t.role === 'agent' ? 'Nostra' : 'User'}: ${t.content}`)
      .join('\n');

    const parsedJson = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: buildParsePrompt(beliefSummary, qaHistory),
      temperature: 0.2,
      maxTokens: 1000,
    });

    let rules: ConstitutionRule[];
    try {
      const parsedRules = JSON.parse(extractJson(parsedJson)) as unknown;
      if (!Array.isArray(parsedRules) || !parsedRules.every(isConstitutionRule)) {
        throw new Error('invalid constitution rules');
      }
      rules = parsedRules.map((r, i) => ({ ...r, id: i + 1 }));
    } catch {
      if (callback)
        await callback({
          text: "I had trouble organizing your beliefs. Please say 'yes' to try again.",
          actions: [],
          source: 'nostra',
        });
      return;
    }

    ConstitutionService.saveDraft(db, rules);

    const displayText = buildConstitutionDisplayText(rules);
    if (callback) await callback({ text: displayText, actions: [], source: 'nostra' });
    OnboardingService.addTurn(db, 'agent', displayText, 'constitution_display');
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'yes', source: 'telegram' },
      },
      {
        name: 'Nostra',
        content: {
          text: '📜 *Your First Constitution*',
          actions: ['PARSE_CONSTITUTION'],
          source: 'nostra',
        },
      },
    ],
  ],
};
