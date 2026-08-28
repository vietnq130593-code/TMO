/**
 * Code Team — Agent Resolution Layer
 *
 * Giải quyết C1 (Auto-seeding Conflict) từ docs/critical-issues-resolution.md:
 *
 * Workflow Engine phụ thuộc vào 5 agents tồn tại trong DB.
 * Auto-seeding cũ bị tắt (Task 14) → workflow crash khi agents không tồn tại.
 *
 * Giải pháp: Agent Resolution Layer — resolve agent từ nhiều nguồn theo thứ tự ưu tiên:
 *   Step 1: Tìm trong DB (AgentProfile) — DB first (user có thể customize)
 *   Step 2: Fallback to Hardcoded Definition — từ agents.ts
 *   Step 3: Lazy Seed — tạo agent vào DB từ hardcoded (isSystem=false → user có thể xóa)
 *   Step 4: Không tìm thấy → ESCALATE (emit SSE event, workflow tạm dừng)
 *
 * Điểm mấu chốt:
 *   - Lazy Seeding: Chỉ tạo agents KHI CẦN (workflow trigger), KHÔNG auto-seed lúc startup
 *   - isSystem=false: Agents lazy-seed KHÔNG phải system agents → user có thể xóa/customize
 *   - DB-First: Nếu user đã tự tạo agent với position đúng → dùng config của user
 *   - Hardcoded-Fallback: Nếu DB không có → dùng hardcoded definition → lazy seed vào DB
 */

import { db } from '@/lib/db'
import { getAgentByPosition, getAgentTools, type CodeTeamAgentDef } from './agents'
import { getAgentPrompt } from './prompts'

/**
 * Parse AgentProfile.tools (JSON string — Agent Factory whitelist) → string[].
 * Null/rỗng/lỗi parse → fallback (hành vi cũ: toolset theo position).
 */
function parseDbTools(raw: string | null | undefined, fallback: string[]): string[] {
  if (!raw) return fallback
  try {
    const arr = JSON.parse(raw)
    if (Array.isArray(arr) && arr.length > 0 && arr.every(x => typeof x === 'string')) {
      return arr as string[]
    }
  } catch { /* JSON hỏng → fallback */ }
  return fallback
}

// ==================== LAZY SEED CACHE ====================

/** Per-process cache of recently resolved agents to avoid redundant DB queries.
 *  Cleared after 5 minutes or when max size (20) is reached.
 *  Key: position (e.g., 'TL', 'G1')
 */
const resolveCache = new Map<string, { agent: ResolvedAgent; timestamp: number }>()
const RESOLVE_CACHE_TTL_MS = 5 * 60_000 // 5 minutes
const RESOLVE_CACHE_MAX = 20

function getCachedResolvedAgent(position: string): ResolvedAgent | null {
  const cached = resolveCache.get(position)
  if (!cached) return null
  if (Date.now() - cached.timestamp > RESOLVE_CACHE_TTL_MS) {
    resolveCache.delete(position)
    return null
  }
  return cached.agent
}

function setCachedResolvedAgent(position: string, agent: ResolvedAgent): void {
  // Evict oldest if full
  if (resolveCache.size >= RESOLVE_CACHE_MAX) {
    const oldestKey = resolveCache.keys().next().value
    if (oldestKey) resolveCache.delete(oldestKey)
  }
  resolveCache.set(position, { agent, timestamp: Date.now() })
}

// ==================== TYPES ====================

/** Resolved agent — ready for workflow engine to use */
export interface ResolvedAgent {
  /** DB agent ID (if exists in DB) */
  id?: string
  /** Agent display name */
  name: string
  /** Agent position: TL | G1 | G2-A | G2-B | G3 */
  position: string
  /** LLM provider (e.g., 'nvidia') */
  provider: string
  /** LLM model (e.g., 'moonshotai/kimi-k2.6') */
  model: string
  /** LLM temperature */
  temperature: number
  /** LLM max tokens */
  maxTokens: number
  /** System prompt / instruction */
  instruction: string
  /** Tool permissions */
  tools: string[]
  /** Avatar emoji */
  avatar: string | null
  /** Where this agent config came from */
  source: 'database' | 'hardcoded' | 'lazy_seeded' | 'missing'
  /** Ghi chú bổ sung (vd lý do missing — agent bị disable) */
  note?: string
}

