/**
 * ALISTA — Daily SQLite DB Backup Executor (BLUEPRINT-DB-P0-P3 §P3-c, task 31-f)
 * ============================================================================
 *
 * Cron backup SQLite HẰNG NGÀY 03:00 giờ VN (Asia/Ho_Chi_Minh) — P3-c:
 * "đăng ký job POST /api/storage/db-backup 03:00 lịch vực (timezone user
 * Etc/GMT-7), kèm alert qua ALISTA nếu 2 ngày liên tiếp không có backup
 * thành công".
 *
 * CƠ CHẾ (mirror pattern ALISTA — KHÔNG scheduler mới):
 *   - CronJob row executor='DB-BACKUP' + agentId='alista' (≠'default'):
 *       · mini-service cron-scheduler port 3004 filter executor='' → bỏ qua
 *       · automation-engine loop B filter agentId='default' → bỏ qua
 *       · executeCronJob guard executor≠'' → từ chối (FIX v1.2 ALISTA)
 *     → scheduler nền trong process Next.js (tick 60s của ALISTA — được PM2
 *       duy trì, gọi qua alistaTick bước 1d) là executor DUY NHẤT.
 *   - Backup THẬT bằng INTERNAL FUNCTION CALL: dynamic import route handler
 *     POST của /api/storage/db-backup rồi gọi trực tiếp (precedent import
 *     route handler: tests/r86, r87, r108) — route tự làm VACUUM INTO +
 *     upload R2 (timestamped + latest pointer) + verify sha256 round-trip
 *     (rounds 31–39 hardening). KHÔNG đi qua openclaw chat queue.
 *
 * VÌ SAO KHÔNG copy nguyên văn seed-weekly-backup-cron (createCronJob,
 * executor='')? Cơ chế đó POST task text vào /api/openclaw/sessions?action=run
 * — route đó CHỈ queue task như chatMessage ("actual LLM execution is handled
 * by the openclaw chat loop… deep async LLM dispatch is a Phase 5 hardening"
 * — sessions/route.ts:206-210) → backup không bao giờ thật sự chạy trừ khi
 * có người mở UI chat. Weekly row vì vậy chỉ là "reminder". Daily backup cần
 * executor thật → theo pattern ALISTA (in-app scheduler + internal call) —
 * đúng ưu tiên của task: "internal function call if importable".
 *
 * Gate (xuất xưởng từ ./db-backup-core.ts — pure, test r119):
 *   - due khi now ≥ nextRunAt (catch-up cả ngày — server down lúc 03:00 vẫn
 *     chạy khi lên lại, triết lý catch-up ALISTA v1.2)
 *   - 1 lần/ngày theo lastRunAt vs mốc 03:00 VN (lastRunAt chỉ ghi khi THÀNH
 *     CÔNG — fail thì retry backoff 30', tối đa 24 lần/ngày rồi đợi mai)
 *   - in-flight guard globalThis (chống HMR double + tick chồng nhau)
 *
 * Fail-open tuyệt đối: tick lỗi không throw phá interval ALISTA; row bị owner
 * pause (UI Automation) thì không bắn.
 */
import { db } from '@/lib/db'
import { listR2Objects, isR2Configured } from '@/lib/r2-storage'
import {
  DAILY_BACKUP_AGENT_ID,
  DAILY_BACKUP_EXECUTOR,
  DAILY_BACKUP_MAX_RETRIES_PER_DAY,
  DAILY_BACKUP_RETRY_BACKOFF_MS,
  R2_NEO4J_BACKUP_PREFIX,
  R2_QDRANT_BACKUP_PREFIX,
  R2_SQLITE_BACKUP_PREFIX,
  artifactAgeHours,
  computeNextDailyBackupRunAt,
  interpretBackupResponse,
  newestBackupArtifact,
  shouldFireDailyBackup,
  type BackupFreshnessData,
  type BackupStoreFreshness,
} from './db-backup-core'

