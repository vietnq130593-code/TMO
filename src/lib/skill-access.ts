/**
 * Skill Access — 2026-09-01 (user request: "Agents - skills access" trong
 * dialog Quản lý Tools & Skills): phân quyền ĐỌC skill theo agent.
 *
 * Model Prisma SkillAssignment (agentKey, slug, enabled) — mirror ToolAssignment:
 *   - KHÔNG có row          → MỶC ĐỊNH = agent đọc được skill (behavior
 *                             2026-09-12 "MỌI agents đọc qua list_skills/
 *                             read_skill" giữ nguyên — fail-open).
 *   - override enabled=false → CHẶN agent đó: read_skill hard-gate + list_skills
 *                             ẩn skill + DB skill không inject vào prompt.
 *   - override enabled=true  → cấp tường minh (hiển thị xanh trong UI).
 *   - reset (enabled=null)   → xóa row → về mặc định.
 *
 * ENFORCEMENT 2 LỚP (đối xứng tool-access.ts):
 *   1. PROMPT-SIDE: list_skills lọc skill bị chặn khỏi danh sách + DB skill
 *      không inject vào system prompt (openclaw/chat + workflow-engine).
 *   2. EXECUTOR HARD-GATE: read_skill chặn tại tool-executor — dù LLM vẫn
 *      phát tool call (defense in depth).
 *
 * Raw-SQL bridge (pattern tool-access.ts/metrics-db.ts): dev server giữ
 * PrismaClient instance CŨ trong process — `db.skillAssignment` có thể
 * undefined sau db:push. Try delegate trước; thiếu → raw SQL. Instance
 * fresh (sau restart) tự lành sang delegate path.
 *
 * Cache: globalThis 30s — list_skills/read_skill là hot path. setSkillAssignment
 * tự invalidate.
 */

import { db } from '@/lib/db'
import { AGENT_KEYS, normalizeAgentKeyStrict, resolveAgentKey, type AgentKey } from '@/lib/tool-access'

export { AGENT_KEYS, normalizeAgentKeyStrict, resolveAgentKey }
export type { AgentKey }

// ==================== ROW SHAPES ====================

export interface SkillAssignmentRow {
  id: string
  agentKey: string
  slug: string
  enabled: boolean
  updatedBy: string | null
  createdAt: Date
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
    return globalThis.crypto?.randomUUID?.() || `sa_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  } catch {
    return `sa_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  }
}

// ==================== CACHE (globalThis, TTL 30s) ====================

interface SkillAccessCache {
  assignments: SkillAssignmentRow[] | null
  fetchedAt: number
  inflight: Promise<void> | null
}

const CACHE_TTL_MS = 30_000

const g = globalThis as unknown as { __tmoSkillAccessCache?: SkillAccessCache }
function cache(): SkillAccessCache {
  if (!g.__tmoSkillAccessCache) {
    g.__tmoSkillAccessCache = { assignments: null, fetchedAt: 0, inflight: null }
  }
  return g.__tmoSkillAccessCache
}

function invalidateSkillAccessCache(): void {
  const c = cache()
  c.assignments = null
  c.fetchedAt = 0
}

async function loadAssignments(): Promise<SkillAssignmentRow[]> {
  if (hasDelegate('skillAssignment')) {
    return (db as unknown as { skillAssignment: { findMany(): Promise<SkillAssignmentRow[]> } }).skillAssignment.findMany()
  }
  const raw = await db.$queryRaw<
    Array<{ id: string; agentKey: string; slug: string; enabled: number; updatedBy: string | null; createdAt: Date; updatedAt: Date }>
  >`SELECT id, agentKey, slug, enabled, updatedBy, createdAt, updatedAt FROM SkillAssignment`
  return raw.map(r => ({
    id: r.id,
    agentKey: r.agentKey,
    slug: r.slug,
    enabled: !!r.enabled,
    updatedBy: r.updatedBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }))
}

/** Đảm bảo cache tươi (TTL 30s) — 1 inflight duy nhất chống stampede. */
async function ensureCache(): Promise<void> {
  const c = cache()
  if (c.assignments && Date.now() - c.fetchedAt < CACHE_TTL_MS) return
  if (c.inflight) return c.inflight
  c.inflight = (async () => {
    try {
      c.assignments = await loadAssignments()
      c.fetchedAt = Date.now()
    } finally {
      c.inflight = null
    }
  })()
  return c.inflight
}