/** Resolution result — includes all resolved agents + any missing positions */
export interface ResolutionResult {
  agents: Map<string, ResolvedAgent>
  missingPositions: string[]
  lazySeeded: string[]
  fromDatabase: string[]
  fromHardcoded: string[]
}

// ==================== MAIN RESOLVER ====================

/**
 * Resolve ALL agents needed for a pipeline.
 * Returns a Map<position, ResolvedAgent> plus metadata about resolution.
 *
 * @param positions - Array of positions needed (e.g., ['TL', 'G1', 'G2-A', 'G2-B', 'G3'])
 * @returns Resolution result with all agents and metadata
 */
export async function resolveAllAgents(positions: string[]): Promise<ResolutionResult> {
  const agents = new Map<string, ResolvedAgent>()
  const missingPositions: string[] = []
  const lazySeeded: string[] = []
  const fromDatabase: string[] = []
  const fromHardcoded: string[] = []

  for (const position of positions) {
    const resolved = await resolveAgent(position)

    if (resolved.source === 'missing') {
      missingPositions.push(position)
    } else {
      agents.set(position, resolved)

      if (resolved.source === 'database') {
        fromDatabase.push(position)
      } else if (resolved.source === 'lazy_seeded') {
        lazySeeded.push(position)
      } else if (resolved.source === 'hardcoded') {
        fromHardcoded.push(position)
      }
    }
  }

  if (lazySeeded.length > 0) {
    console.log(`[AgentResolver] Lazy seeded ${lazySeeded.length} agents: ${lazySeeded.join(', ')}`)
  }
  if (fromDatabase.length > 0) {
    console.log(`[AgentResolver] Found ${fromDatabase.length} agents in DB: ${fromDatabase.join(', ')}`)
  }
  if (missingPositions.length > 0) {
    console.warn(`[AgentResolver] ⚠️ Missing agents for positions: ${missingPositions.join(', ')}`)
  }

  return { agents, missingPositions, lazySeeded, fromDatabase, fromHardcoded }
}

/**
 * Resolve a single agent by position.
 *
 * Resolution order:
 *   1. DB lookup — if agent exists with matching position and team='code' and enabled=true
 *   2. Hardcoded fallback — if not in DB, use definition from agents.ts
 *   3. Lazy seed — create agent in DB from hardcoded (isSystem=false)
 *   4. Missing — no definition found, return with source='missing'
 *
 * @param position - Agent position (TL, G1, G2-A, G2-B, G3)
 * @returns ResolvedAgent with source indicating where config came from
 */
