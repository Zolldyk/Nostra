import type { Action, ActionResult, IAgentRuntime, Memory } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';
import { WalletService } from '../services/wallet-service.js';
import { prependLivePrefix } from '../utils/live-prefix.js';
import * as migrations from '../db/migrations.js';

// Solana base58 public key — 32 to 44 chars, base58 alphabet
const SOLANA_PUBKEY_REGEX = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;

export const HandleWalletConnection: Action = {
  name: 'HANDLE_WALLET_CONNECTION',
  description: 'Handle user wallet address input to activate live mode after Trust Ladder promotion.',
  similes: ['CONNECT_WALLET', 'LIVE_MODE_ACTIVATION', 'WALLET_CONNECTED'],
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    try {
      const state = AgentStateService.getState();
      if (!state.promotionPending) return false;
      const text = (message.content?.text ?? '').trim();
      return SOLANA_PUBKEY_REGEX.test(text);
    } catch {
      return false;
    }
  },
  handler: async (_runtime: IAgentRuntime, message: Memory, _state, _options, callback): Promise<ActionResult | void | undefined> => {
    const db = migrations.getDb();

    // Switch to live mode and clear promotion flag
    await AgentStateService.setState({ mode: 'live', promotionPending: false }, db);

    let balanceLine = '';
    try {
      const { sol, publicKey } = await WalletService.getBalance();
      balanceLine = `\n\nWallet: \`${publicKey}\`\nSOL balance: ${sol.toFixed(4)} SOL`;
    } catch {
      balanceLine = '\n\n(Balance read failed — wallet may not be funded yet. Try /status once funded.)';
    }

    const confirmationText = prependLivePrefix(
      `Your wallet is connected. I'm switching to live mode — every action from here is real.${balanceLine}`
    );

    if (callback) {
      await callback({
        text: confirmationText,
        actions: [],
        source: 'nostra',
      });
    }

    return { success: true, data: { mode: 'live' } };
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', source: 'telegram' },
      },
      {
        name: 'Nostra',
        content: {
          text: '🔐 LIVE TREASURY\n\nYour wallet is connected. I\'m switching to live mode — every action from here is real.',
          actions: ['HANDLE_WALLET_CONNECTION'],
          source: 'nostra',
        },
      },
    ],
  ],
};
