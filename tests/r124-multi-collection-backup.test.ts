/**
 * R124 TESTS — S1 MULTI-COLLECTION QDRANT BACKUP/RESTORE (BLUEPRINT-BACKUP-GATE
 * P1/S1, fix BUG2-304 — backup cũ chỉ snapshot 1/6 collection).
 *
 * Phạm vi regression (pattern r123: nhóm A source-scan + nhóm B unit):
 *   A. Source-scan — cấu trúc multi-collection phải còn nguyên sau mọi lần sửa:
 *      env QDRANT_BACKUP_COLLECTIONS mặc định 5 collection (chunks/documents/
 *      agent_memory/task_context/episodes — KHÔNG communities) · vòng for qua
 *      danh sách · key per-collection backups/qdrant/<collection>/ · legacy
 *      dual-write + fallback CHỈ chunks (quên = giết đường hồi 868 chunks) ·
 *      policy restoreIfEmpty · size guard QDRANT_BACKUP_MAX_POINTS 5000 ·
 *      force param mặc định 0 · GET snapshot-full byCollection + compat fields.
 *   B. Unit — restoreDecision (hàm thuần, 7 case: chunks thay · documents thay ·
 *      memory rỗng thay · memory 5 điểm skip · force=1 thay cả khi 5 điểm ·
 *      episodes 134 skip · task_context 0 thay) · findBackupKey với mock
 *      @/lib/r2-storage (per-collection hit mới nhất · latest pointer · legacy
 *      root fallback CHỈ chunks + không lẫn key 4-segment · miss → null).
 *
 * Không đụng DB thật / Qdrant thật / R2 thật (listR2Objects mock toàn bộ).
 */

import { describe, test, expect, mock } from 'bun:test'
import { readFileSync } from 'node:fs'

const read = (p: string): string => readFileSync(p, 'utf8')

// ==================== MOCK @/lib/r2-storage (điều khiển được) ====================

interface R2ObjLike {
  key: string
  size: number
  lastModified: Date
}

/** prefix → objects (mỗi test gán lại). */
let r2Listing: Record<string, R2ObjLike[]> = {}

mock.module('@/lib/r2-storage', () => ({
  uploadToR2: async () => ({ success: true, key: '' }),
  downloadFromR2: async () => ({ success: true, buffer: Buffer.alloc(0), size: 0 }),
  listR2Objects: async (prefix?: string, _maxKeys?: number) => ({
    success: true,
    objects: (prefix ? r2Listing[prefix] : undefined) ?? [],
  }),
}))

const {
  restoreDecision,
  findBackupKey,
  getBackupCollections,
  getBackupMaxPoints,
} = await import('@/lib/backup/qdrant-snapshot')

// ==================== A. SOURCE-SCAN — cấu trúc multi-collection ====================

