/**
 * r78-fb7-regression — REGRESSION TEST cho FB-ĐỢT7 vòng R4 (fixbug đợt 7
 * mở rộng theo chỉ thị user "Kích hoạt giao thức Fixbug cho đợt 7"):
 * pin hành vi của TẤT CẢ các fix — 5 fix inline gốc (BUG2-064..068) + các
 * phát hiện R4 (A1-A8, B1-B6, F2, F4 — xem Bug_v2.md BUG2-069+).
 *
 * Nguyên tắc C5 (giao thức fixbug.md): MỖI fix phải kèm ≥ 1 test chứng minh
 * lỗi cũ đã hết — nếu ai revert bất kỳ fix nào, test tương ứng fail ngay.
 *
 * Các nhóm:
 *   A. computeEmbeddingSuccessRate — pin 4 đường đo (BUG2-064 skip → null;
 *      BUG2-065 resume-partial tử số; fresh; alias needing=0 kẹp 1)
 *   B. savedVectorCount — F2: chỉ đếm batch ghi Qdrant thành công
 *   C. hasEnoughValidProbes — A5: provider hỏng 2/3 probe → KHÔNG kết luận
 *      trùng (fail-open); 1-chunk doc vẫn quyết được
 *   D. resolveEntities duplicates KHÔNG nhân đôi — B2 (mỗi merge 1 entry)
 *   E. isQdrantScrollExhausted — BUG2-068: null VÀ undefined đều dừng
 *   F. resolveCopySourceUrl + copySqliteFiles + DB_COPY_SUFFIXES — BUG2-066
 *      (không copy -shm) + BUG2-067 (env ngoài project → .env project) + F4
 *      (đường tuyệt đối chứa ".." không lọt kiểm "trong project")
 *   G. evaluateExpectations — A4 (entity_rate=0 đo được → warn "miss") +
 *      A3 (zero_vector_rate > 0.01 đo được → fail)
 *   H. pcaTop2 — B1 (dữ liệu đối xứng hoán-trục: component1 phải là trục
 *      TRỘI, không kẹt ở trục phụ) + B3 (đường implicit 2n<d cho cùng kết quả
 *      phương sai với eigen đóng dạng)
 */

import { describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  computeEmbeddingSuccessRate,
  savedVectorCount,
  evaluateExpectations,
} from '@/lib/ingestion/pipeline-expectations'
import { hasEnoughValidProbes, NEAR_DUP_MIN_PROBES } from '@/lib/ingestion/doc-dedup'
import { resolveEntities, type ExtractedEntity } from '@/lib/ingestion/entity-resolver'
import { isQdrantScrollExhausted } from '@/lib/qdrant'
import { pcaTop2 } from '@/lib/stats/pca'
import {
  resolveCopySourceUrl,
  copySqliteFiles,
  DB_COPY_SUFFIXES,
} from './db-isolation-preload'

// ==================== A. computeEmbeddingSuccessRate (BUG2-064/065) ====================

describe('A. computeEmbeddingSuccessRate — pin 4 đường đo embedding_success_rate', () => {
  test('BUG2-064: đường SKIP-embeddings (resume đã đủ vector) → KHÔNG đo (null)', () => {
    // Bản cũ đo 0/33 = 0 → FAIL giả → doc kẹt 'partial' vĩnh viễn mỗi lần reprocess
    expect(computeEmbeddingSuccessRate({
      embeddingsStepRan: false,
      chunkCount: 33,
      realVectorsBefore: 33,
      vectorsSaved: 0,
    })).toBeNull()
  })

  test('đường FRESH: (0 + n)/n = 1', () => {
    expect(computeEmbeddingSuccessRate({
      embeddingsStepRan: true,
      chunkCount: 33,
      realVectorsBefore: 0,
      vectorsSaved: 33,
    })).toBe(1)
  })

  test('BUG2-065: đường RESUME-PARTIAL (30/33 thật + 3 mới) → (30+3)/33 = 1, không phải 3/33', () => {
    // Bản cũ tử số chỉ đếm mới-lưu-run-này → 3/33 = 0.0909 < 0.999 → FAIL giả
    expect(computeEmbeddingSuccessRate({
      embeddingsStepRan: true,
      chunkCount: 33,
      realVectorsBefore: 30,
      vectorsSaved: 3,
    })).toBe(1)
  })

  test('ALIAS needing=0 (embeddingsSavedCount = realVectorCount) → 2n/n kẹp min(1,·)', () => {
    expect(computeEmbeddingSuccessRate({
      embeddingsStepRan: true,
      chunkCount: 33,
      realVectorsBefore: 33,
      vectorsSaved: 33, // alias từ nhánh needing===0 của route
    })).toBe(1)
  })

  test('provider hỏng thật 1/33 → 32/33 < 0.999 → FAIL đúng nghĩa (không phải giả)', () => {
    expect(computeEmbeddingSuccessRate({
      embeddingsStepRan: true,
      chunkCount: 33,
      realVectorsBefore: 0,
      vectorsSaved: 32,
    })).toBeCloseTo(32 / 33, 12)
  })

  test('chunkCount = 0 → null (không chia 0)', () => {
    expect(computeEmbeddingSuccessRate({
      embeddingsStepRan: true,
      chunkCount: 0,
      realVectorsBefore: 0,
      vectorsSaved: 0,
    })).toBeNull()
  })
})

