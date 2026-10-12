/**
 * ROUND-92 TESTS — BRAIN-LIVE · TAB BRAIN SMOLAB + ACTIVITY API
 * (chỉ thị user 2026-10-12, trích ngắn: "mỗi lớp có bao nhiêu nơ-ron thì phải
 * hiển thị đúng số điểm nơ-ron đấy … cơ chế lan truyền tiến bằng các đường
 * màu xanh, lan truyền ngược là các đường màu vàng … điểm sáng tương ứng với
 * các nơ-ron hoạt động … theo thực tế … có thu to phóng nhỏ … di chuyển toàn
 * bộ ô Não vận hành — MLP-CPU (BRAIN) về module Smolab và tạo thành 1 tab
 * tên là BRAIN")
 *
 * Đo lường:
 *   A. MLP.forwardActivations (public mới 15-a — thuần): MLP [3,4,2] seed
 *      tất định → length = số lớp · shape [3][4][2] · lớp 0 deep-equal input
 *      · lớp cuối deep-equal predict(x) · đổi 1 input → lớp 1+ đổi (lan
 *      truyền THẬT) · input sai chiều → throw · 2 lần gọi deep-equal +
 *      KHÔNG phải tham chiếu nội bộ (đục bản sao không ảnh hưởng lần sau) +
 *      JSON-serializable (mảng thường, không Float64Array).
 *   B. parseTuningInput (15-b — thuần): number hợp lệ trong [min,max] → ok +
 *      giá trị (kèm làm tròn 6 chữ số lẻ) · ngoài phạm vi → 'Ngoài phạm vi'
 *      · rác 'abc' → 'số hợp lệ' · enum trong enumValues → ok · enum ngoài
 *      → lỗi liệt kê giá trị · biên min/max (min ok, min−ε lỗi) · spec
 *      không min/max → phạm vi vô hạn (±1e300 vẫn ok).
 *   C. GET /api/brain/activity (DB cô lập qua preload — gọi handler trực tiếp
 *      như r86/r88): brain thiếu/rác + head rác surrogate → 400 · DB sạch
 *      (dọn AgentRunRecord/EvalResult/BrainModel) → 200 dormant cả 3 brain,
 *      agentRunInProgress=false, inputVector/activations/featureNames null ·
 *      seed completed (gpt-x/tester) + running → agentRunInProgress=true +
 *      inputVector one-hot THÔ 0/1 đối chiếu buildSurrogateFeatureRow /
 *      buildPolicyFeatureRow (kèm featureNames) · seed bản BrainModel
 *      surrogate active (đủ điều kiện loadActiveSurrogate) → status
 *      'active' + inputVector standardized (độ dài = featureNames.length) +
 *      activations [lớp][unit] deep-equal MLP dựng lại cùng seed · head
 *      'tokens' chọn đúng MLP đầu đó (≠ head 'success') · READ-ONLY pin:
 *      count 5 bảng (AgentRunRecord/EvalResult/EvalCase/BrainModel/
 *      TuningParam) trước/sau chuỗi GET GIỐNG HỆT (hiệu đính 16-c R2-01:
 *      16-b R1-07 thêm EvalCase vào snap — header 15-e sót “4 bảng”)
 *      · calibration_v3 dormant + có
 *      EvalResult → sourceLabel nhắc 'EvalResult' + inputVector NULL
 *      (quyết định 15-a: không chuẩn hóa đúng scale được thì không trả thô).
 *   D. buildStageLayout v2 — pins BỔ SUNG (không trùng r90-J): công thức y =
 *      26 + row×17 + height = 26 + maxDisplay×17 + 26 đối chiếu TÍNH TRỰC
 *      TIẾP cho [10,16,1] · columns [256, 8] → cột 0 đủ 256 nơ-ron + height
 *      theo cột cao nhất 256 (cột 8 không kéo cao) · realIndex = row sweep
 *      units ≤ 256 (1..256, gồm biên 255/256) + 257 → vẽ 256 + nén đơn điệu
 *      (đầu 0, cuối 256) · biên 0 cột / 1 cột + tất định [256, 8] ×2.
 *   E. Source-scan wiring BRAIN-LIVE (đọc nguồn bằng node:fs như r91-D — pin
 *      chống hồi quy cấu trúc): smolab-module SMOLAB_TABS có entry id
 *      'brain' label 'BRAIN' + render 'brain' → BrainTabContent (import tồn
 *      tại) · brain-tab fetch '/api/brain/activity' + POLL 2.5s (setInterval)
 *      + refreshNonce + tall + TuningParamDialog + ui_synapse_fx + &head= ·
 *      neural-architecture-section PRUNE THẬT (bỏ comment: không còn 'Não
 *      vận hành'/MLP-CPU, không import BrainStage/BrainStudio/
 *      TrainingConsole — panel đã sang Smolab; đồ thị 6 lớp + inspector +
 *      Bảng Q còn nguyên) · brain-stage v2 (tiến rgba(16,185,129 emerald +
 *      ngược rgba(250,204,21 yellow + zoom viewBox state + prop activity +
 *      STAGE_LIMITS — KHÔNG còn cap 8 cứng) · tuning-param-dialog
 *      (parseTuningInput import + segmented enum aria-pressed + min-h-[44px]).
 *   F. Cờ mặc định (đối trọng r89-E — pin spec-side chống hồi quy):
 *      TUNING_SPECS.length === 25 (count không đổi) + getTuningEnum
 *      ('ui_synapse_fx') === 'on' (chỉ thị user 2026-10-12) +
 *      'ui_brain_edit'/'ui_hitech' === 'off' + 3 spec đủ enumValues/default/
 *      envKey đúng nguồn.
 *
 * Nguyên tắc dọn state (bài học r83/r81 — bun test 1 process, thứ tự file
 * tùy ý): nhóm C wipe + seed + dọn SẠCH AgentRunRecord/EvalResult/EvalCase/
 * BrainModel (DB CÔ LẬP của preload — không bao giờ đụng db/custom.db) ở
 * beforeAll + afterAll; nhóm F chỉ resetTuningValue 3 cờ UI + xóa env +
 * refresh snapshot (không set giá trị mới → không rò state sang file khác).
 * Mọi expected DẪN NGUỒN ĐƯỢC (comment công thức/đối chiếu builder thật).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '@/lib/db'
import { MLP } from '@/lib/brain/mlp'
import { GET } from '@/app/api/brain/activity/route'
import { parseTuningInput } from '@/lib/learning/tuning-input'
import { TUNING_SPECS, getTuningSpec, type TuningSpec } from '@/lib/learning/neural-types'
import { getTuningEnum, resetTuningValue, refreshTuningSnapshot } from '@/lib/learning/tuning-store'
import { buildStageLayout, STAGE_LIMITS, type StageColumn } from '@/lib/brain/stage-geometry'
import {
  buildSurrogateFeatureRow,
  buildSurrogateVocab,
  surrogateFeatureNames,
  type SurrogateVocab,
  type SurrogateFeatureCtx,
} from '@/lib/brain/brains/surrogate'
import {
  buildPolicyFeatureRow,
  buildPolicyVocab,
  policyFeatureNames,
  type PolicyFeatureCtx,
} from '@/lib/brain/brains/policy'

// ==================== A. forwardActivations (THUẦN — public mới 15-a) ====================

describe('r92 · A MLP.forwardActivations — activation từng lớp cho đài quan sát BRAIN', () => {
  // MLP [3,4,2] seed tất định — mọi test nhóm A dựng lại từ spec này
  const spec = {
    layers: [
      { units: 3, activation: 'linear' as const },
      { units: 4, activation: 'tanh' as const },
      { units: 2, activation: 'sigmoid' as const },
    ],
    loss: 'bce' as const,
    optimizer: 'adam' as const,
    lr: 0.01,
    l2: 0.01,
    seed: 42,
  }
  const X = [0.5, -1, 2]
  const mlp = new MLP(spec)

  test('length = số lớp (3) + shape đúng [3][4][2] theo spec.layers', () => {
    const acts = mlp.forwardActivations(X)
    expect(acts).toHaveLength(3) // layers.length — input + ẩn + output
    expect(acts[0]).toHaveLength(3) // lớp input = 3 đặc trưng
    expect(acts[1]).toHaveLength(4) // lớp ẩn 4 unit
    expect(acts[2]).toHaveLength(2) // lớp output 2 unit
  })

  test('lớp 0 deep-equal input; lớp cuối deep-equal predict(x) cùng input', () => {
    const acts = mlp.forwardActivations(X)
    expect(acts[0]).toEqual(X) // a[0] = x (hợp đồng forwardAll)
    // predict trả Array.from(lớp cuối) — cùng giá trị, tính độc lập
    expect(acts[acts.length - 1]).toEqual(mlp.predict(X))
  })

  test('đổi 1 input → lớp 1+ đổi (lan truyền THẬT qua trọng số, không phải copy)', () => {
    const a1 = mlp.forwardActivations(X)
    const x2 = [X[0], 1, X[2]] // CHỈ đổi input[1]: -1 → 1
    const a2 = mlp.forwardActivations(x2)
    expect(a2[0]).toEqual(x2) // lớp 0 = input mới
    // Lớp ẩn đổi (z_j += w_{j,1}·Δx ≠ 0 với weights khởi tạo seed 42) —
    // nếu forwardActivations chỉ copy đầu vào thì 2 dòng dưới SAI
    expect(a2[1]).not.toEqual(a1[1])
    expect(a2[2]).not.toEqual(a1[2]) // lan truyền tới output
  })

  test('input sai chiều dài → throw rõ ràng (giữ hợp đồng forwardAll)', () => {
    expect(() => mlp.forwardActivations([1, 2])).toThrow(/≠ 3 unit lớp input/)
    expect(() => mlp.forwardActivations([])).toThrow()
  })

  test('tất định + BẢN SAO: 2 lần gọi deep-equal; đục kết quả KHÔNG ảnh hưởng lần sau; JSON-serializable', () => {
    const r1 = mlp.forwardActivations(X)
    const r2 = mlp.forwardActivations(X)
    expect(r1).toEqual(r2) // tất định cùng input
    expect(r1).not.toBe(r2) // 2 mảng KHÁC nhau — không trả tham chiếu cache
    expect(r1[0]).not.toBe(r2[0]) // từng lớp cũng là bản sao riêng
    // Sửa bản sao của caller → lần gọi sau + predict KHÔNG bị đục
    r1[0][0] = 9999
    r1[1][0] = 9999
    const r3 = mlp.forwardActivations(X)
    expect(r3).toEqual(r2)
    expect(mlp.predict(X)).toEqual(r2[2])
    // Mảng thường (number[][]) — JSON-serializable sẵn cho route API,
    // KHÔNG lộ Float64Array nội bộ của mạng
    expect(Array.isArray(r3[0])).toBe(true)
    expect(r3[0] instanceof Float64Array).toBe(false)
    expect(JSON.parse(JSON.stringify(r3))).toEqual(r3)
    // 2 instance cùng seed → cùng weights → cùng activations (tất định chéo)
    expect(new MLP(spec).forwardActivations(X)).toEqual(r3)
  })
})

// ==================== B. parseTuningInput (THUẦN — 15-b) ====================

describe('r92 · B parseTuningInput — lõi validate editor TuningParamDialog', () => {
  // Spec number có biên [0, 1] — dùng key thật để pin song song nguồn
  const numSpec = getTuningSpec('reward_w_outcome')!
  // Synthetic spec biên tắt (chỉ dùng trong test — không ghi DB)
  const boundsSpec: TuningSpec = {
    key: 'r92_bounds', label: 'R92', description: 'synthetic', nodeId: 'n',
    type: 'number', min: 0, max: 1, default: 0.5, appliesTo: 'test',
  }
  const unboundedSpec: TuningSpec = {
    key: 'r92_unbounded', label: 'R92U', description: 'synthetic', nodeId: 'n',
    type: 'number', default: 0, appliesTo: 'test', // KHÔNG min/max → ±∞
  }
  const enumSpec = getTuningSpec('ui_synapse_fx')!

  test('number hợp lệ trong [min,max] → ok + giá trị; trim khoảng trắng; làm tròn 6 chữ số lẻ', () => {
    expect(numSpec.type).toBe('number') // tiền đề: key thật là number
    expect(parseTuningInput(numSpec, '0.5')).toEqual({ ok: true, value: 0.5 })
    expect(parseTuningInput(numSpec, '  0.25  ')).toEqual({ ok: true, value: 0.25 }) // trim
    // float-junk 0.30000000004 → làm tròn 1e6 → 0.3 (chống rác chuỗi hóa)
    expect(parseTuningInput(numSpec, '0.30000000004')).toEqual({ ok: true, value: 0.3 })
    expect(parseTuningInput(numSpec, '0.123456789')).toEqual({ ok: true, value: 0.123457 })
  })

  test("ngoài phạm vi → error 'Ngoài phạm vi' (KHÔNG kẹp về min/max)", () => {
    const under = parseTuningInput(numSpec, '-0.1')
    expect(under.ok).toBe(false)
    if (!under.ok) expect(under.error).toContain('Ngoài phạm vi [0, 1]')
    const over = parseTuningInput(numSpec, '1.1')
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.error).toContain('Ngoài phạm vi')
  })

  test("rác 'abc' / rỗng / Infinity → error 'số hợp lệ' (bắt buộc hữu hạn)", () => {
    for (const raw of ['abc', '', '   ', 'Infinity', 'NaN']) {
      const res = parseTuningInput(numSpec, raw)
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toBe('Giá trị phải là số hợp lệ')
    }
  })

  test('enum trong enumValues → ok giữ nguyên chuỗi (trim; so THẦN chữ)', () => {
    expect(enumSpec.type).toBe('enum') // tiền đề: ui_synapse_fx là enum
    expect(parseTuningInput(enumSpec, 'on')).toEqual({ ok: true, value: 'on' })
    expect(parseTuningInput(enumSpec, ' off ')).toEqual({ ok: true, value: 'off' })
    // Dialog so thầm chữ (khác server lowercase) — 'ON' là giá trị SAI
    const upper = parseTuningInput(enumSpec, 'ON')
    expect(upper.ok).toBe(false)
  })

  test('enum ngoài danh sách → error LIỆT KÊ giá trị hợp lệ', () => {
    const res = parseTuningInput(enumSpec, 'maybe')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toContain('off | on') // liệt kê đủ enumValues
      expect(res.error).toContain('"maybe"') // nhắc lại input user
    }
  })

  test('biên min/max: đúng ranh giới OK (0 và 1); min−ε / max+ε lỗi; spec không min/max → vô hạn', () => {
    // min/max là khoảng ĐÓNG — chính ranh giới hợp lệ
    expect(parseTuningInput(boundsSpec, '0')).toEqual({ ok: true, value: 0 })
    expect(parseTuningInput(boundsSpec, '1')).toEqual({ ok: true, value: 1 })
    expect(parseTuningInput(boundsSpec, '-0.000001').ok).toBe(false) // min−ε
    expect(parseTuningInput(boundsSpec, '1.000001').ok).toBe(false) // max+ε
    // spec thiếu min/max → −∞/+∞ (min ?? -Infinity trong nguồn)
    expect(parseTuningInput(unboundedSpec, '1e300')).toEqual({ ok: true, value: 1e300 })
    expect(parseTuningInput(unboundedSpec, '-1e300')).toEqual({ ok: true, value: -1e300 })
    expect(parseTuningInput(unboundedSpec, '0')).toEqual({ ok: true, value: 0 })
  })
})

// ==================== C. GET /api/brain/activity (DB CÔ LẬP — route handler trực tiếp) ====================

/** Response shape route activity (contract 15-a — đối chiếu registry.BrainActivity). */
interface ActivityJson {
  ok: boolean
  brain: string
  head: string | null
  status: 'active' | 'dormant'
  agentRunInProgress: boolean
  inputVector: number[] | null
  activations: number[][] | null
  featureNames: string[] | null
  sourceLabel: string | null
  fetchedAt: string
  error?: string
}

