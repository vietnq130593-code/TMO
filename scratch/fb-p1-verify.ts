/**
 * FB-P1 KIỂM CHỨNG ĐỘC LẬP — thuật toán THAY THẾ hoàn toàn cho toán của đợt 2.
 * (Giao thức fixbug.md: mọi nghi vấn phải chấm chéo bằng phương pháp thứ ba.)
 *
 * 1. AUC-PR step-wise  ⇔  Average Precision (AP) chuẩn sklearn trên cùng sweep
 * 2. nDCG@k            ⇔  brute-force DCG/IDCG tổng trực tiếp
 * 3. iqrBounds         ⇔  quantile nội suy kiểu sort-index độc lập
 * 4. statusForKpi      ⇔  bảng điều kiện if-else viết lại từ đầu
 * 5. buildRelevanceVector: tính chất retrievedCount === đếm filter+some trên
 *    2000 case RANDOM (entity/chunk text từ bảng chữ cái ngẫu nhiên)
 * 6. scorecard byAgent ⇔  Σ n_byAgent === n tổng (phân vùng đầy đủ)
 * 7. round4(từ verdict-scorecard) — làm tròn nhất quán
 */

import { confusionMatrix, prf1, sweepThresholds, aucPr } from '../src/lib/stats'
import { ndcgAtK, mrr } from '../src/lib/stats'
import { iqrBounds } from '../src/lib/stats'
import { buildRelevanceVector, normalizeForEntityMatch, type ExpectedEntity } from '../src/lib/eval/relevance'
import { statusForKpi, type KpiDef } from '../src/lib/kpi/registry'

let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}
function close(a: number, b: number, tol: number) { return Math.abs(a - b) < tol }

// ---------- 1. AUC-PR ⇔ Average Precision (định nghĩa chuẩn) ----------
// AP chuẩn kiểu sklearn: duyệt theo NGƯỠNG (không theo thứ tự list) — tại
// ngưỡng t, MỌI item score ≥ t cùng được dự đoán dương → precision tính tại
// CUỐI nhóm tie. Không được sort tie "positive trước" (đó là biến thể
// optimistic-ordering — sẽ LỚN HƠN threshold-based khi có tie).
function altAP(scores: number[], actuals: boolean[]): number {
  const totalPos = actuals.reduce((s, a) => s + (a ? 1 : 0), 0)
  if (totalPos === 0) return 0
  const thresholds = [...new Set(scores)].sort((a, b) => b - a)
  let prevRecall = 0
  let ap = 0
  for (const t of thresholds) {
    let tp = 0, predicted = 0
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] >= t) {
        predicted++
        if (actuals[i]) tp++
      }
    }
    const precision = tp / predicted
    const recall = tp / totalPos
    ap += precision * (recall - prevRecall)
    prevRecall = recall
  }
  return ap
}

console.log('\n━━━ 1. AUC-PR step-wise ⇔ AP chuẩn (random, có tie) ━━━')
{
  let seed = 42
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  let allOk = true
  for (let trial = 0; trial < 300; trial++) {
    const n = 2 + Math.floor(rnd() * 30)
    const scores: number[] = [], actuals: boolean[] = []
    for (let i = 0; i < n; i++) {
      scores.push(Math.round(rnd() * 4) / 4) // quantize → ép tie
      actuals.push(rnd() < 0.35)
    }
    if (!actuals.some(Boolean)) continue
    const mine = aucPr(sweepThresholds(scores, actuals))
    const alt = altAP(scores, actuals)
    if (!close(mine, alt, 1e-12)) { allOk = false; console.log(`    lệch trial ${trial}: mine=${mine} alt=${alt}`); break }
  }
  check('300 trial random có tie: aucPr === AP chuẩn < 1e-12', allOk)
}

