import type { Action, IAgentRuntime, Memory } from '@elizaos/core';
import { ModelType } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';
import { WalletService } from '../services/wallet-service.js';
import { buildMemoText } from './log-decision-on-chain.js';
import { ConstitutionService } from '../services/constitution-service.js';
import * as migrations from '../db/migrations.js';
import type { CrisisOption } from '../types/agent-state.js';

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

async function sendTelegramMessage(rt: IAgentRuntime, chatId: string, text: string, options?: Record<string, unknown>): Promise<void> {
  const runtimeWithClients = rt as RuntimeWithClients;
  const telegramClient = (runtimeWithClients.clients ?? []).find(c => c.type === 'telegram');
  if (telegramClient?.bot?.telegram) {
    await telegramClient.bot.telegram.sendMessage(chatId, text, options);
  }
}

// ---- Crisis Briefing helpers ----

function buildCrisisBriefingPrompt(violationSummary: string, constitutionRules: string): string {
  return (
    `You are Nostra, a constitutional financial agent. A constitutional crisis has been detected.\n\n` +
    `Crisis: ${violationSummary}\n` +
    `Active constitution rules: ${constitutionRules}\n\n` +
    `Generate a crisis briefing and 3 resolution options. Output ONLY valid JSON — no other text:\n` +
    `{\n` +
    `  "briefing": "<250-400 word briefing. FIRST SENTENCE must be: I have frozen all actions. Explain the crisis clearly. End before options listing. Plain prose only — no markdown headers.>",\n` +
    `  "options": {\n` +
    `    "a": { "label": "A — <concise action (≤6 words)>", "tradeoff": "<1-2 sentence risk/values explanation>" },\n` +
    `    "b": { "label": "B — <concise action (≤6 words)>", "tradeoff": "<1-2 sentence risk/values explanation>" },\n` +
    `    "c": { "label": "C — <concise action (≤6 words)>", "tradeoff": "<1-2 sentence risk/values explanation>" }\n` +
    `  }\n` +
    `}\n\n` +
    `Ranking rule: A = lowest risk (preserve values), B = medium, C = highest risk (most disruptive).`
  );
}

const CRISIS_BRIEFING_FALLBACK_OPTIONS = {
  a: { label: 'A — Hold until rules amended', tradeoff: 'Lowest risk. Treasury stays frozen while you amend the conflicting rule. No positions change.' },
  b: { label: 'B — Suspend conflicting rule', tradeoff: 'Medium risk. Allows execution to resume by treating the newer conflicting rule as temporarily inactive.' },
  c: { label: 'C — Accept current state', tradeoff: 'Higher risk. Resumes with the existing portfolio as-is. The rule conflict will persist until manually resolved.' },
};

const CRISIS_FREEZE_OPENING = 'I have frozen all actions.';

function buildFallbackBriefingMessage(violationSummary: string): string {
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const opts = CRISIS_BRIEFING_FALLBACK_OPTIONS;
  return (
    `${CRISIS_FREEZE_OPENING}\n\n` +
    `🚨 CRISIS BRIEFING — ${date}\n\n` +
    `A constitutional impossibility was detected: ${violationSummary}\n\n` +
    `Please choose a resolution option:\n\n` +
    `${opts.a.label}\n${opts.a.tradeoff}\n\n` +
    `${opts.b.label}\n${opts.b.tradeoff}\n\n` +
    `${opts.c.label}\n${opts.c.tradeoff}`
  );
}

function stripFreezeOpening(briefing: string): string {
  const normalized = briefing.trim();
  if (normalized.startsWith(CRISIS_FREEZE_OPENING)) {
    return normalized.slice(CRISIS_FREEZE_OPENING.length).trimStart();
  }
  return normalized;
}

function buildCrisisBriefingMessage(date: string, briefing: string, options: { a: CrisisOption; b: CrisisOption; c: CrisisOption }): string {
  const body = stripFreezeOpening(briefing);
  return (
    `${CRISIS_FREEZE_OPENING}\n\n` +
    `🚨 CRISIS BRIEFING — ${date}\n\n` +
    `${body}\n\n` +
    `${options.a.label}\n${options.a.tradeoff}\n\n` +
    `${options.b.label}\n${options.b.tradeoff}\n\n` +
    `${options.c.label}\n${options.c.tradeoff}`
  );
}

