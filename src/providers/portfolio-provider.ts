import type { Provider, ProviderResult } from '@elizaos/core';
import { AgentStateService } from '../services/agent-state-service.js';
import * as migrations from '../db/migrations.js';

interface PaperPosition {
  id: number;
  protocol: string;
  symbol: string;
  amount_usd: number;
  percentage: number;
  last_updated: string;
}

let cachedPaperPositions: PaperPosition[] | null = null;

function readPaperPositionsFromDb(): PaperPosition[] {
  const db = migrations.getDb();
  return db.prepare('SELECT * FROM paper_positions ORDER BY percentage DESC').all() as PaperPosition[];
}

export function warmPortfolioCache(): void {
  cachedPaperPositions = readPaperPositionsFromDb();
}

export function reloadPortfolioCacheFromDb(): PaperPosition[] {
  warmPortfolioCache();
  return getPaperPortfolioSnapshot();
}

export function replacePaperPortfolioCache(rows: PaperPosition[]): void {
  cachedPaperPositions = rows.map(row => ({ ...row }));
}

export function getPaperPortfolioSnapshot(): PaperPosition[] {
  if (cachedPaperPositions === null) {
    warmPortfolioCache();
  }
  return (cachedPaperPositions ?? []).map(row => ({ ...row }));
}

export function resetPortfolioCache(): void {
  cachedPaperPositions = null;
}

export const PortfolioProvider: Provider = {
  name: 'PORTFOLIO',
  description: 'Provides simulated Paper Treasury portfolio positions.',
  get: async (): Promise<ProviderResult> => {
    const state = AgentStateService.getState();

    if (state.mode !== 'paper') {
      return { text: 'Live portfolio reads: not yet implemented.', values: {}, data: {} };
    }

    const rows = getPaperPortfolioSnapshot();

    if (rows.length === 0) {
      return {
        text: 'Paper Treasury: no positions simulated yet.',
        values: { totalSimulatedValue: 0, allocations: [], mode: 'paper' },
        data: { positions: [] },
      };
    }

    const total = rows.reduce((sum, r) => sum + r.amount_usd, 0);
    const allocations = rows.map(r => ({
      protocol: r.protocol,
      symbol: r.symbol,
      amount: r.amount_usd,
      percentage: r.percentage,
    }));
    const positionLines = rows
      .map(r => `  ${r.protocol} ${r.symbol}: $${r.amount_usd.toFixed(2)} (${r.percentage.toFixed(1)}%)`)
      .join('\n');
    const text = `Portfolio (Paper):\n${positionLines}\nTotal: $${total.toFixed(2)}`;

    return {
      text,
      values: { totalSimulatedValue: total, allocations, mode: 'paper' },
      data: { positions: rows },
    };
  },
};