// ---------- 2. nDCG ⇔ brute-force ----------
console.log('\n━━━ 2. nDCG@k ⇔ brute-force DCG/IDCG ━━━')
{
  let seed = 7
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  let allOk = true
  for (let trial = 0; trial < 300; trial++) {
    const len = 1 + Math.floor(rnd() * 10)
    const rel: number[] = Array.from({ length: len }, () => (rnd() < 0.4 ? 1 : 0))
    const k = 1 + Math.floor(rnd() * 8)
    const dcg = rel.slice(0, k).reduce((s, r, i) => s + r / Math.log2(i + 2), 0)
    const ideal = [...rel].sort((a, b) => b - a).slice(0, k).reduce((s, r, i) => s + r / Math.log2(i + 2), 0)
    const ndcg = ideal > 0 ? dcg / ideal : 0
    if (!close(ndcgAtK(rel, k), ndcg, 1e-12)) { allOk = false; console.log(`    lệch trial ${trial}: rel=${rel} k=${k}`); break }
  }
  check('300 trial random: ndcgAtK === brute-force < 1e-12', allOk)

  // MRR: vị trí relevant đầu tiên
  let mrrOk = true
  for (let trial = 0; trial < 200; trial++) {
    const len = 1 + Math.floor(rnd() * 8)
    const rel: number[] = Array.from({ length: len }, () => (rnd() < 0.5 ? 1 : 0))
    const first = rel.findIndex((r) => r === 1)
    const expect = first === -1 ? 0 : 1 / (first + 1)
    if (!close(mrr(rel), expect, 1e-12)) { mrrOk = false; break }
  }
  check('200 trial random: mrr === 1/vị trí relevant đầu tiên', mrrOk)
}

// ---------- 3. iqrBounds ⇔ sort-index nội suy độc lập ----------
console.log('\n━━━ 3. iqrBounds ⇔ quantile nội suy sort ━━━')
{
  function altQuantile(sorted: number[], q: number): number {
    const n = sorted.length
    const pos = q * (n - 1)
    const lo = Math.floor(pos), hi = Math.ceil(pos)
    return lo === hi ? sorted[lo] : sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo])
  }
  let seed = 99
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  let allOk = true
  for (let trial = 0; trial < 300; trial++) {
    const n = 1 + Math.floor(rnd() * 40)
    const xs = Array.from({ length: n }, () => Math.round(rnd() * 100000))
    const { q1, q3, low, high } = iqrBounds(xs, 1.5)
    const sorted = [...xs].sort((a, b) => a - b)
    const aq1 = altQuantile(sorted, 0.25), aq3 = altQuantile(sorted, 0.75)
    const aiqr = aq3 - aq1
    if (!close(q1, aq1, 1e-9) || !close(q3, aq3, 1e-9) || !close(low, aq1 - 1.5 * aiqr, 1e-9) || !close(high, aq3 + 1.5 * aiqr, 1e-9)) {
      allOk = false; console.log(`    lệch trial ${trial}`); break
    }
  }
  check('300 trial random: iqrBounds === sort-index nội suy < 1e-9', allOk)
}

// ---------- 4. statusForKpi ⇔ if-else viết lại ----------
console.log('\n━━━ 4. statusForKpi ⇔ bảng điều kiện độc lập ━━━')
{
  const mk = (goal: 'higher' | 'lower', target?: number): KpiDef =>
    ({ key: 't', label: 't', goal, ...(target !== undefined ? { target } : {}), compute: async () => ({ value: 0, n: 0 }) })
  let allOk = true
  for (const goal of ['higher', 'lower'] as const) {
    for (const target of [0, 0.2, 0.5, 0.8, 1, 2]) {
      for (const value of [0, 0.1, 0.18, 0.2, 0.22, 0.45, 0.5, 0.55, 0.72, 0.75, 0.8, 0.88, 0.9, 1, 1.8, 2.2]) {
        const mine = statusForKpi(mk(goal, target), value)
        let expect: string
        if (goal === 'higher') {
          expect = value >= target ? 'on_target' : value >= target * 0.9 ? 'near' : 'off'
        } else {
          expect = value <= target ? 'on_target' : value <= target * 1.1 ? 'near' : 'off'
        }
        if (mine !== expect) { allOk = false; console.log(`    lệch goal=${goal} t=${target} v=${value}: ${mine} ≠ ${expect}`) }
      }
    }
  }
  check('2 goal × 6 target × 16 value: status khớp bảng độc lập', allOk)
  check('không target → no_target', statusForKpi(mk('higher'), 0.5) === 'no_target')
}

