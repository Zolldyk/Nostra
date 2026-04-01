import { describe, it, expect } from 'bun:test';
import { WalletService } from './wallet-service.js';

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
    const savedRpc = process.env.ALCHEMY_RPC_URL;
    delete process.env.SOLANA_PRIVATE_KEY;
    delete process.env.ALCHEMY_RPC_URL;

    expect(() => WalletService.init()).toThrow('SOLANA_PRIVATE_KEY');

    process.env.SOLANA_PRIVATE_KEY = savedKey ?? '';
    if (savedRpc) process.env.ALCHEMY_RPC_URL = savedRpc;
  });

  it('throws if ALCHEMY_RPC_URL is missing', () => {
    const savedKey = process.env.SOLANA_PRIVATE_KEY;
    const savedRpc = process.env.ALCHEMY_RPC_URL;

    // Provide a valid-looking base58 key for testing
    process.env.SOLANA_PRIVATE_KEY = '5J3mBbAH58CpQ3Y5RNJpUKPE62SQ5tfv2z5N7JMVo1c7TvTbbRCN2YkGSbsH9kVDuHxUDJLJMjJCiNiTa6BzMgA';
    delete process.env.ALCHEMY_RPC_URL;

    expect(() => WalletService.init()).toThrow('ALCHEMY_RPC_URL');

    process.env.SOLANA_PRIVATE_KEY = savedKey ?? '';
    if (savedRpc) process.env.ALCHEMY_RPC_URL = savedRpc;
  });
});
