/**
 * ALISTA — Daily DB Backup — LÕI THUẦN (BLUEPRINT-DB-P0-P3 §P3-c, task 31-f)
 * ============================================================================
 *
 * Module THUẦN (doctrine #9 — precedent d2-stats.ts): KHÔNG import db/server/
 * R2 — mọi hàm ở đây là phép toán thuần trên Date/object để test được (r119).
 *
 * Phần "có side-effect" (CronJob row + executor tick + R2 listing) nằm ở
 * ./db-backup.ts — file này chỉ là lõi tính toán dùng chung bởi:
 *   - ./db-backup.ts          (scheduler tick 60s trong process Next.js)
 *   - scripts/seed-daily-backup-cron.ts (seed row — chạy 1 lần)
 *   - ./collectors.ts ⑦(i)    (backup-freshness — tuổi artifact trên R2)
 *   - ./rules.ts ⑦(i)         (alert khi backup SQLite > 2 ngày — P3-c)
 *
 * BỐI CẢNH P3-c (audit 31-b): verify nội tuyến backup ĐÃ xong (route
 * db-backup sha256 round-trip) nhưng thiếu (1) cron hằng ngày + (2) restore
 * drill + (3) alert freshness. Task 31-f đóng cả 3.
 */

// ==================== CONSTANTS (P3-c) ====================

/** Múi giờ owner — mọi mốc lịch của backup tính theo giờ VN (server chạy UTC). */
export const DAILY_BACKUP_TZ = 'Asia/Ho_Chi_Minh'

/** Giờ bắn backup hằng ngày (giờ VN) — blueprint P3-c: "03:00 lịch vực". */
export const DAILY_BACKUP_HOUR_VN = 3

/**
 * Executor của CronJob row — scheduler nền trong app là executor DUY NHẤT
 * (pattern ALISTA): mini-service cron-scheduler port 3004 filter executor=''
 * (bỏ qua), automation-engine loop B filter agentId='default' (bỏ qua) →
 * không đường nào bắn nhầm row này.
 */
export const DAILY_BACKUP_EXECUTOR = 'DB-BACKUP'

/** agentId của row — dùng 'alista' để automation-engine loop B bỏ qua (≠'default'). */
export const DAILY_BACKUP_AGENT_ID = 'alista'

/** P3-c: alert nếu backup SQLite hằng ngày không thành công ≥ 2 ngày → 48h. */
export const SQLITE_BACKUP_MAX_AGE_HOURS = 48

/** Snapshot Qdrant/Neo4j chạy HẰNG TUẦN (seed-weekly-backup-cron) → ngưỡng 7d + 1d grace. */
export const WEEKLY_SNAPSHOT_MAX_AGE_HOURS = 192

/** Prefix R2 của db-backup route (src/app/api/storage/db-backup/route.ts R2_PREFIX). */
export const R2_SQLITE_BACKUP_PREFIX = 'backups/sqlite/'
/** Prefix R2 của snapshot-full route (Qdrant tar + Neo4j cypher.gz). */
export const R2_QDRANT_BACKUP_PREFIX = 'backups/qdrant/'
export const R2_NEO4J_BACKUP_PREFIX = 'backups/neo4j/'

/** Backoff giữa các lần thử lại khi backup fail — 30 phút. */
export const DAILY_BACKUP_RETRY_BACKOFF_MS = 30 * 60_000

/** Hủy nốt ngày hôm đó sau 24 lần fail (48h không thành công → ALISTA alert). */
export const DAILY_BACKUP_MAX_RETRIES_PER_DAY = 24

// ==================== TYPES ====================

/** Trạng thái CronJob row (subset — đủ cho gate thuần, không kéo Prisma type vào). */
export interface DailyBackupJobState {
  enabled: boolean
  status: string
  nextRunAt: Date | null
  lastRunAt: Date | null
}

/** Kết quả gate — fire + reason tiếng Việt cho log. */
export interface DailyBackupGate {
  fire: boolean
  reason: string
}

/** Object R2 tối thiểu cho phép toán chọn artifact mới nhất. */
export interface R2ObjectLike {
  key: string
  size: number
  lastModified: Date
}

/**
 * Độ tươi 1 kho backup trên R2 (collector ⑦-i). fail-open: available=false
 * (không đo được) → rule KHÔNG alert — R2 disconnected đã có rule layer:r2.
 */
export interface BackupStoreFreshness {
  /** listR2Objects thành công (đo được) — false = chưa configure / lỗi list */
  available: boolean
  totalArtifacts: number
  newestKey: string | null
  /** ISO timestamp — null khi 0 artifact */
  newestAt: string | null
  /** Tuổi artifact mới nhất (giờ, làm tròn 1 chữ số) — null khi 0 artifact */
  ageHours: number | null
  error?: string
}

/** Data sub-check ⑦(i) — backup freshness cả 3 kho (sqlite hằng ngày + 2 kho tuần). */
export interface BackupFreshnessData {
  r2Configured: boolean
  sqlite: BackupStoreFreshness
  qdrant: BackupStoreFreshness
  neo4j: BackupStoreFreshness
}

// ==================== LỊCH 03:00 VIỆT NAM (pattern ALISTA — Intl tz tường minh) ====================

