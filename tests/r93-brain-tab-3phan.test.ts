/**
 * ROUND-93 TESTS — BRAIN-TAB-3PHAN · TAB BRAIN 3 SECTION DỌC + THÔNG SỐ ĐẦY ĐỦ
 * (chỉ thị user 2026-10-12, nguyên văn: "Đúng ra nên chia 3 phần, Phần trên
 * cùng là nút chọn Brain cũng như thông tin liên quan brain, Có thể thêm lớp
 * cũng như chỉnh số nơ ron mỗi lớp, sau đó là đến giao diện lớp có thể chỉnh
 * to nhỏ để xem từ tổng quan đến chi tiết được. Nếu số nơ rọn nhiều thì các
 * điểm nơ ron chỉnh kích thước nhỏ lại, vị trí các lớp chỉnh căn giữa thay vì
 * căn trên như hiện tại. Cuối cùng là phần chứa các bản thông số có thể chỉnh
 * sửa và thiết lập được" + "xác định cho tôi phần cuối chứa các thông số chỉnh
 * được như Trainning Console hay Tham số runtime liệu đã có thông tin để lựa
 * chọn về các hàm kích hoạt, hàm thưởng, hàm mất mát, các thông số liên quan
 * lan truyền tiến và lan truyền ngược, đạo hàm và nhiều thông số liên quan có
 * đầy đủ chưa")
 *
 * Đo lường (THUẦN + SOURCE-SCAN — không DB, không network; precedent pin
 * r88-G-3PHAN / r90-J / r92-D/E, wave 18-a/18-b/18-c/18-d đã xong):
 *   A. buildStageLayout v3 — pin chéo các case trung tâm (TÍNH TAY trước khi
 *      viết, sai số toBeCloseTo(_, 10) cho số thực — cùng nguồn stage-geometry
 *      như r90-J/r92-D, overlay cố ý làm regression chéo giữa các file):
 *      [10,16,1] width 390 + colX 161 + rowStep [17,17,17] + radius 6.12 +
 *      yStart [77,26,153.5] (PIN CENTER-ALIGN: nơ-ron đơn cột output y ===
 *      153.5 = 26 + 255/2 — KHÔNG còn y=26 căn trên) + height 331 ·
 *      [256,8] rowStep [2,17] + height 586 (PIN thay 4404 cũ) + radius cột
 *      256 = 0.72 (=2×0.36 — "nơ-ron nhiều → chấm nhỏ") + cột 8 đầu tiên
 *      y = 221.5 (= 26 + (510−119)/2 — cột ngắn lơ lửng GIỮA) · đơn điệu
 *      sweep [1..256] (rowStep + radius không tăng, clamp 2 đầu) · width động
 *      clamp(n×130, 340, 900) · tất định 2 lần gọi deep-equal.
 *      (realIndex KHÔNG lặp — r90-J + r92-D đã cover [10,16,1] thẳng +
 *      [300,1] nén đầu 0 cuối 299 + sweep; r93 chỉ giữ phần r90 CHƯA có.)
 *   B. spec-schema α/β/δ — CHỈ phần r88-G-3PHAN (18-d) CHƯA cover: pin
 *      DRAFT_LIMITS 6 hằng mới (alphaMin/Max · betaMin/Max · huberDeltaMin/
 *      Max) + chạm mép hợp lệ (α 0.001/10 · β 0.01/10 · δ 0.01/10 — r88-G
 *      chỉ pin 0/-1/100/NaN/11 lỗi) + INTEGRATION round-trip 1 draft đủ CẢ
 *      α (lớp leakyRelu) + β (lớp swish) + δ (2 head huber) với inputUnits
 *      null (D động) → validateBrainDraft ok → normalized giữ đủ →
 *      buildSurrogateSpecs truyền đúng → engine new MLP(spec) NHẬN (không
 *      throw + forward finite — validateSpec engine chặn thật).
 *   C. Source-scan wiring 3 SECTION + 4 tab console (PIN UPDATE Task 26 —
 *      chỉ thị user 2026-10-13: "tab Quan sát trong Bảng thông số nên tích
 *      hợp vào ô Chọn não và kiến trúc — chọn xong não nào có thể xem ngay
 *      dưới đài quan sát não, và chọn quan sát cái gì ở trên thì xem được ở
 *      đài bên dưới" — pattern stripComments của r92-E, helper copy NGUYÊN,
 *      string-aware FB-BRAIN-LIVE-R1-08):
 *      brain-tab 3 role="region" + 3 aria-label + KHÔNG còn máy bottom-sheet
 *      (consoleSheetOpen/useIsDesktopViewport/bottom-4 right-4/
 *      DESKTOP_BREAKPOINT) + 4 giá trị tab 'train'|'tuning'|'log'|'ref'
 *      (PIN UPDATE Task 26: BỎ 'observation' — Quan sát chuyển lên SECTION 1
 *      selector + panel dưới đài SECTION 2 theo chỉ thị user) +
 *      BrainReference import/render + 2 chuỗi chốt r92-E ('&head=
 *      ${activityHead}' + tall) · brain-studio segmented (aria-pressed +
 *      sm:grid-cols-3) + α/β editor (DRAFT_LIMITS + nhánh leakyRelu/swish +
 *      placeholder default) + KHÔNG selectorOpen · brain-stage TASK 26
 *      (nơ-ron tím radial #c084fc + cạnh thẳng + đường ngược vàng per-edge
 *      |δ×a| + canvas hạt 60fps rAF + wheel/pan rAF coalesce + weights cache
 *      + ResizeObserver + layout.width + layout.radius + stageBox
 *      440/520/600) ·
 *      training-console hằng optimizer (SGD_MOMENTUM/ADAM_BETA1 import) +
 *      field huberDelta (input δ chỉ head huber) · brain-reference
 *      (stripComments FB-BRAIN-TAB-R1-01 — pin asserting CODE, không phụ
 *      thuộc comment): ACTIVATION_MENU + SGD_MOMENTUM + crossEntropy +
 *      composite + w₁ — bảng 9 activation + 4 loss + reward + lan truyền
 *      tiến/ngược ·
 *      surrogate.ts lossParams+huberDelta (δ vào spec head huber) ·
 *      calibration-v3.ts + policy.ts activationParams (α/β qua pipeline).
 *   D. Regression layout r92-E KHÔNG VỠ — KHÔNG code trong file này (quyết
 *      định theo chỉ thị 18-e): chạy `bun test tests/r92-brain-live.test.ts`
 *      chứng minh (gate 18-e chạy kèm); r93-C.2 giữ 2 assert chéo cho ổn.
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// Thuần geometry v3 — cùng đường import như r90-J (bun giải @/ qua tsconfig)
import { buildStageLayout, STAGE_LIMITS, type StageColumn } from '@/lib/brain/stage-geometry'
import {
  validateBrainDraft,
  defaultDraftFor,
  DRAFT_LIMITS,
  type BrainDraftSpec,
} from '@/lib/brain/spec-schema'
import { buildSurrogateSpecs } from '@/lib/brain/brains/surrogate'
import { MLP } from '@/lib/brain/mlp'

// ==================== A. buildStageLayout v3 (thuần — tính tay trước khi pin) ====================

describe('r93 · A buildStageLayout v3 — center-align + rowStep/radius thích ứng (BRAIN-TAB-3PHAN)', () => {
  /** StageColumn chuẩn (display 0 — buildStageLayout tự min(units, 256)). */
  function col(units: number, label = 'x'): StageColumn {
    return { units, display: 0, label, activation: 'tanh', locked: false }
  }

  test('[10,16,1]: width 390 · colX bước 161 · rowStep [17,17,17] · radius 6.12 · contentSpan 255 · yStart [77, 26, 153.5] + height 331', () => {
    // Spec thật Brain-A (registry planned 10→16→1) — BRAIN-LIVE vẽ đủ 27
    const columns = [
      { units: 10, display: 0, label: '1-hot cfg', activation: 'linear', locked: true },
      { units: 16, display: 0, label: '×16', activation: 'tanh', locked: false },
      { units: 1, display: 0, label: 'sigmoid', activation: 'sigmoid', locked: true },
    ]
    const lay = buildStageLayout(columns)
    expect(lay.neurons).toHaveLength(27) // 10 + 16 + 1
    // width động clamp(3×130, 340, 900) = 390; bước colX (390−68)/2 = 161
    expect(lay.width).toBe(390)
    expect(lay.colX[1] - lay.colX[0]).toBeCloseTo(161, 10)
    // Cột thưa (display ≤ ~24): rowStep kẹp trần 17 mọi cột
    expect(lay.rowStep).toEqual([17, 17, 17])
    // radius từng cột = clamp(17×0.36, 0.7, 6.5) = 6.12
    for (let c = 0; c < 3; c++) expect(lay.radius[c]).toBeCloseTo(6.12, 10)
    // colSpan [153, 255, 0] → contentSpan 255 → CENTER yStart_c = 26 + (255−colSpan_c)/2
    const yOf = (c: number, r: number) => lay.neurons.find(n => n.col === c && n.row === r)!.y
    expect(yOf(0, 0)).toBeCloseTo(77, 10) // 26 + (255−153)/2
    expect(yOf(1, 0)).toBeCloseTo(26, 10) // cột cao nhất — tự nhiên top
    // PIN CENTER-ALIGN: nơ-ron đơn cột output y === 153.5 = 26 + 255/2
    // (nơ-ron giữa theo chiều dọc — KHÔNG còn y=26 căn trên của v2)
    expect(yOf(2, 0)).toBeCloseTo(153.5, 10)
    expect(yOf(2, 0)).toBeCloseTo(26 + 255 / 2, 10)
    // contentSpan suy ra từ pin center (yStart cột span-0 = 26 + contentSpan/2)
    expect(2 * (yOf(2, 0) - 26)).toBeCloseTo(255, 10)
    // height = topY + contentSpan + 50 = 26 + 255 + 50 = 331
    expect(lay.height).toBe(26 + 255 + 50)
    expect(lay.height).toBe(331)
  })

  test('PIN [256,8]: rowStep [2,17] · height 586 (thay 4404 cũ) · radius cột 256 = 0.72 (nơ-ron nhiều → chấm nhỏ) · cột 8 đầu tiên y = 221.5 (lơ lửng GIỮA)', () => {
    const lay = buildStageLayout([col(256), col(8)])
    const c0 = lay.neurons.filter(n => n.col === 0)
    const c1 = lay.neurons.filter(n => n.col === 1)
    // Vẽ đủ 256 theo cap BRAIN-LIVE
    expect(c0).toHaveLength(STAGE_LIMITS.maxDisplayNeurons)
    expect(c1).toHaveLength(8)
    // rowStep thích ứng: 256 → 400/255 ≈ 1.57 kẹp SÀN 2 (span 255×2=510);
    // cột 8 thưa → 17 (diện mạo v2)
    expect(lay.rowStep).toEqual([2, 17])
    // height = 26 + contentSpan(510) + 50 = 586 — PIN QUAN TRỌNG thay 4404
    // absurd của v2 (chỉ thị user "chỉnh to nhỏ để xem từ tổng quan đến chi tiết")
    expect(lay.height).toBe(26 + 510 + 50)
    expect(lay.height).toBe(586)
    // "nơ-ron nhiều thì các điểm nơ ron chỉnh kích thước nhỏ lại":
    // radius cột 256 = clamp(2×0.36, 0.7, 6.5) = 0.72 < 6.12 cột thưa
    expect(lay.radius[0]).toBeCloseTo(0.72, 10) // = 2×0.36
    expect(lay.radius[0]).toBeLessThan(lay.radius[1])
    // Cột ngắn lơ lửng GIỮA: đầu tiên y = 26 + (510−119)/2 = 221.5 ≠ 26
    expect(c1[0].y).toBeCloseTo(221.5, 10)
    expect(c1[0].y).toBeCloseTo(26 + (510 - 119) / 2, 10)
    // Cột cao nhất giữ top tự nhiên 26
    expect(c0[0].y).toBeCloseTo(26, 10)
  })

  test('ĐƠN ĐIỆU sweep [1,2,8,16,24,32,64,128,256]: rowStep + radius KHÔNG TĂNG khi display tăng; clamp 2 đầu (1 → 17/6.12 · 256 → 2/0.72)', () => {
    // 2 cột [X, 1] — chỉ đổi display cột trái (cột phải hằng để layout ổn định)
    const layOf = (units: number) => buildStageLayout([col(units), col(1)])
    const displays = [1, 2, 8, 16, 24, 32, 64, 128, 256]
    const steps = displays.map(d => layOf(d).rowStep[0])
    const radii = displays.map(d => layOf(d).radius[0])
    // Không tăng giữa liên tiếp (8/16/24 cùng kẹp trần 17 — bằng nhau OK)
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeLessThanOrEqual(steps[i - 1])
    for (let i = 1; i < radii.length; i++) expect(radii[i]).toBeLessThanOrEqual(radii[i - 1])
    // Clamp 2 đầu: display 1 → rowStep 17 (400/max(0,1) kẹp trần), radius 6.12
    expect(layOf(1).rowStep[0]).toBe(17)
    expect(layOf(1).radius[0]).toBeCloseTo(6.12, 10)
    // display 256 → rowStep sàn 2, radius 0.72
    expect(layOf(256).rowStep[0]).toBe(2)
    expect(layOf(256).radius[0]).toBeCloseTo(0.72, 10)
    // Giữa sweep có giá trị KHÔNG kẹp (32 → 400/31 ≈ 12.9 — thật sự thích ứng)
    expect(layOf(32).rowStep[0]).toBeCloseTo(400 / 31, 10)
  })

  test('width ĐỘNG clamp(n×130, 340, 900): 1→340 · 2→340 (260 < 340) · 3→390 · 4→520 · 6→780 · 7→900 · 8→900', () => {
    const widthOf = (n: number) => buildStageLayout(
      Array.from({ length: n }, () => col(3)),
    ).width
    expect(widthOf(1)).toBe(340) // 130 → kẹp dưới
    expect(widthOf(2)).toBe(340) // 260 < 340 → kẹp dưới
    expect(widthOf(3)).toBe(390)
    expect(widthOf(4)).toBe(520)
    expect(widthOf(6)).toBe(780)
    expect(widthOf(7)).toBe(900) // 910 → kẹp trên
    expect(widthOf(8)).toBe(900) // 1040 → kẹp trên
  })

  test('TẤT ĐỊNH: 2 lần gọi deep-equal ([10,16,1] + [256,8] — pattern r90-J)', () => {
    const columns = [col(10), col(16), col(1)]
    expect(buildStageLayout(columns)).toEqual(buildStageLayout(columns))
    const pair = [col(256), col(8)]
    expect(buildStageLayout(pair)).toEqual(buildStageLayout(pair))
  })
})