/** Gọi GET trực tiếp route handler (pattern r86/r88 — không cần server). */
function getActivity(brain: string | null, head?: string): Promise<Response> {
  const qs: string[] = []
  if (brain !== null) qs.push(`brain=${brain}`)
  if (head !== undefined) qs.push(`head=${head}`)
  const q = qs.length > 0 ? `?${qs.join('&')}` : ''
  return GET(new Request(`http://t/api/brain/activity${q}`))
}

async function activity(brain: string | null, head?: string): Promise<ActivityJson> {
  const res = await getActivity(brain, head)
  expect(res.status).toBe(200)
  return (await res.json()) as ActivityJson
}

describe('r92 · C GET /api/brain/activity — đài quan sát não READ-ONLY (DB cô lập)', () => {
  // Chưa seed gì — mọi test tự dựng state mình cần (r92 chạy 1 process với
  // các file khác nhưng wipe tại beforeAll đảm bảo tất định)

  beforeAll(async () => {
    // DB SẠCH cho nhóm C: 3 bảng nguồn dữ liệu route + model (bản copy /tmp
    // của preload — không bao giờ đụng DB app)
    await db.agentRunRecord.deleteMany({})
    await db.evalResult.deleteMany({})
    await db.evalCase.deleteMany({})
    await db.brainModel.deleteMany({
      where: { brain: { in: ['calibration_v3', 'surrogate', 'policy'] } },
    })
  })

  afterAll(async () => {
    // Dọn SẠCH state nhóm C đã seed (không quét đại trà table khác)
    await db.agentRunRecord.deleteMany({})
    await db.evalResult.deleteMany({})
    await db.evalCase.deleteMany({})
    await db.brainModel.deleteMany({
      where: { brain: { in: ['calibration_v3', 'surrogate', 'policy'] } },
    })
  })

  test('query rác → 400: thiếu brain · brain lạ · head lạ cho surrogate', async () => {
    const missing = await GET(new Request('http://t/api/brain/activity')) // KHÔNG có ?brain
    expect(missing.status).toBe(400)
    expect(((await missing.json()) as { ok: boolean; error: string }).ok).toBe(false)

    const junk = await getActivity('brain_x')
    expect(junk.status).toBe(400)
    const junkJson = (await junk.json()) as { ok: boolean; error: string }
    expect(junkJson.ok).toBe(false)
    expect(junkJson.error).toContain('không hợp lệ')

    // head chỉ surrogate — rác chặn 400, message nhắc head
    const badHead = await getActivity('surrogate', 'tokensMs')
    expect(badHead.status).toBe(400)
    const badHeadJson = (await badHead.json()) as { ok: boolean; error: string }
    expect(badHeadJson.ok).toBe(false)
    expect(badHeadJson.error).toContain("head 'tokensMs' không hợp lệ")
  })

  test('DB sạch → 200 dormant cả 3 brain + agentRunInProgress=false + mọi field dữ liệu null', async () => {
    for (const brain of ['calibration_v3', 'surrogate', 'policy']) {
      const json = await activity(brain)
      expect(json.ok).toBe(true)
      expect(json.brain).toBe(brain)
      expect(json.status).toBe('dormant') // không có bản active
      expect(json.agentRunInProgress).toBe(false) // count running = 0
      expect(json.inputVector).toBeNull() // không có run/eval nguồn
      expect(json.activations).toBeNull()
      expect(json.featureNames).toBeNull()
      expect(json.sourceLabel).toBeNull()
      expect(Number.isNaN(Date.parse(json.fetchedAt))).toBe(false) // ISO hợp lệ
    }
    // head CHỈ surrogate — non-surrogate bỏ qua head rác, trả head=null
    const ignored = await activity('calibration_v3', 'tokens')
    expect(ignored.head).toBeNull()
    expect(ignored.ok).toBe(true)
  })

  test('seed completed (gpt-x/tester) + running → surrogate: agentRunInProgress + one-hot THÔ đối chiếu builder', async () => {
    // Run RUNNING tạo trước (không usable: chưa có complete/tokens/duration)
    const base = Date.now() - 2 * 60 * 60 * 1000
    await db.agentRunRecord.create({
      data: {
        sessionId: 'r92-brain-live', runId: 'run_r92_running',
        agentName: 'Omega', model: 'alpha', status: 'running',
        parentRunId: 'run-parent-r92', // delegation
        createdAt: new Date(base),
      },
    })
    // Run COMPLETED là run GẦN NHẤT (createdAt +60s — latestRun theo desc)
    await db.agentRunRecord.create({
      data: {
        sessionId: 'r92-brain-live', runId: 'run_r92_completed',
        agentName: 'tester', model: 'gpt-x', status: 'completed',
        stopReason: 'complete', cycles: 2, tokensUsed: 120, toolCalls: 3,
        durationMs: 1500, complete: true,
        startedAt: new Date(base + 60_000), completedAt: new Date(base + 60_000),
        createdAt: new Date(base + 60_000),
        parentRunId: null,
      },
    })

    const json = await activity('surrogate')
    // (a) Có AgentRunRecord running → chip "Agent đang chạy"
    expect(json.agentRunInProgress).toBe(true)
    expect(json.status).toBe('dormant') // vẫn chưa có bản active
    // (b) ctx từ run gần nhất (completed — gpt-x/tester/không delegated)
    expect(json.sourceLabel).toContain('AgentRun')
    expect(json.sourceLabel).toContain('model gpt-x')
    expect(json.sourceLabel).toContain('agent tester')
    // (c) one-hot THÔ dựng từ vocab run usable (chỉ run completed usable)
    //     — đối chiếu TRỰC TIẾP builder thật như nguồn route
    const ctx: SurrogateFeatureCtx = { model: 'gpt-x', agent: 'tester', delegated: false }
    const vocab = buildSurrogateVocab([ctx]) // models [gpt-x], agents [tester]
    expect(json.inputVector).not.toBeNull()
    expect(json.inputVector!).toEqual(
      buildSurrogateFeatureRow(ctx, vocab).map(v => (v === null ? 0 : v)),
    )
    expect(json.featureNames).toEqual(surrogateFeatureNames(vocab))
    // one-hot THÔ 0/1 (chưa chuẩn hóa — dormant không có means/stds)
    expect(json.inputVector!.every(v => v === 0 || v === 1)).toBe(true)
    expect(json.inputVector).toEqual([1, 1, 0]) // model:gpt-x + agent:tester + ¬delegated
    expect(json.activations).toBeNull() // dormant không có activations
  })

  test('policy tương tự: one-hot THÔ [agent:tester, delegated] đối chiếu buildPolicyFeatureRow', async () => {
    const json = await activity('policy')
    expect(json.agentRunInProgress).toBe(true) // count running toàn cục
    expect(json.status).toBe('dormant')
    expect(json.sourceLabel).toContain('agent tester')
    // Vocab policy = agents từ run usable (run completed) — ĐÚNG filter route
    const ctx: PolicyFeatureCtx = { agent: 'tester', delegated: false }
    const vocab = buildPolicyVocab([ctx]) // agents [tester]
    expect(json.inputVector!).toEqual(
      buildPolicyFeatureRow(ctx, vocab).map(v => (v === null ? 0 : v)),
    )
    expect(json.featureNames).toEqual(policyFeatureNames(vocab))
    expect(json.inputVector).toEqual([1, 0]) // agent:tester + ¬delegated
    expect(json.activations).toBeNull()
  })

  test('seed bản surrogate active (đủ điều kiện loadActiveSurrogate) → status active + inputVector standardized + activations per-layer', async () => {
    // Vocab cố định trong specJson — ĐỘC LẬP với runs (đúng tư cách bản train)
    const vocab: SurrogateVocab = { models: ['alpha', 'beta'], agents: ['Omega'] } // D = 4
    const means = [0.1, 0.2, 0.3, 0.4]
    const stds = [1, 1, 1, 1]
    // 3 head MLP nhỏ thật — seed KHÁC NHAU để phân biệt head (C6)
    const headSpec = (seed: number, outAct: 'sigmoid' | 'linear', loss: 'bce' | 'huber') => ({
      layers: [
        { units: 4, activation: 'linear' as const },
        { units: 8, activation: 'tanh' as const },
        { units: 1, activation: outAct },
      ],
      loss, optimizer: 'adam' as const, lr: 0.01, l2: 0.01, seed,
    })
    const mlpSuccess = new MLP(headSpec(42, 'sigmoid', 'bce'))
    const mlpTokens = new MLP(headSpec(43, 'linear', 'huber'))
    const mlpDur = new MLP(headSpec(44, 'linear', 'huber'))
    await db.brainModel.create({
      data: {
        brain: 'surrogate', version: 9201, inputMode: 'runs-features',
        specJson: JSON.stringify({ vocab }),
        weightsJson: JSON.stringify({
          heads: {
            success: mlpSuccess.serialize(),
            tokens: mlpTokens.serialize(),
            durationMs: mlpDur.serialize(),
          },
        }),
        // trainMeta đủ mọi field loadActiveSurrogate đọc: nSamples ≥ 40 +
        // standardization D chiều stds > 0 + targetStats + heads + baselines
        trainMetaJson: JSON.stringify({
          nSamples: 50,
          standardization: { means, stds },
          targetStats: { tokens: { mean: 6, std: 1 }, durationMs: { mean: 9, std: 1 } },
          heads: {
            success: { improved: true }, tokens: { improved: true },
            durationMs: { improved: true },
          },
          baselines: { successPrior: 0.5, tokensMedianLog: 6, durationMedianLog: 9 },
        }),
        active: true,
      },
    })

    const json = await activity('surrogate') // head mặc định 'success'
    expect(json.status).toBe('active')
    expect(json.head).toBe('success')
    // inputVector = one-hot (model 'gpt-x' LẠ → khối model 0; agent 'tester'
    // lạ → 0; ¬delegated → 0) rồi chuẩn hóa (x−mean)/std — công thức route
    const row = buildSurrogateFeatureRow(
      { model: 'gpt-x', agent: 'tester', delegated: false }, vocab,
    )
    const x = row.map((v, j) => ((v ?? 0) - means[j]) / stds[j])
    expect(json.inputVector).toEqual(x)
    expect(json.inputVector).toEqual([-0.1, -0.2, -0.3, -0.4]) // means [0.1..0.4], stds 1
    // featureNames theo vocab BẢN ACTIVE (không phải vocab run)
    expect(json.featureNames).toEqual(surrogateFeatureNames(vocab))
    expect(json.inputVector!.length).toBe(json.featureNames!.length) // D khớp nhau
    // activations per-layer [3 lớp][4/8/1 unit] — deep-equal MLP dựng lại
    // cùng seed 42 (tất định — deserialize bit-đối-bit)
    const expected = mlpSuccess.forwardActivations(x)
    expect(json.activations).toEqual(expected)
    expect(json.activations!).toHaveLength(3) // [input][ẩn][output]
    expect(json.activations![0]).toHaveLength(4)
    expect(json.activations![1]).toHaveLength(8)
    expect(json.activations![2]).toHaveLength(1)
  })

  test("head 'tokens' → activations của MLP đầu đó (seed 43) ≠ head 'success' (seed 42)", async () => {
    // loadActiveSurrogate trả ĐỦ 3 head — route chọn theo query
    const vocab: SurrogateVocab = { models: ['alpha', 'beta'], agents: ['Omega'] }
    const x = [-0.1, -0.2, -0.3, -0.4] // tính ở test trên: one-hot lạ + standardized
    const success = await activity('surrogate') // head mặc định success
    const tokens = await activity('surrogate', 'tokens')
    expect(tokens.head).toBe('tokens')
    // Đúng MLP đầu tokens: hidden 8 unit + output linear 1 unit, seed 43
    const mlpTokens = new MLP({
      layers: [
        { units: 4, activation: 'linear' },
        { units: 8, activation: 'tanh' },
        { units: 1, activation: 'linear' },
      ],
      loss: 'huber', optimizer: 'adam', lr: 0.01, l2: 0.01, seed: 43,
    })
    expect(tokens.activations).toEqual(mlpTokens.forwardActivations(x))
    // HAI HEAD CHO KẾT QUẢ KHÁC NHAU (weights khác seed → lan truyền khác)
    expect(tokens.activations).not.toEqual(success.activations)
    expect(tokens.activations![1]).not.toEqual(success.activations![1]) // lớp ẩn khác
    // durationMs cũng là head hợp lệ (đủ 3 — 15-a contract)
    const dur = await activity('surrogate', 'durationMs')
    expect(dur.head).toBe('durationMs')
    expect(dur.activations).not.toBeNull()
    expect(dur.activations!).toHaveLength(3)
  })

  test('READ-ONLY pin: count 5 bảng (AgentRunRecord/EvalResult/EvalCase/BrainModel/TuningParam) trước/sau chuỗi GET GIỐNG HỆT', async () => {
    // FB-BRAIN-LIVE-R1-07: thêm EvalCase vào pin — route có cả
    // evalCase.findUnique (nhánh calibration_v3) nên phải chụp ĐỦ 5 bảng
    // route đọc (probe 16-a G4 đã bọc 5 bảng; r92 trước-fix thiếu EvalCase).
    const snap = async () => ({
      runs: await db.agentRunRecord.count(),
      evals: await db.evalResult.count(),
      cases: await db.evalCase.count(),
      models: await db.brainModel.count(),
      tuning: await db.tuningParam.count(),
    })
    const before = await snap()
    // Chuỗi GET đầy đủ: 3 brain + 3 head surrogate + head non-surrogate + 400
    const urls: Array<[string | null, string?]> = [
      ['calibration_v3'], ['calibration_v3', 'tokens'],
      ['surrogate'], ['surrogate', 'success'], ['surrogate', 'tokens'], ['surrogate', 'durationMs'],
      ['policy'], ['policy', 'success'],
      ['brain_x'], [null],
    ]
    for (const [brain, head] of urls) await getActivity(brain, head)
    const after = await snap()
    expect(after).toEqual(before) // route CHỈ đọc — KHÔNG ghi bảng nào
  })

  test('calibration_v3 dormant + có EvalResult → sourceLabel nhắc EvalResult + inputVector NULL (quyết định 15-a)', async () => {
    // Seed 1 EvalCase + 1 EvalResult đầy đủ đặc trưng (không có bản active
    // calibration_v3 → dormant — stats chuẩn hóa không có → KHÔNG trả thô)
    const evalCase = await db.evalCase.create({
      data: { question: 'r92 q', expectedAnswer: 'r92 a', category: 'ml', difficulty: 'hard' },
    })
    await db.evalResult.create({
      data: {
        runId: 'run_r92_eval', caseId: evalCase.id, answer: 'seed',
        rawConfidence: 0.6, coverage: 1, answered: true, retrievedChunks: 3,
        extractionF1: 0.8, hallucinationDetected: false,
      },
    })
    const json = await activity('calibration_v3')
    expect(json.status).toBe('dormant') // vẫn dormant (không có bản active)
    // Nhãn nguồn NHẮC EvalResult (route: 'EvalResult · HH:MM')
    expect(json.sourceLabel).toContain('EvalResult')
    // QUYẾT ĐỊNH 15-a: dormant → inputVector null (không chuẩn hóa được
    // đúng scale — trả feature thô sẽ sai lệch input layer thật)
    expect(json.inputVector).toBeNull()
    expect(json.featureNames).toBeNull()
    expect(json.activations).toBeNull()
  })
})

