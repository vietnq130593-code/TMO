/**
 * r119 — P3-c Daily Backup Cron + Restore Drill (task 31-f) — PURE TESTS
 * ============================================================================
 *
 * Pin logic thuần của src/lib/alista/db-backup-core.ts (0 import db/server —
 * doctrine #9, precedent r117 pin d2-stats) + rule backup-freshness của
 * src/lib/alista/rules.ts ⑦(i) (rules.ts chỉ import type từ collectors nên
 * import an toàn không kéo Prisma):
 *
 *  - computeNextDailyBackupRunAt / dailyBackupAnchorMs: mốc 03:00 VN
 *    (Asia/Ho_Chi_Minh = UTC+7) — trước 03:00 → hôm nay 03:00, sau → mai
 *    03:00, ranh giới nửa đêm VN (17:00Z) không nhảy ngày, đúng thời điểm
 *    chính xác tới ms.
 *  - shouldFireDailyBackup: đủ nhánh gate — disabled/paused/nextRunAt null/
 *    chưa due/1 lần mỗi backup-day theo lastRunAt vs anchor 03:00 VN (kể cả
 *    ca khó: backup thành công LÚC 02:41 VN — trước anchor — thì 03:00 VN hôm
 *    đó vẫn là backup-day MỚI, được phép bắn lại).
 *  - interpretBackupResponse: 200+verify ok → ok+verified; 200+verify FAIL →
 *    ok (artifact đã lên R2) nhưng verified=false + error; HTTP lỗi +
 *    success thiếu → ok=false (đối xứng warning của route round-32).
 *  - newestBackupArtifact / artifactAgeHours: chọn max lastModified, lọc
 *    suffix .db, mảng rỗng/toàn bị lọc → null, tuổi làm tròn 1 chữ số.
 *  - rulesForDatabaseSystem ⑦(i): sqlite > 48h → high; 0 artifact →
 *    'no_artifact'; available=false (đo không được) → KHÔNG alert (fail-open —
 *    R2 disconnected đã có layer:r2); r2Configured=false → không alert;
 *    qdrant/neo4j > 192h → medium; tươi (20h/100h) → 0 finding.
 *
 * Không đụng DB thật (bunfig preload db-isolation không liên quan — module
 * thuần; rule import type-only).
 */

import { describe, expect, test } from 'bun:test'
import {
  DAILY_BACKUP_TZ,
  SQLITE_BACKUP_MAX_AGE_HOURS,
  WEEKLY_SNAPSHOT_MAX_AGE_HOURS,
  artifactAgeHours,
  computeNextDailyBackupRunAt,
  dailyBackupAnchorMs,
  interpretBackupResponse,
  newestBackupArtifact,
  shouldFireDailyBackup,
  vnDateStr,
  type BackupFreshnessData,
  type BackupStoreFreshness,
  type DailyBackupJobState,
  type R2ObjectLike,
} from '../src/lib/alista/db-backup-core'
import { rulesForDatabaseSystem } from '../src/lib/alista/rules'
import type { DatabaseSystemData } from '../src/lib/alista/collectors'
import { makeDedupeKey } from '../src/lib/alista/types'

// ==================== MỐC 03:00 VIỆT NAM (UTC+7) ====================

describe('r119 · computeNextDailyBackupRunAt / dailyBackupAnchorMs — 03:00 VN', () => {
  test('02:00 VN (19:00Z) → 03:00 VN HÔM NAY = 20:00Z cùng ngày UTC', () => {
    const now = new Date('2026-10-17T19:00:00Z') // 02:00 VN chủ nhật 18/10
    expect(computeNextDailyBackupRunAt(now).toISOString()).toBe('2026-10-17T20:00:00.000Z')
  })

  test('04:00 VN (21:00Z) → 03:00 VN NGÀY MAI = 20:00Z ngày UTC kế tiếp', () => {
    const now = new Date('2026-10-17T21:00:00Z') // 04:00 VN 18/10
    expect(computeNextDailyBackupRunAt(now).toISOString()).toBe('2026-10-18T20:00:00.000Z')
  })

  test('ranh giới nửa đêm VN 00:00 (17:00Z) — "hôm nay" VN đã lịch sang ngày mới, anchor vẫn 03:00 VN tới', () => {
    const now = new Date('2026-10-17T17:00:00Z') // 00:00 VN 18/10
    expect(computeNextDailyBackupRunAt(now).toISOString()).toBe('2026-10-17T20:00:00.000Z')
  })

  test('đúng 03:00:00.000 VN → "kế tiếp" là mai (anchor không > now → +24h)', () => {
    const now = new Date('2026-10-17T20:00:00.000Z') // đúng 03:00 VN 18/10
    expect(computeNextDailyBackupRunAt(now).toISOString()).toBe('2026-10-18T20:00:00.000Z')
  })

  test('anchor epoch chính xác tới ms (03:00+07:00) + vnDateStr theo tz VN không phụ thuộc server UTC', () => {
    const now = new Date('2026-10-17T19:59:59.999Z') // 02:59:59.999 VN 18/10
    expect(dailyBackupAnchorMs(now)).toBe(new Date('2026-10-18T03:00:00+07:00').getTime()) // = 20:00Z 17/10
    expect(vnDateStr(new Date('2026-10-17T19:00:00Z'))).toBe('2026-10-18') // 02:00 VN 18/10
    expect(DAILY_BACKUP_TZ).toBe('Asia/Ho_Chi_Minh')
  })
})

