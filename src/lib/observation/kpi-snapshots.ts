/**
 * GAP-1 (Task 26-BE — BLUEPRINT-OBSERVATION-P1-P4 §C.6: "impact tracker cần
 * KpiSnapshot ngày liền trước vs liền sau"; hiện trạng thiếu: snapshot chỉ
 * tồn tại khi có người gọi /api/metrics/kpi hoặc /api/metrics/overview)
 * ==========================================================================
 *
 * `ensureDailyKpiSnapshots()` — scheduler chạy TRONG tick 10 phút của worker
 * impact.ts (CÙNG setInterval hiện có — KHÔNG setInterval mới, KHÔNG cron
 * mới; được gọi qua dynamic import từ impact.ts vì file này import kpiDateOf
 * từ impact — chống chu trình tĩnh, tiền lệ ledger ↔ tuning-store).
 *
 * SNAPSHOT LÀ NGUYÊN LIỆU CHO IMPACT TRACKER: impact pass so sánh KPI snapshot
 * ngày liền trước vs liền sau mỗi TuningChangeLog (Q5 §7 chốt) — không có
 * dòng snapshot thì change không bao giờ được chấm. Vì output cuối cùng là
 * SỰ KIỆN impact.estimate nên ensure CHỈ chạy khi cờ `obs_impact` bật (tick
 * rỗng khi cờ off — precedent FB-OBS-R1-11) VÀ `obs_ledger` bật (impact.ts
 * gate 2 cờ này trước khi gọi — xem tick() bên đó).
 *
 * Cadence "2h/ngày" (hợp đồng 26-BE mục 3):
 *   - Mỗi tick kiểm tra NHẸ: 2 count query (hôm nay + hôm qua) — đủ dòng
 *     (mỗi KPI trong KPI_REGISTRY 1 dòng) thì tick đó không compute gì.
 *   - Làm mới HÔM NAY mỗi 2 TỜI GIỜ (guard in-memory lastEnsureAt trên
 *     globalThis — sống sót HMR): upsert theo (kpi, date) — KpiSnapshot có
 *     @@unique([date, kpi]) nên idempotent, gọi 2 lần không nhân bản. KPI
 *     compute đọc cửa sổ tròn 24h/7 ngày từ "bây giờ" → làm mới giữ cho dòng
 *     hôm nay đi theo ngày (xấp xỉ trung thực — xem JSDoc computeAllKpis).
 *   - HÔM QUA: final 1 LẦN nếu thiếu (tick đầu sau nửa đêm chốt số liệu ngày
 *     trọn vẹn cho impact so trước/sau; đã đủ thì KHÔNG đè).
 *
 * Mọi op fail-open try/catch — KHÔNG throw, KHÔNG log spam (console.error
 * tối đa 1 dòng/lần fail). TÁI DỤNG computeAllKpis (kpi/compute.ts) —
 * KHÔNG nhân bản logic KPI (doctrine #9).
 */

import { db } from '@/lib/db'
import { KPI_REGISTRY } from '@/lib/kpi/registry'
import { computeAllKpis } from '@/lib/kpi/compute'
import { kpiDateOf } from './impact'

// ==================== HẰNG SỐ (doctrine #1 — hợp đồng 26-BE mục 3) ====================

/** Mỗi 2 TỜI GIỜ mới thực hiện 1 lần ensure đầy đủ (làm mới hôm nay + final hôm qua). */
export const KPI_ENSURE_EVERY_MS = 2 * 3600_000

// ==================== STATE (globalThis — sống sót HMR, precedent ledger.ts) ====================

interface KpiEnsureState {
  /** epoch-ms lần ensure đầy đủ cuối — null = chưa chạy lần nào (process mới). */
  lastEnsureAt: number | null
}

const globalForKpiEnsure = globalThis as unknown as { __tmoKpiEnsure?: KpiEnsureState }

function state(): KpiEnsureState {
  if (!globalForKpiEnsure.__tmoKpiEnsure) {
    globalForKpiEnsure.__tmoKpiEnsure = { lastEnsureAt: null }
  }
  return globalForKpiEnsure.__tmoKpiEnsure
}

/** Dọn guard cho TEST (bun test 1 process — cô lập giữa các file). */
export function resetKpiEnsureGuard(): void {
  try {
    state().lastEnsureAt = null
  } catch {
    /* no-op */
  }
}

// ==================== ENSURE ====================

/**
 * Đảm bảo KpiSnapshot tồn tại cho HÔM NAY (làm mới mỗi 2h — upsert) + HÔM QUA
 * (final 1 lần nếu thiếu). Gọi từ tick obs_impact mỗi 10 phút; bản thân hàm
 * tự throttle — tick giữa 2 cửa 2h chỉ tốn 2 count query nhẹ. Fail-open tuyệt
 * đối: KHÔNG throw, KHÔNG log spam. `now` tùy chọn cho TEST.
 */
export async function ensureDailyKpiSnapshots(now: number = Date.now()): Promise<void> {
  try {
    const today = kpiDateOf(new Date(now))
    const yesterday = kpiDateOf(new Date(now - 24 * 3600_000))

    // ── Kiểm tra NHẸ mỗi tick: 2 count (đủ dòng = mỗi KPI trong registry 1
    //    dòng). Hôm nay đủ → tick này không cần "điền thiếu"; việc LÀM MỚI
    //    (cửa sổ tròn dịch theo giờ) chờ cửa 2h phía dưới. Hôm qua thiếu →
    //    cần final (tick đầu sau nửa đêm).
    const [todayCount, yesterdayCount] = await Promise.all([
      db.kpiSnapshot.count({ where: { date: today } }),
      db.kpiSnapshot.count({ where: { date: yesterday } }),
    ])
    const yesterdayFull = yesterdayCount >= KPI_REGISTRY.length
    if (todayCount >= KPI_REGISTRY.length && yesterdayFull) return // 2 ngày đủ — tick rỗng

    // ── Guard 2 TỜI GIỜ: mọi compute (điền thiếu hôm nay + làm mới + final
    //    hôm qua) đều qua cửa này — tránh mỗi tick 10 phút tính lại nguyên
    //    registry. Đánh dấu NGAY (kể cả khi compute sau đó lỗi — fail thì
    //    cửa sau 2h mới thử lại, đúng tinh thần "không log spam").
    const st = state()
    if (st.lastEnsureAt !== null && now - st.lastEnsureAt < KPI_ENSURE_EVERY_MS) return
    st.lastEnsureAt = now

    // ── Ensure đầy đủ:
    //  (a) Hôm nay — LÀM MỚI bằng upsert (kể cả đã đủ dòng: giá trị trượt
    //      theo cửa sổ tròn của KPI compute; @@unique([date, kpi]) →
    //      idempotent theo where date_kpi).
    //  (b) Hôm qua — CHỈ khi thiếu (final 1 lần; đủ rồi không đè số cuối).
    await computeAllKpis(today)
    if (!yesterdayFull) {
      await computeAllKpis(yesterday)
    }
  } catch (err) {
    // fail-open — 1 dòng/lần fail, KHÔNG throw (worker không bao giờ chết vì KPI)
    console.error(
      '[KpiSnapshots] ensureDailyKpiSnapshots thất bại (fail-open):',
      err instanceof Error ? err.message : String(err),
    )
  }
}
