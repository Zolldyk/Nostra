import {
  Connection,
  Keypair,
  Transaction,
  TransactionInstruction,
  PublicKey,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { withRetry } from '../utils/with-retry.js';
import { AgentStateService } from '../services/agent-state-service.js';

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const MEMO_MAX_CHARS = 500;
const MEMO_CONFIRM_TIMEOUT_MS = 10_000;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_PATTERN = /\b(?:\+?\d[\d\s().-]{7,}\d)\b/;

type SolanaNetwork = 'devnet' | 'mainnet-beta';

class WalletServiceImpl {
  private keypair: Keypair | null = null;
  private connection: Connection | null = null;
  private network: SolanaNetwork = 'devnet';

  private getRpcUrlForNetwork(network: SolanaNetwork): string {
    const legacyRpcUrl = process.env.ALCHEMY_RPC_URL;
    const rpcUrl = network === 'devnet'
      ? process.env.ALCHEMY_RPC_URL_DEVNET ?? legacyRpcUrl
      : process.env.ALCHEMY_RPC_URL_MAINNET ?? legacyRpcUrl;

    if (!rpcUrl) {
      const envName = network === 'devnet' ? 'ALCHEMY_RPC_URL_DEVNET' : 'ALCHEMY_RPC_URL_MAINNET';
      throw new Error(`${envName} env var is required but not set`);
    }

    return rpcUrl;
  }

  init(): void {
    const rawKey = process.env.SOLANA_PRIVATE_KEY;
    if (!rawKey) {
      throw new Error('SOLANA_PRIVATE_KEY env var is required but not set');
    }

    // Decode base58 private key — never log the key
    const secretKey = bs58.decode(rawKey);
    this.keypair = Keypair.fromSecretKey(secretKey);
    // Immediately wipe the raw key reference from scope
    // (JS GC will handle actual memory, but we avoid holding it in a named var)

    const networkEnv = process.env.SOLANA_NETWORK ?? 'devnet';
    if (networkEnv !== 'devnet' && networkEnv !== 'mainnet-beta') {
      throw new Error(`Invalid SOLANA_NETWORK: "${networkEnv}" — must be "devnet" or "mainnet-beta"`);
    }
    this.network = networkEnv;
    if (AgentStateService.getState().mode === 'paper' && this.network === 'mainnet-beta') {
      console.warn('[WalletService] Paper mode active — overriding network to devnet (FR44)');
      this.network = 'devnet';
    }
    const rpcUrl = this.getRpcUrlForNetwork(this.network);
    this.connection = new Connection(rpcUrl, 'confirmed');

    console.log(`WalletService initialised — network: ${this.network}, pubkey: ${this.keypair.publicKey.toBase58()}`);
    // NEVER log SOLANA_PRIVATE_KEY — use [REDACTED] in any key-related messages
  }

  getExplorerUrl(txHash: string): string {
    if (this.network === 'mainnet-beta') {
      return `https://explorer.solana.com/tx/${txHash}`;
    }
    return `https://explorer.solana.com/tx/${txHash}?cluster=devnet`;
  }

  async writeMemo(text: string): Promise<{ txHash: string; explorerUrl: string }> {
    if (!this.keypair || !this.connection) {
      throw new Error('WalletService not initialised — call init() first');
    }
    if (text.length > MEMO_MAX_CHARS) {
      throw new Error(`Memo exceeds ${MEMO_MAX_CHARS} character limit (got ${text.length})`);
    }

    const instruction = new TransactionInstruction({
      keys: [],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(text, 'utf-8'),
    });

    const transaction = new Transaction().add(instruction);

    const confirmTimeoutSignal = AbortSignal.timeout(MEMO_CONFIRM_TIMEOUT_MS);

    let txHash: string;
    try {
      txHash = await withRetry(async () =>
        Promise.race([
          sendAndConfirmTransaction(this.connection!, transaction, [this.keypair!], {
            commitment: 'confirmed',
          }),
          new Promise<never>((_, reject) => {
            confirmTimeoutSignal.addEventListener('abort', () =>
              reject(new Error(`Memo confirmation exceeded ${MEMO_CONFIRM_TIMEOUT_MS}ms timeout`)),
            );
          }),
        ]),
      );
    } catch (err) {
      throw err; // surface to 3-step error handler — never swallow
    }

    const explorerUrl = this.getExplorerUrl(txHash);
    return { txHash, explorerUrl };
  }

  /** Validate memo text — used in tests and pre-flight checks */
  validateMemoText(text: string): { valid: boolean; reason?: string } {
    if (text.length > MEMO_MAX_CHARS) {
      return { valid: false, reason: `Memo exceeds ${MEMO_MAX_CHARS} chars (got ${text.length})` };
    }
    if (EMAIL_PATTERN.test(text)) {
      return { valid: false, reason: 'Memo must not contain email addresses or other user PII' };
    }
    if (PHONE_PATTERN.test(text)) {
      return { valid: false, reason: 'Memo must not contain phone numbers or other user PII' };
    }
    return { valid: true };
  }
}

export const WalletService = new WalletServiceImpl();
