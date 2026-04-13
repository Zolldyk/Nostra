import type { IAgentRuntime } from '@elizaos/core';
import { ModelType } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';
import { ConstitutionService } from '../services/constitution-service.js';
import { fetchMonthlyComputeCost } from '../services/nosana-compute-service.js';
import { getPaperPortfolioSnapshot } from '../providers/portfolio-provider.js';
import { YieldRatesProvider } from '../providers/yield-rates-provider.js';
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

async function sendTelegramMessage(rt: IAgentRuntime, chatId: string, text: string): Promise<void> {
  const runtimeWithClients = rt as RuntimeWithClients;
  const telegramClient = (runtimeWithClients.clients ?? []).find(client => client.type === 'telegram');
  if (telegramClient?.bot?.telegram) {
    await telegramClient.bot.telegram.sendMessage(chatId, text);
  }
}

function buildMorningBriefingPrompt(
  positions: Array<{ protocol: string; symbol: string; amount_usd: number; percentage: number }>,
  kaminoApy: number,
  marginfiApy: number,
  driftApy: number,
  date: string,
  computeCostLine = '',
  computeWarning = '',
): string {
  const positionSummary = positions.length > 0
    ? positions.map(p => `${p.protocol}: ${p.symbol} $${p.amount_usd.toFixed(0)} (${p.percentage}%)`).join(', ')
    : 'No positions yet — treasury undeployed';
  const computePart = computeCostLine
    ? `\nCompute (Nosana): ${computeCostLine}${computeWarning ? `. ${computeWarning}` : ''}. Include this line verbatim in the briefing body.\n`
    : '';

  return (
    `You are Nostra, a constitutional financial advisor delivering the morning State of the Treasury briefing.\n\n` +
    `Date: ${date}\n` +
    `Current portfolio: ${positionSummary}\n` +
    `Live yield rates — Kamino: ${kaminoApy.toFixed(2)}%, Marginfi: ${marginfiApy.toFixed(2)}%, Drift: ${driftApy.toFixed(2)}%\n` +
    `${computePart}\n` +
    `Write the morning briefing body (100–200 words). Strict rules:\n` +
    `- CFO tone: forward-looking, analytical, confident — never reflective or sentimental\n` +
    `- Sentence 1: summarise current positions\n` +
    `- Yield Landscape paragraph: rank all 3 protocols by APY descending; bold each APY value e.g. **7.25%**\n` +
    `- End with a 1-sentence forward watch list\n` +
    `- Final line: exactly "🫡 Nostra" with no other text\n` +
    `- Flowing prose only — no markdown headers, no bullet points\n` +
    `- Do NOT include ✈️ PAPER TREASURY SIMULATION or ☀️ — the caller prepends these\n` +
    `- 200 words maximum`
  );
}

function buildFallbackBriefing(
  positions: Array<{ protocol: string; symbol: string; amount_usd: number; percentage: number }>,
  kaminoApy: number,
  marginfiApy: number,
  driftApy: number,
  date: string,
  yieldDataAvailable = true,
  computeCostLine = '',
  computeWarning = '',
): string {
  const rates = [
    { protocol: 'Kamino', apy: kaminoApy },
    { protocol: 'Marginfi', apy: marginfiApy },
    { protocol: 'Drift', apy: driftApy },
  ].sort((a, b) => b.apy - a.apy);

  const positionText = positions.length > 0
    ? positions.map(p => `${p.protocol} ${p.percentage}%`).join(', ')
    : 'treasury undeployed';

  const yieldText = yieldDataAvailable
    ? rates.map(r => `**${r.protocol} ${r.apy.toFixed(2)}%**`).join(' · ')
    : 'yield data temporarily unavailable';

  const guidanceText = yieldDataAvailable
    ? 'Review your constitution rules before the market opens.'
    : 'Yield APIs are temporarily unavailable, so review your constitution rules before the market opens.';
  const computeText = computeCostLine ? `${computeCostLine}. ` : '';
  const warningText = computeWarning ? `${computeWarning}. ` : '';

  return (
    `☀️ State of the Treasury — ${date}\n\n` +
    `AI briefing unavailable. Portfolio: ${positionText}. ` +
    `Yield Landscape: ${yieldText}. ` +
    `${computeText}${warningText}` +
    `${guidanceText}\n\n` +
    `🫡 Nostra`
  );
}