function buildResolutionMessage(chosenKey: 'a' | 'b' | 'c', chosenLabel: string, tradeoff: string): string {
  const followUp: Record<'a' | 'b' | 'c', string> = {
    a: 'Treasury remains frozen. Use the amendment command to update the conflicting rule before execution resumes.',
    b: 'The conflicting rule is now suspended. Review your constitution when ready.',
    c: 'The treasury is active with your existing portfolio. Consider reviewing your constitution rules.',
  };
  const statusLine: Record<'a' | 'b' | 'c', string> = {
    a: '🛑 Hold confirmed. The treasury remains frozen.',
    b: '✅ Crisis resolved. The freeze has been lifted.',
    c: '✅ Crisis resolved. The freeze has been lifted.',
  };
  return (
    `${statusLine[chosenKey]}\n\n` +
    `You chose: ${chosenLabel}\n` +
    `${tradeoff}\n\n` +
    `${followUp[chosenKey]}`
  );
}

export async function sendCrisisBriefing(
  runtime: IAgentRuntime,
  chatId: string,
  violationSummary: string,
): Promise<void> {
  const db = migrations.getDb();

  // Always insert crisis_episodes row BEFORE sending message (so we have the id)
  const now = new Date().toISOString();
  const episodeResult = db.prepare(
    `INSERT INTO crisis_episodes
     (violation_summary, option_a_label, option_b_label, option_c_label, status, created_at)
     VALUES (?, ?, ?, ?, 'open', ?)`
  ).run(
    violationSummary,
    CRISIS_BRIEFING_FALLBACK_OPTIONS.a.label,
    CRISIS_BRIEFING_FALLBACK_OPTIONS.b.label,
    CRISIS_BRIEFING_FALLBACK_OPTIONS.c.label,
    now,
  ) as { lastInsertRowid: number };
  const crisisEpisodeId = episodeResult.lastInsertRowid;

  // Send ⏳ Thinking... before LLM call (UX-DR11, NFR18)
  await sendTelegramMessage(runtime, chatId, '⏳ Thinking...');

  let options: { a: CrisisOption; b: CrisisOption; c: CrisisOption };
  let briefingText: string;
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  try {
    const constitution = ConstitutionService.getActive(db);
    const constitutionRules = constitution?.rules.map(r => `Rule #${r.id}: ${r.description}`).join('; ') ?? 'No active rules';
    const prompt = buildCrisisBriefingPrompt(violationSummary, constitutionRules);

    const rawOutput = await (runtime as any).useModel(ModelType.TEXT_LARGE, {
      prompt,
      temperature: 0.4,
    }) as string;

    const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch?.[0] ?? rawOutput) as {
      briefing: string;
      options: { a: CrisisOption; b: CrisisOption; c: CrisisOption };
    };

    if (
      typeof parsed?.briefing !== 'string' ||
      typeof parsed?.options?.a?.label !== 'string' ||
      typeof parsed?.options?.b?.label !== 'string' ||
      typeof parsed?.options?.c?.label !== 'string'
    ) {
      throw new Error('Invalid briefing schema from LLM');
    }

    options = parsed.options;
    briefingText = buildCrisisBriefingMessage(date, parsed.briefing, options);

    // Update crisis_episodes with LLM-generated option labels
    db.prepare(
      `UPDATE crisis_episodes SET option_a_label = ?, option_b_label = ?, option_c_label = ? WHERE id = ?`
    ).run(options.a.label, options.b.label, options.c.label, crisisEpisodeId);

  } catch {
    // AC5: fallback — never crash, never silent skip
    options = CRISIS_BRIEFING_FALLBACK_OPTIONS;
    briefingText = buildFallbackBriefingMessage(violationSummary);
  }

  // Store in-memory so EmergencyVote can retrieve option labels
  AgentStateService.setPendingCrisisVote({ violationSummary, crisisEpisodeId, options });

  // Send briefing with 3 inline buttons — 1 row (UX-DR6)
  await sendTelegramMessage(runtime, chatId, briefingText, {
    reply_markup: {
      inline_keyboard: [[
        { text: options.a.label, callback_data: 'crisis_vote_a' },
        { text: options.b.label, callback_data: 'crisis_vote_b' },
        { text: options.c.label, callback_data: 'crisis_vote_c' },
      ]],
    },
  });
}