// ==================== CRON JOB REGISTRY (mirror ensureAlistaCronJob) ====================

/**
 * Đảm bảo CronJob row executor='DB-BACKUP' tồn tại (idempotent — seed script
 * + tick #1 của ALISTA scheduler đều gọi). Self-heal nextRunAt null/quá khứ/
 * lệch khỏi "03:00 VN kế tiếp" + hồi status='failed' (đề phòng executor cũ
 * đánh fail nhầm — FIX v1.2 ALISTA cùng triết lý).
 */
export async function ensureDailyBackupCronJob(): Promise<void> {
  try {
    const existing = await db.cronJob.findFirst({
      where: { executor: DAILY_BACKUP_EXECUTOR },
    })
    const nextRun = computeNextDailyBackupRunAt(new Date())
    if (existing) {
      const needsHeal =
        !existing.nextRunAt ||
        existing.nextRunAt < new Date() ||
        existing.status === 'failed' ||
        existing.nextRunAt.getTime() !== nextRun.getTime()
      if (needsHeal) {
        await db.cronJob.update({
          where: { id: existing.id },
          data: {
            nextRunAt: nextRun,
            status: existing.status === 'paused' ? 'paused' : 'active',
            lastError: null,
          },
        }).catch(() => { /* fail-open */ })
      }
      return
    }
    await db.cronJob.create({
      data: {
        agentId: DAILY_BACKUP_AGENT_ID, // ≠'default' → automation-engine loop B bỏ qua
        expression: '0 3 * * *',
        expr: '0 3 * * *',
        kind: 'cron',
        tz: 'Asia/Ho_Chi_Minh',
        taskPrompt: 'DB Backup SQLite hằng ngày 03:00 VN (P3-c) — VACUUM INTO → R2 backups/sqlite/ + verify sha256',
        task: '', // KHÔNG set task — row chỉ để hiển thị/pause trong UI Automation
        executor: DAILY_BACKUP_EXECUTOR, // scheduler nền trong app là executor duy nhất
        scheduleJson: JSON.stringify({
          mode: 'day', times: ['03:00'], repeat: true,
          source: 'BLUEPRINT-DB-P0-P3 §P3-c (task 31-f)',
          trigger: 'POST /api/storage/db-backup (internal function call)',
          retry: '30 phút backoff, tối đa 24 lần/ngày',
        }),
        enabled: true,
        status: 'active',
        nextRunAt: nextRun,
      },
    })
    console.log(
      `[DB-Backup][cron] Đã tạo CronJob row executor='${DAILY_BACKUP_EXECUTOR}' — 03:00 hằng ngày (tz VN), nextRunAt=${nextRun.toISOString()}`,
    )
  } catch (err) {
    console.warn('[DB-Backup][cron] ensureDailyBackupCronJob fail (không chặn boot):', err instanceof Error ? err.message : String(err))
  }
}

// ==================== IN-FLIGHT GUARD (globalThis — chống HMR double) ====================

const INFLIGHT_KEY = '__tmoDailyBackupInFlight'
type InflightGlobal = { [INFLIGHT_KEY]?: boolean }

function isBackupInFlight(): boolean {
  return !!(globalThis as unknown as InflightGlobal)[INFLIGHT_KEY]
}
function markBackupInFlight(): void {
  ;(globalThis as unknown as InflightGlobal)[INFLIGHT_KEY] = true
}
function clearBackupInFlight(): void {
  ;(globalThis as unknown as InflightGlobal)[INFLIGHT_KEY] = false
}

// ==================== EXECUTOR — INTERNAL FUNCTION CALL ====================

