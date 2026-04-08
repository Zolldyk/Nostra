import type { Action, ActionResult, IAgentRuntime, Memory } from '@elizaos/core';
import * as migrations from '../db/migrations.js';
import { WalletService } from '../services/wallet-service.js';
import { handleActionError } from '../utils/action-error-handler.js';

const MEMO_MAX_CHARS = 500;
const ACTION_SUMMARY_MAX_CHARS = 80;

export interface MemoParams {
  actionDescription: string;
  ruleReference: string;       // e.g. "Rule #3"
  complianceStatus: string;    // e.g. "Constitutional compliance: 100%."
}

export function buildMemoText(params: MemoParams): string {
  const timestamp = new Date().toISOString();
  const { ruleReference, complianceStatus } = params;

  const fixedPart = `${timestamp} — `;
  const suffix = ` ${ruleReference}. ${complianceStatus}`;
  const maxDescriptionLength = MEMO_MAX_CHARS - fixedPart.length - suffix.length;

  let desc = params.actionDescription;
  if (desc.length > maxDescriptionLength) {
    desc = desc.slice(0, maxDescriptionLength - 1) + '…';
  }

  return `${fixedPart}${desc}${suffix}`;
}

export function buildRevealMessage(actionSummary: string, memoText: string, explorerUrl: string): string {
  const singleLineSummary = actionSummary.replace(/\s+/g, ' ').trim();
  const summary = singleLineSummary.length > ACTION_SUMMARY_MAX_CHARS
    ? singleLineSummary.slice(0, ACTION_SUMMARY_MAX_CHARS - 1) + '…'
    : singleLineSummary;
  return `${summary}\n\`${memoText}\`\n🔗 ${explorerUrl}`;
}

export const LogDecisionOnChain: Action = {
  name: 'LOG_DECISION_ON_CHAIN',
  description: 'Write a Lamport memo to Solana recording a constitutional decision or action.',
  similes: ['WRITE_MEMO', 'RECORD_DECISION', 'ON_CHAIN_LOG'],
  validate: async () => true,
  handler: async (runtime: IAgentRuntime, message: Memory, _state, _options, callback): Promise<ActionResult | void | undefined> => {
    const content = message.content as {
      actionDescription?: string;
      ruleReference?: string;
      complianceStatus?: string;
      actionType?: 'ACTION' | 'NON_ACTION';
    };

    const actionDescription = content.actionDescription ?? 'System initialisation complete. AgentStateService online.';
    const ruleReference = content.ruleReference ?? 'Rule #0';
    const complianceStatus = content.complianceStatus ?? 'System initialisation.';
    const actionType = content.actionType ?? 'ACTION';

    const memoText = buildMemoText({ actionDescription, ruleReference, complianceStatus });

    try {
      const { txHash, explorerUrl } = await WalletService.writeMemo(memoText);

      const db = migrations.getDb();
      db.prepare(
        `INSERT OR IGNORE INTO on_chain_memos (tx_hash, action_type, memo_text, explorer_url, status, created_at)
         VALUES (?, ?, ?, ?, 'confirmed', ?)`
      ).run(txHash, actionType, memoText, explorerUrl, new Date().toISOString());

      if (callback) {
        await callback({
          text: buildRevealMessage(actionDescription, memoText, explorerUrl),
          actions: [],
          source: 'nostra',
        });
      }
      return { success: true, data: { txHash, explorerUrl, memoText } };
    } catch (error) {
      try {
        const db = migrations.getDb();
        const failedTxHash = `FAILED_${new Date().toISOString()}_${crypto.randomUUID()}`;
        db.prepare(
          `INSERT OR IGNORE INTO on_chain_memos (tx_hash, action_type, memo_text, explorer_url, status, created_at)
           VALUES (?, ?, ?, 'N/A', 'failed', ?)`
        ).run(failedTxHash, actionType, memoText, new Date().toISOString());
      } catch {
        // DB write in error path — never let it mask the original error
      }

      await handleActionError(
        async (msg) => {
          await runtime.sendMessageToTarget(
            { source: 'telegram', roomId: message.roomId },
            { text: msg, actions: [], source: 'nostra' },
          );
        },
        async () => {
          const errorMemo = buildMemoText({
            actionDescription: `Error in LOG_DECISION_ON_CHAIN: ${error instanceof Error ? error.message.slice(0, 100) : 'unknown'}`,
            ruleReference: 'Rule #0',
            complianceStatus: 'Non-action memo. System error logged.',
          });
          await WalletService.writeMemo(errorMemo);
        },
        error,
      );
    }
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Log a decision on chain', source: 'telegram' },
      },
      {
        name: 'Nostra',
        content: {
          text: '✅ On-chain memo recorded.',
          actions: ['LOG_DECISION_ON_CHAIN'],
          source: 'nostra',
        },
      },
    ],
  ],
};