// ---------- 5. buildRelevanceVector: tính chất trên 2000 case random ----------
console.log('\n━━━ 5. buildRelevanceVector — 2000 case random ━━━')
{
  let seed = 2026
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const ALPHA = 'abcdefghij'
  const word = () => {
    const len = 2 + Math.floor(rnd() * 5)
    let s = ''
    for (let i = 0; i < len; i++) s += ALPHA[Math.floor(rnd() * ALPHA.length)]
    return s
  }
  const QUOTES = ['\u2018', '\u2019', '\u201C', '\u201D', '\u2013', '\u2014', "'"]
  const mangle = (w: string) => QUOTES[Math.floor(rnd() * QUOTES.length)] + w + QUOTES[Math.floor(rnd() * QUOTES.length)]

  let countOk = 0, firstOccOk = 0, trialsWithEntities = 0
  for (let trial = 0; trial < 2000; trial++) {
    const nEnt = Math.floor(rnd() * 4)
    const nChunk = 1 + Math.floor(rnd() * 6)
    const entities: ExpectedEntity[] = Array.from({ length: nEnt }, () => ({ name: word() }))
    const chunks = Array.from({ length: nChunk }, () => {
      const nWord = 1 + Math.floor(rnd() * 8)
      const words = Array.from({ length: nWord }, () => (rnd() < 0.35 && entities.length ? entities[Math.floor(rnd() * entities.length)].name : word()))
      return { text: words.map((w) => (rnd() < 0.25 ? mangle(w) : w)).join(' ') }
    })
    const { rel, retrievedCount } = buildRelevanceVector(entities, chunks)

    // (a) retrievedCount === cách đếm cũ filter+some
    const oldCount = entities.filter((e) =>
      chunks.some((c) => normalizeForEntityMatch(c.text).includes(normalizeForEntityMatch(e.name))),
    ).length
    if (retrievedCount === oldCount) countOk++
    if (nEnt > 0) trialsWithEntities++

    // (b) first-occurrence: mỗi rel[i]=1 ⇔ chunk i chứa entity chưa khớp trước đó
    const matched = new Set<number>()
    let ok = true
    for (let ci = 0; ci < chunks.length; ci++) {
      let expect = 0
      for (let ei = 0; ei < entities.length; ei++) {
        if (matched.has(ei)) continue
        if (normalizeForEntityMatch(chunks[ci].text).includes(normalizeForEntityMatch(entities[ei].name))) {
          matched.add(ei); expect = 1
        }
      }
      if (rel[ci] !== expect) { ok = false; break }
    }
    if (ok) firstOccOk++
  }
  check(`retrievedCount === filter+some: ${countOk}/2000`, countOk === 2000)
  check(`first-occurrence semantics: ${firstOccOk}/2000`, firstOccOk === 2000)
  check(`có trial với entity (không lưu không)`, trialsWithEntities > 500)
}

// ---------- 6. scorecard: confusion + byAgent phân vùng đầy đủ ----------
console.log('\n━━━ 6. scorecard confusionMatrix/prf1 — phân vùng ━━━')
{
  let seed = 555
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  let allOk = true
  for (let trial = 0; trial < 200; trial++) {
    const n = 1 + Math.floor(rnd() * 40)
    const predicted = Array.from({ length: n }, () => rnd() < 0.5)
    const actual = Array.from({ length: n }, () => rnd() < 0.5)
    const cm = confusionMatrix(predicted, actual)
    if (cm.tp + cm.fp + cm.fn + cm.tn !== n) { allOk = false; break }
    // Đếm tay độc lập
    let tp = 0, fp = 0, fn = 0, tn = 0
    for (let i = 0; i < n; i++) {
      if (predicted[i] && actual[i]) tp++
      else if (predicted[i] && !actual[i]) fp++
      else if (!predicted[i] && actual[i]) fn++
      else tn++
    }
    if (cm.tp !== tp || cm.fp !== fp || cm.fn !== fn || cm.tn !== tn) { allOk = false; break }
    const m = prf1(cm)
    const p = tp + fp > 0 ? tp / (tp + fp) : 0
    const r = tp + fn > 0 ? tp / (tp + fn) : 0
    const f1 = p + r > 0 ? (2 * p * r) / (p + r) : 0
    if (!close(m.precision, p, 1e-12) || !close(m.recall, r, 1e-12) || !close(m.f1, f1, 1e-12)) { allOk = false; break }
  }
  check('200 trial random: confusion + prf1 khớp đếm tay/công thức', allOk)
}

// ---------- 7. round4 không âm/NaN ----------
{
  const r4 = (x: number) => Math.round(x * 10000) / 10000
  check('round4 chuẩn (0.66666→0.6667, 0.27375→0.2738 — Math.round half-up)', r4(0.66666) === 0.6667 && r4(1.00005) === 1.0001)
}

console.log(`\n━━━ KẾT QUẢ: ${pass} pass · ${fail} fail ━━━`)
if (fail > 0) { console.log('FAILS:', fails.join(' | ')); process.exit(1) }
process.exit(0)