/**
 * Bắn backup THẬT: dynamic import route handler POST của db-backup rồi gọi
 * trực tiếp trong process (không network, không chat queue). Route tự resolve
 * live DB path (PRAGMA database_list + mismatch-guard P0-1), VACUUM INTO,
 * upload R2 (timestamped + latest) và verify sha256 round-trip.
 *
 * Sau chạy: THÀNH CÔNG → lastRunAt=now + nextRunAt=03:00 VN mai + retryCount=0
 * (verify FAIL vẫn tính thành công nhưng ghi lastError — đối xứng warning của
 * route). THẤT BẠI → KHÔNG ghi lastRunAt (giữ gate 1 lần/ngày mở cho retry),
 * nextRunAt=now+30' backoff, quá 24 lần/ngày → đợi 03:00 mai.
 */
async function runDailyBackupNow(jobId: string): Promise<void> {
  const startedAt = Date.now()
  const fail = async (msg: string) => {
    try {
      const job = await db.cronJob.findUnique({ where: { id: jobId } })
      const newRetry = (job?.retryCount ?? 0) + 1
      const giveUp = newRetry >= DAILY_BACKUP_MAX_RETRIES_PER_DAY
      const nextRun = giveUp
        ? computeNextDailyBackupRunAt(new Date())
        : new Date(Date.now() + DAILY_BACKUP_RETRY_BACKOFF_MS)
      await db.cronJob.update({
        where: { id: jobId },
        data: {
          retryCount: newRetry,
          lastError: `attempt ${newRetry}/${DAILY_BACKUP_MAX_RETRIES_PER_DAY}: ${msg}`.slice(0, 500),
          nextRunAt: nextRun,
        },
      })
      console.warn(
        `[DB-Backup][cron] backup FAIL (attempt ${newRetry}/${DAILY_BACKUP_MAX_RETRIES_PER_DAY}, ${giveUp ? 'đợi 03:00 mai' : `thử lại ${new Date(Date.now() + DAILY_BACKUP_RETRY_BACKOFF_MS).toISOString()}`}): ${msg}`,
      )
    } catch (updateErr) {
      console.warn('[DB-Backup][cron] ghi fail-state lỗi:', updateErr instanceof Error ? updateErr.message : String(updateErr))
    }
  }

  try {
    // Internal function call (precedent import route handler: tests r86/r87/r108)
    const { POST } = await import('@/app/api/storage/db-backup/route')
    const { NextRequest } = await import('next/server')
    // URL chỉ để route đọc searchParams (action mặc định 'backup') — host không
    // quan trọng vì gọi thẳng handler trong process, không ra network.
    const req = new NextRequest('http://localhost:3000/api/storage/db-backup', {
      method: 'POST',
      signal: AbortSignal.timeout(10 * 60_000),
    })
    const res = await POST(req)
    const json = await res.json().catch(() => ({}))
    const verdict = interpretBackupResponse(res.status, json)

    if (!verdict.ok) {
      await fail(verdict.error ?? 'unknown error')
      return
    }

    await db.cronJob.update({
      where: { id: jobId },
      data: {
        lastRunAt: new Date(),
        nextRunAt: computeNextDailyBackupRunAt(new Date()),
        retryCount: 0,
        // verify FAIL: artifact đã lên R2 nhưng đáng ngờ — ghi lastError cho
        // vận hành (freshness rule đo tuổi artifact vẫn thấy bản này).
        lastError: verdict.verified ? null : (verdict.error ?? 'verify FAILED'),
      },
    })
    console.log(
      `[DB-Backup][cron] backup OK: ${verdict.versionedKey ?? '(không có key)'} ` +
      `(${verdict.sizeBytes != null ? `${(verdict.sizeBytes / 1024 / 1024).toFixed(2)} MB` : '?'}, ${Date.now() - startedAt}ms, verified=${verdict.verified})`,
    )
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err))
  }
}

// ==================== TICK (gọi từ alistaTick — 60s) ====================