// ==================== D. buildStageLayout v2 — pins BỔ SUNG (không trùng r90-J) ====================

describe('r92 · D buildStageLayout v2 — công thức + tổ hợp cột mới (BRAIN-LIVE)', () => {
  /** StageColumn chuẩn cho test D. */
  function col(units: number, label = 'x'): StageColumn {
    return { units, display: 0, label, activation: 'tanh', locked: false }
  }

  test('[10,16,1]: 27 nơ-ron đúng 10/16/1 mỗi cột + y = 26 + row×17 + height = 26 + 16×17 + 26 (đối chiếu CÔNG THỨC)', () => {
    const columns = [
      { units: 10, display: 0, label: '1-hot cfg', activation: 'linear', locked: true },
      { units: 16, display: 0, label: '×16', activation: 'tanh', locked: false },
      { units: 1, display: 0, label: 'sigmoid', activation: 'sigmoid', locked: true },
    ]
    const lay = buildStageLayout(columns)
    expect(lay.neurons).toHaveLength(27) // 10 + 16 + 1 — BRAIN-LIVE vẽ đủ
    for (let c = 0; c < 3; c++) {
      const inCol = lay.neurons.filter(n => n.col === c)
      expect(inCol.length).toBe(columns[c].units) // đúng 10 / 16 / 1
      // CÔNG THỨC toạ độ (topY 26, rowStep 17 — stage-geometry.ts)
      for (const n of inCol) {
        expect(n.y).toBe(26 + n.row * 17)
        expect(n.x).toBe(lay.colX[c]) // nơ-ron thẳng hàng theo cột
      }
    }
    // height theo cột CAO NHẤT (16) — tính bằng biểu thức nguồn, không hardcode
    expect(lay.height).toBe(26 + 16 * 17 + 26)
  })

  test('[256, 8]: cột 0 đủ 256 nơ-ron + height theo cột cao nhất 256 (cột 8 không kéo cao) + colX 2 cột', () => {
    const lay = buildStageLayout([col(256), col(8)])
    const c0 = lay.neurons.filter(n => n.col === 0)
    const c1 = lay.neurons.filter(n => n.col === 1)
    expect(c0).toHaveLength(256) // biên cap: 256 vẽ ĐỦ 256
    expect(c0).toHaveLength(STAGE_LIMITS.maxDisplayNeurons)
    expect(c1).toHaveLength(8)
    // Height do cột 256 quyết (26 + 256×17 + 26) — cột 8 KHÔNG kéo cao thêm
    expect(lay.height).toBe(26 + 256 * 17 + 26)
    // Toạ độ biên: nơ-ron cuối cột 0 ở y = 26 + 255×17; cột 1 y = 26 + 7×17
    expect(c0[255].y).toBe(26 + 255 * 17)
    expect(c1[7].y).toBe(26 + 7 * 17)
    // 2 cột: margin 34, viewBox 340 → bước (340−68)/1 = 272
    expect(lay.colX).toHaveLength(2)
    expect(lay.colX[0]).toBe(34)
    expect(lay.colX[1]).toBe(306)
    // Tất định — 2 lần dựng deep-equal (input mới so với r90-J)
    expect(buildStageLayout([col(256), col(8)])).toEqual(lay)
  })

  test('realIndex = row sweep mọi units ≤ 256 (1/2/8/64/128/255/256) + units 257 → vẽ 256 nén đơn điệu', () => {
    // Mọi cột trong khoảng editor 1–256 map thẳng 1-1 (BRAIN-LIVE 15-a) —
    // r90-J chốt 10/16/1 + 256; sweep này phủ TRỌN dải giá trị còn lại
    for (const units of [1, 2, 8, 64, 128, 255, 256]) {
      const lay = buildStageLayout([col(units), col(3)])
      const c0 = lay.neurons.filter(n => n.col === 0)
      expect(c0.length).toBe(Math.min(units, STAGE_LIMITS.maxDisplayNeurons))
      expect(c0.map(n => n.realIndex)).toEqual(c0.map((_, r) => r)) // = row
    }
    // VƯỢT cap đúng 1 unit (257) → vẽ 256 + nén đều: đầu 0, cuối units−1=256
    const lay = buildStageLayout([col(257), col(3)])
    const c0 = lay.neurons.filter(n => n.col === 0)
    expect(c0).toHaveLength(256)
    const idx = c0.map(n => n.realIndex) as number[]
    expect(idx[0]).toBe(0)
    expect(idx[idx.length - 1]).toBe(256) // 257 − 1
    expect(idx.every((v, i) => i === 0 || v >= idx[i - 1])).toBe(true) // đơn điệu
  })

  test('biên cấu trúc: 0 cột → rỗng + height 100; 1 cột → colX [34] (stepX 0); [256, 8] tất định', () => {
    expect(buildStageLayout([])).toEqual({ neurons: [], colX: [], height: 100 })
    const single = buildStageLayout([col(5)])
    expect(single.colX).toEqual([34]) // n=1 → stepX 0, không chia 0
    expect(single.neurons).toHaveLength(5)
    // [256, 8] 2 lần deep-equal — pin tất định tổ hợp cột BRAIN-LIVE mới
    const a = buildStageLayout([col(256), col(8)])
    const b = buildStageLayout([col(256), col(8)])
    expect(a).toEqual(b)
  })
})

