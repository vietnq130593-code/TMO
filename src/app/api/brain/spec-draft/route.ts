/**
 * BRAIN-UX §9.2/§9.7 — SPEC-DRAFT API (GET/PUT /api/brain/spec-draft)
 * ============================================================================
 *
 * Bản nháp kiến trúc brain cho editor UX-1 (Brain Studio) + console UX-2.
 *
 *   GET  → { drafts: [{brain, spec, note, updatedAt} | null × 3] ,
 *           defaults: {brain: defaultDraftFor} } — draft null = chưa có
 *           nháp (UI fallback về default chuẩn).
 *   PUT  → body { brain, spec: BrainDraftSpec } — VALIDATE bằng
 *          spec-schema.validateBrainDraft (single-source, client cùng rule)
 *          TRƯỚC khi ghi; upsert theo @unique(brain) (1 nháp mỗi brain).
 *
 * Bất biến §9.1-1 (Draft ≠ runtime): route này CHỈ đụng bảng BrainSpecDraft —
 * KHÔNG BAO GIỜ ghi BrainModel/active. Đường lên runtime duy nhất vẫn là
 * train (POST /api/brain/train với useDraft) → thắng đối chứng CV → thăng cấp.
 *
 * Fail-open: lỗi DB → 500 kèm thông điệp; lỗi validation → 400 kèm DANH SÁCH
 * lỗi (editor hiển thị hết một lượt).
 */

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  BRAIN_DRAFT_RULES,
  defaultDraftFor,
  validateBrainDraft,
  type BrainDraftSpec,
} from '@/lib/brain/spec-schema'
import type { BrainKey } from '@/lib/brain/registry'

export const dynamic = 'force-dynamic'

const BRAIN_KEYS = Object.keys(BRAIN_DRAFT_RULES) as BrainKey[]

/** Đọc 1 bản nháp — fail-open null (chưa có nháp/lỗi parse). */
function parseDraft(raw: { brain: string; specJson: string; note: string | null; updatedAt: Date } | null): {
  brain: string
  spec: BrainDraftSpec | null
  note: string | null
  updatedAt: string
} | null {
  if (!raw) return null
  let spec: BrainDraftSpec | null = null
  try {
    spec = JSON.parse(raw.specJson) as BrainDraftSpec
  } catch {
    spec = null
  }
  return { brain: raw.brain, spec, note: raw.note, updatedAt: raw.updatedAt.toISOString() }
}

export async function GET() {
  try {
    const rows = await db.brainSpecDraft.findMany()
    const byBrain = new Map(rows.map(r => [r.brain, r]))
    return NextResponse.json({
      drafts: BRAIN_KEYS.map(key => {
        const r = byBrain.get(key)
        const parsed = parseDraft(r ?? null)
        return parsed ?? { brain: key, spec: null, note: null, updatedAt: new Date(0).toISOString() }
      }),
      defaults: Object.fromEntries(BRAIN_KEYS.map(k => [k, defaultDraftFor(k)])) as Record<BrainKey, BrainDraftSpec>,
    })
  } catch (err) {
    console.error('[BrainSpecDraft] GET failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: 'Không tải được bản nháp spec (fail-open — editor dùng default chuẩn)', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

export async function PUT(request: Request) {
  let body: { brain?: unknown; spec?: unknown } = {}
  try {
    body = (await request.json()) as { brain?: unknown; spec?: unknown }
  } catch {
    return NextResponse.json({ error: 'Body phải là JSON { brain, spec }' }, { status: 400 })
  }

  const brain = typeof body.brain === 'string' ? body.brain : ''
  if (!BRAIN_KEYS.includes(brain as BrainKey)) {
    return NextResponse.json(
      { error: `brain '${brain || '(trống)'}' không hợp lệ (${BRAIN_KEYS.join(' | ')})` },
      { status: 400 },
    )
  }
  const rawSpec = body.spec
  if (!rawSpec || typeof rawSpec !== 'object') {
    return NextResponse.json({ error: 'spec phải là object BrainDraftSpec' }, { status: 400 })
  }
  // Ép brain khớp path/body (tránh spec.brain lệch body.brain)
  const candidate = { ...(rawSpec as object), brain } as unknown

  // inputDim cho kiểm trần tham số: A khóa 10; B/C động → null (bỏ trần tại
  // draft — mlp.validateSpec lúc train là điểm chặn thật, §9.1-3)
  const validation = validateBrainDraft(candidate, BRAIN_DRAFT_RULES[brain as BrainKey].inputUnits)
  if (!validation.ok) {
    return NextResponse.json({ error: 'Bản nháp không hợp lệ', errors: validation.errors }, { status: 400 })
  }

  try {
    const saved = await db.brainSpecDraft.upsert({
      where: { brain },
      update: { specJson: JSON.stringify(validation.normalized), note: validation.normalized.note ?? null },
      create: {
        brain,
        specJson: JSON.stringify(validation.normalized),
        note: validation.normalized.note ?? null,
      },
    })
    return NextResponse.json({
      saved: true,
      brain,
      spec: validation.normalized,
      params: validation.params,
      updatedAt: saved.updatedAt.toISOString(),
    })
  } catch (err) {
    console.error('[BrainSpecDraft] PUT failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: 'Lưu bản nháp thất bại (không chạm bản active — fail-open)', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
