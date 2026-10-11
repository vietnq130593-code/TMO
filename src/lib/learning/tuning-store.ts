/**
 * RUNTIME TUNING STORE — nền tảng tab "Kiến trúc Neural" (2026-10-11)
 * ==================================================================
 *
 * Mọi hyperparameter học/điều tiết của hệ thống (α/γ/τ/ε/ngưỡng dedup/
 * IQR-k...) đọc GIÁ TRỊ HIỆU LỰC qua module này thay vì hằng số cứng:
 *
 *   STORE (Prisma TuningParam — user đặt qua UI, sống qua restart)
 *     > ENV (fallback theo spec.envKey — giữ ý nghĩa .env như cũ)
 *     > DEFAULT (hằng số spec — trùng giá trị trong code nguồn)
 *
 * THIẾT KẾ ĐỒNG BỘ (không await mỗi lần đọc):
 *   - Snapshot in-process (globalThis, TTL 5s): consumer gọi bản SYNC
 *     getTuningNumber/getTuningEnum — rẻ như tra Map (đường call nóng
 *     updateQ/softmaxPolicy không đợi DB).
 *   - Hết TTL → KÉO NỀN fire-and-forget (đedup in-flight); lần đọc hiện
 *     tại dùng giá trị cũ/default — sai lệch tối đa 1 cửa sổ TTL, đúng
 *     triết lý fail-open của toàn learning side-channel.
 *   - set/reset ghi DB trước, cập nhật snapshot NGAY sau khi thành công
 *     → cùng process (pm2 fork 1 instance) consumer thấy tức thì.
 *   - DB lỗi → giữ snapshot cũ / trả default — KHÔNG BAO GIỜ throw lên
 *     đường call nóng (fail-open tuyệt đối, học không làm gãy agent).
 *
 * Ghi chú phân kỳ: Prisma + SQLite $transaction tương tác giữ lock
 * (bài học BUG2-119) — module này chỉ dùng upsert/deleteMany/findMany
 * đơn lẻ trên bảng nhỏ (13 row tối đa), không cần transaction.
 */

import { db } from '@/lib/db'
import {
  TUNING_SPECS,
  getTuningSpec,
  TUNING_CHANGE_LOG_CAP,
  type TuningChangeLogEntry,
  type TuningSource,
  type TuningSpec,
  type TuningStateEntry,
} from './neural-types'

// ==================== SNAPSHOT (globalThis + TTL) ====================

interface TuningSnapshot {
  at: number
  values: Map<string, string>
}

const SNAPSHOT_TTL_MS = 5_000

const globalForTuning = globalThis as unknown as {
  __tmoTuningSnapshot?: TuningSnapshot
  __tmoTuningLoad?: Promise<void>
  __tmoTuningWarnedAt?: number
}

/** Copy DB → snapshot (KHÔNG throw — lỗi giữ snapshot cũ).
 *
 * FB-P2-R1-N1 (phòng thủ): nếu snapshot hiện tại đã được cập nhật SAU thời
 * điểm bắt đầu load này (set/reset thủ công ghi at=now giữa chừng) → KHÔNG
 * đè — chống load-cũ-resolve-muộn ghi đè mất giá trị vừa set (consumer
 * thấy stale tối đa 1 TTL). Load nối tiếp bình thường vẫn ghi (at cũ <
 * startedAt). */
async function loadSnapshotFromDb(): Promise<void> {
  const startedAt = Date.now()
  try {
    const rows = await db.tuningParam.findMany({ select: { key: true, value: true } })
    const current = globalForTuning.__tmoTuningSnapshot
    if (current && current.at > startedAt) return
    const values = new Map<string, string>()
    for (const r of rows) {
      if (typeof r.key === 'string' && typeof r.value === 'string') values.set(r.key, r.value)
    }
    globalForTuning.__tmoTuningSnapshot = { at: Date.now(), values }
  } catch (err) {
    // Chống spam log khi DB_down dài hạn: tối đa 1 dòng / 60s
    const now = Date.now()
    if (!globalForTuning.__tmoTuningWarnedAt || now - globalForTuning.__tmoTuningWarnedAt > 60_000) {
      globalForTuning.__tmoTuningWarnedAt = now
      console.warn('[TuningStore] load DB failed (fail-open → snapshot cũ/default):', err instanceof Error ? err.message : String(err))
    }
  }
}

/**
 * Đảm bảo snapshot "đủ tươi" theo kiểu fire-and-forget: hết TTL thì kéo nền,
 * KHÔNG đợi (caller sync trả về giá trị hiện có). Đedup in-flight để 100
 * consumer gọi cùng lúc chỉ sinh 1 truy vấn DB.
 */
