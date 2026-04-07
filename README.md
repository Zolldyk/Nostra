# Nostra — The Sovereign Kid

![Nosana x ElizaOS challenge banner](./assets/NosanaXEliza.jpg)

> **Your rules. Your chain. Your agent.**

[![Live on Nosana](https://img.shields.io/badge/Live%20on%20Nosana-RTX%204090-14C9A0?style=flat-square)](https://3FZ2EyGUSy3ehMXtANL7ZC3Rx29YNcp1HtnuPSe3mV4F.node.k8s.prd.nos.ci)
[![Telegram Bot](https://img.shields.io/badge/Telegram-@zoll__arb__bot-2CA5E0?style=flat-square&logo=telegram)](https://t.me/zoll_arb_bot)
[![Branch](https://img.shields.io/badge/branch-elizaos--challenge-E8B86D?style=flat-square)](https://github.com/Zolldyk/Nostra/tree/elizaos-challenge)

---

## What is Nostra

Nostra is a constitutional DeFi agent — a financial companion that acts only when you say it can, proves every decision on-chain, and freezes itself the moment your rules are broken. It does not ask for permission to think. It asks for permission to act.

Built on ElizaOS v2 and deployed on Nosana's decentralized GPU network, Nostra implements a **Trust Ladder**: the agent starts as a read-only observer, earns the right to simulate, and only graduates to live execution after you have verified it understands your constitution. Every swap, every non-action, and every constitutional override is written to the Solana Memo Program — a permanent, tamper-proof audit trail you own.

Nostra speaks your language through Telegram. No web dashboard, no login wall — just a bot that knows your rules and proves it keeps them.

---

## Architecture Overview

Nostra is a single-container ElizaOS v2 agent with a layered plugin architecture:

| Layer | Component | Technology |
|-------|-----------|------------|
| Interface | Telegram client | `@elizaos/plugin-telegram` |
| Constitution Engine | Parse → validate → gate | Custom ElizaOS Action/Provider |
| Execution Pipeline | Paper mode → Live mode | Jupiter v6 API + `@solana/web3.js` |
| On-Chain Accountability | Lamport Conscience | Solana Memo Program |
| Trust State Machine | Advisor → Executor | SQLite (persisted via Nosana volume) |
| Scheduling | Morning briefings, bedtime reports | `node-cron` inside container |
| Inference | Qwen3.5-27B-AWQ-4bit | Nosana GPU endpoint |
| Persistence | SQLite + mounted volume | `@elizaos/plugin-sql` |

Full architecture decisions and rationale: [`_bmad-output/planning-artifacts/architecture.md`](./_bmad-output/planning-artifacts/architecture.md)

Design system and UX directions: [`ux-design-directions.html`](./ux-design-directions.html)

---

## Quick Start

**Prerequisites:** [Bun](https://bun.sh) (≥1.0), Docker, Git

```bash
git clone https://github.com/Zolldyk/Nostra.git
cd Nostra
git checkout elizaos-challenge

bun install

cp .env.example .env
# Edit .env with your credentials (Telegram token, Solana keypair, Alchemy RPC)

bun dev
```

The agent starts on `http://localhost:3000`. Connect your Telegram bot by setting `TELEGRAM_BOT_TOKEN` in `.env`.

---

## Nosana Deployment

Nostra is deployed on Nosana's decentralized GPU network using the pre-built Docker image.

**Docker Hub image:** `zolldyck/nostra:latest` (linux/amd64)
**GPU market:** `nvidia-rtx-4090`
**Live job ID:** `9g6vVGjzJyjPzJQNXHsrV9YcdRoyjRpfZUBwZYmhFjQF`
**Live endpoint:** `https://3FZ2EyGUSy3ehMXtANL7ZC3Rx29YNcp1HtnuPSe3mV4F.node.k8s.prd.nos.ci`

### Deploy Your Own Instance

**Step 1 — Inject secrets into Nosana**

Sensitive values are never baked into the image. Create runtime secrets:

```bash
nosana secret create TELEGRAM_BOT_TOKEN <your-token>
nosana secret create SOLANA_PRIVATE_KEY <base58-keypair>
nosana secret create ALCHEMY_RPC_URL <your-rpc-url>
```

**Step 2 — Build and push (amd64 required)**

Nosana nodes run x86_64. Always build for `linux/amd64`:

```bash
docker buildx build --platform linux/amd64 -t yourusername/nostra:latest --push .
```

Update the image reference in `nos_job_def/nosana_eliza_job_definition.json`.

**Step 3 — Deploy via CLI**

```bash
nosana job post \
  --file ./nos_job_def/nosana_eliza_job_definition.json \
  --market nvidia-rtx-4090 \
  --api $NOSANA_API_KEY
```

**Step 4 — Monitor**

```bash
nosana job status 9g6vVGjzJyjPzJQNXHsrV9YcdRoyjRpfZUBwZYmhFjQF
nosana job logs  9g6vVGjzJyjPzJQNXHsrV9YcdRoyjRpfZUBwZYmhFjQF
```

Once running, Nosana provides a public HTTPS endpoint on port 3000. Your Telegram bot is live.

---

## Environment Variables

Copy `.env.example` to `.env` and fill in the values below. **Never commit `.env`.**

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | `nosana` (fixed value for Nosana inference endpoint) |
| `OPENAI_API_URL` | Yes | Nosana GPU inference endpoint URL |
| `MODEL_NAME` | Yes | `Qwen/Qwen3.5-4B` |
| `OPENAI_EMBEDDING_URL` | Yes | Nosana embedding endpoint URL |
| `OPENAI_EMBEDDING_API_KEY` | Yes | `nosana` |
| `OPENAI_EMBEDDING_MODEL` | Yes | `Qwen3-Embedding-0.6B` |
| `OPENAI_EMBEDDING_DIMENSIONS` | Yes | `1024` |
| `SERVER_PORT` | Yes | `3000` (must match Nosana job port mapping) |
| `TELEGRAM_BOT_TOKEN` | Yes | From [@BotFather](https://t.me/BotFather) — inject at runtime |
| `SOLANA_PRIVATE_KEY` | Yes | Base58 agent wallet keypair — inject at runtime, never log |
| `SOLANA_NETWORK` | Yes | `devnet` or `mainnet-beta` |
| `ALCHEMY_RPC_URL` | Yes | Dedicated Alchemy RPC (devnet or mainnet) |
| `SQLITE_PATH` | Yes | `/app/data/nostra.db` (matches Nosana volume mount) |
| `NOSANA_API_KEY` | Yes | From [deploy.nosana.com/account](https://deploy.nosana.com/account/) |

See `.env.example` for the full template with comments.

---

## Project Structure

```
Nostra/
├── characters/
│   └── agent.character.json        # Nostra's personality, plugins, voice
├── src/
│   └── index.ts                    # Custom ElizaOS plugin entry point
│                                   # Constitution engine, Lamport Conscience,
│                                   # Trust Ladder, Treasury actions
├── nos_job_def/
│   └── nosana_eliza_job_definition.json  # Nosana GPU job spec (amd64, port 3000)
├── _bmad-output/
│   ├── planning-artifacts/         # Architecture, PRD, UX design spec, epics
│   └── implementation-artifacts/  # Stories, sprint status
├── docs/                           # Challenge reference docs
├── Dockerfile                      # Multi-stage build (node → bun → prod)
├── .env.example                    # Environment variable template
├── bun.lock                        # Bun lockfile
├── ux-design-directions.html       # Sovereign Warm design system reference
└── README.md
```

---

## Judging Criteria

| Criterion | Weight | How Nostra Scores |
|-----------|--------|-------------------|
| Technical implementation | 25% | ElizaOS v2 plugins following Provider/Action/Evaluator patterns; constitutional compliance as a synchronous hard gate; state machine with SQLite durability |
| Nosana integration depth | 25% | Full CLI pipeline: `docker buildx --platform linux/amd64` → Docker Hub → `nosana job post`; runtime secrets injection; persistent volume mount for SQLite; GPU inference via Nosana endpoint |
| Usefulness & UX | 25% | Sovereign Warm design system (WCAG AA); Telegram-native UX with inline buttons; Morning briefings, Bedtime reports, Crisis Protocol — a financial companion, not a tool |
| Creativity & originality | 15% | Constitutional AI governance + Solana on-chain audit trail + Trust Ladder state machine — a novel combination of DeFi agent, blockchain accountability, and user-defined governance |
| Documentation | 10% | Architecture decision record, UX design spec, sprint-tracked development, this README |

---

## V2 Roadmap

The V1 architecture was deliberately chosen for solo velocity within a 14-day window. V2 targets production-grade infrastructure:

**Decision 1 — PostgreSQL migration**
SQLite serves V1 well on a single Nosana node. V2 migrates to PostgreSQL (PlanetScale or Supabase) for multi-node deployments, horizontal scaling, and row-level locking required by the Crisis Protocol freeze across nodes.

**Decision 2 — Hardware wallet signing**
V1 uses an in-memory Solana keypair injected at runtime. V2 integrates Ledger hardware wallet support via `@solana/hw-wallet-adapter` — the agent proposes, the user physically approves on-device. True non-custodial.

**Decision 3 — Multi-node Nosana deployment**
V1 is a single-container job. V2 distributes: dedicated inference node (GPU), agent logic node (CPU), and a Lamport Conscience archival node. Nosana's job definition supports multi-container orchestration.

---

## Challenge Submission

**Deadline:** April 14, 2026
**Submission:** [superteam.fun/earn/listing/nosana-builders-elizaos-challenge/](https://superteam.fun/earn/listing/nosana-builders-elizaos-challenge/)

- GitHub fork: [github.com/Zolldyk/Nostra](https://github.com/Zolldyk/Nostra) (branch: `elizaos-challenge`)
- Live Nosana URL: `https://3FZ2EyGUSy3ehMXtANL7ZC3Rx29YNcp1HtnuPSe3mV4F.node.k8s.prd.nos.ci`
- Telegram bot: [@zoll_arb_bot](https://t.me/zoll_arb_bot)

---

## License

[MIT](./LICENSE) — Built with ElizaOS · Deployed on Nosana · Governed by you