// ==================== B. savedVectorCount (F2) ====================

describe('B. savedVectorCount — chỉ đếm vector GHI thành công', () => {
  test('updateOk=true → đếm đủ batch', () => {
    expect(savedVectorCount(true, 33)).toBe(33)
  })

  test('F2: updateOk=false (Qdrant lỗi) → 0 — bản cũ PASS giả 1.0 đúng lúc mass-fail', () => {
    expect(savedVectorCount(false, 33)).toBe(0)
  })
})

// ==================== C. hasEnoughValidProbes (A5) ====================

describe('C. hasEnoughValidProbes — corroborated probe tối thiểu', () => {
  test('A5: 3 thử / 1 sống (provider hỏng 1 phần) → KHÔNG đủ — fail-open', () => {
    expect(hasEnoughValidProbes(1, 3)).toBe(false)
  })

  test('2 thử / 1 sống → KHÔNG đủ', () => {
    expect(hasEnoughValidProbes(1, 2)).toBe(false)
  })

  test('3/3 và 3/2 sống → đủ (≥2 corroborated)', () => {
    expect(hasEnoughValidProbes(3, 3)).toBe(true)
    expect(hasEnoughValidProbes(2, 3)).toBe(true)
  })

  test('doc 1-chunk: 1/1 sống → đủ (probe là toàn bộ nội dung doc)', () => {
    expect(hasEnoughValidProbes(1, 1)).toBe(true)
  })

  test('0 sống / 0 thử → không đủ', () => {
    expect(hasEnoughValidProbes(0, 3)).toBe(false)
    expect(hasEnoughValidProbes(0, 0)).toBe(false)
  })

  test('hằng số min-probe = 2 (nguồn: FB-Đợt7-R4 A5)', () => {
    expect(NEAR_DUP_MIN_PROBES).toBe(2)
  })
})

// ==================== D. resolveEntities duplicates không nhân đôi (B2) ====================

describe('D. resolveEntities — mỗi merge đúng 1 entry duplicates (B2)', () => {
  const mk = (name: string, type: string, description = ''): ExtractedEntity => ({
    name, type, description, confidence: 0.9, domain: 'programming',
    properties: {}, sourceChunkIndexes: [0],
  } as unknown as ExtractedEntity)

  test('2 exact-dup + 1 fuzzy-dup → duplicates.length = 3 (bản cũ = 6, nhân đôi)', () => {
    // Exact (khác hoa/thường): "React JS"/"react js" + "Docker"/"docker";
    // fuzzy (cùng type, Levenshtein 0.94 > 0.85): "Machine Learning" vs
    // "Machine Learningz" (dist 1 / maxLen 17)
    const entities = [
      mk('React JS', 'Technology'),
      mk('react js', 'Technology'),
      mk('Machine Learning', 'Technology'),
      mk('Machine Learningz', 'Technology'),
      mk('Docker', 'Technology'),
      mk('docker', 'Technology'),
    ]
    const result = resolveEntities(entities)
    expect(result.duplicates.length).toBe(3)
    // Mỗi cặp (merged, into) xuất hiện đúng 1 lần — không entry lặp
    const keys = result.duplicates.map(d => `${d.merged}→${d.into}`)
    expect(new Set(keys).size).toBe(keys.length)
    // 2 exact + 1 fuzzy đúng loại
    expect(result.duplicates.filter(d => d.method === 'exact').length).toBe(2)
    expect(result.duplicates.filter(d => d.method === 'fuzzy').length).toBe(1)
  })

  test('không merge → duplicates rỗng (0 entry, không âm/dương tính sai)', () => {
    const result = resolveEntities([mk('Docker', 'Technology'), mk('Kubernetes', 'Technology')])
    expect(result.duplicates.length).toBe(0)
  })
})