export async function resolveAgent(position: string, opts?: { strictEnabled?: boolean }): Promise<ResolvedAgent> {
  // strictEnabled (fix review 2026-09-08): caller là SUB-AGENT DELEGATION —
  // agent bị user DISABLE phải từ chối (missing) thay vì fallback hardcoded
  // và chạy ngầm (user tắt agent mà vẫn bị gọi = vi phạm ý người dùng).
  // Workflow engine giữ hành vi cũ (fallback để pipeline không chết).
  const strictEnabled = opts?.strictEnabled === true

  // ===== Step 0: Check resolve cache (Phase 4: avoid redundant DB queries) =====
  const cached = getCachedResolvedAgent(position)
  if (cached) {
    return cached
  }

  // ===== Step 1: Tìm trong DB (enabled=true) =====
  try {
    const dbAgent = await db.agentProfile.findFirst({
      where: {
        team: 'code',
        position: position,
        enabled: true,
      },
    })

    if (dbAgent) {
      const result: ResolvedAgent = {
        id: dbAgent.id,
        name: dbAgent.name,
        position: dbAgent.position || position,
        provider: dbAgent.provider,
        model: dbAgent.model,
        temperature: dbAgent.temperature,
        maxTokens: dbAgent.maxTokens,
        instruction: dbAgent.instruction || getAgentPrompt(position),
        // FIX (review 2026-09-08): tôn trọng whitelist tools riêng của agent
        // (Agent Factory / user-customized) thay vì luôn lấy toolset hardcoded.
        tools: parseDbTools(dbAgent.tools, getAgentTools(position)),
        avatar: dbAgent.avatar || '',
        source: 'database',
      }
      setCachedResolvedAgent(position, result)
      return result
    }

    // Edge case (Phase 4): DB có agent nhưng disabled
    // → Dùng hardcoded fallback, KHÔNG lazy seed mới (tránh duplicate)
    const disabledAgent = await db.agentProfile.findFirst({
      where: {
        team: 'code',
        position: position,
        enabled: false,
      },
    })

    if (disabledAgent) {
      // STRICT MODE (sub-agent delegation): agent bị disable → missing, KHÔNG
      // chạy fallback hardcoded (đều đặn với ý định disable của user).
      if (strictEnabled) {
        console.warn(`[AgentResolver] Agent ${position} (${disabledAgent.name}) is DISABLED — strict mode → missing (từ chối delegate)`)
        const disabledResult: ResolvedAgent = {
          name: disabledAgent.name,
          position,
          provider: '',
          model: '',
          temperature: 0.5,
          maxTokens: 4096,
          instruction: '',
          tools: [],
          avatar: disabledAgent.avatar || '⏸️',
          source: 'missing',
          note: `Agent "${disabledAgent.name}" đang bị TẮT (disabled) — không thể delegate. Bật lại agent trong module Agents nếu cần.`,
        }
        setCachedResolvedAgent(position, disabledResult)
        return disabledResult
      }
      console.warn(`[AgentResolver] Agent ${position} exists in DB but is DISABLED — using hardcoded fallback (no lazy seed to avoid duplicate)`)
      const hardcoded = getAgentByPosition(position)
      if (hardcoded) {
        const prompt = getAgentPrompt(position)
        const result: ResolvedAgent = {
          name: hardcoded.name,
          position: hardcoded.position,
          provider: hardcoded.provider,
          model: hardcoded.model,
          temperature: hardcoded.temperature,
          maxTokens: hardcoded.maxTokens,
          instruction: prompt,
          tools: hardcoded.tools,
          avatar: hardcoded.avatar,
          source: 'hardcoded',
        }
        setCachedResolvedAgent(position, result)
        return result
      }
      // No hardcoded either — return missing
      const missingResult: ResolvedAgent = {
        name: `Unknown-${position}`,
        position,
        provider: '',
        model: '',
        temperature: 0.5,
        maxTokens: 4096,
        instruction: '',
        tools: [],
        avatar: '❓',
        source: 'missing',
      }
      setCachedResolvedAgent(position, missingResult)
      return missingResult
    }
  } catch (err) {
    console.warn(`[AgentResolver] DB lookup failed for position ${position}:`, err)
    // Continue to fallback — don't crash if DB is unavailable
  }

  // ===== Step 2: Fallback to Hardcoded Definition =====
  const hardcoded = getAgentByPosition(position)
  if (!hardcoded) {
    // No definition found for this position
    console.warn(`[AgentResolver] No hardcoded definition for position: ${position}`)
    const missingResult: ResolvedAgent = {
      name: `Unknown-${position}`,
      position,
      provider: '',
      model: '',
      temperature: 0.5,
      maxTokens: 4096,
      instruction: '',
      tools: [],
      avatar: '❓',
      source: 'missing',
    }
    setCachedResolvedAgent(position, missingResult)
    return missingResult
  }

  // ===== Step 3: Lazy Seed — tạo agent vào DB từ hardcoded =====
  // QUAN TRỌNG: isSystem = false → User có thể xóa/customize
  try {
    const prompt = getAgentPrompt(position)
    const newAgent = await db.agentProfile.create({
      data: {
        name: hardcoded.name,
        description: hardcoded.description,
        instruction: prompt,
        domain: hardcoded.domain,
        capable: hardcoded.capable,
        provider: hardcoded.provider,
        model: hardcoded.model,
        temperature: hardcoded.temperature,
        maxTokens: hardcoded.maxTokens,
        team: hardcoded.team,
        position: hardcoded.position,
        avatar: hardcoded.avatar,
        isSystem: false,  // ← KHÁC BIỆT QUAN TRỌNG: user có thể xóa
        enabled: true,
      },
    })

    console.log(`[AgentResolver] Lazy seeded agent: ${hardcoded.name} (${position}) [isSystem=false]`)

    const lazySeededResult: ResolvedAgent = {
      id: newAgent.id,
      name: hardcoded.name,
      position: hardcoded.position,
      provider: hardcoded.provider,
      model: hardcoded.model,
      temperature: hardcoded.temperature,
      maxTokens: hardcoded.maxTokens,
      instruction: prompt,
      tools: hardcoded.tools,
      avatar: hardcoded.avatar,
      source: 'lazy_seeded',
    }
    setCachedResolvedAgent(position, lazySeededResult)
    return lazySeededResult
  } catch (seedErr) {
    // Lazy seed failed — maybe concurrent create, or DB issue
    // Try to find the agent again (another request might have created it)
    console.warn(`[AgentResolver] Lazy seed failed for ${position}:`, seedErr)

    try {
      const retryDb = await db.agentProfile.findFirst({
        where: {
          team: 'code',
          position: position,
          enabled: true,
        },
      })

      if (retryDb) {
        const retryResult: ResolvedAgent = {
          id: retryDb.id,
          name: retryDb.name,
          position: retryDb.position || position,
          provider: retryDb.provider,
          model: retryDb.model,
          temperature: retryDb.temperature,
          maxTokens: retryDb.maxTokens,
          instruction: retryDb.instruction || getAgentPrompt(position),
          tools: parseDbTools(retryDb.tools, getAgentTools(position)),
          avatar: retryDb.avatar || '',
          source: 'database',
        }
        setCachedResolvedAgent(position, retryResult)
        return retryResult
      }
    } catch {
      // DB still unavailable — return hardcoded without seeding
    }

    // Return hardcoded definition without DB entry
    const prompt = getAgentPrompt(position)
    const fallbackResult: ResolvedAgent = {
      name: hardcoded.name,
      position: hardcoded.position,
      provider: hardcoded.provider,
      model: hardcoded.model,
      temperature: hardcoded.temperature,
      maxTokens: hardcoded.maxTokens,
      instruction: prompt,
      tools: hardcoded.tools,
      avatar: hardcoded.avatar,
      source: 'hardcoded',
    }
    setCachedResolvedAgent(position, fallbackResult)
    return fallbackResult
  }
}

