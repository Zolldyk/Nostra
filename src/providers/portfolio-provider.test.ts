import { describe, it, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as migrations from '../db/migrations.js';
import { AgentStateService } from '../services/agent-state-service.js';
import {
  PortfolioProvider,
  getPaperPortfolioSnapshot,
  reloadPortfolioCacheFromDb,
  replacePaperPortfolioCache,
  resetPortfolioCache,
  warmPortfolioCache,
} from './portfolio-provider.js';

const CREATE_PAPER_POSITIONS = `
CREATE TABLE IF NOT EXISTS paper_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  protocol TEXT NOT NULL,
  symbol TEXT NOT NULL,
  amount_usd REAL NOT NULL DEFAULT 0,
  percentage REAL NOT NULL DEFAULT 0,
  last_updated TEXT NOT NULL
)`;

function makeInMemoryDb(): Database {
  const db = new Database(':memory:');
  db.run(CREATE_PAPER_POSITIONS);
  return db;
}

describe('PortfolioProvider', () => {
  let getDbSpy: ReturnType<typeof spyOn>;
  let getStateSpy: ReturnType<typeof spyOn>;
  let inMemoryDb: Database;

  beforeEach(() => {
    inMemoryDb = makeInMemoryDb();
    resetPortfolioCache();
    getDbSpy = spyOn(migrations, 'getDb').mockReturnValue(inMemoryDb as ReturnType<typeof migrations.getDb>);
    getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue({
      mode: 'paper',
      trustLadder: 'advisor',
      crisisStatus: 'active',
      constitutionVersion: 0,
      accuracyScore: 0,
      suggestionsSampled: 0,
      onboardingState: 'complete',
      referralSource: undefined,
      updatedAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    resetPortfolioCache();
    getDbSpy.mockRestore();
    getStateSpy.mockRestore();
    inMemoryDb.close();
  });

  it('get() returns empty state when paper_positions table is empty', async () => {
    const result = await PortfolioProvider.get!(null as never, null as never, null as never);

    expect(result.values?.['totalSimulatedValue']).toBe(0);
    expect(result.text).toContain('no positions');
    expect(result.values?.['allocations']).toEqual([]);
  });

  it('get() returns position summary when rows exist', async () => {
    inMemoryDb.run(
      `INSERT INTO paper_positions (protocol, symbol, amount_usd, percentage, last_updated) VALUES (?, ?, ?, ?, ?)`,
      ['Kamino', 'USDC', 500, 50, new Date().toISOString()],
    );
    inMemoryDb.run(
      `INSERT INTO paper_positions (protocol, symbol, amount_usd, percentage, last_updated) VALUES (?, ?, ?, ?, ?)`,
      ['Marginfi', 'SOL', 500, 50, new Date().toISOString()],
    );
    warmPortfolioCache();

    const result = await PortfolioProvider.get!(null as never, null as never, null as never);

    expect(result.text).toContain('Kamino');
    expect(result.text).toContain('Marginfi');
    expect(result.values?.['totalSimulatedValue']).toBe(1000);
    expect((result.values?.['allocations'] as unknown[]).length).toBe(2);
  });

  it('get() reads from in-memory cache after startup warm', async () => {
    inMemoryDb.run(
      `INSERT INTO paper_positions (protocol, symbol, amount_usd, percentage, last_updated) VALUES (?, ?, ?, ?, ?)`,
      ['Kamino', 'USDC', 500, 50, new Date().toISOString()],
    );
    warmPortfolioCache();
    inMemoryDb.run('DELETE FROM paper_positions');

    const result = await PortfolioProvider.get!(null as never, null as never, null as never);

    expect(result.text).toContain('Kamino');
    expect(result.values?.['totalSimulatedValue']).toBe(500);
  });

  it('reloadPortfolioCacheFromDb() refreshes the in-memory snapshot after DB writes', () => {
    inMemoryDb.run(
      `INSERT INTO paper_positions (protocol, symbol, amount_usd, percentage, last_updated) VALUES (?, ?, ?, ?, ?)`,
      ['Drift', 'JTO', 250, 25, new Date().toISOString()],
    );

    const snapshot = reloadPortfolioCacheFromDb();

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.protocol).toBe('Drift');
    expect(getPaperPortfolioSnapshot()[0]?.symbol).toBe('JTO');
  });

  it('replacePaperPortfolioCache() updates the provider snapshot without re-reading SQLite', async () => {
    replacePaperPortfolioCache([
      {
        id: 99,
        protocol: 'Marginfi',
        symbol: 'SOL',
        amount_usd: 750,
        percentage: 75,
        last_updated: new Date().toISOString(),
      },
    ]);

    const result = await PortfolioProvider.get!(null as never, null as never, null as never);

    expect(result.text).toContain('Marginfi SOL');
    expect(result.values?.['totalSimulatedValue']).toBe(750);
  });

  it('get() does not make RPC calls in Paper mode', async () => {
    const origFetch = globalThis.fetch;
    let fetchWasCalled = false;
    globalThis.fetch = async () => {
      fetchWasCalled = true;
      return new Response('{}', { status: 200 });
    };

    const result = await PortfolioProvider.get!(null as never, null as never, null as never);

    globalThis.fetch = origFetch;

    expect(fetchWasCalled).toBe(false);
    expect(result.values?.['mode']).toBe('paper');
  });

  it('get() returns not-implemented message in Live mode', async () => {
    getStateSpy.mockReturnValue({
      mode: 'live',
      trustLadder: 'advisor',
      crisisStatus: 'active',
      constitutionVersion: 0,
      accuracyScore: 0,
      suggestionsSampled: 0,
      onboardingState: 'complete',
      referralSource: undefined,
      updatedAt: new Date().toISOString(),
    } as ReturnType<typeof AgentStateService.getState>);

    const result = await PortfolioProvider.get!(null as never, null as never, null as never);

    expect(result.text).toContain('not yet implemented');
  });
});
