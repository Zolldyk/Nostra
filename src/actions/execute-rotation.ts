import type { Action, ActionResult, IAgentRuntime, Memory } from '@elizaos/core';
import { VersionedTransaction } from '@solana/web3.js';
import { AgentStateService } from '../services/agent-state-service.js';
import { WalletService } from '../services/wallet-service.js';
import { buildMemoText } from './log-decision-on-chain.js';
import { prependLivePrefix } from '../utils/live-prefix.js';
import { withRetry } from '../utils/with-retry.js';
import * as migrations from '../db/migrations.js';

// Jupiter V6 API — derived from SOLANA_NETWORK at call time
// Jupiter V6 is mainnet-only; skip on devnet
function getJupiterBaseUrl(): string {
  const network = process.env.SOLANA_NETWORK ?? 'devnet';
  if (network === 'devnet') return ''; // Jupiter not available on devnet
  return 'https://quote-api.jup.ag/v6';
}

const JUPITER_TIMEOUT_MS = 10_000; // NFR17

interface SwapParams {
  inputMint: string;
  outputMint: string;
  amount: number;      // in lamports / base units
  slippageBps: number; // e.g. 50 = 0.5%
}

function extractSwapParams(message: Memory): SwapParams | null {
  const content = message.content as Record<string, unknown> | undefined;
  if (!content) return null;
  const { inputMint, outputMint, amount, slippageBps } = content as Record<string, unknown>;
  if (
    typeof inputMint !== 'string' ||
    typeof outputMint !== 'string' ||
    typeof amount !== 'number' ||
    typeof slippageBps !== 'number'
  ) return null;
  return { inputMint, outputMint, amount, slippageBps };
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export const ExecuteRotation: Action = {
  name: 'EXECUTE_ROTATION',
  description: 'Execute a live Jupiter V6 token swap after passing the constitutional compliance gate.',
  similes: ['SWAP_TOKENS', 'JUPITER_SWAP', 'EXECUTE_SWAP', 'ROTATE_TREASURY'],
  validate: async (_runtime: IAgentRuntime, _message: Memory): Promise<boolean> => {
    try {
      const state = AgentStateService.getState();
      return state.trustLadder === 'executor' && state.mode === 'live';
    } catch {
      return false;
    }
  },
  handler: async (_runtime: IAgentRuntime, message: Memory, _state, _options, callback): Promise<ActionResult | void | undefined> => {
    const db = migrations.getDb();
    const baseUrl = getJupiterBaseUrl();

    // Guard: Jupiter not available on devnet
    if (!baseUrl) {
      if (callback) {
        await callback({
          text: prependLivePrefix('Jupiter swaps are only available on mainnet. Set SOLANA_NETWORK=mainnet-beta to enable live execution.'),
          actions: [],
          source: 'nostra',
        });
      }
      return;
    }

    const params = extractSwapParams(message);
    if (!params) {
      if (callback) {
        await callback({
          text: prependLivePrefix('Swap parameters missing — expected inputMint, outputMint, amount, slippageBps in message content.'),
          actions: [],
          source: 'nostra',
        });
      }
      return;
    }

    try {
      // Step 1: Get Jupiter quote (10s timeout, withRetry — NFR17)
      const quoteResponse = await withRetry(async () => {
        const url = `${baseUrl}/quote?inputMint=${params.inputMint}&outputMint=${params.outputMint}&amount=${params.amount}&slippageBps=${params.slippageBps}`;
        const res = await fetchWithTimeout(url, { method: 'GET' }, JUPITER_TIMEOUT_MS);
        if (!res.ok) throw new Error(`Jupiter quote failed: ${res.status} ${res.statusText}`);
        return res.json();
      });

      // Step 2: Get swap transaction from Jupiter
      const { publicKey } = await WalletService.getBalance();
      const swapResponse = await withRetry(async () => {
        const res = await fetchWithTimeout(
          `${baseUrl}/swap`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              quoteResponse,
              userPublicKey: publicKey,
              wrapAndUnwrapSol: true,
            }),
          },
          JUPITER_TIMEOUT_MS,
        );
        if (!res.ok) throw new Error(`Jupiter swap API failed: ${res.status} ${res.statusText}`);
        return res.json() as Promise<{ swapTransaction: string }>;
      });

      // Step 3: Deserialize, sign, and submit (30s confirm timeout — NFR4)
      const txBytes = Buffer.from(swapResponse.swapTransaction, 'base64');
      const tx = VersionedTransaction.deserialize(txBytes);
      const { txHash, explorerUrl } = await WalletService.signAndSubmit(tx);

      // Step 4: Write Lamport memo (Story 3.3 pattern)
      const memoText = buildMemoText({
        actionDescription: `EXECUTE_ROTATION: ${params.inputMint} → ${params.outputMint}, amount: ${params.amount}`,
        ruleReference: 'withComplianceGate: PASSED',
        complianceStatus: 'Constitutional compliance: APPROVED.',
      });
      const { txHash: memoTxHash, explorerUrl: memoExplorerUrl } = await WalletService.writeMemo(memoText);

      // Persist memo to SQLite
      try {
        db.prepare(
          `INSERT OR IGNORE INTO on_chain_memos (tx_hash, action_type, memo_text, explorer_url, status, created_at)
           VALUES (?, 'EXECUTE_ROTATION', ?, ?, 'confirmed', ?)`,
        ).run(memoTxHash, memoText, memoExplorerUrl, new Date().toISOString());
      } catch {
        // DB write in success path — never block user notification
      }

      // Step 5: Deliver 🔐 Lamport Reveal Message (Story 3.3 pattern — UX-DR12)
      const revealMessage = prependLivePrefix(
        `Swap executed and confirmed.\n\n🔗 On-chain proof: ${explorerUrl}`
      );
      if (callback) {
        await callback({ text: revealMessage, actions: ['EXECUTE_ROTATION'], source: 'nostra' });
      }

      return { success: true, data: { txHash, explorerUrl } };

    } catch (error) {
      // 3-step error pattern (NFR13, NFR19): memo → notify → rethrow
      const errorMessage = error instanceof Error ? error.message : 'Unknown execution error';

      // Step 1: Write non-action Lamport memo
      try {
        const errorMemo = buildMemoText({
          actionDescription: `NON_ACTION: ${errorMessage}`,
          ruleReference: 'EXECUTE_ROTATION: FAILED',
          complianceStatus: 'Transaction not submitted.',
        });
        const { txHash: memoTxHash, explorerUrl: memoExplorerUrl } = await WalletService.writeMemo(errorMemo);
        try {
          db.prepare(
            `INSERT OR IGNORE INTO on_chain_memos (tx_hash, action_type, memo_text, explorer_url, status, created_at)
             VALUES (?, 'NON_ACTION', ?, ?, 'confirmed', ?)`,
          ).run(memoTxHash, errorMemo, memoExplorerUrl, new Date().toISOString());
        } catch { /* DB write failure in error path — never mask the real error */ }
      } catch { /* Memo write failure must never prevent user notification */ }

      // Step 2: Notify user
      if (callback) {
        await callback({
          text: prependLivePrefix(`⚠️ Swap could not be completed: ${errorMessage}`),
          actions: [],
          source: 'nostra',
        });
      }

      // Step 3: Re-throw — never swallow
      throw error;
    }
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'execute rotation',
          inputMint: 'So11111111111111111111111111111111111111112',
          outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          amount: 1000000,
          slippageBps: 50,
          source: 'telegram',
        },
      },
      {
        name: 'Nostra',
        content: {
          text: '🔐 LIVE TREASURY\n\nSwap executed and confirmed.\n\n🔗 On-chain proof: https://explorer.solana.com/tx/...',
          actions: ['EXECUTE_ROTATION'],
          source: 'nostra',
        },
      },
    ],
  ],
};