// ==================== GATE: DUE + 1 LẦN/BACKUP-DAY ====================

describe('r119 · shouldFireDailyBackup — gate đủ nhánh', () => {
  // Bối cảnh chung: now = 21:00Z 17/10 = 04:00 VN 18/10; anchor hôm nay = 20:00Z 17/10
  const NOW = new Date('2026-10-17T21:00:00Z')
  const base: DailyBackupJobState = {
    enabled: true,
    status: 'active',
    nextRunAt: new Date('2026-10-17T20:00:00Z'), // 03:00 VN hôm nay — đã tới hạn
    lastRunAt: null,
  }

  test('row disabled → không bắn (owner pause UI Automation)', () => {
    expect(shouldFireDailyBackup({ ...base, enabled: false }, NOW).fire).toBe(false)
  })

  test("status 'paused'/'failed' → không bắn", () => {
    expect(shouldFireDailyBackup({ ...base, status: 'paused' }, NOW).fire).toBe(false)
    expect(shouldFireDailyBackup({ ...base, status: 'failed' }, NOW).fire).toBe(false)
  })

  test('nextRunAt null → không bắn (cần self-heal)', () => {
    expect(shouldFireDailyBackup({ ...base, nextRunAt: null }, NOW).fire).toBe(false)
  })

  test('chưa đến hạn (nextRunAt mai) → không bắn', () => {
    const gate = shouldFireDailyBackup({ ...base, nextRunAt: new Date('2026-10-18T20:00:00Z') }, NOW)
    expect(gate.fire).toBe(false)
    expect(gate.reason).toContain('chưa đến hạn')
  })

  test('due + chưa từng chạy → bắn (reason "lần đầu")', () => {
    const gate = shouldFireDailyBackup(base, NOW)
    expect(gate.fire).toBe(true)
    expect(gate.reason).toContain('lần đầu')
  })

  test('due + lần cuối HÔM QUA → bắn catch-up', () => {
    const gate = shouldFireDailyBackup({ ...base, lastRunAt: new Date('2026-10-16T20:05:00Z') }, NOW) // 03:05 VN 17/10
    expect(gate.fire).toBe(true)
    expect(gate.reason).toContain('due')
  })

  test('due + đã thành công SAU anchor 03:00 VN hôm nay → KHÔNG bắn lại (gate 1 lần/backup-day)', () => {
    const gate = shouldFireDailyBackup({ ...base, lastRunAt: new Date('2026-10-17T20:30:00Z') }, NOW) // 03:30 VN 18/10
    expect(gate.fire).toBe(false)
    expect(gate.reason).toContain('1 lần/ngày')
  })

  test('ca khó: thành công lúc 02:41 VN (TRƯỚC anchor 03:00) — 03:00 hôm đó là backup-day MỚI → được bắn', () => {
    // Kịch bản thật của E2E verify 31-f: row due lúc 02:41 VN (19:41Z), chạy xong
    // nextRunAt=20:00Z (03:00 VN) — tới 03:00 VN gate phải MỞ (backup-day mới),
    // không phải coi 02:41 là "đã chạy hôm nay".
    const gate = shouldFireDailyBackup(
      {
        enabled: true,
        status: 'active',
        nextRunAt: new Date('2026-10-17T20:00:00Z'),
        lastRunAt: new Date('2026-10-17T19:41:43Z'), // 02:41 VN 18/10
      },
      new Date('2026-10-17T20:00:30Z'), // 03:00:30 VN 18/10
    )
    expect(gate.fire).toBe(true)
  })
})

// ==================== DIỄN DỊCH RESPONSE ROUTE db-backup ====================

