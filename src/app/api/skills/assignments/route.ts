/**
 * Skills Assignments API — 2026-09-01 (user request: "Agents - skills access"
 * trong dialog Quản lý Tools & Skills — tab Skills).
 *
 * GET  /api/skills/assignments — toàn bộ SkillAssignment overrides (cho UI).
 * POST /api/skills/assignments — body { agentKey, slug, enabled, updatedBy? }
 *        enabled=false → chặn agent đọc skill (read_skill hard-gate +
 *                        list_skills ẩn + không inject prompt)
 *        enabled=true  → cấp tường minh (mặc định đã là cho phép)
 *        enabled=null  → XÓA override (reset về mặc định = mọi agent đọc được)
 *
 * Validate: agentKey ∈ AGENT_KEYS (9 key — tool-access.ts)
 *           slug ∈ FS skills (skills/<slug>/SKILL.md) ∪ DB skills (AgentSkill.slug)
 */

import { NextRequest, NextResponse } from 'next/server'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { getAllSkillAssignments, setSkillAssignment, normalizeAgentKeyStrict, AGENT_KEYS } from '@/lib/skill-access'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/** Enum slugs hợp lệ: FS skills (đĩa) + DB AgentSkill — 1 query duy nhất. */
async function collectValidSlugs(): Promise<Set<string>> {
  const slugs = new Set<string>()
  // FS skills
  try {
    const skillsRoot = join(process.cwd(), 'skills')
    if (existsSync(skillsRoot)) {
      for (const d of readdirSync(skillsRoot, { withFileTypes: true })) {
        if (d.isDirectory() && existsSync(join(skillsRoot, d.name, 'SKILL.md'))) {
          slugs.add(d.name)
        }
      }
    }
  } catch { /* fail-open — chỉ validate qua DB */ }
  // DB skills
  try {
    const rows = await db.agentSkill.findMany({ select: { slug: true } })
    for (const r of rows) slugs.add(r.slug)
  } catch { /* fail-open */ }
  return slugs
}

export async function GET() {
  try {
    const assignments = await getAllSkillAssignments()
    return NextResponse.json({
      ok: true,
      agentKeys: AGENT_KEYS,
      assignments,
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { agentKey, slug, enabled, updatedBy } = body ?? {}

    if (typeof agentKey !== 'string' || typeof slug !== 'string') {
      return NextResponse.json(
        { ok: false, error: 'Thiếu agentKey hoặc slug' },
        { status: 400 },
      )
    }
    if (enabled !== null && enabled !== undefined && typeof enabled !== 'boolean') {
      return NextResponse.json(
        { ok: false, error: 'enabled phải là boolean hoặc null (reset)' },
        { status: 400 },
      )
    }
    const key = normalizeAgentKeyStrict(agentKey)
    if (!key) {
      return NextResponse.json(
        { ok: false, error: `agentKey không hợp lệ: "${agentKey}" — hợp lệ: ${AGENT_KEYS.join('|')}` },
        { status: 400 },
      )
    }
    const cleanSlug = slug.trim()
    if (!cleanSlug || cleanSlug.includes('..') || cleanSlug.includes('/') || cleanSlug.length > 200) {
      return NextResponse.json(
        { ok: false, error: `slug không hợp lệ: "${slug}"` },
        { status: 400 },
      )
    }
    // Slug phải là skill THẬT (FS hoặc DB) — chặn override rác
    const validSlugs = await collectValidSlugs()
    if (!validSlugs.has(cleanSlug)) {
      return NextResponse.json(
        { ok: false, error: `Skill "${cleanSlug}" không tồn tại (filesystem hoặc DB)` },
        { status: 404 },
      )
    }

    const row = await setSkillAssignment(key, cleanSlug, enabled ?? null, updatedBy === 'omega' ? 'omega' : 'user')
    return NextResponse.json({
      ok: true,
      agentKey: key,
      slug: cleanSlug,
      enabled: enabled ?? null,
      assignment: row,
      message: enabled == null
        ? `Đã reset skill "${cleanSlug}" về mặc định cho ${key} (mọi agent đọc được)`
        : enabled
          ? `Đã cấp tường minh skill "${cleanSlug}" cho ${key}`
          : `ĐÃ CHẶN agent ${key} đọc skill "${cleanSlug}" (read_skill + list_skills + prompt inject)`,
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
