import type { IAgentRuntime } from '@elizaos/core';
import { ModelType } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';
import { prependPaperPrefix } from '../utils/paper-prefix.js';
import * as migrations from '../db/migrations.js';

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

interface MemoRow {
  action_type: string;
  memo_text: string;
}

interface PendingCountRow {
  count: number;
}

function buildEveningReportPrompt(
  memos: MemoRow[],
  date: string,
  accuracyScore: number,
  suggestionsSampled: number,
): string {
  const decisionSummary = memos.length > 0
    ? memos.map(m => `[${m.action_type}] ${m.memo_text.split('\n')[0]}`).join('; ')
    : 'No treasury actions today — all positions held';

  return (
    `You are Nostra, a constitutional financial advisor delivering the nightly Bedtime Report.\n\n` +
    `Date: ${date}\n` +
    `Today's decisions: ${decisionSummary}\n` +
    `Trust Ladder accuracy: ${accuracyScore.toFixed(1)}% across ${suggestionsSampled} graded suggestion${suggestionsSampled !== 1 ? 's' : ''}\n\n` +
    `Write the bedtime report body (100–200 words). Strict rules:\n` +
    `- Companion tone: reflective, empathetic, conversational — never analytical or CFO-like\n` +
    `- Open with 🌙 and date\n` +
    `- Summarise what was decided (or held) and WHY — reference specific constitutional rules\n` +
    `- Briefly note Trust Ladder progress toward 80% Executor threshold\n` +
    `- End with a single reflective closing sentence — no 🫡, no ☀️, no watch list\n` +
    `- Flowing prose only — no markdown headers, no bullet points\n` +
    `- Do NOT include ✈️ PAPER TREASURY SIMULATION — the caller prepends it\n` +
    `- 200 words maximum`
  );
}

function buildFallbackReport(
  memos: MemoRow[],
  date: string,
  accuracyScore: number,
  suggestionsSampled: number,
): string {
  const summary = memos.length > 0
    ? memos.map(m => `${m.action_type}: ${m.memo_text.split('\n')[0]}`).join(' · ')
    : 'No treasury actions recorded today.';

  return (
    `🌙 Bedtime Report — ${date}\n\n` +
    `AI report unavailable. Today's decisions: ${summary} ` +
    `Trust Ladder: ${accuracyScore.toFixed(1)}% (${suggestionsSampled} samples). ` +
    `Rest well — the constitution holds through the night.`
  );
}

function composeEveningReport(date: string, reportBody: string): string {
  const trimmedBody = reportBody.trim();
  const normalizedBody = trimmedBody.replace(/^🌙[^\n]*\n\n?/, '').trim();
  return `🌙 Bedtime Report — ${date}\n\n${normalizedBody}`;
}

export async function generateEveningReport(runtime: IAgentRuntime): Promise<void> {
  const state = AgentStateService.getState();

  // AC5: only run in Paper mode with an active chat session
  if (state.mode !== 'paper' || !state.telegramChatId) return;

  const chatId = state.telegramChatId;
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Send thinking indicator first (NFR18, UX-DR11)
  await sendTelegramMessage(runtime, chatId, prependPaperPrefix('⏳ Thinking...'));

  // Query today's on-chain memos for decision summary
  const db = migrations.getDb();
  const todayMemos = db.prepare(
    `SELECT action_type, memo_text FROM on_chain_memos WHERE date(created_at) = date('now') ORDER BY created_at DESC LIMIT 5`
  ).all() as MemoRow[];

  // Check if there is a pending suggestion to grade (AC2 — buttons conditional on pending entry)
  const pendingCount = (db.prepare(
    `SELECT COUNT(*) as count FROM trust_ladder_log WHERE status = 'pending'`
  ).get() as PendingCountRow).count;

  const hasPendingGrade = pendingCount > 0;

  // Call Qwen — fall back to static report on failure (AC4, NFR19)
  try {
    const reportBody = await (runtime as any).useModel(ModelType.TEXT_LARGE, {
      prompt: buildEveningReportPrompt(todayMemos, dateStr, state.accuracyScore, state.suggestionsSampled),
      temperature: 0.5,
    }) as string;

    const fullReport = composeEveningReport(dateStr, reportBody);
    await sendTelegramMessage(
      runtime,
      chatId,
      prependPaperPrefix(fullReport),
      hasPendingGrade ? {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Good call', callback_data: 'grade_good' },
            { text: '❌ Bad call', callback_data: 'grade_bad' },
          ]],
        },
      } : undefined,
    );
  } catch {
    // AC4 fallback: deliver static report — no crash, no silent skip
    const fallback = buildFallbackReport(todayMemos, dateStr, state.accuracyScore, state.suggestionsSampled);
    await sendTelegramMessage(
      runtime,
      chatId,
      prependPaperPrefix(fallback),
      hasPendingGrade ? {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Good call', callback_data: 'grade_good' },
            { text: '❌ Bad call', callback_data: 'grade_bad' },
          ]],
        },
      } : undefined,
    );
  }
}