describe('r119 · interpretBackupResponse — đối xứng warning route round-32', () => {
  test('200 + success + verify ok (sha256 + header) → ok + verified', () => {
    const r = interpretBackupResponse(200, {
      success: true,
      versionedKey: 'backups/sqlite/custom-2026-10-17T19-41-40-643Z.db',
      sizeBytes: 17854464,
      verify: { roundTripOk: true, sha256Match: true, sqliteHeaderOk: true },
    })
    expect(r.ok).toBe(true)
    expect(r.verified).toBe(true)
    expect(r.sizeBytes).toBe(17854464)
    expect(r.versionedKey).toBe('backups/sqlite/custom-2026-10-17T19-41-40-643Z.db')
    expect(r.error).toBeUndefined()
  })

  test('200 + success + verify FAIL → ok (artifact đã lên R2) nhưng verified=false + error', () => {
    const r = interpretBackupResponse(200, {
      success: true,
      verify: { roundTripOk: false, sha256Match: false, sqliteHeaderOk: true, detail: 'sha mismatch' },
      warning: 'Backup verify FAILED',
    })
    expect(r.ok).toBe(true)
    expect(r.verified).toBe(false)
    expect(r.error).toContain('verify FAILED')
  })

  test('verify thiếu field (route lỗi verify step) → verified=false', () => {
    const r = interpretBackupResponse(200, { success: true, verify: {} })
    expect(r.ok).toBe(true)
    expect(r.verified).toBe(false)
  })

  test('HTTP 503 (R2 chưa cấu hình) / 500 (upload fail) / success thiếu → ok=false kèm HTTP code', () => {
    expect(interpretBackupResponse(503, { error: 'R2 not configured' }).ok).toBe(false)
    expect(interpretBackupResponse(503, { error: 'R2 not configured' }).error).toContain('HTTP 503')
    expect(interpretBackupResponse(500, { error: 'R2 upload failed' }).ok).toBe(false)
    expect(interpretBackupResponse(200, { success: false, error: 'x' }).ok).toBe(false)
    expect(interpretBackupResponse(200, null).ok).toBe(false)
  })
})

// ==================== CHỌN ARTIFACT MỚI NHẤT + TUỔI ====================

describe('r119 · newestBackupArtifact / artifactAgeHours', () => {
  const objects: R2ObjectLike[] = [
    { key: 'backups/sqlite/custom-2026-10-15T20-00-00Z.db', size: 100, lastModified: new Date('2026-10-15T20:00:00Z') },
    { key: 'backups/sqlite/custom-2026-10-17T19-41-40Z.db', size: 200, lastModified: new Date('2026-10-17T19:41:40Z') },
    { key: 'backups/sqlite/custom.db', size: 200, lastModified: new Date('2026-10-17T19:41:42Z') }, // latest pointer — mới nhất
    { key: 'backups/sqlite/custom-2026-10-16T20-00-00Z.db.tmp', size: 1, lastModified: new Date('2026-10-17T23:00:00Z') }, // không phải .db
  ]

  test('chọn max lastModified; suffix .db lọc file khác', () => {
    const { newestKey, newestAt } = newestBackupArtifact(objects, '.db')
    expect(newestKey).toBe('backups/sqlite/custom.db')
    expect(newestAt?.toISOString()).toBe('2026-10-17T19:41:42.000Z')
  })

  test('suffix null → lấy tất cả (kể cả .tmp — qdrant/neo4j lấy cả tar/gz)', () => {
    expect(newestBackupArtifact(objects, null).newestKey).toBe('backups/sqlite/custom-2026-10-16T20-00-00Z.db.tmp')
  })

  test('mảng rỗng / toàn bộ bị lọc → newest null (rule hiểu là no_artifact)', () => {
    expect(newestBackupArtifact([], '.db')).toEqual({ newestKey: null, newestAt: null })
    expect(newestBackupArtifact(objects.filter(o => o.key.endsWith('.gz')), '.db')).toEqual({ newestKey: null, newestAt: null })
  })

  test('tuổi artifact: null → null; 90 phút → 1.5h; 50h → 50.0 (làm tròn 1 chữ số)', () => {
    const now = new Date('2026-10-18T00:00:00Z')
    expect(artifactAgeHours(null, now)).toBeNull()
    expect(artifactAgeHours(new Date('2026-10-17T22:30:00Z'), now)).toBe(1.5)
    expect(artifactAgeHours(new Date('2026-10-15T22:00:00Z'), now)).toBe(50.0)
  })
})

// ==================== RULE ⑦(i) — BACKUP FRESHNESS (P3-c) ====================

