/**
 * r144 — KPI #2 INTERACTIVE-TX STATS (trả nợ BLUEPRINT-R17BC §6 — 2026-10-21)
 * =====================================================================================
 * KPI #2: "Interactive tx p95 (ledger + trace) < 2s" — baseline 5s expired bị
 * kéo 15s (ledger writeOne, OBS-1). W1 batcher đã gánh 4 nhóm write; 2 interactive
 * tx còn lại (ledger.writeOne cấp seq + trace.writeOne) cần ĐO p95 trên run thật
 * để nghiệm thu (nguyên tắc §3.7 — chỉ công nhận khi có run thật đầy đủ).
 *
 * Instrument: tx-stats.ts (histogram in-memory ring 512/label trên globalThis)
 * + ops route /api/observation/interactive-tx + snapshot kind kpi.tx mỗi 1000
 * write (drain ledger) cho tích lũy dài hạn sống sót restart.
 *
 *   A. percentileFromSorted THUẦN — nearest-rank đủ biên (rỗng/1 phần tử/p0-p100).
 *   B. noteInteractiveTxMs + getInteractiveTxStats — count/total/max/avg/p50/p95,
 *      ring cap 512, guard NaN/âm, reset sạch.
 *   C. Source-scan wiring — ledger + trace gọi noteInteractiveTxMs; kinds có
 *      kpi.tx; ops route tồn tại read-only.
 * Tiền lệ: r132-r143 (helper thuần + source-scan).
 */

import { test, expect, describe, beforeEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  noteInteractiveTxMs,
  getInteractiveTxStats,
  resetInteractiveTxStats,
  percentileFromSorted,
  TX_STATS_RING_MAX,
} from '@/lib/observation/tx-stats'

const TMO = join(import.meta.dir, '..')
const read = (p: string) => readFileSync(join(TMO, p), 'utf-8')