/**
 * 1 tick daily backup — đọc row, gate, bắn (fire-and-forget có in-flight
 * guard). Fail-open tuyệt đối: mọi lỗi chỉ warn, không throw (tick ALISTA
 * phía sau không bị ảnh hưởng). KHÔNG phụ thuộc cửa sổ ca trực 23:30-05:30
 * (backup 03:00 nằm trong ca nhưng catch-up ban ngày vẫn phải chạy được).
 */
export async function dailyBackupTick(tickNo: number): Promise<void> {
  try {
    const job = await db.cronJob.findFirst({ where: { executor: DAILY_BACKUP_EXECUTOR } })
    if (!job) return // chưa seed — ensureDailyBackupCronJob (tick #1) sẽ tạo

    const gate = shouldFireDailyBackup({
      enabled: job.enabled,
      status: job.status,
      nextRunAt: job.nextRunAt,
      lastRunAt: job.lastRunAt,
    })
    if (!gate.fire) return

    if (isBackupInFlight()) {
      console.log(`[DB-Backup][cron] tick #${tickNo}: backup đang chạy (in-flight) — skip`)
      return
    }

    console.log(`[DB-Backup][cron] tick #${tickNo}: ${gate.reason} → bắn backup SQLite (03:00 VN P3-c)`)
    markBackupInFlight()
    void runDailyBackupNow(job.id)
      .catch((err) => {
        console.error('[DB-Backup][cron] executor lỗi (đã ghi fail-state):', err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        clearBackupInFlight()
      })
  } catch (err) {
    // Fail-open: tick lỗi thì tick sau sẽ thử lại — không throw phá interval ALISTA
    console.warn(`[DB-Backup][cron] tick #${tickNo} lỗi (bỏ qua, chờ tick sau):`, err instanceof Error ? err.message : String(err))
  }
}

// ==================== COLLECTOR ⑦(i) — BACKUP FRESHNESS (P3-c) ====================

/**
 * Đo tuổi artifact backup mới nhất trên R2 cho cả 3 kho (sqlite hằng ngày +
 * qdrant/neo4j hằng tuần). Fail-open TỪNG kho: list fail → available=false +
 * error (rule KHÔNG alert khi không đo được — R2 disconnected đã có layer:r2).
 * Prefix khớp 100% route: db-backup R2_PREFIX + snapshot-full qdrantPrefix/neo4jPrefix.
 */
export async function collectBackupFreshness(): Promise<BackupFreshnessData> {
  const unavailable = (): BackupStoreFreshness => ({
    available: false, totalArtifacts: 0, newestKey: null, newestAt: null, ageHours: null,
  })

  if (!isR2Configured()) {
    return { r2Configured: false, sqlite: unavailable(), qdrant: unavailable(), neo4j: unavailable() }
  }

  const now = new Date()
  const one = async (prefix: string, suffix: string | null): Promise<BackupStoreFreshness> => {
    try {
      const listing = await listR2Objects(prefix, 200)
      if (!listing.success) {
        return { ...unavailable(), error: listing.error ?? 'listR2Objects failed' }
      }
      // SQLite: chỉ tính file .db (route GET lọc tương tự); qdrant/neo4j: tất cả (tar/gz)
      const objects = suffix ? listing.objects.filter(o => o.key.endsWith(suffix)) : listing.objects
      const { newestKey, newestAt } = newestBackupArtifact(objects)
      return {
        available: true,
        totalArtifacts: objects.length,
        newestKey,
        newestAt: newestAt?.toISOString() ?? null,
        ageHours: artifactAgeHours(newestAt, now),
      }
    } catch (err) {
      return { ...unavailable(), error: err instanceof Error ? err.message : String(err) }
    }
  }

  const [sqlite, qdrant, neo4j] = await Promise.all([
    one(R2_SQLITE_BACKUP_PREFIX, '.db'),
    one(R2_QDRANT_BACKUP_PREFIX, null),
    one(R2_NEO4J_BACKUP_PREFIX, null),
  ])
  return { r2Configured: true, sqlite, qdrant, neo4j }
}