/** Synthetic DatabaseSystemData — chỉ backupFreshness thay đổi, còn lại sạch (0 finding khác). */
function makeDbData(backupFreshness: BackupFreshnessData): DatabaseSystemData {
  return {
    schemaDrift: { migrated: false, reason: null, orphanTables: null },
    zombies: {
      agentRunRunning6h: 0, taskExecutionRunning24h: 0, smolabTaskRunning30m: 0, goalLoopJobRunning15m: 0,
      details: [],
    },
    memoryDrift: {
      episodeMirrorCount: 0, episodeGraphCount: 0, episodeDriftPct: 0,
      lessonMirrorCount: 0, lessonGraphCount: 0, lessonDriftPct: 0, neo4jReachable: false,
    },
    learning: {
      autoLearn: { total: 0, completed: 0, failed: 0, pending: 0, failedIn24h: 0, pendingStuck24h: 0 },
      pendingWriteback: 0,
      lessonsNeedReview: 0,
    },
    kgSync: { unsyncedResolvedEntities: 0, rawBufferSize: 0, graphEntityCount: 0, bufferToGraphRatio: 0 },
    tokenAnomaly: { agentsWithSpike: [], agentsWithDrop: [] },
    dbStorage: { sqliteBytes: 0, tableRowCounts: {}, largeTables: [] },
    scheduler: {
      jobQueue: { pending: 0, running: 0, failedIn24h: 0, stuckRunning1h: 0, oldestPendingHours: null },
      cronJobs: { total: 0, enabled: 0, stuck: [] },
    },
    backupFreshness,
  }
}

function store(over: Partial<BackupStoreFreshness> = {}): BackupStoreFreshness {
  return {
    available: true, totalArtifacts: 3,
    newestKey: 'backups/sqlite/custom.db',
    newestAt: new Date('2026-10-16T00:00:00Z').toISOString(),
    ageHours: 24,
    ...over,
  }
}

function backupData(over: Partial<BackupFreshnessData> = {}): BackupFreshnessData {
  return {
    r2Configured: true,
    sqlite: store({ ageHours: 20 }),       // tươi — dưới 48h
    qdrant: store({ ageHours: 100 }),      // tươi — dưới 192h
    neo4j: store({ ageHours: 100 }),
    ...over,
  }
}

describe('r119 · rulesForDatabaseSystem ⑦(i) — backup freshness (P3-c ≤ 2 ngày)', () => {
  test('mọi kho tươi (sqlite 20h, weekly 100h) → 0 finding', () => {
    expect(rulesForDatabaseSystem(makeDbData(backupData()))).toEqual([])
  })

  test('sqlite 50h (> 48h P3-c) → 1 finding high, key dedupe chuẩn, criteria target 48h', () => {
    const findings = rulesForDatabaseSystem(makeDbData(backupData({ sqlite: store({ ageHours: 50 }) })))
    expect(findings.length).toBe(1)
    const f = findings[0]
    expect(f.key).toBe(makeDedupeKey('db', 'backup_stale_sqlite'))
    expect(f.priority).toBe('high')
    expect(f.checkId).toBe(7)
    expect(f.successCriteria?.target).toBe(SQLITE_BACKUP_MAX_AGE_HOURS)
    expect(f.successCriteria?.operator).toBe('lte')
    expect(f.successCriteria?.current).toBe(50)
    expect(f.evidence.ageHours).toBe(50)
  })

  test('sqlite KHÔNG có artifact nào (ageHours null) → vẫn alert, current = no_artifact', () => {
    const findings = rulesForDatabaseSystem(makeDbData(backupData({
      sqlite: store({ ageHours: null, newestKey: null, newestAt: null, totalArtifacts: 0 }),
    })))
    expect(findings.length).toBe(1)
    expect(findings[0].successCriteria?.current).toBe('no_artifact')
  })

  test('sqlite 48.0h đúng ngưỡng → KHÔNG alert (chỉ > ngưỡng mới bắn)', () => {
    expect(rulesForDatabaseSystem(makeDbData(backupData({ sqlite: store({ ageHours: 48 }) })))).toEqual([])
  })

  test('fail-open: available=false (list R2 fail) → KHÔNG alert (R2 disconnect đã có layer:r2)', () => {
    expect(rulesForDatabaseSystem(makeDbData(backupData({
      sqlite: store({ available: false, ageHours: null, error: 'list failed' }),
    })))).toEqual([])
  })

  test('r2Configured=false → không alert gì về backup', () => {
    expect(rulesForDatabaseSystem(makeDbData(backupData({
      r2Configured: false,
      sqlite: store({ available: false }),
      qdrant: store({ available: false }),
      neo4j: store({ available: false }),
    })))).toEqual([])
  })

  test('qdrant 200h + neo4j 300h (> 192h weekly+grace) → 2 finding medium (backup_stale_qdrant/neo4j)', () => {
    const findings = rulesForDatabaseSystem(makeDbData(backupData({
      qdrant: store({ ageHours: 200 }),
      neo4j: store({ ageHours: 300 }),
    })))
    expect(findings.length).toBe(2)
    expect(findings.every(f => f.priority === 'medium')).toBe(true)
    expect(findings.map(f => f.key).sort()).toEqual([
      makeDedupeKey('db', 'backup_stale_neo4j'),
      makeDedupeKey('db', 'backup_stale_qdrant'),
    ])
    expect(findings.every(f => f.successCriteria?.target === WEEKLY_SNAPSHOT_MAX_AGE_HOURS)).toBe(true)
  })
})
