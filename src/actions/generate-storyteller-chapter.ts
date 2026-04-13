import type { IAgentRuntime } from '@elizaos/core';
import { ModelType } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';
import { prependPaperPrefix } from '../utils/paper-prefix.js';
import * as migrations from '../db/migrations.js';

type RuntimeWithClients = IAgentRuntime & {
  clients?: Array<{
    type?: string;
    bot?: { telegram?: { sendMessage: (chatId: string, text: string) => Promise<unknown> } };
  }>;
};

async function sendTelegramMessage(rt: IAgentRuntime, chatId: string, text: string): Promise<void> {
  const runtimeWithClients = rt as RuntimeWithClients;
  const telegramClient = (runtimeWithClients.clients ?? []).find(c => c.type === 'telegram');
  if (telegramClient?.bot?.telegram) {
    await telegramClient.bot.telegram.sendMessage(chatId, text);
  }
}

interface MemoRow { action_type: string; memo_text: string; }
interface TrustGradeRow { user_grade: number; }
interface CrisisEpisodeRow { violation_summary: string; status: string; }
interface ChapterCountRow { max_num: number | null; }
const COMPLIANCE_SUMMARY_REGEX = /^Constitutional compliance this week: \d+%\.?$/;

function getNextChapterNum(db: ReturnType<typeof migrations.getDb>): number {
  const row = db.prepare(
    `SELECT MAX(chapter_num) as max_num FROM storyteller_chapters`
  ).get() as ChapterCountRow;
  return (row.max_num ?? 0) + 1;
}

function recordChapter(db: ReturnType<typeof migrations.getDb>, chapterNum: number, title: string): void {
  db.prepare(
    `INSERT INTO storyteller_chapters (chapter_num, title, created_at) VALUES (?, ?, ?)`
  ).run(chapterNum, title, new Date().toISOString());
}

function buildStorytellerPrompt(
  memos: MemoRow[],
  grades: TrustGradeRow[],
  crisisEpisodes: CrisisEpisodeRow[],
  chapterNum: number,
  dateStr: string,
): string {
  const memoSummary = memos.length > 0
    ? memos.map(m => `[${m.action_type}] ${m.memo_text.split('\n')[0]}`).join('; ')
    : 'No treasury actions this week — all positions held';

  const gradeSummary = grades.length > 0
    ? `User grades this week: ${grades.map(g => g.user_grade).join(', ')}`
    : 'No grading activity this week';

  const crisisPart = crisisEpisodes.length > 0
    ? `\nCrisis episode this week: ${crisisEpisodes.map(c => c.violation_summary).join('; ')} — narrate this as a turning point in the chapter, not a system event.`
    : '';

  const sparsePart = memos.length < 2
    ? '\nNote: Very limited on-chain history exists. Write an orientation chapter acknowledging this early stage.'
    : '';

  return (
    `You are Nostra, narrating the financial autobiography of this treasury as Chapter ${chapterNum}.\n\n` +
    `Week of: ${dateStr}\n` +
    `Treasury decisions: ${memoSummary}\n` +
    `${gradeSummary}${crisisPart}${sparsePart}\n\n` +
    `Write Chapter ${chapterNum} of the financial story (150–300 words). Strict rules:\n` +
    `- FIRST LINE MUST BE EXACTLY: 📖 Chapter ${chapterNum}: {your title here} — write your own evocative title\n` +
    `- Past-tense literary narrative voice — not clinical, not CFO-like\n` +
    `- The constitutional rules are the plot logic — reference them as the guiding principles\n` +
    `- If a crisis episode occurred, narrate it as a "turning point" section\n` +
    `- If history is sparse (early stage), write an orientation chapter acknowledging early days\n` +
    `- LAST LINE MUST BE EXACTLY: Constitutional compliance this week: {X}%. — compute X from available context\n` +
    `- 150–300 words, flowing prose only — no markdown headers, no bullet points\n` +
    `- Do NOT include ✈️ PAPER TREASURY SIMULATION — the caller prepends it`
  );
}

function buildFallbackChapter(memos: MemoRow[], chapterNum: number, dateStr: string): string {
  const bulletSummaries = memos.length > 0
    ? memos.map(m => `• [${m.action_type}] ${m.memo_text.split('\n')[0]}`).join('\n')
    : '• No treasury actions recorded this week.';

  return (
    `📖 Chapter ${chapterNum} — Week of ${dateStr}\n\n` +
    `${bulletSummaries}\n\n` +
    `AI narrative unavailable.`
  );
}

function extractTitle(chapterText: string): string {
  const firstLine = chapterText.trim().split('\n')[0] ?? '';
  const match = firstLine.match(/^📖 Chapter \d+:\s*(.+)$/);
  return match ? match[1].trim() : 'Untitled Chapter';
}

function maybePrependPaperPrefix(text: string, mode: 'paper' | 'live'): string {
  return mode === 'paper' ? prependPaperPrefix(text) : text;
}

function hasComplianceSummary(chapterText: string): boolean {
  const lines = chapterText
    .trim()
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const lastLine = lines.at(-1) ?? '';
  return COMPLIANCE_SUMMARY_REGEX.test(lastLine);
}

export async function generateStorytellerChapter(runtime: IAgentRuntime): Promise<void> {
  const state = AgentStateService.getState();

  if (!state.telegramChatId) return;

  const chatId = state.telegramChatId;
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Send thinking indicator first (NFR18, UX-DR11)
  await sendTelegramMessage(runtime, chatId, maybePrependPaperPrefix('⏳ Thinking...', state.mode));

  const db = migrations.getDb();

  const memos = db.prepare(
    `SELECT action_type, memo_text FROM on_chain_memos
     WHERE created_at >= datetime('now', '-7 days') ORDER BY created_at ASC`
  ).all() as MemoRow[];

  const grades = db.prepare(
    `SELECT user_grade FROM trust_ladder_log
     WHERE created_at >= datetime('now', '-7 days') ORDER BY created_at ASC`
  ).all() as TrustGradeRow[];

  const crisisEpisodes = db.prepare(
    `SELECT violation_summary, status FROM crisis_episodes
     WHERE created_at >= datetime('now', '-7 days')`
  ).all() as CrisisEpisodeRow[];

  const chapterNum = getNextChapterNum(db);

  try {
    const chapterText = await (runtime as any).useModel(ModelType.TEXT_LARGE, {
      prompt: buildStorytellerPrompt(memos, grades, crisisEpisodes, chapterNum, dateStr),
      temperature: 0.6,
    }) as string;

    const trimmed = chapterText.trim();
    if (!trimmed.startsWith('📖 Chapter')) {
      throw new Error('LLM output did not start with expected 📖 Chapter header');
    }
    if (!hasComplianceSummary(trimmed)) {
      throw new Error('LLM output did not end with required compliance summary');
    }

    await sendTelegramMessage(runtime, chatId, maybePrependPaperPrefix(trimmed, state.mode));

    const title = extractTitle(trimmed);
    recordChapter(db, chapterNum, title);
  } catch {
    // AC5 fallback: deliver plain-text summary — no crash, no silent skip, no recordChapter
    const fallback = buildFallbackChapter(memos, chapterNum, dateStr);
    await sendTelegramMessage(runtime, chatId, maybePrependPaperPrefix(fallback, state.mode));
  }
}
