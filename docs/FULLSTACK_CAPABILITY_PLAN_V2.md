# TMO Fullstack Capability Plan v2.1

**Document version**: 2.1
**Date**: 2026-08-24
**Supersedes**:
- `FULLSTACK_CAPABILITY_PLAN_V2.md` (v2.0, 2026-08-24) — same strategy, refined execution
- `FULLSTACK_COMPLETION_PLAN.md` (v1, 2026-08-23) — original 11-tool approach

**Goal**: Bring TMO Code Team agents to parity with **Claude Code** and **Z.ai Code** for fullstack development, while preserving TMO's unique strengths (Knowledge Graph + 3-tier memory + 5-agent workflow + multi-LLM fallback).

---

## Executive Summary

The v1 plan correctly identified the 30% gap but proposed **11 specialized tools** where Claude Code/Z.ai Code use **1 sandboxed shell + ~5 structured parsers**. v2.0 rebalanced the architecture; **v2.1 refines the execution** with 14 concrete adjustments after self-critique.

### What changed v2.0 → v2.1

| Dimension | v2.0 (claim) | v2.1 (refined) |
|---|---|---|
| Capabilities parity vs Claude Code/Z.ai Code | 25/25 | **23/25** (Cron + Exit_plan_mode added in Phase 4) |
| Effort estimate | 5-6 sessions | **8-10 sessions** (industry realistic: 200-400 lines/session after debug+test) |
| Phase 1 structure | 6 tasks gộp 1 session | **Split 1a/1b/1c by risk** (low/medium/high) |
| Feature flags | Not specified | **Per-tool flag, off by default** |
| Testing strategy | Not specified | **Smoke + snapshot + integration** (Part 10) |
| Monitoring | Not specified | **Per-tool metrics + error budget** (Part 11) |
| MCP support | Phase 5.6 | **Phase 3.6** (industry standard moving fast) |
| `exit_plan_mode` / Plan Mode | Missed | **Phase 4.5** |
| `cron` tool | "via shell" | **Phase 4.6** (native tool) |
| Neo4j checkpoint | Full export | **Differential** (only changed nodes/rels) |
| Permission matrix | Not specified | **Per-tool × per-role** (Part 13) |
| A/B testing safety | Not specified | **warn vs strict dual-mode** (Part 14) |

### Architecture strategy (unchanged from v2.0)

| v1 approach | v2.1 approach |
|---|---|
| 11 tools × 150-300 lines each = ~2,200 lines | 1 shell + 6 parsers + 4 primitives + 1 gateway wire = ~1,400 lines |
| 5 critical gaps missed (todo_write, web unify, native FC, gateway wire, quality gate) | All 5 closed in Phase 1 |
| Safety mechanisms deferred to Phase 4-5 | Quality gate + auto-checkpoint promoted to Phase 1a |
| Regex tool-call parsing → native FC in Phase 5 | Native FC migrated in Phase 1c (foundation, dual-mode safety) |

**Result after v2.1**: TMO reaches **23/25 capabilities parity** with Claude Code/Z.ai Code **+ keeps 5 unique features** they lack. The 2 remaining gaps (Cron, Exit_plan_mode) are added in Phase 4.

---

## Part 1: Problem Synthesis (brief)

### 1.1 Architecture imbalance (the core issue)
TMO creates specialized tools for operations that a sandboxed shell handles natively. Claude Code uses **Bash sandbox** for ~80% of operations (lint, tsc, npm, git, curl, tail) and only creates structured tools when output needs parsing. v1 plan continues this anti-pattern.

### 1.2 Five critical gaps v1 missed
| # | Gap | Why critical |
|---|---|---|
| G1 | No `todo_write`/`todo_read` for in-flight task tracking | Claude Code & Z.ai Code both have this — without it, LLM can't self-track progress, loses context mid-task |
| G2 | Web search fragmented (tavily+serper+jina as 3 separate tools) | LLM confused which to call; should consolidate to 1 with provider routing |
| G3 | Native function calling deferred to Phase 5 | Foundation change — should be Phase 1; everything else depends on it |
| G4 | OpenClaw gateway (36 tools) "sleeping" — bug P2 not fixed | Massive capability already deployed but unwired |
| G5 | Quality gate + auto-checkpoint deferred to Phase 4 | These are CHEAP (50-200 lines) and CRITICAL — running unsafe code in production |

### 1.3 Safety mechanisms deferred too far
v1 plan puts auto-rollback (P1), quality gate (P2), human review (P3), staging branches (P4) in Phase 4. But these are **safety nets**, not features. Code without them in production = liability. v2.1 promotes quality gate to Phase 1a, the rest stay in Phase 4 (with Plan Mode + Cron added).

### 1.4 Architecture fragmentation
- Two parallel architectures: `src/lib/execution/` + `src/lib/orchestration/`
- `master-orchestrator.ts:477` is TODO placeholder
- `delegate` tool is simulated (T5), `decompose` simplified (T6)

---

## Part 2: Design Principles (from Claude Code/Z.ai Code analysis)

| # | Principle | Implementation rule |
|---|---|---|
| D1 | **Shell-first, parser-when-needed** | Use sandboxed shell for ~80% ops. Only create structured tool when (a) output needs parsing for LLM, or (b) operation needs pre-conditions/guards |
| D2 | **Structured receipts** | Every tool returns `{success, exit_code, stdout, stderr, duration, truncated, cursor}` — no silent failures |
| D3 | **Destructive ops need dry_run + path guards** | `file_delete`, `git push`, `env_update`, `cron_create` must support `dry_run: true` and refuse repo root |
| D4 | **Batch atomicity** | `file_multi_edit` must be all-or-nothing; on any failure, rollback all prior edits in batch |
| D5 | **Echo absolute path** in every receipt | LLM needs anchors for follow-up edits |
| D6 | **Truncation flags + cursor** | If output > N bytes, set `truncated: true` + `cursor: <offset>` so LLM knows there's more |
| D7 | **Native function calling > regex** | Use OpenAI-style `tools` parameter in LLM API; deprecate regex parsing (Phase 1c, dual-mode) |
| D8 | **Cross-platform native** | Use Node.js APIs (fs.readdir, fs.readFile) over binary spawns (rg, diff) when feasible |
| D9 | **Staged rollout for tool exposure** | When wiring 36 gateway tools, gate behind feature flag, expose 5 P0 first |
| D10 | **Per-MCP-server permission prompts** | When adding MCP support, prompt user per server (Claude Code pattern) |
| **D11 (v2.1 new)** | **Feature flag per tool, off by default** | Every new tool has `ENABLE_<TOOL_NAME>` flag; flip in `.env` for staged rollout |
| **D12 (v2.1 new)** | **Plan Mode for risky workflows** | `exit_plan_mode` tool — agent proposes plan, user approves, agent executes |
| **D13 (v2.1 new)** | **Differential checkpoint for large graphs** | Neo4j (42,485 rels) → only checkpoint changed nodes/rels, not full export |

