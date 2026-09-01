/**
 * Tool Access — Task 21-c: enforcement + config layer cho phân quyền tool theo agent
 *
 * 2 model Prisma mới (db:push 2026-08-31):
 *   - ToolAssignment (agentKey, toolName, enabled)   → override whitelist tool theo agent
 *   - ToolConfig     (toolName, description)         → override mô tả tool builtin (prompt LLM + UI)
 *
 * ENFORCEMENT 2 LỚP (fail-open tuyệt đối — lỗi DB KHÔNG bao giờ làm hỏng chat/tool):
 *   1. PROMPT-SIDE: nơi build tool defs / whitelist cho LLM
 *      (workflow-engine.ts runAgentStep + openclaw/chat/route.ts agentTools) —
 *      tool bị disable không còn trong list → LLM không gọi nữa.
 *   2. EXECUTOR HARD-GATE: executeTool() đầu hàm (tool-executor.ts) — check
 *      disabled-override theo context.agentName → trả error có cấu trúc dù LLM
 *      vẫn phát tool call (defense in depth — phủ mọi đường gọi executor).
 *
 * Raw-SQL bridge (pattern metrics-db.ts): dev server giữ PrismaClient instance
 * CŨ trong process — `db.toolAssignment`/`db.toolConfig` có thể undefined sau
 * db:push. Try delegate trước; thiếu → raw SQL (bảng đã tồn tại). Instance
 * fresh (sau restart) tự lành sang delegate path.
 *
 * Cache: globalThis 30s (hot-path executeTool gọi mỗi tool call — không spam
 * DB). setAssignment/setToolConfig tự invalidate.
 */

import { db } from '@/lib/db'

// ==================== AGENT KEY MAPPING ====================
//
// Chuẩn hóa 1 chiều về 9 key. Nguồn tên gọi trong app:
//   - Code Team: agents.ts — name (APEX/CORTEX/BOLT/SENTINEL/CATALYST) + position (TL/G1/G2-A/G2-B/G3)
//   - Standalone: standalone-agents.ts — 'Omega' + 'ALISTA' (kỹ sư bảo trì)
//   - Opus (meta-agent CTO): opus-agent.ts — 'Opus' (TASK 22: key riêng để
//     Tools Manager gán/tắt tool cho Opus độc lập với agents động)
//   - Agent động do Omega create_agent: tên bất kỳ → NEW_AGENT (áp chung 1 bộ override)
//   - Tools Registry (agentMatrix): short = 'OM'|'TL'|'G1'|'G2-A'|'G2-B'|'G3'
//
// FIX 2026-09-01 (user request: "hiện tên tất cả các Agents hiện có"): thêm
// ALISTA — đủ 8 agent thật (AgentProfile) + NEW_AGENT bucket cho agents động.

export const AGENT_KEYS = ['APEX', 'CORTEX', 'BOLT', 'SENTINEL', 'CATALYST', 'OMEGA', 'ALISTA', 'OPUS', 'NEW_AGENT'] as const
export type AgentKey = (typeof AGENT_KEYS)[number]

const POSITION_TO_KEY: Record<string, AgentKey> = {
  TL: 'APEX',
  G1: 'CORTEX',
  'G2-A': 'BOLT',
  'G2-B': 'SENTINEL',
  G3: 'CATALYST',
}

const NAME_TO_KEY: Record<string, AgentKey> = {
  APEX: 'APEX',
  CORTEX: 'CORTEX',
  BOLT: 'BOLT',
  SENTINEL: 'SENTINEL',
  CATALYST: 'CATALYST',
  OMEGA: 'OMEGA',
  OM: 'OMEGA', // Tools Registry agentMatrix short
  ALISTA: 'ALISTA', // kỹ sư bảo trì (standalone-agents.ts) — ca trực 23h30
  OPUS: 'OPUS', // meta-agent CTO (opus-agent.ts) — TASK 22
}

/**
 * Map TÊN/POSITION agent (tên động của agent Omega tạo → NEW_AGENT) về key chuẩn.
 * Lenient: input lạ → 'NEW_AGENT' (an toàn cho hard-gate — chỉ chặn khi có override tường minh).
 */
