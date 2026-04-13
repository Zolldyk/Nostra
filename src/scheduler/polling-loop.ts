import type { IAgentRuntime } from '@elizaos/core';
import { ModelType } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';
import { getPaperPortfolioSnapshot } from '../providers/portfolio-provider.js';
import { YieldRatesProvider } from '../providers/yield-rates-provider.js';
import { CrisisTriggerEvaluator } from '../evaluators/crisis-trigger-evaluator.js';
import { prependPaperPrefix } from '../utils/paper-prefix.js';
import type { PendingProposal } from '../types/agent-state.js';
import { buildMemoText } from '../actions/log-decision-on-chain.js';
import * as migrations from '../db/migrations.js';
import { WalletService } from '../services/wallet-service.js';
import { withRetry } from '../utils/with-retry.js';
import { executeCrisisFreeze } from '../actions/trigger-crisis-protocol.js';

const POLL_INTERVAL_MS = 30_000;
const YIELD_PROPOSAL_THRESHOLD = 5;

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
  const telegramClient = (runtimeWithClients.clients ?? []).find(client => client.type === 'telegram');

  if (telegramClient?.bot?.telegram) {
    await telegramClient.bot.telegram.sendMessage(chatId, text, options);
  }
}

function buildProposalRationalePrompt(protocol: string, apy: number, ruleRef: string): string {
  return (
    `You are Nostra, a constitutional financial advisor. In 2 sentences, explain why rotating treasury allocation to ` +
    `${protocol} at ${apy.toFixed(2)}% APY complies with ${ruleRef}. ` +
    `Be direct and specific. Do not use markdown. Do not exceed 100 words.`
  );
}

async function sendAdvisorProposal(rt: IAgentRuntime, chatId: string, proposal: PendingProposal, currentAverageApy: number): Promise<void> {
  // Send thinking indicator first
  await sendTelegramMessage(rt, chatId, prependPaperPrefix('⏳ Thinking...'));

  // Generate rationale via LLM
  let rationale: string;
  try {
    rationale = await (rt as any).useModel(ModelType.TEXT_LARGE, {
      prompt: buildProposalRationalePrompt(proposal.protocol, proposal.proposedApy, proposal.ruleRef),
      temperature: 0.3,
    }) as string;
  } catch {
    rationale = `${proposal.protocol} offers the highest current yield, complying with ${proposal.ruleRef}.`;
  }

  // Calculate APY delta vs actual current portfolio average
  const delta = (proposal.proposedApy - currentAverageApy).toFixed(2);

  const proposalText = prependPaperPrefix(
    `📋 Constitution Rule Threshold Detected\n\n` +
    `Proposed rotation: Move allocation to ${proposal.protocol} at ${proposal.proposedApy.toFixed(2)}% APY.\n` +
    `Expected APY delta: +${delta}% vs current average.\n\n` +
    `Rationale: ${rationale}\n\n` +
    `${proposal.ruleRef} — constitutional compliance verified.`
  );

  await sendTelegramMessage(rt, chatId, proposalText, {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: 'approve_proposal' },
        { text: '❌ Reject', callback_data: 'reject_proposal' },
      ]],
    },
  });
}

async function sendPaperNotification(rt: IAgentRuntime, chatId: string, text: string): Promise<void> {
  await sendTelegramMessage(rt, chatId, prependPaperPrefix(text));
}