// ==================== E. isQdrantScrollExhausted (BUG2-068) ====================

describe('E. isQdrantScrollExhausted — dừng scroll đúng mọi dạng "hết"', () => {
  test('BUG2-068: null (Qdrant thực tế trả khi hết) → dừng — bản cũ chỉ hiểu undefined', () => {
    expect(isQdrantScrollExhausted(null)).toBe(true)
  })

  test('undefined → dừng', () => {
    expect(isQdrantScrollExhausted(undefined)).toBe(true)
  })

  test('offset còn (string/number) → CHƯA hết, cuộn tiếp', () => {
    expect(isQdrantScrollExhausted('abc-offset')).toBe(false)
    expect(isQdrantScrollExhausted(42)).toBe(false)
    expect(isQdrantScrollExhausted(0)).toBe(false)
  })
})

// ==================== F. db-isolation-preload (BUG2-066/067 + F4) ====================

describe('F. db-isolation-preload — copy nguồn đúng, không -shm, không DB ngoại lai', () => {
  // R5 (P4 #1): dọn cây /tmp giả lập sau mỗi test — bản đầu rò 10 thư mục
  // fb7-preload-*/lần chạy (sweepOrphanDirs của preload chỉ quét tmo-test-db-*)
  const fakeProjects: string[] = []

  /** Dựng cây thư mục giả lập project: root/prisma/schema.prisma + .env + db */
  const buildFakeProject = (): { root: string; outside: string; projectDb: string; outsideDb: string } => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fb7-preload-'))
    fakeProjects.push(base)
    const root = path.join(base, 'proj')
    const outside = path.join(base, 'outside')
    fs.mkdirSync(path.join(root, 'prisma'), { recursive: true })
    fs.mkdirSync(path.join(root, 'db'), { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(root, 'prisma', 'schema.prisma'), 'model X { id String @id }')
    const projectDb = path.join(root, 'db', 'custom.db')
    const outsideDb = path.join(outside, 'custom.db')
    fs.writeFileSync(projectDb, 'project-db-bytes')
    fs.writeFileSync(outsideDb, 'outside-db-bytes')
    fs.writeFileSync(path.join(root, '.env'), 'DATABASE_URL=file:../db/custom.db\n')
    return { root, outside, projectDb, outsideDb }
  }

  // Dọn rác sau MỖI test (kể cả fail) — không để lại thư mục mồ côi
  const _cleanup = () => { for (const base of fakeProjects.splice(0)) fs.rmSync(base, { recursive: true, force: true }) }

  test('BUG2-067: env trỏ DB NGOÀI project (leak scaffold) → .env của project là nguồn sự thật', () => {
    try {
      const { root, projectDb, outsideDb } = buildFakeProject()
      // .env khai tương đối prisma/-schema-relative: file:../db/custom.db → root/db/custom.db
      const resolved = resolveCopySourceUrl(`file:${outsideDb}`, root)
      expect(resolved).toBe(`file:${projectDb}`)
    } finally {
      _cleanup()
    }
  })

  test('env trỏ file TRONG project → giữ nguyên (ý định gate: db/.quality-gate-test.db)', () => {
    try {
      const { root, projectDb } = buildFakeProject()
      const resolved = resolveCopySourceUrl(`file:${projectDb}`, root)
      expect(resolved).toBe(`file:${projectDb}`)
    } finally {
      _cleanup()
    }
  })

  test('F4: env đường TUYỆT ĐỐI chứa ".." thoát ra ngoài → không lọt kiểm "trong project"', () => {
    try {
      const { root, projectDb, outsideDb } = buildFakeProject()
      // file:/…/proj/../outside/custom.db — resolve thật trỏ ra NGOÀI root
      const sneaky = `file:${root}/../outside/custom.db`
      const resolved = resolveCopySourceUrl(sneaky, root)
      // Không được trả về bản outside (bản cũ startsWith nguyên văn → lọt)
      expect(resolved).not.toBe(`file:${outsideDb}`)
      expect(resolved).toBe(`file:${projectDb}`)
    } finally {
      _cleanup()
    }
  })

  test('env rỗng + .env hợp lệ → dùng .env (không bỏ copy)', () => {
    try {
      const { root, projectDb } = buildFakeProject()
      expect(resolveCopySourceUrl('', root)).toBe(`file:${projectDb}`)
    } finally {
      _cleanup()
    }
  })

  test('BUG2-066: DB_COPY_SUFFIXES KHÔNG chứa -shm', () => {
    expect(DB_COPY_SUFFIXES).not.toContain('-shm')
    expect(DB_COPY_SUFFIXES).toContain('')
    expect(DB_COPY_SUFFIXES).toContain('-wal')
  })

  test('BUG2-066: copySqliteFiles copy db + -wal, KHÔNG copy -shm', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fb7-copy-'))
    const src = path.join(base, 'src.db')
    const dest = path.join(base, 'dest.db')
    fs.writeFileSync(src, 'main')
    fs.writeFileSync(`${src}-wal`, 'wal')
    fs.writeFileSync(`${src}-shm`, 'shm-live-index')
    copySqliteFiles(src, dest)
    expect(fs.existsSync(dest)).toBe(true)
    expect(fs.existsSync(`${dest}-wal`)).toBe(true)
    expect(fs.existsSync(`${dest}-shm`)).toBe(false) // revert BUG2-066 → fail tại đây
    fs.rmSync(base, { recursive: true, force: true })
  })
})