describe('r144 — KPI #2 interactive-tx stats', () => {
  beforeEach(() => {
    resetInteractiveTxStats()
  })

  describe('A. percentileFromSorted (thuần — nearest-rank)', () => {
    test('A1: mảng rỗng → 0 (không throw)', () => {
      expect(percentileFromSorted([], 95)).toBe(0)
    })

    test('A2: 1 phần tử → chính nó ở mọi p', () => {
      expect(percentileFromSorted([42], 0)).toBe(42)
      expect(percentileFromSorted([42], 50)).toBe(42)
      expect(percentileFromSorted([42], 100)).toBe(42)
    })

    test('A3: 1..100 — p95 = 95, p50 = 50, p99 = 99 (nearest-rank chuẩn)', () => {
      const sorted = Array.from({ length: 100 }, (_, i) => i + 1)
      expect(percentileFromSorted(sorted, 95)).toBe(95)
      expect(percentileFromSorted(sorted, 50)).toBe(50)
      expect(percentileFromSorted(sorted, 99)).toBe(99)
    })

    test('A4: p ngoài [0,100] bị kẹp (âm → min, 150 → max)', () => {
      const sorted = [10, 20, 30, 40, 50]
      expect(percentileFromSorted(sorted, -5)).toBe(10)
      expect(percentileFromSorted(sorted, 150)).toBe(50)
    })

    test('A5: p95 đúng nghĩa "95% mẫu ≤ giá trị" trên phân bố lệch thật', () => {
      // 94 mẫu 5ms + 6 mẫu 500ms (đuôi stall) — rank p95 = ceil(0.95×100) = 95
      // → vị trí 95 là mẫu 500 ĐẦU TIÊN của đuôi (94 fives chiếm vị trí 1-94)
      const sorted = [...Array(94).fill(5), ...Array(6).fill(500)]
      expect(percentileFromSorted(sorted, 95)).toBe(500)
      expect(percentileFromSorted(sorted, 94)).toBe(5)
    })
  })

  describe('B. noteInteractiveTxMs + getInteractiveTxStats (hành vi)', () => {
    test('B1: 0 mẫu → labels rỗng (trung thực — không giả số)', () => {
      const snap = getInteractiveTxStats()
      expect(snap.labels).toEqual([])
      expect(['api', 'worker']).toContain(snap.processRole)
    })

    test('B2: count/total/max/avg + p50/p95 đúng bộ mẫu', () => {
      const samples = [100, 200, 300, 400, 500, 600, 700, 800, 900, 5000]
      for (const s of samples) noteInteractiveTxMs('ledger.writeOne', s)
      const snap = getInteractiveTxStats()
      const ledger = snap.labels.find(l => l.label === 'ledger.writeOne')
      expect(ledger).toBeDefined()
      expect(ledger!.count).toBe(10)
      expect(ledger!.totalMs).toBe(9500)
      expect(ledger!.maxMs).toBe(5000)
      expect(ledger!.avgMs).toBe(950)
      // sorted: [100..900, 5000] — p50 (rank 5) = 500 · p95 (rank 10) = 5000
      expect(ledger!.p50Ms).toBe(500)
      expect(ledger!.p95Ms).toBe(5000)
      expect(ledger!.ringSamples).toBe(10)
    })

    test('B3: nhiều label độc lập + sắp count giảm dần', () => {
      noteInteractiveTxMs('trace.writeOne', 10)
      noteInteractiveTxMs('trace.writeOne', 20)
      noteInteractiveTxMs('ledger.writeOne', 30)
      const snap = getInteractiveTxStats()
      expect(snap.labels.map(l => l.label)).toEqual(['trace.writeOne', 'ledger.writeOne'])
    })

    test('B4: ring cap — vượt TX_STATS_RING_MAX giữ 512 mẫu GẦN ĐÂY, count vẫn đầy', () => {
      const total = TX_STATS_RING_MAX + 10
      for (let i = 1; i <= total; i++) noteInteractiveTxMs('cap.test', i)
      const snap = getInteractiveTxStats()
      const cap = snap.labels.find(l => l.label === 'cap.test')!
      expect(cap.count).toBe(total)           // tổng tích lũy đầy
      expect(cap.ringSamples).toBe(TX_STATS_RING_MAX) // ring giữ gần đây
      // Ring = 11..522 → p50 ≈ 266, p95 ≈ 496 — KHÔNG chứa mẫu 1..10 cũ
      expect(cap.p50Ms).toBeGreaterThan(200)
      expect(cap.p95Ms).toBeLessThan(522)
    })

    test('B5: guard — NaN/âm/label rỗng bị bỏ (không throw, không đếm)', () => {
      noteInteractiveTxMs('guard.test', Number.NaN)
      noteInteractiveTxMs('guard.test', -5)
      noteInteractiveTxMs('', 100)
      noteInteractiveTxMs('guard.test', 50)
      const snap = getInteractiveTxStats()
      const guard = snap.labels.find(l => l.label === 'guard.test')!
      expect(guard.count).toBe(1)
      expect(snap.labels.find(l => l.label === '')).toBeUndefined()
    })
  })

  describe('C. Source-scan wiring (KPI #2 instrumentation)', () => {
    test('C1: ledger.writeOne đo duration (noteInteractiveTxMs + finally bọc vớiSqliteRetry)', () => {
      const src = read('src/lib/observation/ledger.ts')
      expect(src).toContain("noteInteractiveTxMs('ledger.writeOne'")
      expect(src).toMatch(/const txT0 = Date\.now\(\)[\s\S]{0,400}withSqliteRetry/)
    })

    test('C2: trace.writeOne đo duration (cùng pattern)', () => {
      const src = read('src/lib/observation/trace.ts')
      expect(src).toContain("noteInteractiveTxMs('trace.writeOne'")
      expect(src).toMatch(/const txT0 = Date\.now\(\)[\s\S]{0,200}db\.\$transaction/)
    })

    test('C3: kinds.ts có kpi.tx (đăng ký chip) — pin độ dài ở r95/r99/r122', () => {
      const src = read('src/lib/observation/kinds.ts')
      expect(src).toContain("kind: 'kpi.tx'")
    })

    test('C4: ops route /api/observation/interactive-tx tồn tại — READ-ONLY (GET, không POST)', () => {
      const src = read('src/app/api/observation/interactive-tx/route.ts')
      expect(src).toContain('export async function GET()')
      expect(src).toContain('getInteractiveTxStats')
      expect(src).not.toContain('export async function POST')
    })

    test('C5: snapshot kpi.tx phát từ drain ledger (mỗi nhịp prune 1000 write) — fail-open', () => {
      const src = read('src/lib/observation/ledger.ts')
      expect(src).toContain("kind: 'kpi.tx'")
      expect(src).toMatch(/sincePrune >= OBS_PRUNE_EVERY[\s\S]{0,1400}kind: 'kpi\.tx'/)
    })
  })
})