/** Chuỗi YYYY-MM-DD "hôm nay" theo giờ VN — không lệ thuộc đồng hồ server UTC. */
export function vnDateStr(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DAILY_BACKUP_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

/**
 * Mốc 03:00 VN của "hôm nay" (epoch ms). VN không có DST nên +24h luôn đúng
 * khi cộng ngày (không cần lịch bảng — khác múi giờ có DST).
 */
export function dailyBackupAnchorMs(now: Date = new Date()): number {
  const hh = String(DAILY_BACKUP_HOUR_VN).padStart(2, '0')
  return new Date(`${vnDateStr(now)}T${hh}:00:00+07:00`).getTime()
}

/**
 * Lần chạy kế tiếp — 03:00 VN: chưa tới 03:00 hôm nay → hôm nay; đã qua → mai.
 * (FIX-v1.2 ALISTA computeNextRunAt: trả "tối nay" khi chưa tới, không phải mai.)
 */
export function computeNextDailyBackupRunAt(now: Date = new Date()): Date {
  const anchor = dailyBackupAnchorMs(now)
  return new Date(anchor > now.getTime() ? anchor : anchor + 24 * 3600_000)
}

// ==================== GATE: DUE + 1 LẦN/NGÀY ====================

/**
 * Quyết định tick này có bắn backup không:
 *   (1) row enabled + status='active' (owner pause được từ UI Automation)
 *   (2) due: now ≥ nextRunAt (catch-up — server down lúc 03:00 rồi lên lại
 *       trong ngày vẫn chạy, triết lý cửa sổ catch-up của ALISTA v1.2)
 *   (3) 1 lần/ngày: lastRunAt < mốc 03:00 VN hôm nay (lần thành công gần nhất
 *       đã ở "hôm nay" thì thôi — gate theo lastRunAt THÀNH CÔNG, lần fail
 *       KHÔNG ghi lastRunAt nên retry 30' vẫn được phép).
 */
export function shouldFireDailyBackup(job: DailyBackupJobState, now: Date = new Date()): DailyBackupGate {
  if (!job.enabled) return { fire: false, reason: 'row disabled (owner pause trong UI Automation)' }
  if (job.status !== 'active') return { fire: false, reason: `row status='${job.status}'` }
  if (!job.nextRunAt) return { fire: false, reason: 'nextRunAt null (cần self-heal)' }
  if (job.nextRunAt.getTime() > now.getTime()) return { fire: false, reason: 'chưa đến hạn' }
  const anchor = dailyBackupAnchorMs(now)
  if (job.lastRunAt && job.lastRunAt.getTime() >= anchor) {
    return { fire: false, reason: 'hôm nay (VN) đã backup thành công rồi — gate 1 lần/ngày' }
  }
  return {
    fire: true,
    reason: job.lastRunAt
      ? `due (trễ ${Math.round((now.getTime() - job.nextRunAt.getTime()) / 60_000)}' so với lịch)`
      : 'due (lần đầu — chưa có lastRunAt)',
  }
}

// ==================== DIỄN DỊCH RESPONSE CỦA ROUTE db-backup ====================

/** Shape response POST /api/storage/db-backup (action=backup) — subset cần cho executor. */
export interface DailyBackupRouteResponse {
  success?: boolean
  error?: string
  versionedKey?: string
  sizeBytes?: number
  snapshotMethod?: string
  verify?: {
    roundTripOk?: boolean
    sha256Match?: boolean
    sqliteHeaderOk?: boolean
    detail?: string
  }
  warning?: string
}

export interface InterpretedBackupResult {
  /** HTTP 200 + success:true — artifact ĐÃ lên R2 */
  ok: boolean
  /** ok && verify.sha256Match && verify.sqliteHeaderOk — tin được bản backup */
  verified: boolean
  sizeBytes: number | null
  versionedKey: string | null
  error?: string
}

/**
 * Diễn dịch response của route db-backup thành phán quyết executor.
 * Backup "ok" (upload xong) nhưng verify FAIL vẫn là ok=true + verified=false
 * — route tự trả warning; executor ghi lastError để vận hành thấy (đối xứng
 * với round-32: "backup không qua verify = cảnh báo, không fail toàn bộ").
 */
export function interpretBackupResponse(status: number, json: unknown): InterpretedBackupResult {
  const body = (json ?? {}) as DailyBackupRouteResponse
  const ok = status === 200 && body.success === true
  if (!ok) {
    return {
      ok: false,
      verified: false,
      sizeBytes: null,
      versionedKey: null,
      error: `HTTP ${status}: ${body.error ?? 'không có error trong response'}`,
    }
  }
  const verified = body.verify?.sha256Match === true && body.verify?.sqliteHeaderOk === true
  return {
    ok: true,
    verified,
    sizeBytes: typeof body.sizeBytes === 'number' ? body.sizeBytes : null,
    versionedKey: body.versionedKey ?? null,
    error: verified ? undefined : `verify FAILED: ${body.warning ?? body.verify?.detail ?? 'sha256/header không khớp'}`,
  }
}

// ==================== CHỌN ARTIFACT MỚI NHẤT + TUỔI (collector ⑦-i) ====================

/**
 * Chọn artifact mới nhất theo lastModified (S3 LastModified — được R2 cập nhật
 * cả với "latest pointer" bị ghi đè mỗi lần backup). suffix=null → lấy tất cả.
 * Mảng rỗng / toàn object lastModified epoch-0 → newest null.
 */
export function newestBackupArtifact(
  objects: readonly R2ObjectLike[],
  suffix: string | null = null,
): { newestKey: string | null; newestAt: Date | null } {
  let newestKey: string | null = null
  let newestAt: Date | null = null
  for (const o of objects) {
    if (suffix && !o.key.endsWith(suffix)) continue
    if (!newestAt || o.lastModified.getTime() > newestAt.getTime()) {
      newestAt = o.lastModified
      newestKey = o.key
    }
  }
  return { newestKey, newestAt }
}

/** Tuổi artifact (giờ, 1 chữ số) — null khi không có artifact (newestAt null). */
export function artifactAgeHours(newestAt: Date | null, now: Date = new Date()): number | null {
  if (!newestAt) return null
  const hours = (now.getTime() - newestAt.getTime()) / 3600_000
  return Math.round(hours * 10) / 10
}