function ensureFresh(): void {
  const snap = globalForTuning.__tmoTuningSnapshot
  if (snap && Date.now() - snap.at <= SNAPSHOT_TTL_MS) return
  if (globalForTuning.__tmoTuningLoad) return
  globalForTuning.__tmoTuningLoad = loadSnapshotFromDb().finally(() => {
    globalForTuning.__tmoTuningLoad = undefined
  })
}

/** Ép nạp lại DB ngay lập tức (API GET dùng để trả state chính xác). */
export async function refreshTuningSnapshot(): Promise<void> {
  await loadSnapshotFromDb()
}

/** Giá trị thô user đã đặt trong store (null = chưa đặt). Sync, rẻ. */
export function getTuningStoredValue(key: string): string | null {
  ensureFresh()
  return globalForTuning.__tmoTuningSnapshot?.values.get(key) ?? null
}

// ==================== RESOLVE CHUỖI STORE > ENV > DEFAULT ====================

export interface TuningResolution {
  spec: TuningSpec
  value: number | string
  source: TuningSource
}

/** Parse env cho spec number: parseFloat → clamp [min,max]; vô hiệu → undefined. */
function envNumber(spec: TuningSpec, raw: string): number | undefined {
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return undefined
  const min = spec.min ?? -Infinity
  const max = spec.max ?? Infinity
  return Math.min(max, Math.max(min, n))
}

/**
 * Giải chuỗi hiệu lực của một key (sync — dùng snapshot hiện có).
 * Key lạ → throw (lỗi lập trình caller — pin bằng test); DB lỗi thì
 * snapshot rỗng → tự rơi về env/default, không bao giờ throw từ I/O.
 */
export function resolveTuning(key: string): TuningResolution {
  const spec = getTuningSpec(key)
  if (!spec) throw new Error(`[TuningStore] unknown tuning key: ${key}`)
  const stored = getTuningStoredValue(key)
  if (stored !== null) {
    const normalized = normalizeStored(spec, stored)
    return { spec, value: normalized, source: 'store' }
  }
  if (spec.envKey) {
    const raw = process.env[spec.envKey]
    if (typeof raw === 'string' && raw.trim() !== '') {
      if (spec.type === 'number') {
        const n = envNumber(spec, raw)
        if (n !== undefined) return { spec, value: n, source: 'env' }
      } else if (spec.envMap) {
        const mapped = spec.envMap(raw)
        if (mapped !== undefined) return { spec, value: mapped, source: 'env' }
      }
    }
  }
  return { spec, value: spec.default, source: 'default' }
}

// ==================== AUDIT LOG (P2-M2 — review task-98) ====================
// CAP sống ở neural-types (client-safe) — xem ghi chú tại đó.

/** Trạng thái một tham số TẠI THỜI ĐIỂM trước khi đổi (để ghi audit). */
interface AuditCapture {
  storeValue: string | null
  effectiveValue: string
}

/**
 * Chụp trạng thái trước khi đổi (FB-P2-R1-01: KHÔNG tin snapshot — nó có thể
 * rỗng/stale ở lần set/reset ĐẦU TIÊN sau khởi động process, khi chưa có
 * GET nào đi trước). store-value đọc THẲNG DB (authoritative); hiệu lực
 * trước derive từ chính store-value đó qua normalizeStored (belt-and-
 * suspenders đã có — row sửa tay vẫn chuẩn hoá); store null → env/default
 * resolve trực tiếp (env đọc process.env, không phụ thuộc snapshot).
 */
async function captureAuditState(key: string): Promise<AuditCapture> {
  const spec = getTuningSpec(key)
  if (!spec) return { storeValue: null, effectiveValue: '' } // caller đã check — defensive (không đi tới được)
  let storeValue: string | null = null
  try {
    const row = await db.tuningParam.findUnique({ where: { key }, select: { value: true } })
    storeValue = row?.value ?? null
  } catch { /* fail-open — coi như chưa có override */ }
  let effectiveValue: string
  if (storeValue !== null) {
    effectiveValue = String(normalizeStored(spec, storeValue))
  } else {
    // Không override → hiệu lực là env (nếu hợp lệ) hoặc default — đọc trực tiếp
    let v: number | string = spec.default
    if (spec.envKey) {
      const raw = process.env[spec.envKey]
      if (typeof raw === 'string' && raw.trim() !== '') {
        if (spec.type === 'number') {
          const n = envNumber(spec, raw)
          if (n !== undefined) v = n
        } else if (spec.envMap) {
          const mapped = spec.envMap(raw)
          if (mapped !== undefined) v = mapped
        }
      }
    }
    effectiveValue = String(v)
  }
  return { storeValue, effectiveValue }
}