// ==================== E. SOURCE-SCAN WIRING BRAIN-LIVE (node:fs như r91-D) ====================

describe('r92 · E source-scan wiring BRAIN-LIVE — pin chống hồi quy cấu trúc', () => {
  // Đọc nguồn TỪ FILE (không import — pin cả tồn tại file + nội dung wire)
  const read = (...p: string[]) => readFileSync(join(import.meta.dir, '..', 'src', ...p), 'utf-8')
  const smolab = read('components', 'smolab', 'smolab-module.tsx')
  const brainTab = read('components', 'smolab', 'brain-tab.tsx')
  const dialog = read('components', 'smolab', 'tuning-param-dialog.tsx')
  const section = read('components', 'database', 'neural-architecture-section.tsx')
  const stage = read('components', 'database', 'brain-stage.tsx')

  /** Bỏ comment // và block — chỉ quét PHẦN CODE (header file section có
   *  comment lịch sử nhắc 'Não vận hành' một cách hợp lệ — không tính).
   *  FB-BRAIN-LIVE-R1-08: STRING-AWARE — trước-fix `//` trong CHUỖI (vd URL
   *  'https://…') bị coi là mở comment → phần dòng còn lại bị che khỏi
   *  scan; nay gặp ' " ` NGOÀI comment → skip tới closing quote (xử lý
   *  escape \) rồi mới quét tiếp — máy trạng thái nhỏ, không regex lồng. */
  function stripComments(src: string): string {
    let out = ''
    let i = 0
    const n = src.length
    while (i < n) {
      const c = src[i]
      // Chuỗi ký tự — giữ nguyên, chỉ skip tới closing quote (\ bỏ 2 ký tự)
      if (c === "'" || c === '"' || c === '`') {
        const quote = c
        out += c
        i++
        while (i < n) {
          if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue }
          out += src[i]
          if (src[i] === quote) { i++; break }
          i++
        }
        continue
      }
      // Comment dòng // — bỏ tới cuối dòng (kể cả comment cuối dòng code)
      if (c === '/' && src[i + 1] === '/') {
        while (i < n && src[i] !== '\n') i++
        continue
      }
      // Comment block /* … */ — bỏ tới */
      if (c === '/' && src[i + 1] === '*') {
        i += 2
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
        i = Math.min(n, i + 2)
        continue
      }
      out += c
      i++
    }
    return out
  }

  test("smolab-module: SMOLAB_TABS có entry id 'brain' label 'BRAIN' + render 'brain' → BrainTabContent (import tồn tại)", () => {
    // Entry đúng chữ ký các tab khác (id/label/icon/color)
    expect(smolab).toContain("{ id: 'brain', label: 'BRAIN', icon: BrainCircuit, color: 'amber' }")
    expect(smolab).toContain("import { BrainTabContent } from '@/components/smolab/brain-tab'")
    expect(smolab).toContain("activeSmolabTab === 'brain'") // điều kiện render
    expect(smolab).toContain('<BrainTabContent />')
    // Icon có trong import lucide (entry tham chiếu phải resolve được)
    expect(smolab).toContain('BrainCircuit')
  })

  test("brain-tab: fetch '/api/brain/activity' + poll 2.5s (setInterval) + head chỉ surrogate + props v2 (activity/tall/refreshNonce) + TuningParamDialog + ui_synapse_fx", () => {
    expect(brainTab).toContain("fetch(`/api/brain/activity?brain=${selectedBrainKey}${q}`)")
    expect(brainTab).toContain('POLL_ACTIVITY_MS = 2_500')
    expect(brainTab).toContain('setInterval(() => { void fetchActivity() }, POLL_ACTIVITY_MS)')
    expect(brainTab).toContain('&head=') // head CHỈ gắn cho surrogate
    expect(brainTab).toContain("selectedBrainKey === 'surrogate'")
    // FB-BRAIN-LIVE-R1-01 pin (16-c R2-02): head poll = state activityHead
    // (không hardcode 'success') + sync 2 chiều với tab head của stage
    expect(brainTab).toContain('&head=${activityHead}')
    expect(brainTab).toContain('initialHead={activityHead}')
    expect(brainTab).toContain('onHeadChange={h => setActivityHead(h)}')
    // BrainStage props v2 (contract 15-c/15-d)
    expect(brainTab).toContain('activity={activity}')
    expect(brainTab).toContain('refreshNonce={refreshNonce}')
    expect(brainTab).toMatch(/\btall\b/) // prop tall (chế độ tab BRAIN to)
    // Dialog chỉnh tham số runtime tại chỗ (chỉ thị user)
    expect(brainTab).toContain('<TuningParamDialog')
    // Cờ hiệu ứng đọc từ tuning feed
    expect(brainTab).toContain("'ui_synapse_fx'")
  })

  test('neural-architecture-section PRUNE THẬT (bỏ comment): không còn panel Não vận hành + không import BrainStage/BrainStudio/TrainingConsole; đồ thị 6 lớp + inspector + Bảng Q còn nguyên', () => {
    const code = stripComments(section)
    // Panel brain ĐÃ DI CHUYỂN (chỉ thị user) — khối CODE không còn dấu vết
    expect(code).not.toContain('Não vận hành')
    expect(code).not.toContain('MLP-CPU')
    // KHÔNG import component brain nữa (chống hồi quy prune 15-d)
    expect(code).not.toContain('BrainStage')
    expect(code).not.toContain('BrainStudio')
    expect(code).not.toContain('TrainingConsole')
    expect(code).not.toContain("database/brain-stage")
    expect(code).not.toContain('brain-studio')
    expect(code).not.toContain('training-console')
    // PHẦN GIỮ LẠI (đúng scope 15-d): đồ thị 6 lớp + inspector + Q-table
    expect(code).toContain('Sơ đồ kiến trúc 6 lớp')
    expect(code).toContain('selectNode')
    expect(code).toContain('Bảng Q')
  })

  test('brain-stage v2: TIẾN emerald + NGƯỢC yellow + zoom viewBox (StageView state) + prop activity + STAGE_LIMITS (KHÔNG cap 8 cứng)', () => {
    // Màu theo chỉ thị user: tiến XANH emerald / ngược VÀNG yellow
    expect(stage).toContain('rgba(16,185,129') // emerald-500 — tiến
    expect(stage).toContain('rgba(250,204,21') // yellow-400 — ngược
    // Zoom/pan viewBox — state StageView | null (null = fit)
    expect(stage).toContain('useState<StageView | null>')
    expect(stage).toContain('zoomAt(')
    expect(stage).toContain('viewBox') // svg theo of view hiện tại
    // Props v2 (contract 15-c)
    expect(stage).toContain('activity?: BrainActivity | null')
    expect(stage).toContain('tall?: boolean')
    expect(stage).toContain('refreshNonce?: number')
    // FB-BRAIN-LIVE-R1-01 pin (16-c R2-02): stage bắn onHeadChange tại chỗ
    // setHead cũ (event handler — không phải effect)
    expect(stage).toContain('onHeadChange?.(h)')
    expect(stage).toContain("import type { BrainActivity, BrainStatusEntry } from '@/lib/brain/registry'")
    // Vẽ theo cap của geometry (256) — KHÔNG còn cap 8 cứng kiểu UX-3
    expect(stage).toContain('STAGE_LIMITS.maxDisplayNeurons')
    expect(stage).not.toMatch(/Math\.min\([^)]*,\s*8\s*\)/)
    expect(stage).not.toMatch(/maxDisplayNeurons\s*[:=]\s*8\b/)
  })

  test('tuning-param-dialog: parseTuningInput import + segmented enum (aria-pressed) + min-h-[44px] mobile', () => {
    expect(dialog).toContain("import { parseTuningInput } from '@/lib/learning/tuning-input'")
    expect(dialog).toContain('aria-pressed={draft === v}') // nút segmented enum
    expect(dialog).toContain('min-h-[44px]') // touch target mobile
  })
})