function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .length;
}

function injectComputeSection(briefingBody: string, computeCostLine: string, computeWarning: string): string {
  const extras = [computeCostLine, computeWarning].filter(Boolean).join('\n');
  if (!extras) return briefingBody.trim();

  const trimmed = briefingBody.trim();
  const signoff = '\n\n🫡 Nostra';
  if (trimmed.endsWith(signoff)) {
    return `${trimmed.slice(0, -signoff.length)}\n\n${extras}${signoff}`;
  }
  return `${trimmed}\n\n${extras}`;
}

export async function generateMorningBriefing(runtime: IAgentRuntime): Promise<void> {
  const state = AgentStateService.getState();

  // AC5: only run in Paper mode with an active chat session
  if (state.mode !== 'paper' || !state.telegramChatId) return;

  const chatId = state.telegramChatId;
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Send thinking indicator first (NFR18, UX-DR11)
  await sendTelegramMessage(runtime, chatId, prependPaperPrefix('⏳ Thinking...'));

  const positions = getPaperPortfolioSnapshot();
  let kaminoApy = 0;
  let marginfiApy = 0;
  let driftApy = 0;
  let yieldDataAvailable = true;
  let computeCostLine = '';
  let computeWarning = '';

  try {
    const yieldResult = await YieldRatesProvider.get(runtime, undefined as any, undefined as any);
    const yieldValues = (yieldResult.values ?? {}) as Record<string, unknown>;
    kaminoApy = (yieldValues['kamino_apy'] as number | undefined) ?? 0;
    marginfiApy = (yieldValues['marginfi_apy'] as number | undefined) ?? 0;
    driftApy = (yieldValues['drift_apy'] as number | undefined) ?? 0;
  } catch {
    yieldDataAvailable = false;
  }

  const db = migrations.getDb();
  const constitution = ConstitutionService.getActive(db);
  const computeRule = constitution?.rules.find(r => r.type === 'compute_budget');

  if (computeRule) {
    try {
      const { spentNos, monthLabel } = await fetchMonthlyComputeCost();
      const budget = computeRule.condition.value;
      const pct = Math.round((spentNos / budget) * 100);
      computeCostLine = `NOS compute (${monthLabel}): ${spentNos.toFixed(1)} / ${budget} NOS (${pct}%)`;
      if (pct > 80) {
        computeWarning = `⚠️ NOS compute approaching ceiling: ${pct}% used`;
      }
    } catch {
      await sendTelegramMessage(
        runtime,
        chatId,
        prependPaperPrefix('⚠️ NOS compute cost unavailable — Nosana API unreachable')
      );
    }
  }

  // Call Qwen — fall back to static briefing on failure (AC4, NFR19)
  try {
    if (!yieldDataAvailable) {
      throw new Error('Yield data unavailable');
    }

    const briefingBody = await (runtime as any).useModel(ModelType.TEXT_LARGE, {
      prompt: buildMorningBriefingPrompt(positions, kaminoApy, marginfiApy, driftApy, dateStr, computeCostLine, computeWarning),
      temperature: 0.4,
    }) as string;

    const wordCount = countWords(briefingBody);
    if (wordCount < 100 || wordCount > 200) {
      throw new Error(`Morning briefing length out of bounds: ${wordCount} words`);
    }

    const deliveredBody = injectComputeSection(briefingBody, computeCostLine, computeWarning);
    // Compose full message with ☀️ header (caller adds ✈️ via prependPaperPrefix)
    const fullBriefing = `☀️ State of the Treasury — ${dateStr}\n\n${deliveredBody}`;
    await sendTelegramMessage(runtime, chatId, prependPaperPrefix(fullBriefing));
  } catch {
    // AC4 fallback: deliver static briefing — no crash, no silent skip
    const fallback = buildFallbackBriefing(
      positions,
      kaminoApy,
      marginfiApy,
      driftApy,
      dateStr,
      yieldDataAvailable,
      computeCostLine,
      computeWarning,
    );
    await sendTelegramMessage(runtime, chatId, prependPaperPrefix(fallback));
  }
}