// ==================== G. evaluateExpectations (A3 + A4) ====================

describe('G. evaluateExpectations — entity_rate=0 và zero_vector_rate đo được', () => {
  test('A4: entity_rate = 0 (extract miss hoàn toàn) → ĐO được + vi phạm warn', () => {
    const results = evaluateExpectations({ entity_rate: 0 })
    const er = results.find(r => r.id === 'entity_rate')!
    expect(er.evaluated).toBe(true)
    expect(er.passed).toBe(false)
    expect(er.severity).toBe('warn')
  })

  test('A3: zero_vector_rate = 0.03 (3% chunk zero) → ĐO được + vi phạm fail', () => {
    const results = evaluateExpectations({ zero_vector_rate: 0.03 })
    const zr = results.find(r => r.id === 'zero_vector_rate')!
    expect(zr.evaluated).toBe(true)
    expect(zr.passed).toBe(false)
    expect(zr.severity).toBe('fail')
  })

  test('biên giữ nguyên: zero_vector_rate = 0.01 → VI PHẠM (lt NGẶT theo spec); 0.0099 → pass', () => {
    // Sai-kỳ-vọng người-rà lần 12 (FB-Đợt7-R4): lần đầu viết ngược — spec
    // "zero_vector_rate < 0.01" là so sánh NGẶT: 0.01 KHÔNG < 0.01 → vi phạm.
    expect(evaluateExpectations({ zero_vector_rate: 0.01 }).find(r => r.id === 'zero_vector_rate')!.passed).toBe(false)
    expect(evaluateExpectations({ zero_vector_rate: 0.0099 }).find(r => r.id === 'zero_vector_rate')!.passed).toBe(true)
  })
})

// ==================== H. pcaTop2 (B1 + B3) ====================