// ==================== F. FLAG DEFAULT (pin spec-side — đối trọng r89-E) ====================

describe('r92 · F cờ UI mặc định BRAIN-LIVE — TUNING_SPECS chống hồi quy', () => {
  beforeAll(async () => {
    // Dọn store + env 3 cờ để pin DEFAULT thật (bài học r83: không rò state)
    for (const key of ['ui_synapse_fx', 'ui_brain_edit', 'ui_hitech']) {
      await resetTuningValue(key).catch(() => {})
    }
    delete process.env.UI_SYNAPSE_FX
    delete process.env.UI_BRAIN_EDIT
    delete process.env.UI_HITECH
    await refreshTuningSnapshot()
  })
  afterAll(async () => {
    for (const key of ['ui_synapse_fx', 'ui_brain_edit', 'ui_hitech']) {
      await resetTuningValue(key).catch(() => {})
    }
    delete process.env.UI_SYNAPSE_FX
    delete process.env.UI_BRAIN_EDIT
    delete process.env.UI_HITECH
    await refreshTuningSnapshot()
  })

  test('TUNING_SPECS giữ đúng 25 entry + 3 cờ UI đủ enumValues/default/envKey đúng nguồn', () => {
    // Count không đổi qua BRAIN-LIVE (15-a chỉ ĐỔI default, không thêm key)
    expect(TUNING_SPECS.length).toBe(25)
    // ui_synapse_fx — default 'on' (chỉ thị user 2026-10-12: tab BRAIN là
    // đài quan sát não, hiệu ứng lan truyền là NỘI DUNG CHÍNH)
    const fx = getTuningSpec('ui_synapse_fx')!
    expect(fx.type).toBe('enum')
    expect(fx.enumValues).toEqual(['off', 'on'])
    expect(fx.default).toBe('on')
    expect(fx.envKey).toBe('UI_SYNAPSE_FX')
    // 2 cờ trình bày còn lại vẫn fail-open TẮT
    expect(getTuningSpec('ui_brain_edit')!.default).toBe('off')
    expect(getTuningSpec('ui_hitech')!.default).toBe('off')
  })

  test("getTuningEnum sau khi dọn store/env: ui_synapse_fx='on' · ui_brain_edit='off' · ui_hitech='off'", async () => {
    // Chuỗi hiệu lực STORE › ENV › DEFAULT — cả 2 tầng trên đã dọn ở
    // beforeAll → giá trị đọc được chính là DEFAULT của spec
    expect(getTuningEnum('ui_synapse_fx')).toBe('on') // BRAIN-LIVE 2026-10-12
    expect(getTuningEnum('ui_brain_edit')).toBe('off')
    expect(getTuningEnum('ui_hitech')).toBe('off')
  })
})