// ---- CrisisFreeze ----

export interface CrisisFreezeOptions {
  crisisType: 'constitution' | 'rpc_failure';
  violationSummary: string;
}

export async function executeCrisisFreeze(
  runtime: IAgentRuntime,
  options: CrisisFreezeOptions,
): Promise<void> {
  const db = migrations.getDb();

  // STEP 1: Set crisisStatus to 'frozen' in DB FIRST — before any other action (FR30)
  await AgentStateService.setState({ crisisStatus: 'frozen' }, db);

  // STEP 2: Write crisis freeze Lamport memo
  const memoText = buildMemoText({
    actionDescription: `CRISIS FREEZE. ${options.violationSummary}`,
    ruleReference: options.crisisType === 'rpc_failure' ? 'Rule #0' : 'Rule #N/A',
    complianceStatus: 'Awaiting user emergency vote.',
  });

  try {
    const { txHash, explorerUrl } = await WalletService.writeMemo(memoText);
    db.prepare(
      `INSERT OR IGNORE INTO on_chain_memos
       (tx_hash, action_type, memo_text, explorer_url, status, created_at)
       VALUES (?, 'CRISIS_FREEZE', ?, ?, 'confirmed', ?)`
    ).run(txHash, memoText, explorerUrl, new Date().toISOString());
  } catch (err) {
    // Memo write failure must not prevent the freeze from being effective
    console.error('[CrisisProtocol] Memo write failed:', err instanceof Error ? err.message : String(err));
  }

  // STEP 3: Notify user via Telegram
  const chatId = AgentStateService.getState().telegramChatId;
  if (chatId) {
    if (options.crisisType === 'rpc_failure') {
      // RPC failure: plain notification — no vote needed
      await sendTelegramMessage(
        runtime, chatId,
        `🚨 EXECUTION FROZEN\n\nI have frozen all actions due to sustained RPC failure — not a rule conflict. No transactions will execute until connectivity is restored and you lift the freeze.`,
      );
    } else {
      // Constitution crisis: full Crisis Briefing with 3-option vote (Story 5.2)
      await sendCrisisBriefing(runtime, chatId, options.violationSummary);
    }
  }
}

export const TriggerCrisisProtocol: Action = {
  name: 'TRIGGER_CRISIS_PROTOCOL',
  description: 'Freeze all treasury execution and notify user of crisis condition.',
  similes: ['FREEZE_EXECUTION', 'CRISIS_FREEZE', 'EMERGENCY_FREEZE'],
  validate: async () => false, // Story 5.2 enables interactive trigger
  handler: async (runtime, message, _state, _options, callback) => {
    const content = message.content as { crisisType?: string; violationSummary?: string };
    await executeCrisisFreeze(runtime, {
      crisisType: (content.crisisType as 'constitution' | 'rpc_failure') ?? 'constitution',
      violationSummary: content.violationSummary ?? 'Constitutional impossibility detected.',
    });
    if (callback) {
      await callback({ text: '🚨 Crisis Protocol activated. Execution frozen.', actions: [], source: 'nostra' });
    }
  },
  examples: [],
};

