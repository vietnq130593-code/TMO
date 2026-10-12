/**
 * BRAIN-UX §9.4 — WEIGHTS API (GET /api/brain/weights) — READ-ONLY
 * ============================================================================
 *
 * Trả spec + trọng số + |gradient| từng lớp của 1 bản BrainModel để
 * BrainStage (UX-3) vẽ inspector nơ-ron/cạnh bằng dữ liệu THẬT:
 *   ?brain=calibration_v3|surrogate|policy (bắt buộc)
 *   &version=N (tùy chọn — mặc định bản active; không có active và không
 *    có version → 404 kèm danh sách version có sẵn)
 *   &head=success|tokens|durationMs (chỉ surrogate — mặc định success)
 *
 * Payload: MlpSerialized đầy đủ (envelope numpy-đọc được — các brain này
 * ≤ vài nghìn tham số, vài KB JSON) + gradAbsMean từ trainMeta. KHÔNG ghi
 * gì (GET thuần) — không đụng runtime.
 *
 * Fail-open: brain lạ → 400; không có bản → 404 (stage fallback về spec
 * planned registry); lỗi DB → 500.
 */

import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { BRAIN_REGISTRY, type BrainKey } from '@/lib/brain/registry'

export const dynamic = 'force-dynamic'

const BRAIN_KEYS = BRAIN_REGISTRY.map(b => b.key)
const SURROGATE_HEADS = ['success', 'tokens', 'durationMs'] as const

export async function GET(request: Request) {
  const url = new URL(request.url)
  const brain = url.searchParams.get('brain') ?? ''
  if (!BRAIN_KEYS.includes(brain as BrainKey)) {
    return NextResponse.json(
      { error: `brain '${brain || '(trống)'}' không hợp lệ (${BRAIN_KEYS.join(' | ')})` },
      { status: 400 },
    )
  }
  const versionRaw = url.searchParams.get('version')
  const version = versionRaw !== null && /^\d+$/.test(versionRaw) ? Number.parseInt(versionRaw, 10) : null
  const headParam = url.searchParams.get('head') ?? 'success'
  if (brain === 'surrogate' && !SURROGATE_HEADS.includes(headParam as typeof SURROGATE_HEADS[number])) {
    return NextResponse.json(
      { error: `head '${headParam}' không hợp lệ cho surrogate (${SURROGATE_HEADS.join(' | ')})` },
      { status: 400 },
    )
  }

  try {
    const where = version !== null
      ? { brain, version }
      : { brain, active: true }
    const row = await db.brainModel.findFirst({
      where,
      orderBy: version !== null ? undefined : [{ version: 'desc' }],
      select: {
        version: true, inputMode: true, active: true, trainedAt: true,
        specJson: true, weightsJson: true, trainMetaJson: true,
      },
    })
    if (!row) {
      const versions = await db.brainModel.findMany({
        where: { brain },
        orderBy: { version: 'desc' },
        select: { version: true, active: true },
        take: 20,
      })
      return NextResponse.json(
        {
          error: `Không tìm thấy bản ${version !== null ? `v${version}` : 'active'} của brain '${brain}'`,
          available: versions,
        },
        { status: 404 },
      )
    }

    // Parse spec/weights theo dạng từng brain: A = MlpSerialized/MlpSpec
    // trực tiếp; B = { heads: { success|tokens|durationMs: MlpSerialized } }
    // + spec doc { heads: {…MlpSpec} }; C (policy) = lồng thêm 1 tầng —
    // weightsJson { mlp: MlpSerialized } + specJson { inputMode, vocab,
    // actionVocab, spec: MlpSpec, featureNames } (policy.ts weightsDoc/
    // specDoc). Đọc CẢ 2 dạng, fail-open về dạng thẳng khi key lồng
    // không có (calibration_v3 ghi thẳng MlpSerialized/MlpSpec — không
    // có key `mlp`/`spec` ở tầng ngoài nên unwrap là no-op an toàn).
    let mlp: unknown
    let spec: unknown
    try {
      const weightsDoc = JSON.parse(row.weightsJson) as { heads?: Record<string, unknown> }
      const specDoc = JSON.parse(row.specJson) as { heads?: Record<string, unknown> }
      if (brain === 'surrogate') {
        mlp = weightsDoc.heads?.[headParam]
        spec = specDoc.heads?.[headParam]
      } else {
        mlp = (weightsDoc as { mlp?: unknown }).mlp ?? weightsDoc
        spec = (specDoc as { spec?: unknown }).spec ?? specDoc
      }
    } catch {
      return NextResponse.json(
        { error: `weightsJson/specJson của ${brain} v${row.version} không parse được (bản cũ?)` },
        { status: 500 },
      )
    }
    if (!mlp || !spec) {
      return NextResponse.json(
        { error: `Bản ${brain} v${row.version} thiếu head '${headParam}' trong weights/spec` },
        { status: 500 },
      )
    }

    // gradAbsMean từ trainMeta (A/C: number[]; B: {success,tokens,durationMs})
    let gradAbsMean: number[] | null = null
    try {
      const meta = JSON.parse(row.trainMetaJson) as {
        gradAbsMean?: number[] | Record<string, number[]>
      }
      const g = meta.gradAbsMean
      if (Array.isArray(g)) gradAbsMean = g
      else if (g && typeof g === 'object' && Array.isArray((g as Record<string, number[]>)[headParam])) {
        gradAbsMean = (g as Record<string, number[]>)[headParam]
      }
    } catch { /* fail-open null */ }

    return NextResponse.json({
      brain,
      head: brain === 'surrogate' ? headParam : null,
      version: row.version,
      active: row.active,
      trainedAt: row.trainedAt.toISOString(),
      inputMode: row.inputMode,
      spec,
      mlp,
      gradAbsMean,
    })
  } catch (err) {
    console.error('[BrainWeights] GET failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: 'Đọc trọng số thất bại (READ-ONLY — không đụng runtime)', details: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