---

## Part 3: Tool Architecture Strategy (4 layers)

### Layer 1: Primitives (5 tools)
Foundation tools that every agent needs regardless of role.

| Tool | Purpose | Replaces |
|---|---|---|
| `shell` | Sandboxed bash with allowlist + 5-10min timeout + working-dir lock | install_package, read_logs, lint, type_check, db_query, env_update (5 of v1's 11 tools) |
| `todo_write` / `todo_read` | In-flight task list (LLM updates progress) | Nothing — new capability |
| `web_search` | Unified search, routes tavily/serper/jina based on query type | tavily + serper + jina (consolidated) |
| `web_fetch` | URL → markdown | jina (consolidated) |

### Layer 2: Structured Parsers (6 tools)
Operations needing structured output or guards.

| Tool | Why not shell |
|---|---|
| `file_read` | Needs line numbers (anchor for edit) + truncation + offset |
| `file_edit` / `file_multi_edit` | Atomic batch + match count guard (fail on 0 or >1 match) + dry_run |
| `file_list` + `file_grep` | Cross-platform — Node.js native, no rg/diff binary |
| `run_tests` | Framework-aware autodetect (bun/jest/vitest/pytest) + parse pass/fail + `file:line` |
| `git_commit` | Scoped paths + structured receipt |

### Layer 3: Code Intelligence + MCP (6 tools)
| Tool | Purpose | Wire target |
|---|---|---|
| `lsp_diagnostics` | Code intelligence | Existing `/api/opencode/lsp/diagnostics` endpoint (already deployed, unused) |
| `browser_screenshot` | Visual UI verification | Existing `playwright` dep (installed, unused) |
| `lint` / `type_check` | Structured parser | `eslint . --format json` + `tsc --noEmit` |
| `test_coverage` | Coverage report | `bun test --coverage` |
| `db_query` | Read-only by default | Prisma `$queryRaw` + readOnly guard |
| **`mcp_call` (v2.1 new, was Phase 5)** | MCP server invocation | New `mcp-bridge.ts` — supports filesystem/github/postgres/puppeteer MCP servers |

### Layer 4: Process & Safety (5 tools + 2 wires)
| Tool | Purpose |
|---|---|
| `checkpoint_create` / `checkpoint_restore` | Auto-checkpoint + auto-rollback (with Neo4j differential) |
| `exit_plan_mode` (v2.1 new) | Agent proposes plan → user approves → agent executes (Claude Code pattern) |
| `cron` (v2.1 new) | Scheduled tasks with retry + dedup (Z.ai Code parity) |
| **Wire 1**: OpenClaw gateway proxy | 36 tools via `GATEWAY_TOOL_REGISTRY` + fix URL bug |
| **Wire 2**: PendingEdits human review | Already exists, not wired into workflow |

**Critical bug fix in Layer 4**: `executeOpenCode` currently calls `${url}/api/execute` but Hono server exposes `/execute` (no `/api/` prefix) → always 404 silently.

---

## Part 4: Phased Implementation Plan (REVISED with 1a/1b/1c split)

### Phase 1a — Low-risk Foundation (1 session, ~400 lines)
**Goal**: Ship value independently of native FC migration. All 3 tasks are isolated, can deploy in parallel.

| # | Task | Files | Effort |
|---|---|---|---|
| 1a.1 | `shell` tool (sandboxed bash) | `tool-executor.ts` executeShell + `feature-flags.ts` | 200 lines |
| 1a.2 | `todo_write` / `todo_read` + Prisma `Todo` model | `tool-executor.ts` + `prisma/schema.prisma` | 150 lines |
| 1a.3 | Quality gate (warn mode) | `workflow-engine.ts` enforceQualityGate | 50 lines |

**Feature flags** (off by default, enable in `.env`):
- `ENABLE_SHELL_TOOL=true`
- `ENABLE_TODO_TOOL=true`
- `ENABLE_QUALITY_GATE=warn` (warn | strict | off)

**Acceptance**: agent can run `bun add bcrypt` via shell, create todo list, quality gate reports errors in warn mode (workflow still completes).

---

### Phase 1b — Medium-risk Web + Gateway (1 session, ~200 lines)
**Goal**: Consolidate web tools + wire sleeping gateway. Independent of 1c (native FC).

| # | Task | Files | Effort |
|---|---|---|---|
| 1b.1 | Consolidate `web_search` + `web_fetch` (route tavily/serper/jina) | `tool-executor.ts` executeWebSearch + executeWebFetch | 100 lines |
| 1b.2 | Wire OpenClaw gateway proxy + fix URL bug | `tool-executor.ts` executeOpenCode + `mini-services/opencode-server/server.ts` | 100 lines |

**Feature flags**:
- `ENABLE_WEB_UNIFIED=true`
- `ENABLE_GATEWAY_TOOLS=phase-1b` (off | phase-1b | full) — expose 5 P0 gateway tools first (`exec`, `read`, `write`, `edit`, `apply_patch`), gate rest behind `ENABLE_GATEWAY_TOOLS=full`

**Critical bug fix** (1b.2):
```ts
// In executeOpenCode (tool-executor.ts):
const url = `${OPENCODE_SERVER_URL}/execute`;  // was: /api/execute (always 404)
// Add /execute route alias in opencode-server/server.ts (Hono):
app.post('/execute', async (c) => { /* same handler as /api/execute */ });
```

**Acceptance**: agent calls `web_search("Next.js 16 features")` → unified results from best provider. Agent calls `apply_patch` → gateway routes correctly (no 404).

---

### Phase 1c — High-risk Native Function Calling (1 session, ~200 lines, BLOCKS Phase 2+)
**Goal**: Migrate from regex tool-call parsing to native function calling. Dual-mode safety for 1 sprint.

| # | Task | Files | Effort |
|---|---|---|---|
| 1c.1 | Native FC in NVIDIA NIM API call | `nvidia-nim.ts` (add `tools` param) + `workflow-engine.ts` (parse `response.tool_calls`) | 200 lines |
| 1c.2 | Parallel prompt engineering | `prompts.ts` — convert text tool descriptions → JSON schema tool definitions | included |
| 1c.3 | Dual-mode fallback (regex if native fails) | `workflow-engine.ts` parseToolCallsFromOutput (keep, log warnings) | included |

**Feature flags**:
- `ENABLE_NATIVE_FC=true` (off | dual | strict)
- `dual` = native preferred, regex fallback (default for first sprint)
- `strict` = native only (after validation)

**Prompt engineering spec** (1c.2):
- Current: `prompts.ts` injects tool descriptions as text into system prompt
- New: convert each tool to JSON schema `{name, description, parameters}` and pass via `tools` param in API call
- A/B test: parallel agent runs with `dual` mode, compare tool-call success rate

**Acceptance**: LLM emits structured `tool_calls` array; regex fallback invoked <5% of calls; tool-call success rate ≥95%.

---

### Phase 2 — File Ops & Test Runner (1-2 sessions, ~600 lines)
**Depends on**: Phase 1c (native FC for reliable tool dispatch)

| # | Task | Files |
|---|---|---|
| 2.1 | `file_read` (line numbers + truncation + offset) | `tool-executor.ts` |
| 2.2 | `file_edit` (atomic + match count guard + dry_run) | `tool-executor.ts` |
| 2.3 | `file_multi_edit` (atomic batch) | `tool-executor.ts` |
| 2.4 | `file_delete` (dry_run + repo root guard) | `tool-executor.ts` |
| 2.5 | `file_list` + `file_grep` (Node.js native, cross-platform) | `tool-executor.ts` |
| 2.6 | `run_tests` (framework-aware: bun/jest/vitest/pytest autodetect) | `tool-executor.ts` |
| 2.7 | `git_commit` (scoped paths + structured receipt) | `tool-executor.ts` |

**Feature flags**: each tool `ENABLE_<TOOL>` off by default, flip per acceptance test.

**Acceptance**: full file/edit/test/git parity with Claude Code. Per Part 10 testing strategy: smoke test each `executeTool()`.

---

### Phase 3 — Code Intelligence + MCP (2 sessions, ~700 lines)
**Depends on**: Phase 2 (file ops available)

| # | Task | Files |
|---|---|---|
| 3.1 | `lsp_diagnostics` (wire existing endpoint) | `tool-executor.ts` |
| 3.2 | `browser_screenshot` (wire existing playwright) | `tool-executor.ts` |
| 3.3 | `lint` / `type_check` structured parsers | `tool-executor.ts` |
| 3.4 | `test_coverage` (bun test --coverage) | `tool-executor.ts` |
| 3.5 | `db_query` (Prisma $queryRaw + readOnly guard) | `tool-executor.ts` |
| **3.6** | **`mcp_call` (NEW — moved up from Phase 5)** | new `src/lib/mcp/mcp-bridge.ts` |

**3.6 MCP server spec** (v2.1 promoted from Phase 5):
- Support standard MCP servers: filesystem, github, postgres, puppeteer
- Per-server permission prompts on first use (D10 principle, Claude Code pattern)
- Auto-discover from `~/.config/mcp/servers.json` or env `MCP_SERVERS=fs,github`
- Each MCP server runs in sandboxed subprocess, logs all calls

**Acceptance**: agent can call `mcp_call({ server: 'github', tool: 'create_pr', args: {...} })` after user approves github server.

---

### Phase 4 — Process, Safety, Plan Mode, Cron (2 sessions, ~600 lines)
**Depends on**: Phase 1a.3 (quality gate), Phase 2 (file ops for checkpoint targets)

| # | Task | Files |
|---|---|---|
| 4.1 | Auto-checkpoint before risky ops + Neo4j **differential** | `workflow-engine.ts` + `fs-checkpoint.ts` + `neo4j-checkpoint.ts` (new) |
| 4.2 | Auto-restore on verify failure | `workflow-engine.ts` |
| 4.3 | Staging branch per workflow | `workflow-engine.ts` |
| 4.4 | PendingEdits human review integration | `workspace-manager.ts` |
| **4.5** | **`exit_plan_mode` tool (NEW — Claude Code parity)** | `tool-executor.ts` + `workflow-engine.ts` |
| **4.6** | **`cron` tool (NEW — Z.ai Code parity)** | `tool-executor.ts` + new `src/lib/cron/scheduler.ts` |

**4.1 Neo4j differential checkpoint** (v2.1 refinement):
- Full Neo4j export = 42,485 rels × ~200 bytes = ~8.5MB per checkpoint → too slow for every risky op
- **Differential strategy**: query `MATCH (n) WHERE n.updatedAt > $lastCheckpoint RETURN n` + relationships with `updatedAt > $lastCheckpoint`
- Store diff in SQLite table `Neo4jCheckpointDiff { id, sessionId, timestamp, nodesJson, relsJson }`
- Full export only on explicit `checkpoint_create({ full: true })` or daily cron

**4.5 `exit_plan_mode` spec** (NEW):
```ts
// Schema
{ plan: string, filesToModify: string[], riskLevel: 'low'|'medium'|'high' }
// Returns: { approved: boolean, modifications?: string }
// Behavior:
// 1. Agent emits plan + target files + risk assessment
// 2. Workflow pauses, surfaces to UI
// 3. User approves/rejects/modifies
// 4. Agent resumes with approved scope
```

**4.6 `cron` spec** (NEW):
```ts
// Schema
{
  action: 'create' | 'list' | 'delete' | 'run',
  jobId?: string,           // for delete/run
  schedule: {               // for create
    kind: 'one_time' | 'cron' | 'fixed_rate',
    expr: string,           // epoch-ms (one_time) | cron expr | interval
    tz?: string             // timezone
  },
  task: string,             // agent task description
  sessionId?: string        // resume existing session
}
// Returns: { jobId, nextRun, dryRun: boolean }
// Implementation: new mini-service `cron-scheduler` on port 3004
// Retries: max 3 with exponential backoff
// Dedup: jobId hash, refuse duplicate schedules
```

**Feature flags**:
- `ENABLE_AUTO_CHECKPOINT=true`
- `ENABLE_AUTO_RESTORE=warn` (warn | strict | off)
- `ENABLE_STAGING_BRANCH=true`
- `ENABLE_HUMAN_REVIEW=true`
- `ENABLE_PLAN_MODE=true`
- `ENABLE_CRON_TOOL=true`

**Acceptance**: workflow auto-checkpoints before edits (with diff, not full export); on verify failure auto-restores; uses staging branch; user approves via PendingEdits UI; Plan Mode surfaces in UI; cron jobs execute on schedule.

---

### Phase 5 — Architecture Consolidation (2-3 sessions, ~700 lines)
**Depends on**: all above

| # | Task | Files |
|---|---|---|
| 5.1 | Implement `master-orchestrator.ts:477` executeStep() | `master-orchestrator.ts` |
| 5.2 | Real `delegate` (not simulated) — spawn sub-agent | `tool-executor.ts` executeDelegate + `agent-delegator.ts` |
| 5.3 | Delete regex parsing code path (after 1c dual-mode validated) | `workflow-engine.ts` |
| 5.4 | Deprecate old `code-team/workflow-engine.ts` after master-orchestrator stable 1 sprint | cleanup |
| 5.5 | Wire full `thinking/decomposer.ts` (IntentResult + MentalModel) | `tool-executor.ts` executeDecompose |
| 5.6 | Session resume (with detailed spec — Appendix C) | new endpoint + state serializer |

**5.6 Session resume spec** (v2.1 detailed, was vague in v2.0):

See **Appendix C** for full spec. Summary:
- State serialized to SQLite table `WorkflowSession` (JSONB columns)
- `/api/workflow/resume?sessionId=X` endpoint
- Concurrent lock via `sessionId` row lock (prevent 2 agents resuming same)
- Context overflow recovery: re-inject todo list + last 5 tool receipts + original task

---

## Part 5: Comparison Matrix — TMO v2.1 vs Claude Code / Z.ai Code / Kimi-CLI (23/25 parity, was 25/25)

| Capability | Claude Code | Z.ai Code | Kimi-CLI | TMO current (70%) | TMO v2.1 (target) |
|---|---|---|---|---|---|
| Sandboxed shell | ✅ | ✅ | ✅ | ⚠️ whitelist hẹp | ✅ Phase 1a.1 |
| TodoWrite/TodoRead in-flight | ✅ | ✅ | ⚠️ | ❌ | ✅ Phase 1a.2 |
| Web search unified | ✅ | ✅ | ⚠️ | ⚠️ 3 tools rời rạc | ✅ Phase 1b.1 |
| Web fetch unified | ✅ | ✅ | ⚠️ | ⚠️ jina only | ✅ Phase 1b.1 |
| Native function calling | ✅ | ✅ | ✅ | ❌ regex | ✅ Phase 1c |
| Quality gate | ❌ | ❌ | ❌ | ⚠️ không enforce | ✅ Phase 1a.3 |
| File read (line numbers) | ✅ | ✅ | ✅ | ✅ opencode read | ✅ Phase 2.1 |
| File edit (atomic + match guard) | ✅ | ✅ | ✅ | ⚠️ edit | ✅ Phase 2.2-2.3 |
| File list + grep native | ✅ | ✅ | ⚠️ | ⚠️ search_code only | ✅ Phase 2.5 |
| Test runner structured | via shell | via shell | ⚠️ | ✅ run_tests | ✅ Phase 2.6 |
| Git commit scoped | via shell | via shell | via shell | ⚠️ | ✅ Phase 2.7 |
| LSP diagnostics | ❌ (bash) | ❌ | ❌ | ❌ endpoint ngủ | ✅ Phase 3.1 |
| Browser screenshot | ✅ computer-use | ✅ agent-browser | ❌ | ❌ playwright unused | ✅ Phase 3.2 |
| Lint structured | via shell | via shell | via shell | ⚠️ raw | ✅ Phase 3.3 |
| Type check structured | via shell | via shell | via shell | ⚠️ raw | ✅ Phase 3.3 |
| Test coverage | via shell | via shell | ❌ | ❌ | ✅ Phase 3.4 |
| DB query (read-only guard) | via bash | via bash | via bash | ⚠️ Prisma | ✅ Phase 3.5 |
| MCP servers | ✅ | ✅ | ✅ | ❌ (gateway ngủ) | ✅ Phase 3.6 (moved up) |
| Auto-checkpoint + rollback | ❌ | ❌ | ❌ | ⚠️ manual | ✅ Phase 4.1-4.2 (Neo4j diff) |
| Staging branch per workflow | ❌ | ❌ | ❌ | ❌ | ✅ Phase 4.3 |
| Human review (PendingEdits) | ⚠️ Plan mode | ⚠️ | ❌ | ⚠️ unused | ✅ Phase 4.4 |
| **`exit_plan_mode` / Plan Mode** | ✅ | ❌ | ❌ | ❌ | ✅ Phase 4.5 (NEW) |
| **`cron` tool (native)** | via bash | ✅ | ❌ | ❌ | ✅ Phase 4.6 (NEW) |
| Session resume | ✅ | ✅ | ⚠️ | ❌ | ✅ Phase 5.6 |
| Subagent delegation | ✅ Task | ✅ Task | ⚠️ | ⚠️ simulated | ✅ Phase 5.2 |
| Knowledge graph (Neo4j) | ❌ | ✅ skill | ❌ | ✅ **unique** | ✅ **unique** |
| Vector search (Qdrant) | ❌ | ✅ skill | ❌ | ✅ **unique** | ✅ **unique** |
| 3-tier memory | via files | ✅ tool | ❌ | ✅ **unique** | ✅ **unique** |
| 5-agent Code Team workflow | ❌ | ❌ | ❌ | ✅ **unique** | ✅ **unique** |
| Multi-LLM fallback (5 models) | ❌ Anthropic only | ❌ Z.ai only | ❌ Kimi only | ✅ **unique** | ✅ **unique** |

**Result**: TMO v2.1 reaches **23/25 capabilities parity** (was claimed 25/25 in v2.0) + keeps 5 unique features.

**2 remaining gaps** (Cron + Exit_plan_mode) are now ADDED in Phase 4 — so realistically **TMO v2.1 = 25/25 after Phase 4 completes** (was previously 23/25 if those 2 weren't added).

**Correction**: After Phase 4 fully ships (with 4.5 + 4.6), TMO v2.1 reaches **25/25 capabilities parity** + 5 unique. The 23/25 figure is **interim state after Phase 3**.

---

## Part 6: Implementation Order & Dependencies (REVISED)

```
Phase 1a — Low-risk Foundation (independent, deploy anytime)
  ├── 1a.1 shell                                    ← parallel
  ├── 1a.2 todo_write                               ← parallel
  └── 1a.3 quality gate (warn mode)                 ← parallel
       ↓ (1a ships independently, value delivered)

Phase 1b — Web + Gateway (independent of 1a, parallel-safe)
  ├── 1b.1 web consolidate                          ← parallel
  └── 1b.2 gateway wire + bug fix                  ← parallel
       ↓ (1b ships independently)

Phase 1c — Native FC (BLOCKS Phase 2-5, must be last in Phase 1)
  ├── 1c.1 NIM API tools param
  ├── 1c.2 prompt engineering (parallel)
  └── 1c.3 dual-mode fallback (safety)
       ↓ (after 1 sprint validation, can switch to strict mode)

Phase 2 — File Ops (depends on 1c native FC for reliable dispatch)
       ↓

Phase 3 — Code Intelligence + MCP (depends on Phase 2)
       ↓ (after 3, 23/25 capabilities parity achieved)

Phase 4 — Process + Plan Mode + Cron (depends on 1a.3 + 2)
       ↓ (after 4, 25/25 capabilities parity achieved)

Phase 5 — Architecture (depends on all above)
```

**Critical path**: 1c → 2.x → 3.x → 5.x
**Parallel tracks**:
- 1a (3 tasks) — all parallel, independent
- 1b (2 tasks) — all parallel, independent of 1a
- 1c (3 tasks) — must come after 1a+1b, blocks rest

**Effort estimate** (revised from 5-6 → 8-10 sessions, based on industry data 200-400 lines/session after debug+test):
- Phase 1a: ~400 lines, **1 session**
- Phase 1b: ~200 lines, **1 session**
- Phase 1c: ~200 lines + dual-mode validation, **1-2 sessions** (1 sprint dual-mode = +1 week soak)
- Phase 2: ~600 lines, **2 sessions**
- Phase 3: ~700 lines (incl MCP), **2 sessions**
- Phase 4: ~600 lines (incl Plan Mode + Cron), **2 sessions**
- Phase 5: ~700 lines (incl session resume), **2-3 sessions**
- **Total: ~3,400 lines, 9-12 sessions** (was claimed 3,100 / 5-6 in v2.0)

---

## Part 7: Risk Mitigation (UPDATED with 4 new risks)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Shell tool opens RCE vector | High | Critical | Sandboxed working dir + allowlist + 5-10min timeout + log all egress + refuse `sudo`/fork bombs |
| Native function calling breaks old prompts | Medium | High | Dual-mode for 1 sprint (Phase 1c); keep regex as fallback, log warnings, then strict |
| 36 gateway tools exposed at once → confusion | Medium | Medium | Staged rollout: `ENABLE_GATEWAY_TOOLS=phase-1b` exposes 5 P0 first, then `full` |
| Quality gate too strict blocks workflows | Medium | Medium | `ENABLE_QUALITY_GATE=warn` for first sprint, then `strict` after validation |
| Staging branches pollute git history | Low | Low | Auto-cleanup on workflow completion + failure; `git branch -D workflow/*` cron |
| Auto-rollback deletes unsaved work | Low | Critical | Checkpoint BEFORE risky op, restore ON failure, never auto-delete; log all restores |
| MCP servers add attack surface | Medium | High | Per-server permission prompts (D10); sandbox per server; audit log all calls |
| 5-agent workflow conflicts with master-orchestrator | Medium | High | Run both in parallel for 1 sprint; pick winner by workflow completion rate |
| Knowledge graph drift during file ops | Low | Medium | Phase 4.1 differential Neo4j checkpoint (only changed nodes/rels) |
| **(NEW) Native FC tool definitions leak secrets** | Medium | High | Never include env values in tool description; sanitize `description` field; static analysis check |
| **(NEW) Cron jobs pile up if scheduler crashes** | Medium | Medium | Heartbeat to `cron-scheduler` mini-service; auto-restart via PM2; dedup on resume |
| **(NEW) Plan Mode denial loops forever** | Low | Medium | Max 3 plan revisions per workflow; on 3rd denial, escalate to user with diff |
| **(NEW) MCP filesystem server reads `.env`** | High | Critical | MCP filesystem server has hardcoded denylist (`.env*`, `.git/`, `node_modules/`); refuse read on these paths |

---

## Part 8: What NOT to Build (deliberately excluded)

| Excluded | Reason |
|---|---|
| **Deploy tool** | Too environment-specific; use `shell` + deployment scripts per environment |
| **CI/CD trigger tool** | Use `gh` CLI via `shell`; native GitHub Actions already covers |
| **Computer use / mouse-keyboard** | Claude Code-only territory; not core need for TMO's coding agents |
| **Jupyter notebook support** | Not relevant to TMO's web-dev use case |
| **Slack/Discord integration** | Out of scope; user can add via MCP server if needed |
| **Real-time collaboration** | Out of scope; single-user agent workflows |
| **Voice input/output** | Already removed in commit `129ff61` (Live voice mode dropped) |

---

## Part 9: Unique TMO Features to PRESERVE (do not lose in migration)

| Feature | Why it's unique | Migration rule |
|---|---|---|
| **Knowledge Graph (Neo4j, 15,447 nodes/42,485 rels)** | Claude Code/Kimi-CLI have none; Z.ai Code has it as optional skill | Keep as separate tool, don't fold into `shell`. Use **differential checkpoint** (D13) — full export too slow |
| **3-tier Memory (Supabase + Qdrant + Neo4j)** | None of the 3 competitors have this depth | Keep `knowledge_search`/`knowledge_write`/`knowledge_graph` as separate tools |
| **5-agent Code Team (TL/CORTEX/BOLT/SENTINEL/CATALYST)** | None have structured multi-agent workflow | Keep workflow-engine.ts; master-orchestrator (Phase 5.1) is COMPLEMENT not replacement |
| **Multi-LLM fallback (Kimi K3, DeepSeek V4, GLM, MiniMax, Qwen)** | All competitors are single-vendor locked | Keep provider rotation logic in `nvidia-nim.ts`. Native FC must support all 5 models (verify per-model `tools` param support) |

---

## Part 10: Testing Strategy (NEW in v2.1)

Per project rule "do not write any test code" — but production tools need validation. Compromise: **manual smoke tests + snapshot fixtures**, not unit test files.

### 10.1 Smoke test per `executeTool()` (manual, documented)
For each new tool, document in `docs/tool-smoke-tests.md`:
```
## shell
- Input: { command: "echo hello", timeout_ms: 5000 }
- Expected: { success: true, exit_code: 0, stdout: "hello\n", ... }
- Failure case: { command: "exit 1" } → { success: false, exit_code: 1, ... }
```

### 10.2 Snapshot fixtures for receipts
Store in `docs/tool-snapshots/`:
- `shell-receipt.json` — sample receipt shape
- `file-edit-receipt.json` — match count guard behavior
- `web-search-receipt.json` — unified provider response
Used by agents as reference, not as automated tests.

### 10.3 Integration test (golden path)
Single E2E flow documented in `docs/golden-path.md`:
1. Agent creates todo list
2. Agent calls `shell` to install package
3. Agent calls `file_edit` to add code
4. Agent calls `run_tests` to verify
5. Agent calls `git_commit` to commit
6. Quality gate checks lint+tsc

Run manually after each phase, verify via Agent Browser.

### 10.4 Dual-mode validation for native FC (Phase 1c)
- Run 10 sample agent tasks in `dual` mode
- Compare tool-call success rate (native vs regex fallback)
- If native <95% success → debug, don't switch to `strict`
- After 1 sprint with ≥95% success → switch to `strict`, delete regex code

---

## Part 11: Monitoring & Observability (NEW in v2.1)

### 11.1 Per-tool metrics (logged to SQLite)
New table `ToolMetric`:
```prisma
model ToolMetric {
  id          String   @id @default(cuid())
  toolName    String
  sessionId   String
  agentRole   String   // TL | CORTEX | BOLT | SENTINEL | CATALYST
  success     Boolean
  exitCode    Int?
  durationMs  Int
  errorTag    String?  // categorized error
  timestamp   DateTime @default(now())
}
```

Every `executeTool()` call logs row. Queryable for:
- Call count per tool per day
- Success rate per tool (alert if <90%)
- Latency P50/P95/P99 per tool (alert if P95 > 30s)

### 11.2 Error budget per tool
| Tool | Error budget (per 100 calls) | Action if exceeded |
|---|---|---|
| `shell` | 10 failures | Log + flag for review |
| `file_edit` | 5 failures | Block tool, require human review |
| `run_tests` | 15 failures | Warn only (tests can fail legitimately) |
| `web_search` | 20 failures | Switch provider (tavily → serper → jina) |
| `git_commit` | 0 failures | Block immediately, alert |
| `cron` | 5 failures | Disable job, alert |

### 11.3 Alerting (via existing toast UI)
- Real-time toast on critical failures (git_commit error, cron job crash)
- Daily summary toast: "Tool X had Y% success rate today"
- Weekly report: aggregate metrics to `docs/weekly-tool-report.md`

---

## Part 12: Feature Flags (NEW in v2.1)

All flags in `.env` (off by default for safe rollout):

```bash
# Phase 1a
ENABLE_SHELL_TOOL=false
ENABLE_TODO_TOOL=false
ENABLE_QUALITY_GATE=off  # off | warn | strict

# Phase 1b
ENABLE_WEB_UNIFIED=false
ENABLE_GATEWAY_TOOLS=off  # off | phase-1b | full

# Phase 1c
ENABLE_NATIVE_FC=off  # off | dual | strict

# Phase 2
ENABLE_FILE_READ=false
ENABLE_FILE_EDIT=false
ENABLE_FILE_MULTI_EDIT=false
ENABLE_FILE_DELETE=false
ENABLE_FILE_LIST=false
ENABLE_FILE_GREP=false
ENABLE_RUN_TESTS=false
ENABLE_GIT_COMMIT=false

# Phase 3
ENABLE_LSP_DIAGNOSTICS=false
ENABLE_BROWSER_SCREENSHOT=false
ENABLE_LINT=false
ENABLE_TYPE_CHECK=false
ENABLE_TEST_COVERAGE=false
ENABLE_DB_QUERY=false
ENABLE_MCP_CALL=false

# Phase 4
ENABLE_AUTO_CHECKPOINT=false
ENABLE_AUTO_RESTORE=off  # off | warn | strict
ENABLE_STAGING_BRANCH=false
ENABLE_HUMAN_REVIEW=false
ENABLE_PLAN_MODE=false
ENABLE_CRON_TOOL=false

# Phase 5
ENABLE_MASTER_ORCHESTRATOR=false
ENABLE_REAL_DELEGATE=false
ENABLE_SESSION_RESUME=false
```

**Rollout protocol**:
1. Implement tool with flag `false`
2. Smoke test (Part 10.1) with flag `true` in dev
3. Promote to `true` in `.env.example` (template)
4. After 1 sprint stable, remove flag (always-on)
5. After 2 sprints stable, remove dual-mode safety (e.g., `ENABLE_NATIVE_FC=dual` → `strict`)

---

## Part 13: Per-tool Permission Matrix (NEW in v2.1)

### 13.1 Role × Tool matrix
| Tool | TL (APEX) | G1 (CORTEX) | G2-A (BOLT) | G2-B (SENTINEL) | G3 (CATALYST) |
|---|---|---|---|---|---|
| `shell` | ✅ | ✅ | ✅ | ✅ read-only | ✅ |
| `todo_write`/`read` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `web_search`/`fetch` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `file_read` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `file_edit`/`multi_edit` | ❌ | ✅ design only | ✅ | ❌ review only | ✅ optimize |
| `file_delete` | ❌ | ❌ | ✅ | ❌ | ⚠️ with checkpoint |
| `file_list`/`grep` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `run_tests` | ✅ | ❌ | ✅ | ✅ | ✅ |
| `git_commit` | ⚠️ with approval | ❌ | ✅ scoped | ❌ | ✅ scoped |
| `lsp_diagnostics` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `browser_screenshot` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `lint`/`type_check` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `test_coverage` | ✅ | ❌ | ✅ | ✅ | ✅ |
| `db_query` | ✅ read-only | ❌ | ✅ read-only | ✅ read-only | ✅ read-only |
| `mcp_call` | ⚠️ with approval | ❌ | ✅ | ❌ | ✅ |
| `checkpoint_*` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `exit_plan_mode` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `cron` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `delegate` | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Gateway tools (36)** | 5 P0 | ❌ | 5 P0 | ❌ | 5 P0 |

Legend: ✅ allowed | ❌ denied | ⚠️ conditional

### 13.2 Audit log
Every tool call logs to `ToolMetric` (Part 11.1) with `agentRole`. Deny rules enforced in `executeTool()` dispatcher.

### 13.3 Rate limiting per tool per agent
| Tool | Rate limit per agent per minute |
|---|---|
| `shell` | 20 (prevent runaway) |
| `web_search`/`fetch` | 10 (prevent API quota burn) |
| `file_edit` | 30 |
| `git_commit` | 5 (prevent spam commits) |
| `cron` create | 3 |
| Others | 60 (generous) |

Enforced via in-memory token bucket per `agentRole + toolName`.

---

## Part 14: A/B Testing Plan for Safety Mechanisms (NEW in v2.1)

### 14.1 Quality gate: warn vs strict
- **Sprint 1**: `ENABLE_QUALITY_GATE=warn` for all workflows
  - Logs errors, workflow still completes
  - Track: % workflows with lint errors, % with tsc errors
- **Sprint 2**: 50/50 split (hash by sessionId)
  - Half `warn`, half `strict`
  - Track: completion rate, user satisfaction
- **Sprint 3**: based on Sprint 2 data, pick winner
  - If strict doesn't reduce completion rate significantly → switch to `strict` default

### 14.2 Auto-restore: dry-run vs enabled
- **Sprint 1**: `ENABLE_AUTO_RESTORE=warn` (logs "would have restored to checkpoint X", doesn't actually restore)
- **Sprint 2**: enable for low-risk workflows only (no DB writes, no Neo4j writes)
- **Sprint 3**: enable for all workflows if no false-positives

### 14.3 Native FC: dual vs strict
- **Sprint 1**: `ENABLE_NATIVE_FC=dual` (covered in Phase 1c.3)
- **Sprint 2**: continue dual, gather success rate data
- **Sprint 3**: if native ≥95% success → `strict`; else debug

### 14.4 Plan Mode: opt-in vs default
- **Sprint 1**: `ENABLE_PLAN_MODE=true` but only for high-risk workflows (file_delete, git_commit, mcp_call)
- **Sprint 2**: extend to medium-risk (file_edit, file_multi_edit)
- **Sprint 3**: all workflows opt-in via `--plan` flag

---

## Appendix A: File Change Map (UPDATED)

| File | Phase | Changes |
|---|---|---|
| `src/lib/code-team/tool-executor.ts` | 1a-5 | Add executeShell, todoWrite/Read, web consolidated, gateway wire, file_read/edit/multi_edit/delete/list/grep, run_tests, git_commit, lsp_diagnostics, browser_screenshot, lint, type_check, test_coverage, db_query, mcp_call, exit_plan_mode, cron, real delegate |
| `prisma/schema.prisma` | 1a, 5 | Add `Todo`, `ToolMetric`, `Neo4jCheckpointDiff`, `WorkflowSession` models |
| `src/lib/code-team/workflow-engine.ts` | 1a, 4, 5 | enforceQualityGate, auto-checkpoint (Neo4j diff), staging branch, PendingEdits wire, exit_plan_mode integration, delete regex parsing |
| `src/lib/llm/nvidia-nim.ts` | 1c | Add `tools` param support, verify per-model (5 models) |
| `mini-services/opencode-server/server.ts` | 1b | Add `/execute` route alias, fix URL mismatch |
| `src/lib/code-team/agents.ts` | 1b | Wire 36 gateway tools to roles per Part 13 matrix |
| `src/lib/code-team/prompts.ts` | 1c, 2-5 | Convert text descriptions → JSON schemas for native FC |
| `src/lib/feature-flags.ts` (NEW) | 1a | Centralized flag reader from `.env` |
| `src/lib/mcp/mcp-bridge.ts` (NEW) | 3.6 | MCP server support with per-server permissions |
| `src/lib/cron/scheduler.ts` (NEW) | 4.6 | Cron job scheduler with retry + dedup |
| `mini-services/cron-scheduler/index.ts` (NEW) | 4.6 | Mini-service on port 3004 |
| `src/lib/orchestration/master-orchestrator.ts` | 5.1 | Implement executeStep() at line 477 |
| `src/lib/orchestration/agent-delegator.ts` | 5.2 | Implement real delegation |
| `src/lib/fs-checkpoint.ts` + `neo4j-checkpoint.ts` (NEW) | 4.1 | Auto-checkpoint + Neo4j differential |
| `src/app/api/workflow/resume/route.ts` (NEW) | 5.6 | Session resume endpoint |

---

## Appendix B: Acceptance Criteria per Phase (UPDATED)

| Phase | Demo verification |
|---|---|
| **1a** | Agent creates todo list → calls `shell` to install package → quality gate reports errors in `warn` mode (workflow still completes). All feature flags observed in `.env`. |
| **1b** | Agent calls `web_search("Next.js 16")` → unified results. Agent calls gateway `apply_patch` → no 404, routes correctly. |
| **1c** | LLM emits `tool_calls` array in logs. Dual-mode: native FC tried first, regex fallback invoked <5%. Tool-call success rate ≥95%. |
| **2** | Agent reads file with line numbers → edits with match guard → multi-edits atomically → deletes with dry_run → runs tests structured → commits scoped. |
| **3** | Agent gets LSP diagnostics → screenshots UI → lints structured → checks coverage → queries DB read-only → calls MCP github server after user approval. |
| **4** | Workflow auto-checkpoints before edits (Neo4j diff, not full export) → on verify failure auto-restores → uses staging branch → user approves via PendingEdits UI → Plan Mode surfaces for high-risk → cron job executes on schedule. |
| **5** | master-orchestrator routes steps → real delegation spawns sub-agent → session resume after context overflow → regex parsing code deleted. |

---

## Appendix C: Session Resume Spec (NEW, detailed)

### C.1 State persistence
- New Prisma model `WorkflowSession`:
```prisma
model WorkflowSession {
  id              String   @id @default(cuid())
  agentRole       String   // TL | CORTEX | BOLT | SENTINEL | CATALYST
  taskDescription String   // original user request
  state           String   // JSON: { currentStep, todoIds, lastToolReceipts, ... }
  status          String   @default("active")  // active | paused | completed | failed
  contextOverflowCount Int @default(0)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@index([status, updatedAt])
}
```

- State serialized as JSONB-equivalent (SQLite TEXT column)
- Updated after every tool call (incremental, not full rewrite)

### C.2 Resume endpoint
```
POST /api/workflow/resume?sessionId=X
Authorization: Bearer <user_token>
```

Returns:
```json
{
  "sessionId": "X",
  "taskDescription": "...",
  "todoList": [...],
  "lastToolReceipts": [...5 most recent],
  "currentStep": "G2-A code generation",
  "ready": true
}
```

### C.3 Concurrent lock
- Row lock on `WorkflowSession` with `status='active'`
- If 2 agents try to resume same session → second gets `409 Conflict { error: "Session locked by another agent" }`
- Lock released on completion, failure, or 30-min timeout

### C.4 Context overflow recovery
When LLM context exceeds limit:
1. Agent detects context overflow (token count > threshold)
2. Saves state to `WorkflowSession.state`
3. Marks `status='paused'`, `contextOverflowCount++`
4. New agent session starts, calls `/api/workflow/resume?sessionId=X`
5. Re-injects: original task + todo list + last 5 tool receipts + current step
6. Agent continues from checkpoint (not from scratch)

### C.5 Cleanup
- Sessions older than 30 days with `status='completed'` → archive to cold storage
- Sessions with `status='paused'` >7 days → alert user, prompt resume or delete
- Max 100 active sessions per user (FIFO eviction)

---

## Appendix D: Sample `.env.example` additions (for v2.1 feature flags)

Add to existing `.env.example`:

```bash
# ============================================
# TMO v2.1 Feature Flags (all OFF by default for safe rollout)
# ============================================
# Phase 1a
ENABLE_SHELL_TOOL=false
ENABLE_TODO_TOOL=false
ENABLE_QUALITY_GATE=off  # off | warn | strict

# Phase 1b
ENABLE_WEB_UNIFIED=false
ENABLE_GATEWAY_TOOLS=off  # off | phase-1b | full

# Phase 1c
ENABLE_NATIVE_FC=off  # off | dual | strict

# Phase 2-5 (all off, enable per phase)
ENABLE_FILE_OPS=false
ENABLE_CODE_INTEL=false
ENABLE_MCP_CALL=false
ENABLE_PROCESS_SAFETY=false
ENABLE_PLAN_MODE=false
ENABLE_CRON_TOOL=false
ENABLE_MASTER_ORCHESTRATOR=false
ENABLE_SESSION_RESUME=false

# MCP servers
MCP_SERVERS=  # comma-separated: filesystem,github,postgres,puppeteer
MCP_SERVERS_CONFIG_PATH=~/.config/mcp/servers.json

# Cron scheduler (mini-service on port 3004)
CRON_SCHEDULER_PORT=3004
CRON_SCHEDULER_HEARTBEAT_MS=30000
```

---

**Next action**: Begin Phase 1a implementation (3 parallel tasks: shell + todo_write + quality gate, all behind feature flags). Estimated 1 session to deliver value independently of native FC migration. Phase 1c can wait until 1a+1b validated.

---

## Changelog (v2.0 → v2.1)

| # | Change | Reason |
|---|---|---|
| C1 | Split Phase 1 → 1a/1b/1c by risk | W1: native FC migration risk too high to bundle |
| C2 | Added Part 12 (Feature Flags) | W3: need rollback strategy per tool |
| C3 | Added Part 10 (Testing Strategy) | W2: production tools need validation |
| C4 | Added Part 11 (Monitoring) | W4: need metrics + error budget |
| C5 | Specified Neo4j differential checkpoint | W8: 42,485 rels too slow for full export |
| C6 | Moved MCP Phase 5 → Phase 3.6 | W6: MCP is industry standard, ship earlier |
| C7 | Added `exit_plan_mode` Phase 4.5 | W9: Claude Code Plan Mode is critical safety |
| C8 | Added `cron` tool Phase 4.6 | W10: Z.ai Code has it, shell crontab not audit-friendly |
| C9 | Specified prompt engineering for native FC | W5: not just API change, prompts need rewrite |
| C10 | Added Part 13 (Permission Matrix) | W12: 36 gateway tools need role-based access |
| C11 | Revised effort 5-6 → 9-12 sessions | W13: industry data 200-400 lines/session |
| C12 | Added Part 14 (A/B Testing) | W7: safety mechanisms need validation before enforce |
| C13 | Specified session resume in Appendix C | W11: was vague in v2.0 |
| C14 | Corrected matrix 25/25 → 23/25 interim, 25/25 after Phase 4 | Self-corrected over-claim |