/** Ghi 1 dòng audit — fail-open (lỗi log KHÔNG làm fail phép set/reset). */
async function writeChangeLog(row: {
  key: string
  action: 'set' | 'reset'
  fromStoreValue: string | null
  toStoreValue: string | null
  fromEffectiveValue: string
  toEffectiveValue: string
}): Promise<void> {
  try {
    await db.tuningChangeLog.create({ data: row })
    await pruneChangeLog()
  } catch (err) {
    console.warn('[TuningStore] change-log write failed (fail-open):', err instanceof Error ? err.message : String(err))
  }
}

/** Prune giữ đúng CAP dòng mới nhất (FB-P2-R1-02: cap TUYỆT ĐỐI kể cả
 * createdAt trùng ms — tiebreak id autoincrement: (createdAt desc, id desc)
 * là thứ tự insertion tất định; dòng vừa insert có cặp khoá lớn nhất mọi
 * thời điểm → không bao giờ rơi vào phần dư thừa → không cần bảo vệ riêng). */
async function pruneChangeLog(): Promise<void> {
  const total = await db.tuningChangeLog.count()
  if (total <= TUNING_CHANGE_LOG_CAP) return
  const excess = await db.tuningChangeLog.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: TUNING_CHANGE_LOG_CAP,
    take: total - TUNING_CHANGE_LOG_CAP,
    select: { id: true },
  })
  if (excess.length > 0) {
    await db.tuningChangeLog.deleteMany({ where: { id: { in: excess.map(e => e.id) } } })
  }
}

/** Đọc N dòng audit mới nhất (mới → cũ; tie createdAt break bằng id giảm dần
 * = thứ tự insertion) — lỗi DB trả [] (fail-open cho API GET). */
export async function getTuningChangeLog(take = 10): Promise<TuningChangeLogEntry[]> {
  try {
    const rows = await db.tuningChangeLog.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    })
    return rows.map(r => ({
      id: r.id,
      key: r.key,
      action: r.action === 'reset' ? 'reset' : 'set',
      fromStoreValue: r.fromStoreValue,
      toStoreValue: r.toStoreValue,
      fromEffectiveValue: r.fromEffectiveValue,
      toEffectiveValue: r.toEffectiveValue,
      createdAt: r.createdAt.toISOString(),
    }))
  } catch {
    return []
  }
}

/**
 * Chuẩn hoá chuỗi thô từ store về giá trị đúng type (store đã được
 * validate lúc ghi — đây là belt-and-suspenders chống row bị sửa tay
 * qua DB: giá trị lỗi rơi về default, KHÔNG throw).
 */
function normalizeStored(spec: TuningSpec, stored: string): number | string {
  if (spec.type === 'number') {
    const n = parseFloat(stored)
    if (!Number.isFinite(n)) return spec.default as number
    const min = spec.min ?? -Infinity
    const max = spec.max ?? Infinity
    return Math.min(max, Math.max(min, n))
  }
  const v = stored.trim().toLowerCase()
  return (spec.enumValues ?? []).includes(v) ? v : (spec.default as string)
}

/** Số hiệu lực (number spec) — vô hiệu/hết phạm vi tự kẹp về default. */
export function getTuningNumber(key: string): number {
  const { spec, value } = resolveTuning(key)
  const n = typeof value === 'number' ? value : parseFloat(value)
  if (!Number.isFinite(n)) return spec.default as number
  return n
}

/** Enum hiệu lực (enum spec) — giá trị lạ rơi về default. */
export function getTuningEnum(key: string): string {
  const { spec, value } = resolveTuning(key)
  return typeof value === 'string' ? value : String(value)
}

// ==================== VALIDATE + GHI (API tuning) ====================

export type ValidateResult =
  | { ok: true; normalized: string }
  | { ok: false; error: string }

/**
 * Kiểm tra + chuẩn hoá input user cho một key (THUẦN — test trực tiếp):
 *   number: parseFloat bắt buộc hữu hạn, sai phạm vi min/max → lỗi
 *           (không tự kẹp — user phải thấy sai phạm vi rõ ràng);
 *           làm tròn 6 chữ số lẻ chống float-junk 0.30000000000000004.
 *   enum:   trim + lowercase, phải nằm trong enumValues.
 */