// ==================== B. spec-schema α/β/δ — phần r88-G-3PHAN CHƯA cover ====================

describe('r93 · B spec-schema activationParams + huberDelta — DRAFT_LIMITS pin + biên chạm mép + integration round-trip (bổ sung r88-G)', () => {
  test('DRAFT_LIMITS 6 hằng mới (18-d) đúng giá trị audit + CHẠM MÉP hợp lệ: α 0.001/10 · β 0.01/10 · δ 0.01/10 (r88-G chỉ pin lỗi 0/11/100)', () => {
    // Pin hằng (hẹp hơn engine >0-hữu-hạn — editor không nhận giá trị vô nghĩa)
    expect(DRAFT_LIMITS.alphaMin).toBe(0.001)
    expect(DRAFT_LIMITS.alphaMax).toBe(10)
    expect(DRAFT_LIMITS.betaMin).toBe(0.01)
    expect(DRAFT_LIMITS.betaMax).toBe(10)
    expect(DRAFT_LIMITS.huberDeltaMin).toBe(0.01)
    expect(DRAFT_LIMITS.huberDeltaMax).toBe(10)
    // Chạm mép dưới + mép trên đều HỢP LỆ (không strictly-less/greater)
    for (const alpha of [DRAFT_LIMITS.alphaMin, DRAFT_LIMITS.alphaMax]) {
      const d = {
        ...defaultDraftFor('calibration_v3'),
        hidden: [{ units: 16, activation: 'leakyRelu' as const, activationParams: { alpha } }],
      }
      expect(validateBrainDraft(d, 10).ok).toBe(true)
    }
    for (const beta of [DRAFT_LIMITS.betaMin, DRAFT_LIMITS.betaMax]) {
      const d = {
        ...defaultDraftFor('calibration_v3'),
        hidden: [{ units: 16, activation: 'swish' as const, activationParams: { beta } }],
      }
      expect(validateBrainDraft(d, 10).ok).toBe(true)
    }
    for (const huberDelta of [DRAFT_LIMITS.huberDeltaMin, DRAFT_LIMITS.huberDeltaMax]) {
      const d = {
        ...defaultDraftFor('surrogate'),
        lossPerHead: [
          { type: 'bce' as const, weight: 1 / 3 },
          { type: 'huber' as const, weight: 1 / 3, huberDelta },
          { type: 'huber' as const, weight: 1 / 3 },
        ],
      }
      expect(validateBrainDraft(d, null).ok).toBe(true)
    }
  })

  test('INTEGRATION round-trip: 1 draft đủ CẢ α (leakyRelu) + β (swish) + δ (2 head huber) · inputUnits null (D động) → normalized giữ đủ → buildSurrogateSpecs truyền đúng', () => {
    const d: BrainDraftSpec = {
      brain: 'surrogate',
      hidden: [
        { units: 16, activation: 'leakyRelu', activationParams: { alpha: 0.05 } },
        { units: 12, activation: 'swish', activationParams: { beta: 1.4 } },
      ],
      lossPerHead: [
        { type: 'bce', weight: 1 / 3 },
        { type: 'huber', weight: 1 / 3, huberDelta: 2.5 },
        { type: 'huber', weight: 1 / 3, huberDelta: 0.01 },
      ],
      hyper: defaultDraftFor('surrogate').hyper,
    }
    // inputUnits NULL = surrogate chưa đo D — vẫn validate đủ rule (không
    // chặn trần tham số — mlp.validateSpec lúc train là điểm chặn thật)
    const v = validateBrainDraft(d, null)
    expect(v.ok).toBe(true)
    if (!v.ok) return // expect trên đã fail nếu !ok — narrow cho TS
    // normalized GIỮ ĐỦ α/β/δ (chuẩn hoá chỉ DROP khóa sai activation/loss)
    expect(v.normalized.hidden[0].activationParams).toEqual({ alpha: 0.05 })
    expect(v.normalized.hidden[1].activationParams).toEqual({ beta: 1.4 })
    expect(v.normalized.lossPerHead[1].huberDelta).toBe(2.5)
    expect(v.normalized.lossPerHead[2].huberDelta).toBe(0.01)
    // Build pipeline từ CHÍNH bản normalized (đường PUT → train useDraft)
    const vocab = { models: ['m1', 'm2'], agents: ['FORGE', 'Omega'] }
    const specs = buildSurrogateSpecs(vocab, v.normalized)
    expect(specs.tokens.layers[1].activationParams).toEqual({ alpha: 0.05 })
    expect(specs.tokens.layers[2].activationParams).toEqual({ beta: 1.4 })
    // δ từng head huber → lossParams {delta} riêng (head 1 tokens · head 2 duration)
    expect(specs.tokens.lossParams).toEqual({ delta: 2.5 })
    expect(specs.durationMs.lossParams).toEqual({ delta: 0.01 })
    // head success bce (khóa hợp đồng) → KHÔNG lossParams
    expect('lossParams' in specs.success).toBe(false)
  })

  test('ENGINE NHẬN: new MLP(spec) dựng từ draft α/β/δ KHÔNG throw + predict finite (validateSpec engine là điểm chặn thật — pipeline trọn vẹn)', () => {
    const d: BrainDraftSpec = {
      brain: 'surrogate',
      hidden: [
        { units: 16, activation: 'leakyRelu', activationParams: { alpha: 0.05 } },
        { units: 12, activation: 'swish', activationParams: { beta: 1.4 } },
      ],
      lossPerHead: [
        { type: 'bce', weight: 1 / 3 },
        { type: 'huber', weight: 1 / 3, huberDelta: 2.5 },
        { type: 'huber', weight: 1 / 3, huberDelta: 0.01 },
      ],
      hyper: defaultDraftFor('surrogate').hyper,
    }
    const v = validateBrainDraft(d, null)
    expect(v.ok).toBe(true)
    if (!v.ok) return
    const vocab = { models: ['m1', 'm2'], agents: ['FORGE', 'Omega'] }
    const specs = buildSurrogateSpecs(vocab, v.normalized)
    // Cả 3 head dựng được — engine validateSpec chấp nhận α/β (hữu hạn > 0)
    // + lossParams.delta (hữu hạn > 0) từ draft
    for (const spec of [specs.success, specs.tokens, specs.durationMs]) {
      expect(() => new MLP(spec)).not.toThrow()
      const inputDim = spec.layers[0].units
      const out = new MLP(spec).predict(new Array<number>(inputDim).fill(0.5))
      expect(out).toHaveLength(1) // mỗi head 1 MLP output 1 unit (khóa hợp đồng)
      expect(out.every(Number.isFinite)).toBe(true) // forward chạy thật với α/β
    }
  })
})

