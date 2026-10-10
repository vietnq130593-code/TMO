/**
 * P1-M4 · KPI COMPUTE — tính toàn bộ KPI của registry + upsert snapshot hôm
 * nay (idempotent theo unique date+kpi — gọi 2 lần không nhân bản).
 *
 * Mỗi KPI fail-open ĐỘC LẬP (blueprint §P1-M4): compute lỗi → mục đó
 * ok=false + error, KHÔNG upsert, KHÔNG kéo sập các KPI khác (đúng pattern
 * section của /api/metrics/overview).
 *
 * Nguồn: BLUEPRINT-STATS-LEARNING-P0-P6.md §P1-M4 bước 3.
 */

import { db } from '@/lib/db'
import { KPI_REGISTRY, statusForKpi, type KpiDef, type KpiStatus } from './registry'

export interface KpiComputed {
  key: string
  label: string
  goal: 'higher' | 'lower'
  target?: number
  value: number
  sampleSize: number
  status: KpiStatus
  meta?: Record<string, unknown>
  /** false khi compute lỗi (kèm error) — vẫn trả row để bảng không đứt */
  ok: boolean
  error?: string
}

/** Hôm nay theo UTC dạng YYYY-MM-DD (KpiSnapshot.date — 1 snapshot/ngày/KPI). */
export function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10)
}

async function computeOne(def: KpiDef): Promise<KpiComputed> {
  const base = {
    key: def.key,
    label: def.label,
    goal: def.goal,
    target: def.target,
    ok: true,
  }
  try {
    const { value, n, meta } = await def.compute()
    if (!Number.isFinite(value)) {
      // Defensive: KPI không được mang NaN/Infinity vào snapshot (REAL column)
      return { ...base, value: 0, sampleSize: n, status: 'no_target', meta, ok: false, error: 'compute trả giá trị không hữu hạn — ghi 0' }
    }
    const computed: KpiComputed = {
      ...base,
      value,
      sampleSize: n,
      status: statusForKpi(def, value),
      meta,
    }
    // Upsert snapshot hôm nay — idempotent theo @@unique([date, kpi])
    await db.kpiSnapshot.upsert({
      where: { date_kpi: { date: todayUtcDate(), kpi: def.key } },
      create: {
        date: todayUtcDate(),
        kpi: def.key,
        value,
        sampleSize: n,
        meta: JSON.stringify(meta ?? {}),
      },
      update: {
        value,
        sampleSize: n,
        meta: JSON.stringify(meta ?? {}),
      },
    })
    return computed
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[KPI] compute '${def.key}' failed (fail-open):`, message)
    return {
      ...base,
      value: 0,
      sampleSize: 0,
      status: 'no_target',
      ok: false,
      error: message,
    }
  }
}

/**
 * Tính toàn bộ KPI trong KPI_REGISTRY + upsert KpiSnapshot hôm nay.
 * KHÔNG bao giờ throw toàn bộ — từng KPI độc lập fail-open.
 */
export async function computeAllKpis(): Promise<KpiComputed[]> {
  const results: KpiComputed[] = []
  for (const def of KPI_REGISTRY) {
    results.push(await computeOne(def))
  }
  return results
}