export function validateTuningInput(key: string, rawValue: unknown): ValidateResult {
  const spec = getTuningSpec(key)
  if (!spec) return { ok: false, error: `Tham số không tồn tại: ${key}` }
  if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') {
    return { ok: false, error: 'Giá trị phải là chuỗi/số' }
  }
  const raw = String(rawValue).trim()
  if (spec.type === 'number') {
    const n = parseFloat(raw)
    if (!Number.isFinite(n)) return { ok: false, error: `Giá trị phải là số (nhận: "${raw}")` }
    const min = spec.min ?? -Infinity
    const max = spec.max ?? Infinity
    if (n < min || n > max) return { ok: false, error: `Ngoài phạm vi [${min}, ${max}]: ${n}` }
    return { ok: true, normalized: String(Math.round(n * 1e6) / 1e6) }
  }
  const v = raw.toLowerCase()
  if (!(spec.enumValues ?? []).includes(v)) {
    return { ok: false, error: `Giá trị phải thuộc [${(spec.enumValues ?? []).join(' | ')}] (nhận: "${raw}")` }
  }
  return { ok: true, normalized: v }
}

/**
 * Đặt tham số (validate → chụp before → upsert → cập nhật snapshot tức thì
 * → ghi audit TuningChangeLog). Trả về state mới của key — API POST dùng
 * trực tiếp. Audit fail-open: lỗi ghi log không làm fail phép set.
 */
export async function setTuningValue(key: string, rawValue: unknown): Promise<TuningStateEntry> {
  const check = validateTuningInput(key, rawValue)
  if (!check.ok) throw new TuningValidationError(check.error)
  const before = await captureAuditState(key)
  await db.tuningParam.upsert({
    where: { key },
    create: { key, value: check.normalized },
    update: { value: check.normalized },
  })
  // Cập nhật snapshot NGAY (cùng process thấy tức thì — không chờ TTL)
  const snap = globalForTuning.__tmoTuningSnapshot
  if (snap) {
    snap.values.set(key, check.normalized)
    snap.at = Date.now()
  } else {
    globalForTuning.__tmoTuningSnapshot = { at: Date.now(), values: new Map([[key, check.normalized]]) }
  }
  const entry = getTuningStateEntry(key)
  await writeChangeLog({
    key,
    action: 'set',
    fromStoreValue: before.storeValue,
    toStoreValue: check.normalized,
    fromEffectiveValue: before.effectiveValue,
    toEffectiveValue: String(entry.effectiveValue),
  })
  return entry
}

/**
 * Xoá override của user — key rơi về env/default như trước khi đặt.
 * Ghi audit 'reset' (toStoreValue=null — hiệu lực mới là env/default).
 */
export async function resetTuningValue(key: string): Promise<TuningStateEntry> {
  const spec = getTuningSpec(key)
  if (!spec) throw new TuningValidationError(`Tham số không tồn tại: ${key}`)
  const before = await captureAuditState(key)
  try {
    await db.tuningParam.deleteMany({ where: { key } })
  } catch (err) {
    // Xoá lỗi (row không có / DB trễ) vẫn coi thành công về mặt ngữ nghĩa
    console.warn('[TuningStore] reset delete failed (fail-open):', err instanceof Error ? err.message : String(err))
  }
  const snap = globalForTuning.__tmoTuningSnapshot
  if (snap) {
    snap.values.delete(key)
    snap.at = Date.now()
  }
  const entry = getTuningStateEntry(key)
  await writeChangeLog({
    key,
    action: 'reset',
    fromStoreValue: before.storeValue,
    toStoreValue: null,
    fromEffectiveValue: before.effectiveValue,
    toEffectiveValue: String(entry.effectiveValue),
  })
  return entry
}

/** Lỗi input user (400) — KHÔNG phải lỗi hệ thống. */
export class TuningValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TuningValidationError'
  }
}

// ==================== STATE TOÀN BỘ (API GET) ====================

function getTuningStateEntry(key: string): TuningStateEntry {
  const { spec, value, source } = resolveTuning(key)
  return {
    ...spec,
    storeValue: getTuningStoredValue(key),
    effectiveValue: value,
    source,
  }
}

/**
 * Trạng thái đầy đủ 13 tham số cho UI (force-refresh DB trước để số liệu
 * chính xác — API gọi không thường xuyên nên chi phí chấp nhận được).
 */
export async function getTuningState(): Promise<TuningStateEntry[]> {
  await refreshTuningSnapshot()
  return TUNING_SPECS.map(s => getTuningStateEntry(s.key))
}