// ==================== PIPELINE RESOLUTION ====================

/**
 * Resolve all agents needed for a specific pipeline (mode + tier combination).
 * Convenience function that combines getPipeline + resolveAllAgents.
 */
export async function resolvePipelineAgents(
  mode: 'A' | 'B' | 'C',
  tier: 1 | 2 | 3
): Promise<ResolutionResult> {
  // Import pipeline helper from agents.ts
  const { getPipelineForMode } = await import('./agents')

  const pipelinePositions = getPipelineForMode(mode, tier)
  const uniquePositions = [...new Set(pipelinePositions)]

  return resolveAllAgents(uniquePositions)
}

/**
 * Check if all required agents are available for a pipeline.
 * Returns true if no missing positions.
 */
export function isPipelineReady(result: ResolutionResult): boolean {
  return result.missingPositions.length === 0
}

/**
 * Get a summary string for logging/debugging.
 */
export function getResolutionSummary(result: ResolutionResult): string {
  const parts: string[] = []
  if (result.fromDatabase.length > 0) {
    parts.push(`DB: ${result.fromDatabase.join(', ')}`)
  }
  if (result.fromHardcoded.length > 0) {
    parts.push(`Hardcoded: ${result.fromHardcoded.join(', ')}`)
  }
  if (result.lazySeeded.length > 0) {
    parts.push(`Lazy-seeded: ${result.lazySeeded.join(', ')}`)
  }
  if (result.missingPositions.length > 0) {
    parts.push(`MISSING: ${result.missingPositions.join(', ')}`)
  }
  return parts.join(' | ')
}
