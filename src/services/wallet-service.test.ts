import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { AgentStateService } from './agent-state-service.js';
import { WalletService } from './wallet-service.js';

const VALID_TEST_KEY = '5y5g74zHWFUof63qtAq9oSNgbsZDTNsFrjaJYvsa18ywdjvrbmgb8YhPCF6SePjwFdALhtKEoowDbzjG6aNbUBmm';

afterEach(() => {
  delete process.env.ALCHEMY_RPC_URL_DEVNET;
  delete process.env.ALCHEMY_RPC_URL_MAINNET;
  delete process.env.ALCHEMY_RPC_URL;
  delete process.env.SOLANA_PRIVATE_KEY;
  delete process.env.SOLANA_NETWORK;
});

// We test the non-network methods only (no live Alchemy calls in unit tests)
// Integration test for writeMemo is documented in Dev Agent Record (requires funded devnet wallet)

describe('WalletService.getExplorerUrl()', () => {
  it('returns devnet URL when SOLANA_NETWORK=devnet', () => {
    // Access private method via cast for unit testing
    const svc = WalletService as unknown as {
      network: string;
      getExplorerUrl: (txHash: string) => string;
    };
    svc.network = 'devnet';
    const url = svc.getExplorerUrl('abc123');
    expect(url).toBe('https://explorer.solana.com/tx/abc123?cluster=devnet');
  });

  it('returns mainnet URL when SOLANA_NETWORK=mainnet-beta', () => {
    const svc = WalletService as unknown as {
      network: string;
      getExplorerUrl: (txHash: string) => string;
    };
    svc.network = 'mainnet-beta';
    const url = svc.getExplorerUrl('xyz789');
    expect(url).toBe('https://explorer.solana.com/tx/xyz789');
  });
});

describe('WalletService.validateMemoText()', () => {
  it('accepts memo at exactly 500 chars', () => {
    const text = 'A'.repeat(500);
    const result = WalletService.validateMemoText(text);
    expect(result.valid).toBe(true);
  });

  it('rejects memo over 500 chars', () => {
    const text = 'A'.repeat(501);
    const result = WalletService.validateMemoText(text);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('500');
  });

  it('rejects email addresses as PII', () => {
    const result = WalletService.validateMemoText('User email is alice@example.com');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('PII');
  });

  it('rejects phone numbers as PII', () => {
    const result = WalletService.validateMemoText('Call me on +1 555 123 4567');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('PII');
  });

  it('accepts empty memo', () => {
    const result = WalletService.validateMemoText('');
    expect(result.valid).toBe(true);
  });
});

describe('WalletService.init() — missing env vars', () => {
  it('throws if SOLANA_PRIVATE_KEY is missing', () => {
    const savedKey = process.env.SOLANA_PRIVATE_KEY;
    const savedDevnetRpc = process.env.ALCHEMY_RPC_URL_DEVNET;
    delete process.env.SOLANA_PRIVATE_KEY;
    delete process.env.ALCHEMY_RPC_URL_DEVNET;

    expect(() => WalletService.init()).toThrow('SOLANA_PRIVATE_KEY');

    process.env.SOLANA_PRIVATE_KEY = savedKey ?? '';
    if (savedDevnetRpc) process.env.ALCHEMY_RPC_URL_DEVNET = savedDevnetRpc;
  });

  it('throws if ALCHEMY_RPC_URL_DEVNET is missing', () => {
    const savedKey = process.env.SOLANA_PRIVATE_KEY;
    const savedDevnetRpc = process.env.ALCHEMY_RPC_URL_DEVNET;

    process.env.SOLANA_PRIVATE_KEY = VALID_TEST_KEY;
    delete process.env.ALCHEMY_RPC_URL_DEVNET;

    const getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue({
      mode: 'paper',
      trustLadder: 'advisor',
      crisisStatus: 'active',
      constitutionVersion: 0,
      accuracyScore: 0,
      suggestionsSampled: 0,
      onboardingState: 'complete',
      updatedAt: new Date().toISOString(),
    });

    expect(() => WalletService.init()).toThrow('ALCHEMY_RPC_URL_DEVNET');

    getStateSpy.mockRestore();

    process.env.SOLANA_PRIVATE_KEY = savedKey ?? '';
    if (savedDevnetRpc) process.env.ALCHEMY_RPC_URL_DEVNET = savedDevnetRpc;
  });

  it('uses the devnet RPC URL when Paper mode overrides mainnet', () => {
    process.env.SOLANA_PRIVATE_KEY = VALID_TEST_KEY;
    process.env.SOLANA_NETWORK = 'mainnet-beta';
    process.env.ALCHEMY_RPC_URL_DEVNET = 'https://devnet.example';
    process.env.ALCHEMY_RPC_URL_MAINNET = 'https://mainnet.example';

    const getStateSpy = spyOn(AgentStateService, 'getState').mockReturnValue({
      mode: 'paper',
      trustLadder: 'advisor',
      crisisStatus: 'active',
      constitutionVersion: 0,
      accuracyScore: 0,
      suggestionsSampled: 0,
      onboardingState: 'complete',
      updatedAt: new Date().toISOString(),
    });

    WalletService.init();

    const svc = WalletService as unknown as {
      network: string;
      connection: { rpcEndpoint: string };
    };
    expect(svc.network).toBe('devnet');
    expect(svc.connection.rpcEndpoint).toBe('https://devnet.example');

    getStateSpy.mockRestore();
  });
});
