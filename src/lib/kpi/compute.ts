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

async function computeOne(def: KpiDef, date: string = todayUtcDate()): Promise<KpiComputed> {
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
      return { ...base, value: 0, sampleSize: n, status: 'no_data', meta, ok: false, error: 'compute trả giá trị không hữu hạn — ghi 0' }
    }
    // FB-P1-R1-02: n=0 = CHƯA đo được gì → 'no_data' (ưu tiên trước mọi so
    // target) — value=0 khi chưa có dữ liệu không được hiện on_target/off
    // kẻo operator đọc nhầm "đạt/kém mục tiêu" cho một phép đo chưa tồn tại.
    const computed: KpiComputed = {
      ...base,
      value,
      sampleSize: n,
      status: n === 0 ? 'no_data' : statusForKpi(def, value),
      meta,
    }
    // Upsert snapshot (idempotent theo @@unique([date, kpi])) — Task 26-BE
    // (GAP-1): date tùy chọn (mặc định hôm nay như cũ) để ensureDailyKpiSnapshots
    // chốt final hôm qua; KPI compute đọc cửa sổ tròn tính từ "bây giờ" — xem
    // JSDoc computeAllKpis cho framing trung thực.
    await db.kpiSnapshot.upsert({
      where: { date_kpi: { date, kpi: def.key } },
      create: {
        date,
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
      status: 'no_data',
      ok: false,
      error: message,
    }
  }
}

/**
 * Tính toàn bộ KPI trong KPI_REGISTRY + upsert KpiSnapshot của NGÀY chỉ định.
 * KHÔNG bao giờ throw toàn bộ — từng KPI độc lập fail-open.
 *
 * Task 26-BE (GAP-1): tham số `date` tùy chọn (mặc định hôm nay — callers cũ
 * giữ nguyên). Khi đặt ngày khác (vd hôm qua — ensureDailyKpiSnapshots chốt
 * final sau nửa đêm): các hàm compute đọc CỬA SỔ TRÒN tính từ "bây giờ"
 * (24h/7 ngày gần nhất) nên snapshot "hôm qua" tính lúc ~00:00 hôm nay sẽ
 * phủ gần trọn ngày hôm qua — xấp xỉ trung thực, KHÔNG chế tạo lại công thức
 * compute (doctrine #9 — tái sử dụng, không nhân bản logic KPI).
 */
export async function computeAllKpis(date: string = todayUtcDate()): Promise<KpiComputed[]> {
  const results: KpiComputed[] = []
  for (const def of KPI_REGISTRY) {
    results.push(await computeOne(def, date))
  }
  return results
}
