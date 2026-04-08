import type { Action, ActionResult, HandlerCallback, IAgentRuntime, Memory } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';
import { WalletService } from '../services/wallet-service.js';
import { buildMemoText, buildRevealMessage } from './log-decision-on-chain.js';
import { reloadPortfolioCacheFromDb } from '../providers/portfolio-provider.js';
import { prependPaperPrefix } from '../utils/paper-prefix.js';
import { handleActionError } from '../utils/action-error-handler.js';
import * as migrations from '../db/migrations.js';

const PROTOCOL_SYMBOL_MAP: Record<string, string> = {
  Kamino: 'USDC',
  Marginfi: 'SOL',
  Drift: 'JTO',
};

interface PaperPositionRow {
  id: number;
  protocol: string;
  symbol: string;
  amount_usd: number;
  percentage: number;
  last_updated: string;
}

export function applyPaperRotation(targetProtocol: string): void {
  const db = migrations.getDb();
  const rows = db.prepare('SELECT * FROM paper_positions ORDER BY percentage ASC, id ASC').all() as PaperPositionRow[];

  if (rows.length === 0) {
    // Seed with default position in target protocol
    const symbol = PROTOCOL_SYMBOL_MAP[targetProtocol] ?? 'USDC';
    db.prepare(
      `INSERT INTO paper_positions (protocol, symbol, amount_usd, percentage, last_updated)
       VALUES (?, ?, 1000, 100, ?)`
    ).run(targetProtocol, symbol, new Date().toISOString());
    reloadPortfolioCacheFromDb();
    return;
  }

  // Find total portfolio value
  const total = rows.reduce((sum, r) => sum + r.amount_usd, 0);

  // Source = lowest-percentage row (deterministic tiebreak by id)
  const source = rows[0];

  // No-op if source is already the target
  if (source.protocol === targetProtocol) {
    reloadPortfolioCacheFromDb();
    return;
  }

  // Clamp transfer to what source actually holds to prevent USD inflation
  const transferAmount = Math.min(total * 0.20, source.amount_usd);
  const transferPct = Math.min(20, source.percentage);
  const now = new Date().toISOString();

  const rotate = db.transaction(() => {
    // Decrement source row
    db.prepare(
      `UPDATE paper_positions SET amount_usd = ?, percentage = ?, last_updated = ? WHERE id = ?`
    ).run(
      source.amount_usd - transferAmount,
      source.percentage - transferPct,
      now,
      source.id,
    );

    // Check if target already exists
    const targetRow = rows.find(r => r.protocol === targetProtocol);
    if (targetRow) {
      db.prepare(
        `UPDATE paper_positions SET amount_usd = ?, percentage = ?, last_updated = ? WHERE id = ?`
      ).run(
        targetRow.amount_usd + transferAmount,
        targetRow.percentage + transferPct,
        now,
        targetRow.id,
      );
    } else {
      const symbol = PROTOCOL_SYMBOL_MAP[targetProtocol] ?? 'USDC';
      db.prepare(
        `INSERT INTO paper_positions (protocol, symbol, amount_usd, percentage, last_updated)
         VALUES (?, ?, ?, ?, ?)`
      ).run(targetProtocol, symbol, transferAmount, transferPct, now);
    }
  });

  rotate();
  reloadPortfolioCacheFromDb();
}

function recordSuggestion(suggestionId: string): void {
  const db = migrations.getDb();
  db.prepare(
    `INSERT OR IGNORE INTO trust_ladder_log (suggestion_id, user_grade, created_at, status)
     VALUES (?, 0, ?, 'pending')`
  ).run(suggestionId, new Date().toISOString());
}

async function writeMemoAndReveal(
  actionDescription: string,
  ruleRef: string,
  complianceStatus: string,
  actionType: 'ACTION' | 'NON_ACTION',
  callback: HandlerCallback | undefined,
): Promise<void> {
  const memoText = buildMemoText({ actionDescription, ruleReference: ruleRef, complianceStatus });
  const { txHash, explorerUrl } = await WalletService.writeMemo(memoText);

  const db = migrations.getDb();
  db.prepare(
    `INSERT OR IGNORE INTO on_chain_memos (tx_hash, action_type, memo_text, explorer_url, status, created_at)
     VALUES (?, ?, ?, ?, 'confirmed', ?)`
  ).run(txHash, actionType, memoText, explorerUrl, new Date().toISOString());

  if (callback) {
    await callback({
      text: prependPaperPrefix(buildRevealMessage(actionDescription, memoText, explorerUrl)),
      actions: [],
      source: 'nostra',
    });
  }
}

export const HandleProposalResponse: Action = {
  name: 'HANDLE_PROPOSAL_RESPONSE',
  description: 'Process user approval or rejection of a treasury rotation proposal.',
  similes: ['APPROVE_PROPOSAL', 'REJECT_PROPOSAL'],
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = (message.content?.text ?? '').trim();
    return text === 'approve_proposal' || text === 'reject_proposal';
  },
  handler: async (runtime: IAgentRuntime, message: Memory, _state, _options, callback): Promise<ActionResult | void | undefined> => {
    const text = (message.content?.text ?? '').trim();
    const isApprove = text === 'approve_proposal';
    const proposal = AgentStateService.getState().pendingProposal;

    if (!proposal) {
      if (callback) await callback({
        text: prependPaperPrefix('No pending proposal found — it may have already been decided or timed out.'),
        actions: [],
        source: 'nostra',
      });
      return;
    }

    try {
      if (isApprove) {
        applyPaperRotation(proposal.protocol);
        const complianceStatus = 'Paper Treasury rotation approved. Constitutional compliance: 100%.';
        await writeMemoAndReveal(proposal.actionDescription, proposal.ruleRef, complianceStatus, 'ACTION', callback);
        recordSuggestion(proposal.timestamp);
      } else {
        const rejectDescription = `User rejected proposed rotation to ${proposal.protocol}`;
        const complianceStatus = 'Non-action memo. User override recorded.';
        await writeMemoAndReveal(rejectDescription, proposal.ruleRef, complianceStatus, 'NON_ACTION', callback);
        recordSuggestion(proposal.timestamp);
      }
    } catch (error) {
      await handleActionError(
        async (msg) => {
          await runtime.sendMessageToTarget(
            { source: 'telegram', roomId: message.roomId },
            { text: msg, actions: [], source: 'nostra' },
          );
        },
        async () => {
          const errorMemo = buildMemoText({
            actionDescription: `Error in HANDLE_PROPOSAL_RESPONSE: ${error instanceof Error ? error.message.slice(0, 100) : 'unknown'}`,
            ruleReference: proposal?.ruleRef ?? 'Rule #0',
            complianceStatus: 'Non-action memo. System error logged.',
          });
          await WalletService.writeMemo(errorMemo);
        },
        error,
      );
    } finally {
      AgentStateService.setPendingProposal(undefined);
    }
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'approve_proposal', source: 'telegram' },
      },
      {
        name: 'Nostra',
        content: {
          text: '✅ Rotation approved and recorded on-chain.',
          actions: ['HANDLE_PROPOSAL_RESPONSE'],
          source: 'nostra',
        },
      },
    ],
  ],
};
