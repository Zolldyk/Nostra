export const CREATE_AGENT_STATE = `
CREATE TABLE IF NOT EXISTS agent_state (
  id INTEGER PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'paper',
  trust_ladder TEXT NOT NULL DEFAULT 'advisor',
  crisis_status TEXT NOT NULL DEFAULT 'active',
  constitution_version INTEGER NOT NULL DEFAULT 0,
  accuracy_score REAL NOT NULL DEFAULT 0,
  suggestions_sampled INTEGER NOT NULL DEFAULT 0,
  onboarding_state TEXT NOT NULL DEFAULT 'pending',
  referral_source TEXT,
  promotion_pending INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
)`;

export const CREATE_CONSTITUTION = `
CREATE TABLE IF NOT EXISTS constitution (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL,
  rules_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0
)`;

export const CREATE_CONSTITUTION_RULES = `
CREATE TABLE IF NOT EXISTS constitution_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  constitution_id INTEGER NOT NULL REFERENCES constitution(id),
  rule_index INTEGER NOT NULL,
  rule_json TEXT NOT NULL
)`;

export const CREATE_ON_CHAIN_MEMOS = `
CREATE TABLE IF NOT EXISTS on_chain_memos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_hash TEXT NOT NULL UNIQUE,
  action_type TEXT NOT NULL,
  memo_text TEXT NOT NULL,
  explorer_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed'
)`;

export const CREATE_TRUST_LADDER_LOG = `
CREATE TABLE IF NOT EXISTS trust_ladder_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suggestion_id TEXT NOT NULL UNIQUE,
  user_grade INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
)`;

export const CREATE_ONBOARDING_SESSION = `
CREATE TABLE IF NOT EXISTS onboarding_session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK(role IN ('agent', 'user')),
  content TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'questions',
  created_at TEXT NOT NULL
)`;

export const CREATE_PAPER_POSITIONS = `
CREATE TABLE IF NOT EXISTS paper_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  protocol TEXT NOT NULL,
  symbol TEXT NOT NULL,
  amount_usd REAL NOT NULL DEFAULT 0,
  percentage REAL NOT NULL DEFAULT 0,
  last_updated TEXT NOT NULL
)`;

export const ALL_SCHEMAS = [
  CREATE_AGENT_STATE,
  CREATE_CONSTITUTION,
  CREATE_CONSTITUTION_RULES,
  CREATE_ON_CHAIN_MEMOS,
  CREATE_TRUST_LADDER_LOG,
  CREATE_ONBOARDING_SESSION,
  CREATE_PAPER_POSITIONS,
] as const;
