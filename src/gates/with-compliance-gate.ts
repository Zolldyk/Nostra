import type { Action, ActionResult, HandlerCallback, IAgentRuntime, Memory, State } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';
import { ConstitutionService } from '../services/constitution-service.js';
import { WalletService } from '../services/wallet-service.js';
import { checkConstitutionalCompliance, type ComplianceCheckInput } from '../actions/check-constitutional-compliance.js';
import { buildMemoText } from '../actions/log-decision-on-chain.js';
import * as migrations from '../db/migrations.js';

type ActionHandler = (
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
  options?: unknown,
  callback?: HandlerCallback,
) => Promise<ActionResult | void | undefined>;

function extractProposedAction(message: Memory): ComplianceCheckInput | null {
  const content = message.content as Record<string, unknown> | undefined;
  if (!content) return null;
  const metric = content['metric'];
  const value = content['value'];
  const unit = content['unit'];
  if (typeof metric !== 'string' || typeof value !== 'number' || typeof unit !== 'string') {
    return null;
  }
  return { metric, value, unit };
}

async function sendCallback(
  callback: HandlerCallback | undefined,
  text: string,
): Promise<void> {
  if (callback) {
    await callback({ text, actions: [], source: 'nostra' });
  }
}

function ensureSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return 'Constitutional violation.';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function withComplianceGate(action: Action): Action;
export function withComplianceGate(handler: ActionHandler): ActionHandler;
export function withComplianceGate(actionOrHandler: Action | ActionHandler): Action | ActionHandler {
  if (typeof actionOrHandler === 'function') {
    return withComplianceGateHandler(actionOrHandler);
  }
  return {
    ...actionOrHandler,
    handler: withComplianceGateHandler(actionOrHandler.handler as unknown as ActionHandler),
  };
}

function withComplianceGateHandler(handler: ActionHandler): ActionHandler {
  return async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ) => {
    const agentState = AgentStateService.getState();

    // Gate 1: Crisis Protocol — block if frozen or resolving
    if (agentState.crisisStatus !== 'active') {
      await sendCallback(
        callback,
        `🚨 All actions are frozen. Crisis Protocol status: ${agentState.crisisStatus}. No transactions will be submitted until the crisis is resolved.`,
      );
      return;
    }

    // Gate 2: Constitutional compliance — consult the active constitution from DB every time
    const db = migrations.getDb();
    const constitution = ConstitutionService.getActive(db);
    if (constitution && constitution.rules.length > 0) {
      const proposed = extractProposedAction(message);
      if (proposed) {
        const result = checkConstitutionalCompliance(constitution.rules, proposed);
        if (!result.passed) {
          const violation = ensureSentence(result.violation ?? 'Constitutional violation');
          // Write non-action Lamport memo with violated rule cited (NFR13)
          const memoText = buildMemoText({
            actionDescription: `NON_ACTION: ${violation}`,
            ruleReference: result.ruleRef ? `Rule #${result.ruleRef}` : 'Rule #0',
            complianceStatus: 'Constitutional compliance: BLOCKED.',
          });
          try {
            const { txHash } = await WalletService.writeMemo(memoText);
            try {
              db.prepare(
                `INSERT OR IGNORE INTO on_chain_memos (tx_hash, action_type, memo_text, explorer_url, status, created_at)
                 VALUES (?, 'NON_ACTION', ?, ?, 'confirmed', ?)`,
              ).run(txHash, memoText, WalletService.getExplorerUrl(txHash), new Date().toISOString());
            } catch {
              // DB write in error path — never mask the gate block
            }
          } catch {
            // Memo write failure must never unblock the gate
          }
          await sendCallback(
            callback,
            `🚫 Action blocked: ${result.violation ?? 'Constitutional violation'}${result.ruleRef ? ` (Rule #${result.ruleRef})` : ''}.`,
          );
          return;
        }
      }
    }

    // Gate 3: Trust Ladder — block if Advisor Mode
    if (agentState.trustLadder === 'advisor') {
      await sendCallback(
        callback,
        `📊 Advisory Mode. I'd recommend this action but cannot execute it yet — I need live execution authority first. Current accuracy: ${agentState.accuracyScore.toFixed(1)}% across ${agentState.suggestionsSampled} suggestion${agentState.suggestionsSampled !== 1 ? 's' : ''}.`,
      );
      return;
    }

    return handler(runtime, message, state, options, callback);
  };
}
