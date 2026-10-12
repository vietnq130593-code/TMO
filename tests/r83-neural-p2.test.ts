/**
 * r83 — NEURAL-ARCH P2 (2026-10-11): audit log + reduced-motion + breakpoint
 * ============================================================================
 * Phủ 3 tầng (theo 4 hạng mục P2 review task-98):
 *   1. AUDIT LOG (P2-M2 — TuningChangeLog): set/reset ghi đúng field
 *      before/after (store + hiệu lực), validate-fail KHÔNG sinh log,
 *      prune giữ cap 500 dòng, getTuningChangeLog mới→cũ, API GET/POST
 *      trả changeLog đúng shape.
 *   2. REDUCED-MOTION GATE (P2-M1 — edgeDotVisible thuần): hạt animateMotion
 *      tắt khi user giảm chuyển động; kind không có hạt thì luôn tắt.
 *   3. BREAKPOINT (P2-M3): NEURAL_DESKTOP_BREAKPOINT = 1024 = lg Tailwind
 *      (media query JS luôn khớp cột `hidden lg:block` — pin chống lệch).
 *
 * FB-P2-R1 regression (điều phối thêm sau vòng R1):
 *   - R1-01: capture-restart — set đầu tiên sau khi snapshot process trống
 *     vẫn ghi đúng fromEffectiveValue (derive từ DB, không tin snapshot).
 *   - R1-02: prune tie — hàng trăm dòng cùng ms vẫn chốt đúng cap 500.
 *   - R1-06b: writeChangeLog fail-open — bảng mất vật lý vẫn set thành công.
 *   - R1-06c: take-limit của getTuningChangeLog.
 *
 * (P2-M3 bottom-sheet + P2-M4 pause-poll là wiring component — pin bằng
 * browser E2E live sau gate, không thể render trong bun:test.)
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import {
  setTuningValue,
  resetTuningValue,
  getTuningChangeLog,
  getTuningNumber,
} from '@/lib/learning/tuning-store'
import { getTuningSpec, TUNING_CHANGE_LOG_CAP } from '@/lib/learning/neural-types'
import {
  edgeDotVisible,
  edgeVisual,
  NEURAL_DESKTOP_BREAKPOINT,
} from '@/lib/learning/neural-layout'
import { db } from '@/lib/db'
import { GET, POST } from '@/app/api/neural-architecture/route'

// ==================== 1. AUDIT LOG (P2-M2) ====================

describe('r83 · TuningChangeLog — set/reset ghi audit đúng field', () => {
  beforeEach(async () => {
    await resetTuningValue('q_learning_alpha')
    await db.tuningChangeLog.deleteMany({ where: { key: 'q_learning_alpha' } })
    await resetTuningValue('anomaly_iqr_k')
    await db.tuningChangeLog.deleteMany({ where: { key: 'anomaly_iqr_k' } })
  })

  test('set lần đầu: fromStoreValue null, toStoreValue giá trị mới, hiệu lực 0.1 → 0.3', async () => {
    await setTuningValue('q_learning_alpha', '0.3')
    const rows = await db.tuningChangeLog.findMany({ where: { key: 'q_learning_alpha' } })
    expect(rows.length).toBe(1)
    const r = rows[0]
    expect(r.action).toBe('set')
    expect(r.fromStoreValue).toBeNull() // chưa từng có override
    expect(r.toStoreValue).toBe('0.3')
    expect(r.fromEffectiveValue).toBe('0.1') // default trước khi đặt
    expect(r.toEffectiveValue).toBe('0.3')
  })

  test('set lần 2: fromStoreValue là giá trị TRƯỚC (chuỗi thay đổi đầy đủ)', async () => {
    await setTuningValue('q_learning_alpha', '0.3')
    await setTuningValue('q_learning_alpha', '0.5')
    const rows = await db.tuningChangeLog.findMany({
      where: { key: 'q_learning_alpha' },
      orderBy: { createdAt: 'asc' },
    })
    expect(rows.length).toBe(2)
    expect(rows[1].fromStoreValue).toBe('0.3')
    expect(rows[1].toStoreValue).toBe('0.5')
    expect(rows[1].fromEffectiveValue).toBe('0.3')
    expect(rows[1].toEffectiveValue).toBe('0.5')
  })

  test('reset: action=reset, toStoreValue null, hiệu lực mới = default', async () => {
    await setTuningValue('q_learning_alpha', '0.3')
    await resetTuningValue('q_learning_alpha')
    const rows = await db.tuningChangeLog.findMany({
      where: { key: 'q_learning_alpha' },
      orderBy: { createdAt: 'asc' },
    })
    expect(rows.length).toBe(2)
    const r = rows[1]
    expect(r.action).toBe('reset')
    expect(r.fromStoreValue).toBe('0.3')
    expect(r.toStoreValue).toBeNull() // override đã bỏ
    expect(r.fromEffectiveValue).toBe('0.3')
    expect(r.toEffectiveValue).toBe('0.1') // rơi về default (alpha không envKey)
  })

  test('validate fail KHÔNG sinh dòng log (set rác / key lạ)', async () => {
    const before = await db.tuningChangeLog.count()
    await setTuningValue('q_learning_alpha', '99').catch(() => undefined) // > max 1
    await setTuningValue('q_learning_alpha', 'abc').catch(() => undefined)
    await setTuningValue('key-ao', '1').catch(() => undefined)
    const after = await db.tuningChangeLog.count()
    expect(after).toBe(before) // không dòng nào sinh ra từ input rác
  })

  test('getTuningChangeLog: mới → cũ, shape transport (createdAt ISO string)', async () => {
    await setTuningValue('q_learning_alpha', '0.2')
    await setTuningValue('anomaly_iqr_k', '2.5')
    const log = await getTuningChangeLog(10)
    expect(log.length).toBeGreaterThanOrEqual(2)
    expect(log[0].key).toBe('anomaly_iqr_k') // phép sau lên đầu
    expect(log[0].action).toBe('set')
    expect(Number.isNaN(Date.parse(log[0].createdAt))).toBe(false) // ISO parse được
    expect(typeof log[0].toEffectiveValue).toBe('string')
    // mọi dòng key đều trỏ về spec có thật (label UI tra được)
    for (const c of log) expect(getTuningSpec(c.key)).toBeDefined()
  })

  test('prune: vượt cap 500 dòng → chỉ giữ 500 mới nhất', async () => {
    // Seed 502 dòng cũ (timestamp tăng dần) + 1 phép set thật = 503 → prune
    // phải cắt về 500, giữ lại dòng MỚI NHẤT (phép set thật ở cuối).
    const base = Date.now() - 1000 * 60 * 60 // 1 giờ trước
    const seed = Array.from({ length: 502 }, (_, i) => ({
      key: 'anomaly_iqr_k',
      action: 'set',
      fromStoreValue: null,
      toStoreValue: '1.5',
      fromEffectiveValue: '1.5',
      toEffectiveValue: '1.5',
      createdAt: new Date(base + i * 1000),
    }))
    await db.tuningChangeLog.createMany({ data: seed })
    await setTuningValue('anomaly_iqr_k', '2.5')
    const count = await db.tuningChangeLog.count()
    expect(count).toBe(TUNING_CHANGE_LOG_CAP) // 503 → prune về đúng 500
    const newest = await db.tuningChangeLog.findFirst({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    expect(newest?.toStoreValue).toBe('2.5') // dòng set thật sống sót (mới nhất)
    const oldest = await db.tuningChangeLog.findFirst({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    expect(oldest?.createdAt.getTime()).toBeGreaterThan(base) // seed cũ nhất đã bị prune
  })

  test('FB-P2-R1-02 regression: prune chốt cap TUYỆT ĐỐI khi hàng trăm dòng CÙNG millisecond', async () => {
    // Trước-fix: deleteMany theo createdAt < boundary → mọi dòng tie cùng ms
    // boundary sống sót → cap vượt (auditor tái lập 601 > 500). Sau-fix:
    // excess lấy theo (createdAt desc, id desc) skip CAP → xoá đúng số dư.
    const sameTs = new Date(Date.now() - 60_000)
    const seed = Array.from({ length: 600 }, () => ({
      key: 'anomaly_iqr_k',
      action: 'set',
      fromStoreValue: null,
      toStoreValue: '1.5',
      fromEffectiveValue: '1.5',
      toEffectiveValue: '1.5',
      createdAt: sameTs, // TOÀN BỘ cùng timestamp
    }))
    seed.push({ ...seed[0], createdAt: new Date(Date.now() - 30_000) }) // 601 dòng
    await db.tuningChangeLog.createMany({ data: seed })
    await setTuningValue('anomaly_iqr_k', '2.5') // 602 dòng → prune
    const count = await db.tuningChangeLog.count()
    expect(count).toBe(TUNING_CHANGE_LOG_CAP) // KHÔNG vượt cap nữa
    // Dòng set thật (id autoincrement lớn nhất) phải là dòng đầu danh sách
    const log = await getTuningChangeLog(1)
    expect(log[0].toStoreValue).toBe('2.5')
    expect(log[0].key).toBe('anomaly_iqr_k')
  })

  test('FB-P2-R1-01 regression: set ĐẦU TIÊN sau restart (snapshot trống) ghi đúng fromEffectiveValue', async () => {
    // Giả lập restart process: DB giữ override 0.3 nhưng snapshot in-process
    // chưa từng nạp → trước-fix fromEffectiveValue rơi default '0.1' (auditor
    // tái lập); sau-fix derive từ store-value DB.
    await db.tuningParam.upsert({
      where: { key: 'q_learning_alpha' },
      create: { key: 'q_learning_alpha', value: '0.3' },
      update: { value: '0.3' },
    })
    ;(globalThis as { __tmoTuningSnapshot?: unknown }).__tmoTuningSnapshot = undefined
    await setTuningValue('q_learning_alpha', '0.5')
    const rows = await db.tuningChangeLog.findMany({ where: { key: 'q_learning_alpha' } })
    expect(rows.length).toBe(1)
    expect(rows[0].fromStoreValue).toBe('0.3')
    expect(rows[0].fromEffectiveValue).toBe('0.3') // KHÔNG PHẢI '0.1' default
    expect(rows[0].toEffectiveValue).toBe('0.5')
  })

  test('FB-P2-R1-06b regression: writeChangeLog fail-open — bảng mất vật lý vẫn set thành công', async () => {
    // Lời hứa chủ chốt của M2: lỗi ghi audit KHÔNG làm fail phép set/reset.
    // Giả lập bằng DROP TABLE thật trên DB test (schema tái tạo ngay sau).
    await db.$executeRawUnsafe('DROP TABLE IF EXISTS "TuningChangeLog"')
    try {
      const entry = await setTuningValue('q_learning_gamma', '0.8') // KHÔNG throw
      expect(entry.source).toBe('store')
      expect(getTuningNumber('q_learning_gamma')).toBe(0.8) // store vẫn ghi + hiệu lực
      expect(await getTuningChangeLog(10)).toEqual([]) // đọc fail-open → []
      const resetEntry = await resetTuningValue('q_learning_gamma') // reset cũng không throw
      expect(resetEntry.source).not.toBe('store')
    } finally {
      // Tái tạo bảng (mirror prisma/schema.prisma — FB-P2-R1-02 autoincrement)
      await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "TuningChangeLog" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "key" TEXT NOT NULL,
        "action" TEXT NOT NULL,
        "fromStoreValue" TEXT,
        "toStoreValue" TEXT,
        "fromEffectiveValue" TEXT NOT NULL,
        "toEffectiveValue" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`)
      await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "TuningChangeLog_createdAt_idx" ON "TuningChangeLog"("createdAt")')
      await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "TuningChangeLog_key_createdAt_idx" ON "TuningChangeLog"("key", "createdAt")')
    }
    // Sau khi bảng sống lại: phép set kế tiếp ghi audit bình thường
    await setTuningValue('q_learning_gamma', '0.7')
    const log = await getTuningChangeLog(1)
    expect(log[0].key).toBe('q_learning_gamma')
    expect(log[0].toEffectiveValue).toBe('0.7')
    // FB-BRAIN-P3-R1-09: set 0.7 xong KHÔNG reset — cùng lớp lỗi với
    // q_learning_alpha (R1-05) đã làm gate không tái lập: file nào chạy
    // sau đọc γ=0.7 từ snapshot chia sẻ (bun test = 1 process mọi file).
    await resetTuningValue('q_learning_gamma')
  })

  test('FB-P2-R1-06c regression: getTuningChangeLog tôn trọng take-limit', async () => {
    await setTuningValue('q_learning_alpha', '0.2')
    await setTuningValue('q_learning_alpha', '0.3')
    await setTuningValue('q_learning_alpha', '0.4')
    const total = await db.tuningChangeLog.count({ where: { key: 'q_learning_alpha' } })
    expect(total).toBeGreaterThanOrEqual(3)
    const log = await getTuningChangeLog(2)
    expect(log.length).toBe(2) // đúng take — không tràn
    expect(log[0].toEffectiveValue).toBe('0.4') // mới nhất trước
    expect(log[1].toEffectiveValue).toBe('0.3')
    // FB-BRAIN-P3-R1-05: set 0.4 xong KHÔNG reset → bun test chạy MỌI file
    // cùng 1 process (thứ tự file tùy ý — đo thật: B,C,A) → file nào chạy
    // sau đọc α=0.4 từ snapshot chia sẻ → r79 updateQ ra Q=0.4 thay vì 0.1
    // (gate không tái lập được trên fresh clone — chính là 5 fail P3 để lại).
    // Reset về default sau khi assert xong.
    await resetTuningValue('q_learning_alpha')
  })
})

describe('r83 · API — changeLog trong response GET/POST', () => {
  beforeEach(async () => {
    await resetTuningValue('anomaly_iqr_k')
  })

  test('GET trả changeLog là mảng (shape transport)', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(Array.isArray(json.changeLog)).toBe(true)
    for (const c of json.changeLog ?? []) {
      expect(['set', 'reset']).toContain(c.action)
      expect(typeof c.createdAt).toBe('string')
    }
  })

  test('POST set → changeLog[0] là phép vừa thực hiện; reset → dòng reset mới nhất', async () => {
    const setRes = await POST(new Request('http://t/api/neural-architecture', {
      method: 'POST',
      body: JSON.stringify({ action: 'set', key: 'anomaly_iqr_k', value: '2.5' }),
    }))
    expect(setRes.status).toBe(200)
    const setJson = await setRes.json()
    expect(setJson.changeLog[0].key).toBe('anomaly_iqr_k')
    expect(setJson.changeLog[0].action).toBe('set')
    expect(setJson.changeLog[0].toStoreValue).toBe('2.5')

    const resetRes = await POST(new Request('http://t/api/neural-architecture', {
      method: 'POST',
      body: JSON.stringify({ action: 'reset', key: 'anomaly_iqr_k' }),
    }))
    expect(resetRes.status).toBe(200)
    const resetJson = await resetRes.json()
    expect(resetJson.changeLog[0].action).toBe('reset')
    expect(resetJson.changeLog[0].key).toBe('anomaly_iqr_k')
    expect(resetJson.changeLog[0].toStoreValue).toBeNull()
  })
})

// ==================== 2. REDUCED-MOTION GATE (P2-M1) ====================

describe('r83 · edgeDotVisible — gate hạt animateMotion theo reduced-motion', () => {
  test('reduced=true: TẤT CẢ kind tắt hạt (data/reward có dot cũng tắt)', () => {
    for (const kind of ['data', 'reward']) {
      const k = edgeVisual(kind, false)
      expect(edgeDotVisible(k.dot, true)).toBe(false)
      const kActive = edgeVisual(kind, true) // trạng thái active cũng phải tắt
      expect(edgeDotVisible(kActive.dot, true)).toBe(false)
    }
  })

  test('reduced=false: data/reward có hạt; feedback/read không bao giờ có', () => {
    expect(edgeDotVisible(edgeVisual('data', false).dot, false)).toBe(true)
    expect(edgeDotVisible(edgeVisual('reward', false).dot, false)).toBe(true)
    expect(edgeDotVisible(edgeVisual('data', true).dot, false)).toBe(true) // active dot to hơn
    expect(edgeDotVisible(edgeVisual('feedback', false).dot, false)).toBe(false)
    expect(edgeDotVisible(edgeVisual('read', false).dot, false)).toBe(false)
  })

  test('kind lạ rơi về read (fallback) → không hạt', () => {
    expect(edgeDotVisible(edgeVisual('khong-co', false).dot, false)).toBe(false)
  })
})

// ==================== 3. BREAKPOINT (P2-M3) ====================

describe('r83 · NEURAL_DESKTOP_BREAKPOINT — media query JS khớp cột lg', () => {
  test('breakpoint = 1024 (lg Tailwind — cột inspector `hidden lg:block`)', () => {
    expect(NEURAL_DESKTOP_BREAKPOINT).toBe(1024)
  })

  test('cap audit = 500 dòng (hằng số hiển thị UI đồng bộ store)', () => {
    expect(TUNING_CHANGE_LOG_CAP).toBe(500)
  })
})