export function resolveAgentKey(input: string | null | undefined): AgentKey {
  if (!input) return 'NEW_AGENT'
  const raw = input.trim().toUpperCase()
  if (raw === 'NEW_AGENT') return 'NEW_AGENT'
  return NAME_TO_KEY[raw] ?? POSITION_TO_KEY[raw] ?? 'NEW_AGENT'
}

/**
 * Strict cho API/UI: chỉ nhận key chuẩn hoặc alias đã biết (tên agent, position,
 * 'OM'). Trả null nếu input không nhận diện được (chặn typo tạo override rác).
 */
export function normalizeAgentKeyStrict(input: string | null | undefined): AgentKey | null {
  if (!input) return null
  const raw = input.trim().toUpperCase()
  if (raw === 'NEW_AGENT') return 'NEW_AGENT'
  return NAME_TO_KEY[raw] ?? POSITION_TO_KEY[raw] ?? null
}

// ==================== ROW SHAPES ====================

export interface ToolAssignmentRow {
  id: string
  agentKey: string
  toolName: string
  enabled: boolean
  updatedBy: string | null
  createdAt: Date
  updatedAt: Date
}

export interface ToolConfigRow {
  id: string
  toolName: string
  description: string | null
  updatedBy: string | null
  updatedAt: Date
}

// ==================== RAW-SQL BRIDGE ====================

function hasDelegate(model: string): boolean {
  try {
    return typeof (db as unknown as Record<string, unknown>)[model] !== 'undefined'
  } catch {
    return false
  }
}

function randomId(): string {
  try {
    return globalThis.crypto?.randomUUID?.() || `ta_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  } catch {
    return `ta_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  }
}

// ==================== CACHE (globalThis, TTL 30s) ====================

interface ToolAccessCache {
  assignments: ToolAssignmentRow[] | null
  configs: ToolConfigRow[] | null
  fetchedAt: number
  inflight: Promise<void> | null
}

const CACHE_TTL_MS = 30_000

const g = globalThis as unknown as { __tmoToolAccessCache?: ToolAccessCache }
function cache(): ToolAccessCache {
  if (!g.__tmoToolAccessCache) {
    g.__tmoToolAccessCache = { assignments: null, configs: null, fetchedAt: 0, inflight: null }
  }
  return g.__tmoToolAccessCache
}

function invalidateToolAccessCache(): void {
  const c = cache()
  c.assignments = null
  c.configs = null
  c.fetchedAt = 0
}

async function loadAssignments(): Promise<ToolAssignmentRow[]> {
  if (hasDelegate('toolAssignment')) {
    return (db as unknown as { toolAssignment: { findMany(): Promise<ToolAssignmentRow[]> } }).toolAssignment.findMany()
  }
  const raw = await db.$queryRaw<
    Array<{ id: string; agentKey: string; toolName: string; enabled: number; updatedBy: string | null; createdAt: Date; updatedAt: Date }>
  >`SELECT id, agentKey, toolName, enabled, updatedBy, createdAt, updatedAt FROM ToolAssignment`
  return raw.map(r => ({
    id: r.id,
    agentKey: r.agentKey,
    toolName: r.toolName,
    enabled: !!r.enabled,
    updatedBy: r.updatedBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }))
}

async function loadConfigs(): Promise<ToolConfigRow[]> {
  if (hasDelegate('toolConfig')) {
    return (db as unknown as { toolConfig: { findMany(): Promise<ToolConfigRow[]> } }).toolConfig.findMany()
  }
  const raw = await db.$queryRaw<
    Array<{ id: string; toolName: string; description: string | null; updatedBy: string | null; updatedAt: Date }>
  >`SELECT id, toolName, description, updatedBy, updatedAt FROM ToolConfig`
  return raw.map(r => ({ ...r }))
}

