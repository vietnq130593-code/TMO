/**
 * ROUND-97 TESTS — OBS-P3 · UI TAB "QUAN SÁT" (tab BRAIN › SECTION 3)
 * (BLUEPRINT-OBSERVATION-P1-P4 §C.5 — chốt §7 Task 23 2026-10-13; Task 25
 * tích hợp vào tab BRAIN theo chỉ thị user cùng ngày)
 *
 * Pattern: SOURCE-SCAN (r92-E precedent — pin chống hồi quy cấu trúc wiring
 * UI, không render thật) + PURE helper kinds.ts (import trực tiếp).
 *
 * Đo lường:
 *   A. kinds.ts pure: 16 kind · obsKindDef tra đúng nhóm · kind lạ → null
 *      (fail-open) · OBS_GROUP_CLASSES đủ 7 nhóm (token tĩnh) · obsActorClass
 *      map đúng 4 nhánh actor.
 *   B. observation-tab.tsx wiring: fetch '/api/observation/timeline' +
 *      '/api/brain' (panel nhãn&não single-source) · poll thích ứng
 *      POLL_ACTIVE_MS=2_500 / POLL_IDLE_MS=15_000 + visibilitychange (pattern
 *      brain-tab 15-d) · kim tuyến (input runId + 'Theo dõi' + GitBranch +
 *      runSummary durationMs) · filter bar (select kind + actor + since) ·
 *      drill-down Dialog payload (precedent tuning-param-dialog) ·
 *      max-h-96 overflow-y-auto (long-list rule) · min-h-[44px] (touch) ·
 *      aria-live + aria-label · off-state cờ ui_observation + nút bật nhanh
 *      POST /api/neural-architecture (precedent hitech-toggle) · chip 4 cờ.
 *   C. brain-tab.tsx (Task 25): tab 'observation' đăng ký trong SECTION 3
 *      (consoleTab union 5 giá trị + entry tablist + render
 *      ObservationTabContent KHÔNG kèm onOpenBrainTab — đã ở trong tab BRAIN)
 *      + smolab-module KHÔNG còn tab riêng (chống hồi quy) + localStorage cũ
 *      'observation' chuyển hướng sang 'brain'.
 *   D. timeline route: contract source — validate limit/before/since + KHÔNG
 *      có lệnh ghi (create/update/deleteMany) trong route (READ-ONLY §C.4 —
 *      đối chứng behavioral r96-E).
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  OBS_KINDS, obsKindDef, OBS_GROUP_CLASSES, obsActorClass,
  type ObsKindGroup,
} from '@/lib/observation/kinds'

const readSrc = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf-8')
const tab = readSrc('src/components/smolab/observation-tab.tsx')
const brainTab = readSrc('src/components/smolab/brain-tab.tsx')
const smolab = readSrc('src/components/smolab/smolab-module.tsx')
const route = readSrc('src/app/api/observation/timeline/route.ts')

// ==================== A. kinds.ts — pure (single-source kind) ====================

describe('r97 · A — kinds.ts pure helpers', () => {
  test('A1 OBS_KINDS 16 kind đủ nhóm + nhãn tiếng Việt', () => {
    expect(OBS_KINDS.length).toBe(16)
    expect(OBS_KINDS.every(k => k.label.length > 0 && k.kind.includes('.'))).toBe(true)
    const groups = new Set(OBS_KINDS.map(k => k.group))
    expect([...groups].sort()).toEqual(['brain', 'db', 'impact', 'reward', 'run', 'search', 'tuning'])
  })

  test('A2 obsKindDef — tra đúng, kind lạ null (fail-open)', () => {
    expect(obsKindDef('run.start')?.group).toBe('run')
    expect(obsKindDef('brain.infer-ref')?.group).toBe('brain')
    expect(obsKindDef('impact.estimate')?.group).toBe('impact')
    expect(obsKindDef('khong-ton.tai')).toBeNull()
  })

  test('A3 OBS_GROUP_CLASSES 7 nhóm — token Tailwind tĩnh (không ghép chuỗi)', () => {
    const groups: ObsKindGroup[] = ['run', 'db', 'brain', 'tuning', 'reward', 'search', 'impact']
    for (const g of groups) {
      expect(OBS_GROUP_CLASSES[g]).toMatch(/^bg-\S+ \S+ border-\S+$/)
    }
  })

  test('A4 obsActorClass — 4 nhánh actor + default', () => {
    expect(obsActorClass('agent:opus')).toContain('emerald')
    expect(obsActorClass('brain:policy')).toContain('violet')
    expect(obsActorClass('user')).toContain('sky')
    expect(obsActorClass('search')).toContain('cyan')
    expect(obsActorClass('system')).toContain('stone') // default fail-open
  })
})

// ==================== B. observation-tab wiring (source-scan) ====================

describe('r97 · B — observation-tab.tsx wiring (§C.5)', () => {
  test('B1 nguồn dữ liệu: timeline + /api/brain (panel nhãn&não — C.5-4)', () => {
    expect(tab).toContain('fetch(`/api/observation/timeline?') // template literal — query động
    expect(tab).toContain("fetch('/api/brain')")
    expect(tab).toContain('computeLabelTotal') // breakdown tổng nhãn GAP-8 — tái dùng registry (single-source)
  })

  test('B2 poll thích ứng 2,5s/15s + visibilitychange (pattern brain-tab 15-d)', () => {
    expect(tab).toContain('POLL_ACTIVE_MS = 2_500')
    expect(tab).toContain('POLL_IDLE_MS = 15_000')
    expect(tab).toContain('visibilitychange')
    expect(tab).toContain("document.visibilityState === 'hidden'")
  })

  test('B3 kim tuyến (C.5-3): input runId + Theo dõi + runSummary + traces join', () => {
    expect(tab).toContain('Kim tuyến runId')
    expect(tab).toContain('runIdInput')
    expect(tab).toContain('startGoldenThread')
    expect(tab).toContain('runSummary')
    expect(tab).toContain('data.traces') // vết suy diễn não của run (C.4 join)
    expect(tab).toContain('đang chạy') // trạng thái run chưa kết thúc
  })

  test('B4 filter bar (C.5-2): kind select từ response.kinds + actor + since', () => {
    expect(tab).toContain('value={kindFilter}')
    expect(tab).toContain('data?.kinds ?? []') // single-source kinds từ API — không hardcode UI
    expect(tab).toContain('value={actorFilter}')
    expect(tab).toContain('value={sinceFilter}')
  })

  test('B5 drill-down payload Dialog (precedent tuning-param-dialog)', () => {
    expect(tab).toContain('Dialog open={detail !== null}')
    expect(tab).toContain('JSON.stringify(detail.payload, null, 2)')
    expect(tab).toContain('seq {detail?.seq}')
  })

  test('B6 long-list + touch + a11y: max-h-96 scroll · min-h-[44px] · aria-live · role region', () => {
    expect(tab).toContain('max-h-96 overflow-y-auto')
    expect(tab).toContain('min-h-[44px]')
    expect(tab).toContain('aria-live="polite"')
    expect(tab).toContain('role="region"')
    expect(tab).toContain('aria-label="Quan sát vận hành')
  })

  test('B7 off-state cờ ui_observation: chip 4 cờ + nút bật nhanh qua neural-architecture', () => {
    expect(tab).toContain('ui_observation')
    expect(tab).toContain('obs_ledger') // chip trạng thái
    expect(tab).toContain("fetch('/api/neural-architecture'")
    expect(tab).toContain("{ action: 'set', key: 'ui_observation', value: 'on' }")
    expect(tab).toContain('Bật ngay')
  })

  test('B8 cảnh báo trung thực khi obs_ledger off (dữ liệu ngừng ghi mới)', () => {
    expect(tab).toContain('không có sự kiện MỚI được')
    expect(tab).toContain('OBS_LEDGER')
  })

  test('B9 import kinds từ lib (single-source doctrine #9 — KHÔNG định nghĩa kind trong UI)', () => {
    expect(tab).toContain("from '@/lib/observation/kinds'")
    expect(tab).not.toContain("kind: 'run.start',") // không khai báo kind mới trong UI
    // FB-OBS-R1-07: bỏ bản sao map 16-kind cục bộ — chip màu tra obsKindDef
    // single-source (thêm kind mới ở kinds.ts tự đúng màu, không trùng lặp map)
    expect(tab).not.toContain('KIND_CLASS_MAP')
    expect(tab).not.toContain('KIND_FALLBACK')
    expect(tab).toContain('obsKindDef(kind)?.group')
  })

  test('B10 lỗi tải phải hiển thị cả khi chưa có data (FB-OBS-R1-12 — không treo spinner vô hạn)', () => {
    // trước đây loadError chỉ render trong nhánh ĐÃ có data (data≠null) —
    // fetch hỏng kéo dài → spinner "Đang tải…" vô hạn, không bao giờ hiện lỗi
    expect(tab).toContain('— thử lại')
    expect(tab).toMatch(/initialLoading &&[\s\S]*?loadError/)
  })
})

// ==================== C. brain-tab SECTION 3 đăng ký tab Quan sát (Task 25) ====================

describe('r97 · C — tab Quan sát tích hợp VÀO tab BRAIN › SECTION 3 (chỉ thị user 2026-10-13 Task 25)', () => {
  test('C1 consoleTab union 5 giá trị + entry tablist sau "Hàm & công thức"', () => {
    expect(brainTab).toContain("'train' | 'tuning' | 'log' | 'ref' | 'observation'")
    const refIdx = brainTab.indexOf("['ref', 'Hàm & công thức']")
    const obsIdx = brainTab.indexOf("['observation', 'Quan sát']")
    expect(refIdx).toBeGreaterThan(0)
    expect(obsIdx).toBeGreaterThan(refIdx) // tab Quan sát ở CUỐI tablist
    expect(brainTab).toContain("consoleTab === 'observation'")
  })

  test('C2 render ObservationTabContent — KHÔNG truyền onOpenBrainTab (đã ở trong tab BRAIN, prop đã gỡ)', () => {
    expect(brainTab).toContain("import { ObservationTabContent } from '@/components/smolab/observation-tab'")
    expect(brainTab).toContain('<ObservationTabContent />')
    // prop + nút "Mở tab BRAIN" gỡ sạch ở CẢ 2 file (không đường navigate chéo)
    expect(brainTab).not.toContain('onOpenBrainTab')
    expect(tab).not.toContain('onOpenBrainTab')
    expect(tab).not.toContain('Mở tab BRAIN')
  })

  test('C3 smolab-module KHÔNG còn tab riêng cấp module (chống hồi quy — chỉ đăng ký qua SECTION 3)', () => {
    expect(smolab).not.toContain("{ id: 'observation'")
    expect(smolab).not.toContain("activeSmolabTab === 'observation'")
    // localStorage cũ 'observation' chuyển hướng sang 'brain' (không rơi về knowledge)
    expect(smolab).toContain("if (saved === 'observation')")
    expect(smolab).toContain("saved = 'brain'")
  })
})

// ==================== D. timeline route — contract source ====================

describe('r97 · D — timeline route contract (đối chứng behavioral r96)', () => {
  test('D1 validate: limit 1–200 + before ≥ 1 + since ISO (400 rác)', () => {
    expect(route).toContain('MAX_LIMIT = 200')
    expect(route).toContain('DEFAULT_LIMIT = 50')
    expect(route).toContain('status: 400')
  })

  test('D2 READ-ONLY source — KHÔNG có create/update/delete trong route', () => {
    expect(route).not.toContain('.create(')
    expect(route).not.toContain('.update(')
    expect(route).not.toContain('.deleteMany(')
    expect(route).not.toContain('.upsert(')
    expect(route).toContain('findMany') // chỉ SELECT
    expect(route).toContain('count')
  })

  test('D3 join traces CHỈ khi có runId + trả kinds catalog (C.4)', () => {
    expect(route).toContain('if (runId)')
    expect(route).toContain('brainInferenceTrace.findMany')
    expect(route).toContain('kinds: OBS_KINDS')
  })

  test('D4 flags 4 cờ trong response (UI hiển thị trạng thái quan sát)', () => {
    expect(route).toContain("safeFlag('obs_ledger')")
    expect(route).toContain("safeFlag('obs_brain_trace')")
    expect(route).toContain("safeFlag('obs_impact')")
    expect(route).toContain("safeFlag('ui_observation')")
  })
})