describe('R124 A · source-scan — multi-collection backup/restore (qdrant-snapshot.ts + 2 route)', () => {
  const lib = 'src/lib/backup/qdrant-snapshot.ts'

  test('A1: env QDRANT_BACKUP_COLLECTIONS override + mặc định 5 collection (không communities)', () => {
    const src = read(lib)
    expect(src).toContain('QDRANT_BACKUP_COLLECTIONS')
    // Mặc định 5 collection trong getBackupCollections()
    for (const c of ['theopus_chunks', 'theopus_documents', 'agent_memory', 'task_context', 'theopus_episodes']) {
      expect(src).toContain(c)
    }
    // communities KHÔNG được backup (tái sinh bằng refresh-communities — §7-5)
    expect(src).not.toContain("'theopus_communities'")
  })

  test('A2: vòng for qua getBackupCollections() trong backup + skip-graceful không fail batch', () => {
    const src = read(lib)
    expect(src).toMatch(/for\s*\(const collection of collections\)/)
    expect(src).toContain('skip-graceful')
    expect(src).toContain("status: 'error'") // lỗi 1 collection vẫn push result, không throw cả batch
  })

  test('A3: key per-collection backups/qdrant/<collection>/ + latest pointer', () => {
    const src = read(lib)
    expect(src).toContain('function collectionPrefix')
    expect(src).toContain('`${prefix}latest.tar`')
    expect(src).toContain('`${prefix}${ts}.tar`')
  })

  test('A4: legacy dual-write root keys CHỈ theopus_chunks (D0 §7.2 compat)', () => {
    const src = read(lib)
    expect(src).toContain('R2_LATEST_KEY')
    // dual-write chỉ trong nhánh chunks
    expect(src).toMatch(/collection === getChunksCollection\(\)[\s\S]{0,200}R2_LATEST_KEY|R2_LATEST_KEY[\s\S]{0,200}collection === getChunksCollection\(\)/)
  })

  test('A5: policy restoreIfEmpty — nhánh thuần currentPoints === 0', () => {
    const src = read(lib)
    expect(src).toContain("currentPoints === 0 ? 'replace' : 'skip'")
    expect(src).toContain('export function restoreDecision')
  })

  test('A6: size guard QDRANT_BACKUP_MAX_POINTS mặc định 5000 + skip (không fail)', () => {
    const src = read(lib)
    expect(src).toContain('QDRANT_BACKUP_MAX_POINTS')
    expect(src).toContain('5000')
    expect(src).toMatch(/points > maxPoints[\s\S]{0,300}status: 'skipped'/)
  })

  test('A7: findBackupKey có legacy fallback CHỈ chunks + lọc key root 3-segment', () => {
    const src = read(lib)
    expect(src).toContain('export async function findBackupKey')
    // legacy fallback branch
    expect(src).toMatch(/if \(collection === getChunksCollection\(\)\)[\s\S]{0,400}parts\.length !== 3/)
  })

  test('A8: restore-full route — force param mặc định 0 (=== "1")', () => {
    const src = read('src/app/api/storage/restore-full/route.ts')
    expect(src).toContain(`get('force') === '1'`)
    expect(src).toContain('restoreQdrantFromR2(date, { force })')
  })

  test('A9: snapshot-full GET — byCollection + currentQdrantPointsByCollection + giữ compat cũ', () => {
    const src = read('src/app/api/storage/snapshot-full/route.ts')
    expect(src).toContain('byCollection')
    expect(src).toContain('currentQdrantPointsByCollection')
    // compat: trường cũ KHÔNG đổi tên (§8-11)
    expect(src).toContain('currentQdrantPoints:')
    expect(src).toContain('qdrantBackups:')
    // entry có field collection
    expect(src).toContain('entry.collection')
  })

  test('A10: backup script backfill documents 9/9 glob *.TXT (không phải SHD_*)', () => {
    const src = read('scripts/backfill-documents-qdrant.ts')
    // glob đúng: lấy MỌI .TXT (8 SHD + 1 PSY-CORE-SCI-009) — L1 review v0.2.
    // Code KHÔNG được filter theo tiền tố SHD_ (glob đó bắt 8/9 — KPI 9/9 không đạt)
    expect(src).toContain("toUpperCase().endsWith('.TXT')")
    expect(src).not.toMatch(/filter\([^)]*SHD_/)
    // status trong union 9 giá trị — 'indexed' (BUG2-291 pattern)
    expect(src).toContain("status: 'indexed'")
    expect(src).toContain("domain: 'ml'")
    // ID: UUID v5-style deterministic từ slug (Qdrant chỉ nhận UUID/integer —
    // 'doc-shd-<slug>' thô bị 400, bắt live khi backfill lần đầu)
    expect(src).toContain('function deterministicUuid')
  })

  test('A11: getBackupCollections/getBackupMaxPoints hành vi mặc định (env không set)', () => {
    // .env repo chỉ set QDRANT_COLLECTION_* trùng default → danh sách 5 collection
    const list = getBackupCollections()
    expect(list).toContain('theopus_chunks')
    expect(list).toContain('theopus_documents')
    expect(list).toContain('agent_memory')
    expect(list).toContain('task_context')
    expect(list).toContain('theopus_episodes')
    expect(list).not.toContain('theopus_communities')
    expect(getBackupMaxPoints()).toBe(5000)
  })
})

// ==================== B. UNIT — restoreDecision (hàm thuần) ====================

