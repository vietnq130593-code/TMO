# Theopusflashlite — Multi-Agent AI Platform

[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Neo4j](https://img.shields.io/badge/Neo4j-5.x-018BFF?logo=neo4j)](https://neo4j.com/)
[![Qdrant](https://img.shields.io/badge/Qdrant-1.14+-DC2C5A?logo=qdrant)](https://qdrant.tech/)
[![License](https://img.shields.io/badge/License-Private-red)]()

**Version**: 2.0.0

**Multi-Agent AI Platform with Code Team, Skills Marketplace, GraphRAG Knowledge Base, and Hybrid Search**

Theopusflashlite is an end-to-end AI platform that combines:
- **Code Team** — Multi-agent coding workflow (Team Lead + Generator + Verifier architecture)
- **Skills Marketplace** — Install and use AI capabilities (Web Search, Page Reader, TTS, ASR, VLM, Image Generation)
- **GraphRAG Knowledge Base** — Upload PDFs, auto-extract entities/relationships, build knowledge graphs
- **Hybrid Search** — Vector similarity + graph traversal + LLM-powered answer generation

---

## Upgrade v2 — Smolab Code Module (2026-08-25)

Module Smolab > Code đã được nâng cấp toàn diện (11 phases, chi tiết: `docs/upgrade/`):

- **Auth**: `TMO_API_TOKEN` middleware bảo vệ `/api/opencode/**` + `/api/workspace/**` (header / Bearer / HttpOnly cookie); CORS khóa origin; blocklist lệnh nguy hiểm (exact-token + wildcard).
- **Workspace sync**: folder picker đăng ký active workspace vào DB — AI tools thao tác đúng thư mục user chọn (không còn `process.cwd()`).
- **Preview**: port 3005+ (hết bug self-collision 3000), `/preview/stop` kill process group, SSE log stream, iframe tự refresh khi server sẵn sàng.
- **Terminal**: persistent `bash -i` session + SSE stream + stdin — chạy được install/build/dev-server (hết giới hạn 30s/1MB).
- **Monaco editor**: multi-tab + Ctrl+S + dirty indicator + revert, vendored local (0 CDN).
- **AI tools mới**: `start_preview` / `stop_preview` (TL, G2-A, G3) — AI tự khởi động/dừng dev server.
- **UI AI transparency**: auto-open file khi AI đọc/sửa, rich bubbles (📖 ✏️ ▶️), auto-open preview khi AI start.
- **Diff & review**: Monaco DiffEditor (session + git HEAD), PendingEdit review modal (Duyệt/Từ chối/Apply).
- **Search**: ripgrep search-across-files click-to-open; file rename/delete trên tree.

Verify: `bash scripts/integration-test.sh` → 20/20 ALL GREEN.

---

## Architecture

```
                    ┌────────────────────────────────────────────────┐
                    │            Next.js 16 Application              │
                    │      (App Router + API Routes + SPA UI)        │
                    └───────────────┬────────────────────────────────┘
                                    │
              ┌─────────────────────┼──────────────────────┐
              │                     │                      │
     ┌────────▼──────┐    ┌────────▼───────┐    ┌────────▼────────┐
     │    SQLite     │    │    Qdrant      │    │     Neo4j       │
     │  (Prisma ORM) │    │  (Vector DB)   │    │   (Graph DB)    │
     │               │    │                │    │                 │
     │ - Job Queue   │    │ - Documents    │    │ - Entities      │
     │ - Token Stats │    │ - Chunks       │    │ - Relationships │
     │ - Agent Data  │    │ - Embeddings   │    │ - Communities   │
     │ - Skills DB   │    │   (1536-dim)   │    │ - Traversal     │
     └───────────────┘    └────────────────┘    └─────────────────┘

     ┌────────────────────────────────────────────────────────────────┐
     │                    Multi-Agent System                          │
     ├────────────────┬───────────────────┬──────────────────────────┤
     │   Code Team    │  Skills Engine    │    AI Gateway            │
     │  (5 agents)    │  (Marketplace)    │  (OpenClaw + LLM Pool)   │
     │  TL → G1 →    │  Install → Inject │  NVIDIA / Mistral /      │
     │  G2-A/G2-B →  │  into prompts     │  OpenRouter / Cerebras   │
     │  G3 (Verify)   │  + filesystem     │                          │
     └────────────────┴───────────────────┴──────────────────────────┘
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | Next.js 16 (App Router), React 19, TypeScript 5, Tailwind CSS 4, shadcn/ui, D3.js, Recharts |
| **Backend** | Next.js API Routes, Prisma ORM (SQLite) |
| **Vector DB** | Qdrant v1.14+ (1536-dim cosine similarity, 2 collections) |
| **Graph DB** | Neo4j Desktop 5.x+ / AuraDB (11 entity labels, 14 relationship types) |
| **Buffer DB** | SQLite via Prisma (job queue, token tracking, agent data, skills) |
| **LLM Providers** | NVIDIA NIM, Mistral, OpenRouter, Cerebras (optional, geo-blocked) |
| **Embeddings** | OpenRouter E5 / NVIDIA Llama-Nemotron-Embed (1536-dim) |
| **AI SDK** | (2026-10-15) z-ai-web-dev-sdk đã GỠ BỎ — Web Search/Page Reader dùng direct API keys (Tavily/Serper/Jina) |
| **Code Team** | 5-agent workflow (Team Lead, Generator×2, Verifier) |

---

## Prerequisites

| Component | Required? | Notes |
|---|---|---|
| **Bun** runtime | ✅ Required | `bun` >= 1.0 (recommended) or Node.js 18+ |
| **Qdrant** v1.14+ | ⚠️ Optional | Needed for Knowledge Base features. Without it, Chat still works. |
| **Neo4j** 5.x+ | ⚠️ Optional | Needed for Graph features. Without it, other features still work. |
| **LLM API Keys** | ✅ Required | At least 1 key from NVIDIA NIM, Mistral, or OpenRouter |
| **Tavily / Jina / Serper** | ⚠️ Optional | Web Search and Page Reader. (z-ai-sdk fallback đã gỡ 2026-10-15 — chỉ dùng direct API keys) |

> **Note**: The app gracefully degrades when optional services are unavailable. You can start with just an LLM API key and add databases later.

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/nguyenquocviety2c-code/Theopusflashlite.git
cd Theopusflashlite
bun install    # postinstall auto-runs `prisma generate`

# 2. Configure environment
cp .env.example .env
# Edit .env — at minimum, set one LLM API key:
#   MISTRAL_API_KEY_1=your-key-here
#   or NVIDIA_API_KEY_1=your-key-here
#   or OPENROUTER_API_KEY_1=your-key-here

# 3. Initialize database (creates SQLite tables)
bun run setup

# 4. (Optional) Start Qdrant for Knowledge Base features
./qdrant --config-path qdrant-config.yaml &

# 5. (Optional) Start Neo4j for Graph features
# Open Neo4j Desktop and start a project

# 6. Start development server
bun run dev

# 7. Open http://localhost:3000
```

### Minimum Viable Setup (No external databases)

If you just want to try the Chat and Code Team features without Qdrant/Neo4j:

1. Follow steps 1-3 above
2. Set at least one LLM API key in `.env`
3. Run `bun run dev`
4. Chat will use the local LLM fallback path

---

## Configuration

All configuration is managed through environment variables. Copy `.env.example` to `.env` and fill in your values.

### Core Configuration

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `file:../db/custom.db` | Prisma SQLite connection string |
| `NEXT_PUBLIC_BASE_URL` | `http://localhost:3000` | App base URL for internal API calls |
| `UPLOAD_DIR` | `/tmp/theopus-uploads` | Directory for uploaded PDF files |

### Vector Database (Qdrant)

| Variable | Default | Description |
|---|---|---|
| `QDRANT_URL` | `http://localhost:6333` | Qdrant REST API endpoint |
| `QDRANT_API_KEY` | *(empty)* | Qdrant API key (optional) |
| `QDRANT_COLLECTION_DOCUMENTS` | `theopus_documents` | Qdrant collection for document metadata |
| `QDRANT_COLLECTION_CHUNKS` | `theopus_chunks` | Qdrant collection for text chunks + vectors |

### Graph Database (Neo4j)

| Variable | Default | Description |
|---|---|---|
| `NEO4J_URI` | `neo4j://127.0.0.1:7687` | Neo4j connection URI |
| `NEO4J_USER` | `neo4j` | Neo4j username |
| `NEO4J_PASSWORD` | *(required)* | Neo4j password |
| `NEO4J_DATABASE` | `neo4j` | Neo4j database name |

### LLM Providers

| Variable | Rate Limit | Notes |
|---|---|---|
| `MISTRAL_API_KEY_1` .. `_4` | 1 RPS/key | ~1B tokens/month free tier |
| `NVIDIA_API_KEY_1` .. `_4` | 40 RPM/key | No daily cap; recommended primary |
| `CEREBRAS_API_KEY_1` .. `_4` | 30 RPM/key | Geo-blocked; set `ENABLE_CEREBRAS=true` only in supported regions |
| `OPENROUTER_API_KEY_1` .. `_4` | 50 req/day/key | Free tier; serves as final fallback |

### Skills (Web Search & Page Reader)

| Variable | Default | Description |
|---|---|---|
| `TAVILY_API_KEY` | *(optional)* | AI-optimized deep web search |
| `SERPER_API_KEY` | *(optional)* | Google Search API |
| `JINA_API_KEY` | *(optional)* | Web page reader |

> **Note**: (2026-10-15) `z-ai-web-dev-sdk` fallback đã GỠ BỎ khỏi codebase + package.json — Web Search / Page Reader cần Tavily/Serper/Jina API keys trực tiếp.

### Code Team & OpenCode Server

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_SERVER_URL` | `http://127.0.0.1:18790` | OpenCode server for file operations |
| `OPENCODE_WORKSPACE` | *(auto-detected)* | Workspace root for Code Team agents |

---

## API Reference

### Chat & Agents

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/openclaw/chat` | Main chat endpoint (auto-routes to Knowledge Base or Code Team) |
| `POST` | `/api/openclaw/workflow` | Start a Code Team workflow (5-agent pipeline) |
| `GET` | `/api/openclaw/skills` | List installed skills with status |
| `POST` | `/api/openclaw/skills` | Install/uninstall/toggle skills from Marketplace |

### Service Info & Health

| Method | Path | Description |
|---|---|---|
| `GET` | `/api` | Service info and available endpoints |
| `GET` | `/api/health` | System health check (Qdrant, Neo4j, SQLite, LLM providers) |
| `GET` | `/api/token-usage` | Token usage statistics |

### Knowledge Base

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/setup/qdrant` | Qdrant connection status |
| `POST` | `/api/setup/qdrant` | Initialize Qdrant collections |
| `POST` | `/api/ingestion/upload` | Upload PDF files |
| `POST` | `/api/ingestion/process` | Process document (extraction pipeline) |
| `POST` | `/api/query` | Hybrid query (vector + graph + LLM) |
| `POST` | `/api/sync-neo4j` | Sync buffered entities/relationships to Neo4j |

---

## Project Structure

```
src/
├── app/
│   ├── api/
│   │   ├── openclaw/          # Chat, Skills, Workflow, Tools APIs
│   │   ├── opencode/          # Code execution, Git, Knowledge APIs
│   │   ├── query/             # Hybrid query engine
│   │   ├── ingestion/         # Upload, process, entities
│   │   ├── setup/             # Qdrant & Neo4j setup
│   │   └── health/            # Health check
│   ├── layout.tsx             # Root layout with ThemeProvider
│   ├── page.tsx               # Main SPA (all tabs)
│   └── globals.css            # Global styles
├── lib/
│   ├── code-team/             # Code Team workflow engine + tool executor
│   ├── neo4j.ts               # Neo4j client
│   ├── qdrant.ts              # Qdrant client
│   ├── llm.ts                 # Multi-provider LLM (slot-based rotation)
│   ├── embeddings.ts          # Embedding generation
│   ├── db.ts                  # Prisma client singleton
│   └── auto-learn.ts          # Auto-learning from agent interactions
├── components/ui/             # shadcn/ui components
└── hooks/                     # Custom React hooks
prisma/
└── schema.prisma              # SQLite schema
mini-services/                 # Standalone microservices (OpenCode, OpenClaw Gateway)
```

---

## Features

### Core Platform
- **Multi-Agent Chat** — Intelligent routing: code queries → Code Team, knowledge queries → GraphRAG, general → LLM
- **Code Team Workflow** — 5-agent pipeline (Team Lead → Generator×2 → Verifier) for complex coding tasks
- **Skills Marketplace** — Browse and install AI capabilities (Web Search, Page Reader, TTS, ASR, VLM, Image Generation)
- **Agent Profiles** — Create custom agents with specific provider/model/instructions

### Knowledge Base
- **PDF Ingestion** with automatic domain classification
- **Multi-step Extraction Pipeline** — parse → chunk → extract entities → relationships → resolve → embeddings → index
- **Hybrid Search** — vector similarity + graph traversal + Reciprocal Rank Fusion (RRF)
- **Auto-Learning** — Agents automatically capture insights from interactions
- **Knowledge Graph Visualization** — D3.js force-directed layout

### Infrastructure
- **Multi-LLM Pool** — 4 providers with slot-based key rotation and automatic fallback
- **Token Usage Tracking** — per provider, per slot, per model with daily history
- **Dark Mode** support via next-themes
- **Graceful Degradation** — App works without Qdrant/Neo4j (limited features)

---

## Scripts

| Script | Command | Description |
|---|---|---|
| `dev` | `bun run dev` | Start development server on port 3000 |
| `build` | `bun run build` | Production build |
| `start` | `bun run start` | Start production server on port 3000 |
| `lint` | `bun run lint` | Run ESLint |
| `setup` | `bun run setup` | Generate Prisma client + push schema to SQLite |
| `db:push` | `bun run db:push` | Push schema changes to SQLite |
| `db:generate` | `bun run db:generate` | Generate Prisma client |
| `db:migrate` | `bun run db:migrate` | Run Prisma migrations |
| `db:reset` | `bun run db:reset` | Reset database (destructive) |

> **Note**: `bun install` automatically runs `prisma generate` via the `postinstall` script. You only need `bun run setup` for the initial database creation.

---

## Local Development Notes

### What works without external services?

| Feature | Without Qdrant | Without Neo4j | Without LLM Keys |
|---|---|---|---|
| Chat | ✅ (mock mode) | ✅ | ❌ |
| Code Team | ✅ | ✅ | ❌ |
| Skills Marketplace | ✅ | ✅ | ⚠️ (install works, usage needs LLM) |
| Knowledge Base Search | ❌ | ✅ (vector only) | ❌ |
| Graph Visualization | ✅ (limited) | ❌ | ✅ |
| PDF Ingestion | ❌ | ⚠️ (no graph sync) | ❌ |

### z-ai-web-dev-sdk — ĐÃ GỠ BỎ (2026-10-15)

The `z-ai-web-dev-sdk` package đã được loại bỏ hoàn toàn khỏi codebase và `package.json` theo user directive (SDK chỉ tồn tại trong sandbox z.ai, không cài được trên local):
- **Web Search**: dùng `TAVILY_API_KEY_*` hoặc `SERPER_API_KEY_*` trực tiếp
- **Page Reader**: dùng `JINA_API_KEY_*` trực tiếp

---

## License

Private project. All rights reserved.