/** Đảm bảo cache tươi (TTL 30s) — 1 inflight duy nhất chống stampede. */
async function ensureCache(): Promise<void> {
  const c = cache()
  if (c.assignments && c.configs && Date.now() - c.fetchedAt < CACHE_TTL_MS) return
  if (c.inflight) return c.inflight
  c.inflight = (async () => {
    try {
      const [assignments, configs] = await Promise.all([loadAssignments(), loadConfigs()])
      c.assignments = assignments
      c.configs = configs
      c.fetchedAt = Date.now()
    } finally {
      c.inflight = null
    }
  })()
  return c.inflight
}

// ==================== PUBLIC API ====================

/** Toàn bộ assignments (cho API/UI + manage_tools). Fail-open trả []. */
export async function getAllAssignments(): Promise<ToolAssignmentRow[]> {
  try {
    await ensureCache()
    return cache().assignments ?? []
  } catch {
    return []
  }
}

/** Toàn bộ ToolConfig overrides (cho API/UI + registry description override). Fail-open []. */
export async function getAllToolConfigs(): Promise<ToolConfigRow[]> {
  try {
    await ensureCache()
    return cache().configs ?? []
  } catch {
    return []
  }
}

/**
 * Tool names HIỆU DỤNG của 1 agent = whitelist mặc định + overrides:
 *   - override enabled=true  → THÊM (kể cả tool ngoài whitelist mặc định)
 *   - override enabled=false → BỎ
 *   - không override         → giữ nguyên mặc định
 *
 * LƯU Ý defaultTools=[] (agent "mở" — mọi tool đều phép, vd agent custom không
 * khai báo tools): trả NGUYÊN VẸN [] — không thể enumerate tập mở; tool bị
 * disable vẫn bị chặn bởi executeTool hard-gate (đúng semantics).
 *
 * Fail-open: lỗi DB → trả defaultTools nguyên vẹn.
 */
export async function getEffectiveToolNames(
  agentKeyOrName: string | null | undefined,
  defaultTools: string[],
): Promise<string[]> {
  try {
    const assignments = await getAllAssignments()
    if (assignments.length === 0) return defaultTools
    const key = resolveAgentKey(agentKeyOrName)
    const effective = new Set(defaultTools)
    for (const a of assignments) {
      if (a.agentKey !== key) continue
      if (a.enabled) effective.add(a.toolName)
      else effective.delete(a.toolName)
    }
    return [...effective]
  } catch {
    return defaultTools
  }
}

/**
 * HARD-GATE check: tool có bị VÔ HIỆU HÓA (override enabled=false) cho agent này không?
 * Chỉ TRUE khi có override tường minh (không chặn theo default — default là việc
 * của whitelist caller). Fail-open FALSE.
 */
export async function isToolDisabledForAgent(
  agentName: string | null | undefined,
  toolName: string,
): Promise<boolean> {
  try {
    const key = resolveAgentKey(agentName)
    const assignments = await getAllAssignments()
    return assignments.some(a => a.agentKey === key && a.toolName === toolName && a.enabled === false)
  } catch {
    return false
  }
}

/** Override description của 1 tool (đưa vào prompt LLM + UI). Fail-open null. */
export async function getToolDescriptionOverride(toolName: string): Promise<string | null> {
  try {
    const configs = await getAllToolConfigs()
    const hit = configs.find(c => c.toolName === toolName)
    return hit?.description ?? null
  } catch {
    return null
  }
}

/**
 * Áp description override lên danh sách tool defs (prompt LLM — workflow-engine
 * native FC + nơi nào khác build defs). Clone — KHÔNG mutate def gốc.
 * Fail-open trả nguyên defs.
 */
export async function applyDescriptionOverrides<
  T extends { function: { name: string; description: string } },
>(defs: T[]): Promise<T[]> {
  try {
    const configs = await getAllToolConfigs()
    if (configs.length === 0) return defs
    const map = new Map(configs.map(c => [c.toolName, c.description]))
    return defs.map(d => {
      const override = map.get(d.function.name)
      if (override === undefined || override === null || override === '') return d
      return { ...d, function: { ...d.function, description: override } }
    })
  } catch {
    return defs
  }
}

