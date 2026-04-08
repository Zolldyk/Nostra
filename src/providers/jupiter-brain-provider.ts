import type { Provider, ProviderResult } from '@elizaos/core';
import { buildMemoText } from '../actions/log-decision-on-chain.js';
import { WalletService } from '../services/wallet-service.js';

const JUPITER_QUOTE_URL = 'https://quote-api.jup.ag/v6/quote';
const TIMEOUT_MS = 10_000;
const JUPITER_UNAVAILABLE_MESSAGE = 'Jupiter routing unavailable — no action taken';

interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: unknown[];
}

async function writeJupiterUnavailableMemo(): Promise<void> {
  const memo = buildMemoText({
    actionDescription: 'No action taken. Jupiter routing unavailable.',
    ruleReference: 'Rule #0',
    complianceStatus: 'Constitutional compliance: N/A.',
  });
  await WalletService.writeMemo(memo);
}

export const JupiterBrainProvider: Provider = {
  name: 'JUPITER_BRAIN',
  description: 'Provides optimal swap routing via Jupiter V6 Quote API.',
  get: async (_runtime, message, _state): Promise<ProviderResult> => {
    const content = (message?.content ?? {}) as {
      inputMint?: string;
      outputMint?: string;
      amount?: number;
    };
    const { inputMint = '', outputMint = '', amount = 0 } = content;

    if (!inputMint || !outputMint || amount <= 0) {
      return {
        text: 'Jupiter: no routing query provided.',
        values: { available: false },
        data: {},
      };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: String(amount),
        slippageBps: '50',
      });
      const res = await fetch(`${JUPITER_QUOTE_URL}?${params}`, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!res.ok) throw new Error(`Jupiter HTTP ${res.status}`);

      const data = await res.json() as JupiterQuoteResponse;

      return {
        text: `Jupiter: ${data.inAmount} → ${data.outAmount} (impact: ${data.priceImpactPct}%)`,
        values: {
          available: true,
          inputMint: data.inputMint,
          outputMint: data.outputMint,
          inAmount: Number(data.inAmount),
          outAmount: Number(data.outAmount),
          priceImpactPct: Number(data.priceImpactPct),
          routePlan: data.routePlan,
        },
        data: { raw: data },
      };
    } catch (err) {
      clearTimeout(timeoutId);
      try {
        await writeJupiterUnavailableMemo();
      } catch {
        // memo write failure must not crash provider
      }
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      return {
        text: isTimeout ? 'Jupiter: 10s timeout — routing unavailable.' : 'Jupiter: routing error.',
        values: {
          available: false,
          errorMessage: JUPITER_UNAVAILABLE_MESSAGE,
          error_message: 'Jupiter routing unavailable',
        },
        data: {},
      };
    }
  },
};