describe('H. pcaTop2 — thoát thế kẹt trục phụ + đường implicit', () => {
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0)

  test('B1: dữ liệu đối xứng hoán-trục (diag ∝ trục PHỤ) → component1 là trục TRỘI', () => {
    // Cụm y=-x trội (6 điểm spread lớn) + cụm y=x phụ (2 điểm) — var_x = var_y
    // bit-perfect → diag(C) ∝ (1,1) = vector riêng PHỤ: bản cũ kẹt ở đó mãi,
    // trả component1 = trục phụ (var 0.056) + component2 = 0, không null.
    const pts: number[][] = [
      [3, -3], [2, -2], [1, -1], [-1, 1], [-2, 2], [-3, 3],
      [1, 1], [1.1, 1.1],
    ]
    const pca = pcaTop2(pts)!
    expect(pca).not.toBeNull()
    const n1 = Math.SQRT1_2
    const cosMajor = Math.abs(pca.component1[0] * n1 - pca.component1[1] * n1) // |cos| với (1,-1)/√2
    const cosMinor = Math.abs(pca.component1[0] * n1 + pca.component1[1] * n1) // |cos| với (1,1)/√2
    expect(cosMajor).toBeGreaterThan(0.99) // component1 PHẢI là trục trội y=-x
    expect(cosMinor).toBeLessThan(0.01)    // không phải trục phụ nữa
    // Tính tay eigen 2x2: λ1/trace = 0.9441, λ2/trace = 0.0559 (script độc lập)
    expect(pca.explainedVariances[0]).toBeCloseTo(0.9441, 3)
    expect(pca.explainedVariances[1]).toBeCloseTo(0.0559, 3)
    expect(pca.component2.some(x => Math.abs(x) > 0.99 * n1)).toBe(true) // trục phụ sống lại
  })

  test('B3: đường implicit (2n < d) cho cùng phương sai với eigen đóng dạng', () => {
    // 5 điểm trong không gian 11 chiều (2n=10 < d=11 → implicit). Hệ số b chọn
    // CÂN BẰNG với a (cov(a_dev, b_dev) = 2.6·0.1 − 2.4·0.1 + 0.1·(−0.2) = 0)
    // để (u1, u2) là đúng 2 trục chính — nếu không, eigen 2x2 có số hạng
    // chéo và kì vọng tay sai (sai-kỳ-vọng người-rà lần 13: quên cov).
    const d = 11
    const u1 = Array.from({ length: d }, (_, j) => (j === 0 ? 1 : 0))
    const u2 = Array.from({ length: d }, (_, j) => (j === 1 ? 1 : 0))
    const aCoeffs = [3, -2, 1.5, -1, 0.5]
    const bCoeffs = [0.1, 0.1, 0, 0, -0.2]
    const pts = aCoeffs.map((a, i) => Array.from({ length: d }, (_, j) => a * u1[j] + bCoeffs[i] * u2[j]))
    const pca = pcaTop2(pts)!
    expect(pca).not.toBeNull()
    // Tính tay: var(a)=3.925, var(b)=0.015, cov=0 (theo thiết kế) → 2 eigen độc lập
    const am = aCoeffs.reduce((s, v) => s + v, 0) / 5
    const varA = aCoeffs.reduce((s, v) => s + (v - am) ** 2, 0) / 4
    const bm = bCoeffs.reduce((s, v) => s + v, 0) / 5
    const varB = bCoeffs.reduce((s, v) => s + (v - bm) ** 2, 0) / 4
    const total = varA + varB // các chiều còn lại variance 0
    expect(pca.explainedVariances[0]).toBeCloseTo(varA / total, 6)
    expect(pca.explainedVariances[1]).toBeCloseTo(varB / total, 6)
    expect(Math.abs(dot(pca.component1, u1))).toBeGreaterThan(0.999)
    expect(Math.abs(dot(pca.component2, u2))).toBeGreaterThan(0.999)
  })

  test('component2 trực giao component1 (cả 2 chiến lược)', () => {
    const pts: number[][] = [
      [2, 1, 0], [1, 2, 0], [-1, -2, 0.5], [-2, -1, -0.5], [0.5, 0.5, 1],
    ]
    const pca = pcaTop2(pts)!
    expect(Math.abs(dot(pca.component1, pca.component2))).toBeLessThan(1e-6)
  })
})

// ==================== I. hygiene — script benchmark dùng helper chung ====================

describe('I. hygiene — script benchmark bundle được (import resolve + cú pháp)', () => {
  test('matryoshka-benchmark.ts bundle OK (không thực thi — bun build chỉ resolve)', () => {
    // Script chạy main() khi import (không import trực tiếp được) — bun build
    // chỉ resolve + transpile graph import (không chạy), exit khác 0 = lỗi.
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb7-bench-build-'))
    try {
      const out = execSync(
        `bun build ${path.join(import.meta.dir, '..', 'scripts', 'matryoshka-benchmark.ts')} --outdir ${outDir}`,
        { stdio: 'pipe' }
      )
      expect(out.length).toBeGreaterThan(0)
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true })
    }
  })
})