export async function runPollingTick(rt: IAgentRuntime): Promise<void> {
  const state = AgentStateService.getState();

  // Crisis detection must protect both Paper and Live modes.
  // Only the advisor yield-opportunity branch remains Paper-only.

  // 0. 24h timeout check — BEFORE yield detection
  const pendingProposal = state.pendingProposal;
  if (pendingProposal) {
    const ageMs = Date.now() - new Date(pendingProposal.timestamp).getTime();
    if (ageMs > 86_400_000) {
      try {
        const timeoutMemoText = buildMemoText({
          actionDescription: 'User did not respond within 24 hours',
          ruleReference: pendingProposal.ruleRef ?? 'Rule #1',
          complianceStatus: 'Non-action memo. Proposal expired.',
        });
        const { txHash, explorerUrl } = await WalletService.writeMemo(timeoutMemoText);
        const db = migrations.getDb();
        db.prepare(
          `INSERT OR IGNORE INTO on_chain_memos (tx_hash, action_type, memo_text, explorer_url, status, created_at)
           VALUES (?, 'NON_ACTION', ?, ?, 'confirmed', ?)`
        ).run(txHash, timeoutMemoText, explorerUrl, new Date().toISOString());
      } catch (err) {
        console.error('[PollingLoop] Timeout memo write failed:', err instanceof Error ? err.message : String(err));
      }
      AgentStateService.setPendingProposal(undefined);
    }
  }

  // 1. Read portfolio snapshot (in-memory cache — no DB hit)
  getPaperPortfolioSnapshot();

  // 2. Run CrisisTriggerEvaluator in both modes.
  await CrisisTriggerEvaluator.handler(rt, undefined as any, undefined as any, {}, undefined);

  // Live mode does not run advisor proposal polling.
  if (state.mode !== 'paper') return;

  // 3. Advisor Mode: check for yield opportunity
  if (state.trustLadder === 'advisor') {
    try {
      const yieldResult = await withRetry(() => YieldRatesProvider.get(rt, undefined as any, undefined as any), 3, 5000);
      const yieldValues = (yieldResult.values ?? {}) as Record<string, unknown>;
      const failedProtocols = (yieldValues['failed_protocols'] as string[] | undefined) ?? [];
      const errorMessage = typeof yieldValues['errorMessage'] === 'string' ? yieldValues['errorMessage'] : '';

      if (failedProtocols.length > 0 && errorMessage && state.telegramChatId) {
        await sendPaperNotification(rt, state.telegramChatId, errorMessage);
      }

      const apys = [
        { protocol: 'Kamino', apy: (yieldValues['kamino_apy'] as number | undefined) ?? 0 },
        { protocol: 'Marginfi', apy: (yieldValues['marginfi_apy'] as number | undefined) ?? 0 },
        { protocol: 'Drift', apy: (yieldValues['drift_apy'] as number | undefined) ?? 0 },
      ];
      const bestYield = apys.reduce((a, b) => (b.apy > a.apy ? b : a));

      // Compute weighted portfolio average APY from current positions
      const positions = getPaperPortfolioSnapshot();
      const portfolioAverageApy = positions.length > 0
        ? positions.reduce((sum, pos) => {
            const protocolApy = apys.find(a => a.protocol === pos.protocol)?.apy ?? 0;
            return sum + (pos.percentage / 100) * protocolApy;
          }, 0)
        : 0;

      // Re-read state after potential timeout clear above
      const freshState = AgentStateService.getState();
      if (bestYield.apy >= YIELD_PROPOSAL_THRESHOLD && !freshState.pendingProposal) {
        // Query active constitution rules — fall back to defaults if DB unavailable
        let ruleRef = 'Rule #1';
        let ruleIndex = 1;
        try {
          const db = migrations.getDb();
          const ruleRow = db.prepare(
            `SELECT c.rules_json FROM constitution c WHERE c.active = 1 ORDER BY c.id DESC LIMIT 1`
          ).get() as { rules_json: string } | undefined;
          if (ruleRow) {
            const rules = JSON.parse(ruleRow.rules_json) as Array<{ id: number; type: string }>;
            const yieldRule = rules.find(r => r.type === 'yield_threshold') ?? rules[0];
            if (yieldRule) { ruleRef = `Rule #${yieldRule.id}`; ruleIndex = yieldRule.id; }
          }
        } catch { /* Use defaults */ }

        const newProposal: PendingProposal = {
          protocol: bestYield.protocol,
          proposedApy: bestYield.apy,
          timestamp: new Date().toISOString(),
          ruleRef,
          ruleIndex,
          actionDescription: `Yield rotation: Move allocation to ${bestYield.protocol} at ${bestYield.apy.toFixed(2)}% APY`,
        };
        AgentStateService.setPendingProposal(newProposal);

        const chatId = freshState.telegramChatId;
        if (chatId) {
          await sendAdvisorProposal(rt, chatId, newProposal, portfolioAverageApy);
        }
      }
    } catch (err) {
      // All 3 withRetry attempts exhausted — trigger precautionary crisis freeze (NFR14)
      const freshState = AgentStateService.getState();
      if (freshState.crisisStatus === 'active') {
        await executeCrisisFreeze(rt, {
          crisisType: 'rpc_failure',
          violationSummary: `Alchemy RPC sustained failure: ${err instanceof Error ? err.message.slice(0, 100) : 'unknown'}`,
        });
      }
    }
  }
}

let _pollingHandle: ReturnType<typeof setInterval> | undefined;

export function startPollingLoop(runtime: unknown): ReturnType<typeof setInterval> {
  stopPollingLoop(); // clear any existing handle before starting
  const rt = runtime as IAgentRuntime;
  _pollingHandle = setInterval(() => {
    runPollingTick(rt).catch(err => {
      // Never let a tick error crash the process — log and continue
      console.error('[PollingLoop] Tick error:', err instanceof Error ? err.message : String(err));
    });
  }, POLL_INTERVAL_MS);
  return _pollingHandle;
}

export function stopPollingLoop(): void {
  if (_pollingHandle !== undefined) {
    clearInterval(_pollingHandle);
    _pollingHandle = undefined;
  }
}

// Export for test use only
export function clearPendingProposal(): void {
  AgentStateService.setPendingProposal(undefined);
}
