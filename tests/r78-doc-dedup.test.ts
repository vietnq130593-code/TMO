/**
 * ROUND-78 TESTS — P5-M2 CONTENT-HASH + NEAR-DUP DEDUP KHI RE-UPLOAD
 * (BLUEPRINT-STATS-LEARNING-P0-P6 §P5-M2, mục #17 — DA.pdf §Duplicate Rows)
 *
 * Đo lường:
 *   A. sha256Hex (thuần) — cùng bytes → cùng hash (64 hex); 1 byte khác → hash
 *      khác; buffer rỗng khớp giá trị chuẩn SHA-256 đã biết (đối chiếu độc lập).
 *   B. decideNearDuplicate (thuần — lõi quyết định near-dup): mọi probe top-1
 *      cùng 1 doc ≥ 0.98 → duplicate; 1 probe trống → KHÔNG trùng; probe trỏ
 *      ≥2 doc khác nhau (boilerplate bìa/mục lục) → KHÔNG trùng; hit của chính
 *      doc đang xét bị loại; hit dưới ngưỡng bị loại (phòng thủ chiều sâu);
 *      probes rỗng → no-probe.
 *   C. exactDupResponseStatus (thuần) — mọi file trùng → 409; hỗn hợp → 200;
 *      không trùng → 200. (Hợp đồng HTTP của upload route.)
 *   D. findExactDuplicate (DB) — tìm đúng theo hash; hash lạ → null; Document
 *      bị xóa → hash "hết hiệu lực" (tái tải sau khi xóa = hợp lệ).
 *   E. Đánh dấu duplicate (DB wiring — pipeline contract): status='duplicate'
 *      + duplicateOfId ghi + đọc lại khớp; giải chuỗi 1 mức: doc B
 *      duplicateOf=A → C trùng B sẽ được trỏ về A (đo trực tiếp contract dữ
 *      liệu: B.duplicateOfId đọc được làm gốc giải chuỗi).
 *
 * Đường E2E đầy đủ (upload thật 2 lần cùng bytes → 409; đổi tên → pipeline
 * đánh dấu duplicate + getChunkCount không tăng) nằm ở live probe sau deploy
 * (embed API + Qdrant thật — ngoài scope gate cô lập, đúng tiền lệ r77).
 *
 * DB-cô-lập (bunfig preload copy DB) — beforeAll wipe Document.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { db } from '@/lib/db'
import {
  sha256Hex,
  findExactDuplicate,
  exactDupResponseStatus,
  decideNearDuplicate,
  NEAR_DUP_THRESHOLD,
  NEAR_DUP_PROBE_CHUNKS,
  EXACT_DUP_HTTP_STATUS,
  type ProbeHit,
} from '@/lib/ingestion/doc-dedup'

const createdDocIds: string[] = []

beforeAll(async () => {
  await db.document.deleteMany({})
})

afterAll(async () => {
  // Dọn document test (đề phòng test fail giữa chừng không để rác cho DB test)
  await db.document.deleteMany({})
})

async function createDoc(overrides: Partial<{ id: string; title: string; contentHash: string | null; status: string; duplicateOfId: string | null }> = {}) {
  const id = overrides.id ?? crypto.randomUUID()
  const doc = await db.document.create({
    data: {
      id,
      title: overrides.title ?? `test-${id.slice(0, 8)}.pdf`,
      contentHash: overrides.contentHash ?? null,
      status: overrides.status ?? 'uploaded',
      duplicateOfId: overrides.duplicateOfId ?? null,
    },
  })
  createdDocIds.push(doc.id)
  return doc
}

// ==================== A. sha256Hex (thuần) ====================

describe('A. sha256Hex — fingerprint nội dung (exact-dup layer)', () => {
  test('cùng bytes → cùng hash, định dạng 64 ký tự hex', () => {
    const a = Buffer.from('%PDF-1.7 nôi dung tài liệu mẫu' + 'x'.repeat(100))
    const b = Buffer.from('%PDF-1.7 nôi dung tài liệu mẫu' + 'x'.repeat(100))
    expect(a.equals(b)).toBe(true)
    const ha = sha256Hex(a)
    const hb = sha256Hex(b)
    expect(ha).toBe(hb)
    expect(ha).toMatch(/^[0-9a-f]{64}$/)
  })

  test('1 byte khác → hash khác (PDF tái xuất khác byte)', () => {
    const base = Buffer.from('%PDF-1.7 same content')
    const modified = Buffer.from('%PDF-1.7 same content ')
    expect(sha256Hex(base)).not.toBe(sha256Hex(modified))
  })

  test('buffer rỗng khớp giá trị chuẩn SHA-256 đã biết (đối chiếu độc lập)', () => {
    // Giá trị chuẩn: echo -n "" | sha256sum — kiểm chứng crypto dùng đúng thuật toán
    expect(sha256Hex(Buffer.alloc(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  test('Uint8Array cũng nhận được (interface rộng như khai báo)', () => {
    const u8 = new Uint8Array([1, 2, 3, 4])
    expect(sha256Hex(u8)).toBe(sha256Hex(Buffer.from(u8)))
  })
})

// ==================== B. decideNearDuplicate (thuần) ====================

describe('B. decideNearDuplicate — lõi quyết định near-dup', () => {
  const DOC = 'doc-current-0000'
  const ORIGIN = 'doc-origin-1111'
  const OTHER = 'doc-other-2222'

  test('mọi probe top-1 cùng 1 doc ≥ 0.98 → duplicate + scores', () => {
    const probes: Array<Array<ProbeHit>> = [
      [{ documentId: ORIGIN, score: 0.9931 }],
      [{ documentId: ORIGIN, score: 0.9872 }],
      [{ documentId: ORIGIN, score: 0.9995 }],
    ]
    const d = decideNearDuplicate(DOC, probes)
    expect(d.duplicate).toBe(true)
    expect(d.duplicateOfId).toBe(ORIGIN)
    expect(d.scores).toEqual([0.9931, 0.9872, 0.9995])
  })

  test('1 probe trống (nội dung mới) → KHÔNG trùng', () => {
    const probes: Array<Array<ProbeHit>> = [
      [{ documentId: ORIGIN, score: 0.995 }],
      [{ documentId: ORIGIN, score: 0.99 }],
      [], // probe 3 không khớp gì ≥ 0.98
    ]
    const d = decideNearDuplicate(DOC, probes)
    expect(d.duplicate).toBe(false)
    expect(d.reason).toContain('probe-no-external-hit')
  })

  test('probe trỏ ≥2 doc khác nhau (boilerplate bìa/mục lục) → KHÔNG trùng', () => {
    const probes: Array<Array<ProbeHit>> = [
      [{ documentId: ORIGIN, score: 0.99 }],
      [{ documentId: OTHER, score: 0.985 }],
      [{ documentId: ORIGIN, score: 0.992 }],
    ]
    const d = decideNearDuplicate(DOC, probes)
    expect(d.duplicate).toBe(false)
    expect(d.reason).toContain('probes-trỏ-2-doc-khác-nhau')
  })

  test('hit của chính doc đang xét bị loại (phòng thủ self-match)', () => {
    const probes: Array<Array<ProbeHit>> = [
      [{ documentId: DOC, score: 1.0 }, { documentId: ORIGIN, score: 0.99 }],
      [{ documentId: ORIGIN, score: 0.988 }],
    ]
    const d = decideNearDuplicate(DOC, probes)
    expect(d.duplicate).toBe(true)
    expect(d.duplicateOfId).toBe(ORIGIN)
  })

  test('chỉ hit của chính doc → probe coi như trống → KHÔNG trùng', () => {
    const probes: Array<Array<ProbeHit>> = [
      [{ documentId: DOC, score: 1.0 }],
      [{ documentId: ORIGIN, score: 0.99 }],
    ]
    const d = decideNearDuplicate(DOC, probes)
    expect(d.duplicate).toBe(false)
    expect(d.reason).toContain('probe-no-external-hit')
  })

  test('hit dưới ngưỡng bị loại ngay cả khi đứng top-1 (phòng thủ chiều sâu)', () => {
    // searchSimilar đã lọc score_threshold — nhưng lõi tự kiểm nữa: 0.97 < 0.98
    const probes: Array<Array<ProbeHit>> = [
      [{ documentId: ORIGIN, score: 0.97 }],
      [{ documentId: ORIGIN, score: 0.99 }],
    ]
    const d = decideNearDuplicate(DOC, probes)
    expect(d.duplicate).toBe(false)
    expect(d.reason).toContain('probe-no-external-hit')
  })

  test('hit đúng ngưỡng 0.98 (biên) được nhận', () => {
    const probes: Array<Array<ProbeHit>> = [
      [{ documentId: ORIGIN, score: NEAR_DUP_THRESHOLD }],
    ]
    const d = decideNearDuplicate(DOC, probes)
    expect(d.duplicate).toBe(true)
    expect(d.scores).toEqual([NEAR_DUP_THRESHOLD])
  })

  test('doc < 3 chunk (1-2 probe) vẫn quyết định được — không đòi đủ 3', () => {
    const probes: Array<Array<ProbeHit>> = [
      [{ documentId: ORIGIN, score: 0.991 }],
      [{ documentId: ORIGIN, score: 0.985 }],
    ]
    const d = decideNearDuplicate(DOC, probes)
    expect(d.duplicate).toBe(true)
    expect(d.scores.length).toBe(2)
  })

  test('probes rỗng → no-probe (không crash)', () => {
    const d = decideNearDuplicate(DOC, [])
    expect(d.duplicate).toBe(false)
    expect(d.reason).toBe('no-probe')
  })

  test('hằng số khớp spec §P5-M2: ngưỡng 0.98, 3 probe, HTTP 409', () => {
    expect(NEAR_DUP_THRESHOLD).toBe(0.98)
    expect(NEAR_DUP_PROBE_CHUNKS).toBe(3)
    expect(EXACT_DUP_HTTP_STATUS).toBe(409)
  })
})

// ==================== C. exactDupResponseStatus (thuần — hợp đồng HTTP) ====================

describe('C. exactDupResponseStatus — 409 chỉ khi MỌI file đều trùng', () => {
  test('1 trùng + 0 lưu mới → 409 (kịch bản spec: upload lần 2 cùng bytes)', () => {
    expect(exactDupResponseStatus(1, 0)).toBe(409)
  })

  test('nhiều trùng + 0 lưu mới → 409', () => {
    expect(exactDupResponseStatus(3, 0)).toBe(409)
  })

  test('hỗn hợp (1 trùng + 1 mới) → 200 (per-file info, không chặn cả request)', () => {
    expect(exactDupResponseStatus(1, 1)).toBe(200)
  })

  test('không trùng → 200', () => {
    expect(exactDupResponseStatus(0, 2)).toBe(200)
    expect(exactDupResponseStatus(0, 0)).toBe(200)
  })
})

// ==================== D. findExactDuplicate (DB) ====================

describe('D. findExactDuplicate — tra cứu hash (upload wiring)', () => {
  test('tìm đúng Document theo hash (id + title + status)', async () => {
    const doc = await createDoc({ title: 'goc.pdf', contentHash: 'hash-abc-111', status: 'indexed' })
    const found = await findExactDuplicate('hash-abc-111')
    expect(found).not.toBeNull()
    expect(found!.id).toBe(doc.id)
    expect(found!.title).toBe('goc.pdf')
    expect(found!.status).toBe('indexed')
  })

  test('hash lạ → null (nội dung mới được upload bình thường)', async () => {
    await createDoc({ contentHash: 'hash-exists-222' })
    expect(await findExactDuplicate('hash-khac-hoan-toan')).toBeNull()
  })

  test('Document bị xóa → hash hết hiệu lực (tái tải sau khi xóa là hợp lệ)', async () => {
    const doc = await createDoc({ contentHash: 'hash-deleted-333' })
    expect(await findExactDuplicate('hash-deleted-333')).not.toBeNull()
    await db.document.delete({ where: { id: doc.id } })
    expect(await findExactDuplicate('hash-deleted-333')).toBeNull()
  })

  test('hash rỗng → null ngay (không query vô nghĩa)', async () => {
    expect(await findExactDuplicate('')).toBeNull()
  })
})

// ==================== E. Đánh dấu duplicate (DB wiring — pipeline contract) ====================

describe('E. Đánh dấu duplicate — pipeline contract (status + duplicateOfId)', () => {
  test('ghi status=duplicate + duplicateOfId → đọc lại khớp (như near-dup gate ghi)', async () => {
    const origin = await createDoc({ title: 'tai-lieu-goc.pdf', status: 'indexed' })
    const dup = await createDoc({ title: 'tai-lieu-goc-re-export.pdf' })

    // Pipeline: updateDocProgress(status='duplicate') + db.document.update(duplicateOfId)
    await db.document.update({ where: { id: dup.id }, data: { status: 'duplicate', duplicateOfId: origin.id } })

    const reread = await db.document.findUnique({ where: { id: dup.id } })
    expect(reread!.status).toBe('duplicate')
    expect(reread!.duplicateOfId).toBe(origin.id)
  })

  test('giải chuỗi 1 mức: B duplicateOf=A → C trùng B đọc được gốc A từ dữ liệu', async () => {
    const a = await createDoc({ title: 'goc-cung.pdf', status: 'indexed' })
    const b = await createDoc({ title: 'ban-trung-cua-goc.pdf', status: 'duplicate', duplicateOfId: a.id })
    // detectNearDuplicate khớp B → tra B.duplicateOfId → trỏ C về A. Ở đây đo
    // contract dữ liệu: từ B đọc ra được gốc A (đúng những gì lib đọc để giải chuỗi)
    const bRow = await db.document.findUnique({ where: { id: b.id }, select: { duplicateOfId: true } })
    expect(bRow!.duplicateOfId).toBe(a.id)
    // ...và A tồn tại để trỏ tới
    const aRow = await db.document.findUnique({ where: { id: bRow!.duplicateOfId! }, select: { id: true } })
    expect(aRow!.id).toBe(a.id)
  })

  test('overlay query (badge UI) đọc đủ trường: duplicateOfId có trong select được', async () => {
    // GET list overlay chọn { id, title, status, processingPercent, errorMessage, duplicateOfId }
    const origin = await createDoc({ title: 'ui-origin.pdf' })
    await createDoc({ title: 'ui-dup.pdf', status: 'duplicate', duplicateOfId: origin.id })
    const rows = await db.document.findMany({
      where: { status: 'duplicate' },
      select: { id: true, title: true, status: true, processingPercent: true, errorMessage: true, duplicateOfId: true },
    })
    expect(rows.length).toBeGreaterThan(0)
    const dupRow = rows.find(r => r.title === 'ui-dup.pdf')
    expect(dupRow!.duplicateOfId).toBe(origin.id)
  })
})