describe('R124 B1 · restoreDecision — policy replace/skip/force', () => {
  test('B1.1: theopus_chunks (tĩnh) — luôn replace dù đang có 868 điểm', () => {
    expect(restoreDecision('theopus_chunks', 868)).toBe('replace')
  })

  test('B1.2: theopus_documents (tĩnh) — luôn replace (9 điểm)', () => {
    expect(restoreDecision('theopus_documents', 9)).toBe('replace')
  })

  test('B1.3: agent_memory đang RỖNG → replace (restoreIfEmpty)', () => {
    expect(restoreDecision('agent_memory', 0)).toBe('replace')
  })

  test('B1.4: agent_memory đang 5 điểm → skip (không bao giờ restore cũ đè data mới)', () => {
    expect(restoreDecision('agent_memory', 5)).toBe('skip')
  })

  test('B1.5: force=1 + agent_memory 5 điểm → replace (disaster-recovery có chủ ý)', () => {
    expect(restoreDecision('agent_memory', 5, true)).toBe('replace')
  })

  test('B1.6: theopus_episodes 134 điểm (lịch sử sống) → skip', () => {
    expect(restoreDecision('theopus_episodes', 134)).toBe('skip')
  })

  test('B1.7: task_context 0 điểm → replace', () => {
    expect(restoreDecision('task_context', 0)).toBe('replace')
  })
})

// ==================== B. UNIT — findBackupKey (mock R2) ====================

describe('R124 B2 · findBackupKey — per-collection + latest + legacy fallback + miss', () => {
  const t = (key: string, iso: string): R2ObjLike => ({
    key,
    size: 100,
    lastModified: new Date(iso),
  })

  test('B2.1: per-collection hit — chọn bản MỚI NHẤT theo lastModified khớp date', async () => {
    r2Listing = {
      'backups/qdrant/agent_memory/': [
        t('backups/qdrant/agent_memory/20261019-120000.tar', '2026-10-19T12:00:00Z'),
        t('backups/qdrant/agent_memory/20261019-130000.tar', '2026-10-19T13:00:00Z'),
        t('backups/qdrant/agent_memory/20261018-090000.tar', '2026-10-18T09:00:00Z'), // khác date
      ],
    }
    expect(await findBackupKey('agent_memory', '20261019')).toBe(
      'backups/qdrant/agent_memory/20261019-130000.tar'
    )
  })

  test('B2.2: date=latest → per-collection latest.tar pointer', async () => {
    r2Listing = {
      'backups/qdrant/agent_memory/': [
        t('backups/qdrant/agent_memory/20261019-130000.tar', '2026-10-19T13:00:00Z'),
        t('backups/qdrant/agent_memory/latest.tar', '2026-10-19T14:00:00Z'),
      ],
    }
    expect(await findBackupKey('agent_memory', 'latest')).toBe(
      'backups/qdrant/agent_memory/latest.tar'
    )
  })

  test('B2.3: chunks date cụ thể — per-collection trống → LEGACY root fallback (tar cũ 18-10)', async () => {
    r2Listing = {
      // root list chứa CẢ per-collection keys — phải bị lọc (chỉ 3-segment)
      'backups/qdrant/': [
        t('backups/qdrant/20260824-101000.tar', '2026-08-24T10:10:00Z'),
        t('backups/qdrant/20261018-135100.tar', '2026-10-18T13:51:00Z'),
        t('backups/qdrant/theopus_documents/20261019-130000.tar', '2026-10-19T13:00:00Z'), // 4-segment — KHÔNG phải root
      ],
    }
    expect(await findBackupKey('theopus_chunks', '20261018')).toBe(
      'backups/qdrant/20261018-135100.tar'
    )
  })

  test('B2.4: chunks latest — per-collection trống → legacy root latest.tar (đường hồi 868 chunks)', async () => {
    r2Listing = {
      'backups/qdrant/': [
        t('backups/qdrant/latest.tar', '2026-10-18T13:51:00Z'),
        t('backups/qdrant/20261018-135100.tar', '2026-10-18T13:51:00Z'),
      ],
    }
    expect(await findBackupKey('theopus_chunks', 'latest')).toBe('backups/qdrant/latest.tar')
  })

  test('B2.5: miss hoàn toàn (documents chưa có key per-collection, không legacy) → null', async () => {
    r2Listing = { 'backups/qdrant/theopus_documents/': [] }
    expect(await findBackupKey('theopus_documents', '20261019')).toBeNull()
    expect(await findBackupKey('theopus_documents', 'latest')).toBeNull()
  })

  test('B2.6: collection KHÔNG phải chunks KHÔNG bao giờ rơi vào legacy root', async () => {
    // root có tar cũ của chunks — episodes miss per-collection phải trả null,
    // không "mượn" tar chunks (sai collection = hỏng data)
    r2Listing = {
      'backups/qdrant/': [t('backups/qdrant/20261018-135100.tar', '2026-10-18T13:51:00Z')],
    }
    expect(await findBackupKey('theopus_episodes', '20261018')).toBeNull()
  })
})