/**
 * Set/xóa 1 assignment. enabled=null → XÓA row (reset về mặc định hardcoded).
 * Trả assignment mới nhất (null nếu đã xóa). Invalidate cache ngay.
 */
export async function setAssignment(
  agentKeyInput: string,
  toolName: string,
  enabled: boolean | null,
  updatedBy?: string,
): Promise<ToolAssignmentRow | null> {
  const key = normalizeAgentKeyStrict(agentKeyInput)
  if (!key) throw new Error(`agentKey không hợp lệ: "${agentKeyInput}" (hợp lệ: ${AGENT_KEYS.join(', ')})`)
  const now = new Date()

  if (enabled === null) {
    if (hasDelegate('toolAssignment')) {
      await (db as unknown as { toolAssignment: { deleteMany(args: unknown): Promise<{ count: number }> } })
        .toolAssignment.deleteMany({ where: { agentKey: key, toolName } })
    } else {
      await db.$executeRaw`DELETE FROM ToolAssignment WHERE agentKey = ${key} AND toolName = ${toolName}`
    }
    invalidateToolAccessCache()
    return null
  }

  if (hasDelegate('toolAssignment')) {
    const row = await (db as unknown as {
      toolAssignment: {
        upsert(args: unknown): Promise<ToolAssignmentRow>
      }
    }).toolAssignment.upsert({
      where: { agentKey_toolName: { agentKey: key, toolName } },
      update: { enabled, updatedBy: updatedBy ?? null, updatedAt: now },
      create: { agentKey: key, toolName, enabled, updatedBy: updatedBy ?? null },
    })
    invalidateToolAccessCache()
    return row
  }

  // Raw upsert (stale client) — SQLite: DELETE + INSERT thay ON CONFLICT (updatedAt là Prisma-side)
  const id = randomId()
  await db.$executeRaw`DELETE FROM ToolAssignment WHERE agentKey = ${key} AND toolName = ${toolName}`
  await db.$executeRaw`
    INSERT INTO ToolAssignment (id, agentKey, toolName, enabled, updatedBy, createdAt, updatedAt)
    VALUES (${id}, ${key}, ${toolName}, ${enabled ? 1 : 0}, ${updatedBy ?? null}, ${now}, ${now})
  `
  invalidateToolAccessCache()
  return {
    id,
    agentKey: key,
    toolName,
    enabled,
    updatedBy: updatedBy ?? null,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Set/xóa description override cho 1 tool builtin. description=null → xóa
 * (reset về mặc định code). Invalidate cache. Trả config mới (null nếu xóa).
 */
export async function setToolConfig(
  toolName: string,
  description: string | null,
  updatedBy?: string,
): Promise<ToolConfigRow | null> {
  const now = new Date()

  if (description === null || description === '') {
    if (hasDelegate('toolConfig')) {
      await (db as unknown as { toolConfig: { deleteMany(args: unknown): Promise<{ count: number }> } })
        .toolConfig.deleteMany({ where: { toolName } })
    } else {
      await db.$executeRaw`DELETE FROM ToolConfig WHERE toolName = ${toolName}`
    }
    invalidateToolAccessCache()
    return null
  }

  if (hasDelegate('toolConfig')) {
    const row = await (db as unknown as {
      toolConfig: { upsert(args: unknown): Promise<ToolConfigRow> }
    }).toolConfig.upsert({
      where: { toolName },
      update: { description, updatedBy: updatedBy ?? null, updatedAt: now },
      create: { toolName, description, updatedBy: updatedBy ?? null },
    })
    invalidateToolAccessCache()
    return row
  }

  const id = randomId()
  await db.$executeRaw`DELETE FROM ToolConfig WHERE toolName = ${toolName}`
  await db.$executeRaw`
    INSERT INTO ToolConfig (id, toolName, description, updatedBy, updatedAt)
    VALUES (${id}, ${toolName}, ${description}, ${updatedBy ?? null}, ${now})
  `
  invalidateToolAccessCache()
  return { id, toolName, description, updatedBy: updatedBy ?? null, updatedAt: now }
}