export const EmergencyVote: Action = {
  name: 'EMERGENCY_VOTE',
  description: 'Process user emergency vote to resolve a crisis and lift the execution freeze.',
  similes: ['CRISIS_VOTE', 'RESOLVE_CRISIS', 'LIFT_FREEZE'],
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    try {
      const text = (message.content?.text ?? '').trim();
      if (!['crisis_vote_a', 'crisis_vote_b', 'crisis_vote_c'].includes(text)) return false;
      const state = AgentStateService.getState();
      // AC6: only fire when frozen (not resolving — prevents double-tap)
      return state.crisisStatus === 'frozen' && state.pendingCrisisVote !== undefined;
    } catch {
      return false;
    }
  },
  handler: async (runtime: IAgentRuntime, message: Memory, _state, _options, callback): Promise<void> => {
    const text = (message.content?.text ?? '').trim();
    const chosenKey = text.replace('crisis_vote_', '') as 'a' | 'b' | 'c';
    const db = migrations.getDb();
    const agentState = AgentStateService.getState();
    const chatId = agentState.telegramChatId;
    const voteData = agentState.pendingCrisisVote;

    if (!voteData) {
      // Guard: no pending vote (should not happen if validate() ran correctly)
      if (callback) {
        await callback({ text: 'No pending crisis vote found — the session may have expired.', actions: [], source: 'nostra' });
      }
      return;
    }

    // AC3 STEP 1: Set crisisStatus to 'resolving' + persist chosen option BEFORE any action (FR32)
    await AgentStateService.setState({ crisisStatus: 'resolving' }, db);
    const chosenLabel = voteData.options[chosenKey].label;
    try {
      db.prepare(
        `UPDATE crisis_episodes SET chosen_option = ? WHERE id = ?`
      ).run(chosenLabel, voteData.crisisEpisodeId);
    } catch (err) {
      console.error('[EmergencyVote] Failed to persist chosen option:', err instanceof Error ? err.message : String(err));
    }

    // Clear pendingCrisisVote immediately to prevent double-processing
    AgentStateService.setPendingCrisisVote(undefined);

    // AC4 STEP 1: Write resolution Lamport memo (action_type = 'CRISIS_RESOLUTION')
    const memoText = buildMemoText({
      actionDescription: `CRISIS RESOLUTION. User chose: ${chosenLabel}. ${voteData.violationSummary}`,
      ruleReference: 'Rule #N/A',
      complianceStatus: 'Crisis resolved by user emergency vote. Constitutional compliance: pending amendment.',
    });

    let resolutionMemoHash = '';
    try {
      const { txHash, explorerUrl } = await WalletService.writeMemo(memoText);
      resolutionMemoHash = txHash;
      db.prepare(
        `INSERT OR IGNORE INTO on_chain_memos
         (tx_hash, action_type, memo_text, explorer_url, status, created_at)
         VALUES (?, 'CRISIS_RESOLUTION', ?, ?, 'confirmed', ?)`
      ).run(txHash, memoText, explorerUrl, new Date().toISOString());
    } catch (err) {
      console.error('[EmergencyVote] Resolution memo write failed:', err instanceof Error ? err.message : String(err));
    }

    // AC4 STEP 2: Mark crisis episode resolved in SQLite
    try {
      db.prepare(
        `UPDATE crisis_episodes
         SET resolution_memo_hash = ?, status = 'resolved', resolved_at = ?
         WHERE id = ?`
      ).run(resolutionMemoHash || null, new Date().toISOString(), voteData.crisisEpisodeId);
    } catch (err) {
      console.error('[EmergencyVote] Failed to update crisis episode:', err instanceof Error ? err.message : String(err));
    }

    // Execute the chosen option explicitly:
    // A confirms the hold and keeps the freeze in place until the user amends the rule.
    // B and C resolve the crisis and lift the freeze.
    const nextCrisisStatus = chosenKey === 'a' ? 'frozen' : 'active';
    await AgentStateService.setState({ crisisStatus: nextCrisisStatus }, db);

    // AC4 STEP 4: Send plain-English outcome message
    const resumptionText = buildResolutionMessage(chosenKey, chosenLabel, voteData.options[chosenKey].tradeoff);
    if (chatId) {
      await sendTelegramMessage(runtime, chatId, resumptionText);
    } else if (callback) {
      await callback({ text: resumptionText, actions: ['EMERGENCY_VOTE'], source: 'nostra' });
    }
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'crisis_vote_a', source: 'telegram' },
      },
      {
        name: 'Nostra',
        content: {
          text: '✅ Crisis resolved. Freeze lifted. Treasury is active.',
          actions: ['EMERGENCY_VOTE'],
          source: 'nostra',
        },
      },
    ],
  ],
};