// ==================== PUBLIC API ====================

/** Toàn bộ skill assignments (cho API/UI). Fail-open trả []. */
export async function getAllSkillAssignments(): Promise<SkillAssignmentRow[]> {
  try {
    await ensureCache()
    return cache().assignments ?? []
  } catch {
    return []
  }
}

/**
 * HARD-GATE check: skill có bị VÔ HIỆU HÓA (override enabled=false) cho agent
 * này không? Chỉ TRUE khi có override tường minh — mặc định (không row) là
 * CHO PHÉP. Fail-open FALSE (lỗi DB không chặn skill).
 */
export async function isSkillDisabledForAgent(
  agentName: string | null | undefined,
  slug: string,
): Promise<boolean> {
  try {
    const key = resolveAgentKey(agentName)
    const assignments = await getAllSkillAssignments()
    return assignments.some(a => a.agentKey === key && a.slug === slug && a.enabled === false)
  } catch {
    return false
  }
}

/**
 * Tập slug bị chặn cho 1 agent (dùng lọc list_skills + prompt injection 1 query).
 * Fail-open trả Set rỗng.
 */
export async function getDisabledSlugsForAgent(
  agentName: string | null | undefined,
): Promise<Set<string>> {
  try {
    const key = resolveAgentKey(agentName)
    const assignments = await getAllSkillAssignments()
    return new Set(assignments.filter(a => a.agentKey === key && a.enabled === false).map(a => a.slug))
  } catch {
    return new Set()
  }
}

/**
 * Set/xóa 1 assignment. enabled=null → XÓA row (reset về mặc định = mọi agent
 * đọc được). Trả assignment mới nhất (null nếu đã xóa). Invalidate cache ngay.
 */
export async function setSkillAssignment(
  agentKeyInput: string,
  slug: string,
  enabled: boolean | null,
  updatedBy?: string,
): Promise<SkillAssignmentRow | null> {
  const key = normalizeAgentKeyStrict(agentKeyInput)
  if (!key) throw new Error(`agentKey không hợp lệ: "${agentKeyInput}" (hợp lệ: ${AGENT_KEYS.join(', ')})`)
  if (!slug || typeof slug !== 'string' || slug.includes('..') || slug.includes('/')) {
    throw new Error(`slug skill không hợp lệ: "${slug}"`)
  }
  const now = new Date()

  if (enabled === null) {
    if (hasDelegate('skillAssignment')) {
      await (db as unknown as { skillAssignment: { deleteMany(args: unknown): Promise<{ count: number }> } })
        .skillAssignment.deleteMany({ where: { agentKey: key, slug } })
    } else {
      await db.$executeRaw`DELETE FROM SkillAssignment WHERE agentKey = ${key} AND slug = ${slug}`
    }
    invalidateSkillAccessCache()
    return null
  }

  if (hasDelegate('skillAssignment')) {
    const row = await (db as unknown as {
      skillAssignment: {
        upsert(args: unknown): Promise<SkillAssignmentRow>
      }
    }).skillAssignment.upsert({
      where: { agentKey_slug: { agentKey: key, slug } },
      update: { enabled, updatedBy: updatedBy ?? null, updatedAt: now },
      create: { agentKey: key, slug, enabled, updatedBy: updatedBy ?? null },
    })
    invalidateSkillAccessCache()
    return row
  }

  // Raw upsert (stale client) — DELETE + INSERT (updatedAt là Prisma-side)
  const id = randomId()
  await db.$executeRaw`DELETE FROM SkillAssignment WHERE agentKey = ${key} AND slug = ${slug}`
  await db.$executeRaw`
    INSERT INTO SkillAssignment (id, agentKey, slug, enabled, updatedBy, createdAt, updatedAt)
    VALUES (${id}, ${key}, ${slug}, ${enabled ? 1 : 0}, ${updatedBy ?? null}, ${now}, ${now})
  `
  invalidateSkillAccessCache()
  return {
    id,
    agentKey: key,
    slug,
    enabled,
    updatedBy: updatedBy ?? null,
    createdAt: now,
    updatedAt: now,
  }
}
