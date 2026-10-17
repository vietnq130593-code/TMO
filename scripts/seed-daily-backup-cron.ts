/**
 * BLUEPRINT-DB-P0-P3 §P3-c (task 31-f) — Seed cron backup SQLite HẰNG NGÀY 03:00 VN.
 * ==================================================================================
 *
 * Tạo CronJob row executor='DB-BACKUP': scheduler nền trong process Next.js
 * (tick 60s của ALISTA — alista-scheduler.ts bước 1d) mỗi tick gate + bắn
 * backup SQLite 03:00 giờ Việt Nam (Asia/Ho_Chi_Minh — blueprint P3-c
 * "03:00 lịch vực, timezone user Etc/GMT-7") bằng INTERNAL FUNCTION CALL:
 * dynamic import route handler POST /api/storage/db-backup (VACUUM INTO →
 * R2 backups/sqlite/custom-<ts>.db + latest pointer + verify sha256
 * round-trip — hardening rounds 31–39).
 *
 * Vì sao KHÔNG copy nguyên văn seed-weekly-backup-cron.ts (createCronJob,
 * executor='')? Cơ chế đó POST task text vào /api/openclaw/sessions?action=run
 * — route đó CHỈ queue task như chatMessage ("actual LLM execution is
 * handled by the openclaw chat loop… deep async LLM dispatch is a Phase 5
 * hardening" — sessions/route.ts:206-210) → backup không tự chạy. Pattern
 * executor riêng + scheduler nền trong app (ALISTA v1.2) là cơ chế cron THẬT
 * duy nhất của project: mini-service cron-scheduler port 3004 filter
 * executor='' (bỏ qua row này), automation-engine loop B filter
 * agentId='default' (bỏ qua vì agentId='alista') → đúng 1 executor.
 *
 * Idempotent: ensureDailyBackupCronJob chỉ tạo khi thiếu + tự heal nextRunAt
 * (mirror ensureAlistaCronJob). Tick #1 của ALISTA scheduler cũng tự gọi
 * ensure này — script này để chủ động đăng ký NGAY không chờ restart app.
 *
 * Usage (bun tự nạp .env; script tự guard DATABASE_URL leak từ shell —
 * tiền lệ pm2-start.sh / scripts/d2-baseline-report.ts):
 *   cd /home/z/tmo-app && bun scripts/seed-daily-backup-cron.ts
 *
 * Alternative (không DB app — chạy trực tiếp trên máy host):
 *   0 3 * * * curl -s -X POST 'http://localhost:3000/api/storage/db-backup' --max-time 600 > /dev/null
 *
 * LƯU Ý VẬN HÀNH: code executor (alista-scheduler.ts + db-backup.ts) được nạp
 * lúc process Next.js khởi động — nếu app đang chạy từ TRƯỚC khi code này
 * được thêm, row sẽ được tick cũ bỏ qua cho tới lần restart app kế tiếp
 * (pm2 restart theopusflashlite). Row + lịch vẫn ghi đúng ngay lập tức.
 */

import fs from 'node:fs'
import path from 'node:path'

// ==================== ENV GUARD (chạy TRƯỚC import db — pattern d2-baseline-report.ts) ====================

const PROJECT_ROOT = path.resolve(import.meta.dir, '..')

/** Đọc DATABASE_URL= từ .env project (bỏ comment, strip quote — cùng logic db.ts). */
function readEnvFileDatabaseUrl(envPath: string): string {
  if (!fs.existsSync(envPath)) return ''
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
    let value = ''
    for (const line of lines) {
      const m = line.match(/^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*)$/)
      if (m) {
        let v = m[1].trim()
        v = v.replace(/\s+#.*$/, '').trim()
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1)
        }
        value = v
      }
    }
    return value
  } catch {
    return ''
  }
}

/** Chuẩn hóa URL file: → tuyệt đối (tương đối tính theo PROJECT_ROOT/prisma). */
function fileUrlToAbsolute(url: string): string {
  const m = url.match(/^file:(.+)$/)
  if (!m) return url
  const raw = m[1].trim()
  const isAbs = raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(raw)
  return isAbs ? raw : path.resolve(path.join(PROJECT_ROOT, 'prisma'), raw)
}

/**
 * Guard DATABASE_URL — seed PHẢI ghi row vào DB của project này, không phải
 * DB do shell sandbox leak (đã bắt gặp thật: DATABASE_URL=file:/home/z/my-project/db/custom.db
 * TỒN TẠI → guard "giữ env kế thừa" của db.ts giữ NHẦM → ghi sai DB).
 */
function guardDatabaseUrl(): string {
  const envUrl = readEnvFileDatabaseUrl(path.join(PROJECT_ROOT, '.env'))
  const inherited = (process.env.DATABASE_URL || '').trim()
  if (!envUrl) return inherited || '(prisma default)'
  const abs = fileUrlToAbsolute(envUrl)
  const sameTarget = inherited ? fileUrlToAbsolute(inherited) === abs : false
  if (inherited && !sameTarget) {
    console.warn(
      `[SeedDailyBackupCron] ⚠️ DATABASE_URL shell ("${inherited}") trỏ DB KHÁC project — bỏ theo (tiền lệ pm2-start.sh) để seed đúng DB project. DB dùng: ${abs}`,
    )
    process.env.DATABASE_URL = /^file:/.test(envUrl) ? `file:${abs}` : envUrl
  } else if (!inherited) {
    process.env.DATABASE_URL = envUrl
  }
  return abs
}

// ==================== MAIN ====================

async function main() {
  const dbTarget = guardDatabaseUrl()
  console.log(`[SeedDailyBackupCron] DB đích: ${dbTarget}`)

  // Import động SAU guard (module db.ts resolve URL lúc import)
  const { ensureDailyBackupCronJob } = await import('../src/lib/alista/db-backup')
  const { computeNextDailyBackupRunAt, DAILY_BACKUP_EXECUTOR } = await import('../src/lib/alista/db-backup-core')

  await ensureDailyBackupCronJob()

  // Verify read-only: đọc lại row + in trạng thái đăng ký
  const { db } = await import('../src/lib/db')
  const row = await db.cronJob.findFirst({ where: { executor: DAILY_BACKUP_EXECUTOR } })
  if (!row) {
    console.error('[SeedDailyBackupCron] FAILED — không tìm thấy row sau khi ensure (kiểm tra DATABASE_URL?)')
    process.exit(1)
  }
  const expectedNext = computeNextDailyBackupRunAt(new Date())
  console.log(
    '[SeedDailyBackupCron] Result:',
    JSON.stringify(
      {
        id: row.id,
        agentId: row.agentId,
        executor: row.executor,
        kind: row.kind,
        expr: row.expr,
        tz: row.tz,
        status: row.status,
        enabled: row.enabled,
        nextRunAt: row.nextRunAt?.toISOString() ?? null,
        nextRunExpected: expectedNext.toISOString(),
        nextRunHealed: row.nextRunAt?.getTime() === expectedNext.getTime(),
        lastRunAt: row.lastRunAt?.toISOString() ?? null,
        lastError: row.lastError,
      },
      null,
      2,
    ),
  )
  console.log(
    `[SeedDailyBackupCron] ✓ Đã đăng ký cron backup SQLite hằng ngày 03:00 VN (P3-c) — executor '${DAILY_BACKUP_EXECUTOR}' chạy trong tick ALISTA (60s) của process Next.js.`,
  )
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[SeedDailyBackupCron] FAILED:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  })

// Module marker — tránh TS2393 trùng tên `main` với script khác khi tsc gộp toàn bộ *.ts
export {}