// ==================== C. SOURCE-SCAN WIRING 3 SECTION + 4 TAB CONSOLE (pattern r92-E) ====================

describe('r93 · C source-scan wiring 3 SECTION — pin chống hồi quy cấu trúc BRAIN-TAB-3PHAN', () => {
  // Đọc nguồn TỪ FILE (không import — pin cả tồn tại file + nội dung wire)
  const read = (...p: string[]) => readFileSync(join(import.meta.dir, '..', 'src', ...p), 'utf-8')
  const brainTab = read('components', 'smolab', 'brain-tab.tsx')
  const studio = read('components', 'database', 'brain-studio.tsx')
  const stage = read('components', 'database', 'brain-stage.tsx')
  const trainingConsole = read('components', 'database', 'training-console.tsx')
  const reference = read('components', 'smolab', 'brain-reference.tsx') // FB-BRAIN-TAB-R1-01: pin theo CODE đã strip comment (2/12 chuỗi pin cũ quét RAW còn fallback trong header comment dòng 19-20 — xóa JSX thật pin vẫn pass)
  const surrogate = read('lib', 'brain', 'brains', 'surrogate.ts')
  const calibV3 = read('lib', 'brain', 'calibration-v3.ts')
  const policy = read('lib', 'brain', 'brains', 'policy.ts')

  /** Bỏ comment // và block — chỉ quét PHẦN CODE (helper copy NGUYÊN từ
   *  r92-E — string-aware FB-BRAIN-LIVE-R1-08: gặp ' " ` NGOÀI comment →
   *  skip tới closing quote (xử lý escape \) rồi mới quét tiếp — máy trạng
   *  thái nhỏ, không regex lồng). */
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

  const tabCode = stripComments(brainTab)
  const studioCode = stripComments(studio)
  const stageCode = stripComments(stage)
  const consoleCode = stripComments(trainingConsole)
  const surrogateCode = stripComments(surrogate)
  const calibCode = stripComments(calibV3)
  const policyCode = stripComments(policy)
  const referenceCode = stripComments(reference) // FB-BRAIN-TAB-R1-01 — cùng máy strip mọi file scan

  test('brain-tab: 3 SECTION dọc — role="region" ≥ 3 (matchAll) + 3 aria-label + KHÔNG còn máy bottom-sheet mobile (consoleSheetOpen/useIsDesktopViewport/bottom-4 right-4/DESKTOP_BREAKPOINT)', () => {
    // 3 section — mỗi section 1 Card riêng (18-c layout 3 phần)
    const regions = [...tabCode.matchAll(/role="region"/g)]
    expect(regions.length).toBeGreaterThanOrEqual(3)
    // 3 aria-label đúng tên section theo chỉ thị user
    expect(tabCode).toContain('aria-label="Chọn não và kiến trúc"')
    expect(tabCode).toContain('aria-label="Đài quan sát não theo thời gian thực"')
    expect(tabCode).toContain('aria-label="Bảng thông số điều chỉnh"')
    // CHỐNG HỒI QUY bottom-sheet (18-c bỏ hẳn — console inline mọi viewport):
    // state sheet + hook viewport + nút nổi + hằng breakpoint không còn dấu vết
    expect(tabCode).not.toContain('consoleSheetOpen')
    expect(tabCode).not.toContain('useIsDesktopViewport')
    expect(tabCode).not.toContain('bottom-4 right-4')
    expect(tabCode).not.toContain('DESKTOP_BREAKPOINT')
  })

  test("brain-tab: 4 tab console ('train' | 'tuning' | 'log' | 'ref') — PIN UPDATE Task 26: BỎ tab 'observation' (Quan sát chuyển lên SECTION 1 selector) + tab 'ref' render BrainReference + 2 chuỗi chốt r92-E còn nguyên", () => {
    // 4 giá trị tab — type state (Task 26 bỏ 'observation' theo chỉ thị user
    // 2026-10-13; 18-c gốc chỉ 4 giá trị, Task 25 từng thêm 'observation')
    expect(tabCode).toContain("'train' | 'tuning' | 'log' | 'ref'")
    expect(tabCode).not.toContain("'train' | 'tuning' | 'log' | 'ref' | 'observation'")
    // Entry tab 'ref' + nhãn hiển thị + nhánh render
    expect(tabCode).toContain("['ref', 'Hàm & công thức']")
    expect(tabCode).toContain("consoleTab === 'ref'")
    // Task 26: KHÔNG còn tab Quan sát trong SECTION 3 (chống hồi quy)
    expect(tabCode).not.toContain("['observation', 'Quan sát']")
    expect(tabCode).not.toContain("consoleTab === 'observation'")
    expect(tabCode).not.toContain('ObservationTabContent')
    // BrainReference — bảng tham chiếu (18-c NEW FILE) import + render
    expect(tabCode).toContain("import { BrainReference } from '@/components/smolab/brain-reference'")
    expect(tabCode).toContain('<BrainReference />')
    // 2 chuỗi chốt r92-E GIỮ NGUYÊN khi tái cấu trúc (phần còn lại của r92-E
    // do `bun test tests/r92-brain-live.test.ts` chứng minh — mục D, no-code)
    expect(tabCode).toContain('&head=${activityHead}') // template fetch activity
    expect(tabCode).toMatch(/\btall\b/) // prop tall truyền BrainStage
  })

  test('TASK 26 (chỉ thị user 2026-10-13): SECTION 1 có khối "Chế độ quan sát" tablist 4 nút (OBS_MODES single-source) + state obsMode + nhãn giải thích', () => {
    // Import 4 panel + OBS_MODES + type ObsMode từ observation-tab (refactor 4 panel)
    expect(tabCode).toContain("from '@/components/smolab/observation-tab'")
    expect(tabCode).toContain('OBS_MODES')
    expect(tabCode).toContain('ObsNeuronsPanel')
    expect(tabCode).toContain('ObsTimelinePanel')
    expect(tabCode).toContain('ObsTracesPanel')
    expect(tabCode).toContain('ObsGoldenPanel')
    // State obsMode (useState — không localStorage) + mặc định 'neurons'
    expect(tabCode).toContain("useState<ObsMode>('neurons')")
    // Khối selector trong SECTION 1: tablist + aria-label + nhãn giải thích
    // (chỉ thị user: "chọn quan sát cái gì ở trên thì xem được ở đài bên dưới")
    expect(tabCode).toContain('Chế độ quan sát')
    expect(tabCode).toContain('aria-label="Chế độ quan sát"')
    expect(tabCode).toContain('nội dung hiển thị dưới đài quan sát bên dưới')
    // Tablist pattern console (min-h-44 mobile) dùng chung cho selector
    expect(tabCode).toContain('min-h-[44px] md:min-h-[32px]')
  })

  test('TASK 26: SECTION 2 có PANEL QUAN SÁT NGAY DƯỚI ĐÀI — 4 panel render theo obsMode (mount/unmount → poll dừng) + BrainStage nhận backprop/training (hợp đồng 26-BE) + poll thích ứng', () => {
    // 4 nhánh render theo obsMode — panel nằm trong SECTION 2 (sau BrainStage)
    expect(tabCode).toContain("obsMode === 'neurons'")
    expect(tabCode).toContain("obsMode === 'timeline'")
    expect(tabCode).toContain("obsMode === 'traces'")
    expect(tabCode).toContain("obsMode === 'golden'")
    // neurons panel dùng CÙNG activity fetch của đài (1 poller duy nhất — B5)
    expect(tabCode).toContain('activity={activity}')
    expect(tabCode).toContain('ObsNeuronsPanel activity={activity}')
    // BrainStage props hợp đồng 26-BE (đường ngược vàng + chip ĐANG TRAIN)
    expect(tabCode).toContain('backprop={activity?.backprop ?? null}')
    expect(tabCode).toContain('training={activity?.training ?? null}')
    // Poll thích ứng 1.5s/10s (Task 26 B5 — thay setInterval 2.5s của 15-d)
    expect(tabCode).toContain('POLL_HOT_MS')
    expect(tabCode).toContain('POLL_CALM_MS')
    // fetchActivity phòng thủ hợp đồng: đọc json.backprop + json.training
    expect(tabCode).toContain('json.backprop')
    expect(tabCode).toContain('json.training')
  })

  test('brain-studio: segmented chọn não (aria-pressed + b.key === selectedKey + grid responsive — PIN UPDATE R24-b: 4 nút não sau Brain-D ghost §8.5, sm:grid-cols-3 → sm:grid-cols-2 lg:grid-cols-4) + α/β editor (DRAFT_LIMITS alphaMin/betaMin + nhánh leakyRelu/swish + placeholder default) + KHÔNG còn selectorOpen', () => {
    // Segmented chọn não (18-b thay dropdown — bấm trực tiếp)
    // PIN UPDATE (R24-b Brain-D ghost 2026-10-17): grid 1 cột mobile /
    // 2 cột sm / 4 cột lg cho 4 nút não (Tri Thức là nút thứ 4 — §8.5.1).
    expect(studioCode).toContain('sm:grid-cols-2')
    expect(studioCode).toContain('lg:grid-cols-4')
    expect(studioCode).toContain('b.key === selectedKey')
    expect(studioCode).toContain('aria-pressed={sel}')
    // α/β editor (18-d field → 18-b UI dòng 4 chip lớp ẩn)
    expect(studioCode).toContain("h.activation === 'leakyRelu' || h.activation === 'elu'") // nhánh α
    expect(studioCode).toContain("h.activation === 'swish'") // nhánh β
    expect(studioCode).toContain('min={DRAFT_LIMITS.alphaMin} max={DRAFT_LIMITS.alphaMax}')
    expect(studioCode).toContain('min={DRAFT_LIMITS.betaMin} max={DRAFT_LIMITS.betaMax}')
    expect(studioCode).toContain('placeholder={String(alphaDefault)}') // default α 0.01/1.0
    expect(studioCode).toContain('placeholder={String(BETA_DEFAULT)}') // default β 1.0
    // Dropdown cũ đã bỏ (18-b) — chống hồi quy
    expect(studioCode).not.toContain('selectorOpen')
  })

  test('brain-stage TASK 26: nơ-ron TÍM tỏa sáng (radial #c084fc + rgba(168,85,247) + HALO r×2.2) + cạnh THẲNG (KHÔNG bezier) + đường NGƯỢC vàng per-edge thật (bwdSignal |δ×a|, EDGE_PARALLEL_OFFSET, KHÔNG vẽ khi null) + canvas hạt 60fps (rAF + MAX_PARTICLES + lighter) + wheel/pan rAF coalesce + weights cache + giữ vỏ BRAIN-LIVE (ResizeObserver + layout.width + layout.radius + stageBox 440/520/600)', () => {
    // Task 26 B2 — nơ-ron tím: radial gradient + core violet + halo
    expect(stageCode).toContain('id="bs-neuron"')
    expect(stageCode).toContain('#c084fc')
    expect(stageCode).toContain('rgba(168,85,247')
    expect(stageCode).toContain('r={rC * 2.2}') // HALO r ≈ rC×2.2
    // Task 26 B1 — cạnh THẲNG: KHÔNG còn import bezier (path C cubic bỏ)
    expect(stageCode).not.toContain('bezierControls')
    // Task 26 B3 — đường ngược vàng per-edge THẬT: gradient bs-bwd giữ +
    // bwdSignal |δ×a| + lệch song song EDGE_PARALLEL_OFFSET + gate 0.5%
    expect(stageCode).toContain('url(#bs-bwd)')
    expect(stageCode).toContain('bwdSignal')
    expect(stageCode).toContain('EDGE_PARALLEL_OFFSET')
    expect(stageCode).toContain('SIGNAL_GATE_RATIO')
    // Task 26 B4 — canvas hạt thật 60fps: rAF loop + cap + sprite lighter
    expect(stageCode).toContain('canvasRef')
    expect(stageCode).toContain('MAX_PARTICLES')
    expect(stageCode).toContain("globalCompositeOperation = 'lighter'")
    expect(stageCode).toContain('requestAnimationFrame')
    expect(stageCode).toContain('PARTICLE_SPEED_PX')
    // Tắt hạt khi ẩn/reduced-motion (SVG tĩnh vẫn đẹp)
    expect(stageCode).toContain('document.hidden')
    expect(stageCode).toContain('prefers-reduced-motion')
    // Task 26 B5 — wheel/pan gom sự kiện áp 1 lần/frame qua rAF
    expect(stageCode).toContain('pendingWheelRef')
    expect(stageCode).toContain('panPendingRef')
    // Weights cache theo brain+head trong ref + AbortController
    expect(stageCode).toContain('weightsCacheRef')
    expect(stageCode).toContain('AbortController')
    // GIỮ vỏ BRAIN-TAB-3PHAN (đối chứng r93 cũ)
    expect(stageCode).toContain('ResizeObserver')
    expect(stageCode).toContain('layout.width')
    expect(stageCode).toContain('baseView')
    expect(stageCode).toContain('layout.radius')
    expect(stageCode).toContain('h-[440px]')
    expect(stageCode).toContain('md:h-[520px]')
    expect(stageCode).toContain('xl:h-[600px]')
    // Màu chỉ thị user giữ: tiến XANH emerald + ngược VÀNG yellow
    expect(stageCode).toContain('rgba(16,185,129')
    expect(stageCode).toContain('rgba(250,204,21')
  })

  test("training-console: hằng optimizer khóa engine (import SGD_MOMENTUM/ADAM_BETA1 từ optimizers) + input δ Huber chỉ head loss='huber' (field huberDelta)", () => {
    // Nhóm A — hiển thị hằng TRUNG THỰC từ engine (không hardcode số)
    expect(consoleCode).toContain("import { SGD_MOMENTUM, ADAM_BETA1, ADAM_BETA2, ADAM_EPSILON } from '@/lib/brain/optimizers'")
    expect(consoleCode).toContain('β={SGD_MOMENTUM}')
    expect(consoleCode).toContain('β₁={ADAM_BETA1}')
    // Nhóm B — δ Huber: input render khi h.type === 'huber', default ?? 1
    expect(consoleCode).toContain("h.type === 'huber'")
    expect(consoleCode).toContain('h.huberDelta ?? 1')
    expect(consoleCode).toContain('δ Huber đầu ra ${names[i]}') // aria-label input δ
    // FB-BRAIN-TAB-R1-03: min/max input δ dùng DRAFT_LIMITS (không hardcode
    // 0.01/10 — nhất quán input α/β Brain Studio)
    expect(consoleCode).toContain('min={DRAFT_LIMITS.huberDeltaMin} max={DRAFT_LIMITS.huberDeltaMax}')
  })

  test('brain-reference (CODE — stripComments FB-BRAIN-TAB-R1-01): ACTIVATION_MENU import + hằng SGD_MOMENTUM + 4 loss (crossEntropy + bce kèm sigmoid) + composite reward (w₁) + lan truyền tiến/ngược — bảng tham chiếu đầy đủ', () => {
    // 9 activation render từ ACTIVATION_MENU single-source (spec-schema)
    expect(referenceCode).toContain("import { ACTIVATION_MENU } from '@/lib/brain/spec-schema'")
    expect(referenceCode).toContain('ACTIVATION_MENU.map')
    // Hằng optimizer import từ optimizers.ts (DÙNG biến — không hardcode)
    expect(referenceCode).toContain("from '@/lib/brain/optimizers'")
    expect(referenceCode).toContain('SGD_MOMENTUM')
    // 4 loss đầy đủ (bce/mse/huber/crossEntropy — khóa/chọn được)
    expect(referenceCode).toContain("'crossEntropy'")
    expect(referenceCode).toContain('Hàm mất mát (4 hàm)')
    // FB-BRAIN-TAB-R1-02: bce deriv có qualifier cặp gộp (kèm sigmoid) —
    // nhất quán dòng crossEntropy '(kèm softmax)' + phụ đề mục 2 "∂L/∂ŷ"
    expect(referenceCode).toContain("deriv: 'ŷ − y (kèm sigmoid)'")
    // Composite reward (§3.1 — LOG-ONLY nhóm C)
    expect(referenceCode).toContain('composite')
    expect(referenceCode).toContain('R = w₁·Outcome* + w₂·Efficiency* + w₃·Quality*')
    // Lan truyền tiến + ngược (công thức + đạo hàm — câu hỏi user)
    expect(referenceCode).toContain('aˡ = φ(Wˡ·aˡ⁻¹ + bˡ)')
    expect(referenceCode).toContain('δᴸ = ∇L ⊙ φ′(zᴸ)')
    expect(referenceCode).toContain('δˡ = (Wˡ⁺¹)ᵀ·δˡ⁺¹ ⊙ φ′(zˡ)')
  })

  test('surrogate.ts: lossParams + huberDelta — pipeline THẬT nhận δ (head huber → lossParams {delta} từng head)', () => {
    expect(surrogateCode).toContain("lossTokens === 'huber' && typeof headTokens?.huberDelta === 'number'")
    expect(surrogateCode).toContain('{ lossParams: { delta: headTokens.huberDelta } }')
    expect(surrogateCode).toContain('{ lossParams: { delta: headDur.huberDelta } }')
    // α/β lớp ẩn cũng truyền (conditional spread — không key undefined)
    expect(surrogateCode).toContain('activationParams')
  })

  test('calibration-v3.ts + policy.ts: activationParams — pipeline truyền α/β từ draft qua engine', () => {
    expect(calibCode).toContain('activationParams')
    expect(calibCode).toContain('...(h.activationParams ? { activationParams: h.activationParams } : {})')
    expect(policyCode).toContain('activationParams')
    expect(policyCode).toContain('...(h.activationParams ? { activationParams: h.activationParams } : {})')
  })
})
