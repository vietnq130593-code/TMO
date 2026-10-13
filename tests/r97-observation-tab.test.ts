/**
 * ROUND-97 TESTS — OBS-P3 · UI QUAN SÁT (PIN UPDATE Task 26 — 4 PANEL)
 * (BLUEPRINT-OBSERVATION-P1-P4 §C.5; chỉ thị user 2026-10-13 Task 26,
 * nguyên văn: "tab Quan sát trong Bảng thông số nên tích hợp vào ô Chọn não
 * và kiến trúc — chọn xong não nào có thể xem ngay dưới đài quan sát não,
 * và chọn quan sát cái gì ở trên thì xem được ở đài bên dưới" — Task 26
 * refactor observation-tab.tsx thành 4 panel mount/unmount theo obsMode)
 *
 * Pattern: SOURCE-SCAN (r92-E precedent — pin chống hồi quy cấu trúc wiring
 * UI, không render thật) + PURE helper kinds.ts (import trực tiếp).
 *
 * Đo lường:
 *   A. kinds.ts pure: ≥ 16 kind (hợp đồng 26-BE thêm obs.alert nhóm alert —
 *      chấp nhận CẢ 2 trạng thái BE đã/chưa land) · obsKindDef tra đúng
 *      nhóm · kind lạ → null (fail-open) · OBS_GROUP_CLASSES đủ 7 nhóm gốc
 *      (token tĩnh) · obsActorClass map đúng 4 nhánh actor.
 *   B. observation-tab.tsx wiring (PIN UPDATE Task 26 — refactor 4 panel):
 *      export OBS_MODES (4 chế độ single-source cho selector SECTION 1) +
 *      type ObsMode + 4 panel component (ObsNeuronsPanel / ObsTimelinePanel /
 *      ObsTracesPanel / ObsGoldenPanel) · hook chia sẻ useObsFeed tái dùng
 *      nguyên logic polling Task 25 (POLL_ACTIVE_MS=2_500 / POLL_IDLE_MS=
 *      15_000 + visibilitychange) · fetch template '/api/observation/timeline?'
 *      · filter bar kind/actor/since · kim tuyến (input runId + Theo dõi +
 *      Xóa + runSummary durationMs + data.traces join) · traces panel lọc
 *      ?brain= (hợp đồng 26-BE) + chip obs_brain_trace + trung thực trống ·
 *      neurons panel: bảng activation thật (min/max/mean |a| + thanh cường
 *      độ + featureNames top nơ-ron sáng nhất) + chip "Agent đang chạy" +
 *      chip "ĐANG TRAIN" + dòng backprop TRUNG THỰC (có/không gradient mẫu
 *      thật — không bịa) + dùng CÙNG activity prop của đài (không fetch
 *      riêng) · alerts24h (hợp đồng 26-BE — thiếu thì 0, hiển thị badge) ·
 *      off-state cờ ui_observation + nút bật nhanh POST
 *      /api/neural-architecture (precedent hitech-toggle) · drill-down
 *      Dialog payload (precedent tuning-param-dialog) · max-h-96
 *      overflow-y-auto (long-list rule) · min-h-[44px] (touch) · aria-live
 *      + role region.
 *   C. brain-tab.tsx (Task 26): SECTION 1 đăng ký selector 4 chế độ
 *      (OBS_MODES + useState<ObsMode>('neurons') + tablist aria-label
 *      "Chế độ quan sát") · SECTION 2 render 4 panel theo obsMode + BrainStage
 *      nhận backprop/training (hợp đồng 26-BE) · BỎ tab 'observation' khỏi
 *      SECTION 3 (union 4 giá trị 'train'|'tuning'|'log'|'ref' + KHÔNG còn
 *      ObservationTabContent) + smolab-module KHÔNG còn tab riêng (chống
 *      hồi quy) + localStorage cũ 'observation' chuyển hướng sang 'brain'.
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
  test('A1 OBS_KINDS ≥ 16 kind đủ nhóm gốc + nhãn tiếng Việt (PIN UPDATE Task 26 — hợp đồng 26-BE thêm obs.alert nhóm alert)', () => {
    // PIN UPDATE Task 26: Task 25 có 16 kind; hợp đồng 26-BE thêm obs.alert
    // (nhóm alert) — pin chịu CẢ 2 trạng thái (BE triển khai song song).
    expect(OBS_KINDS.length).toBeGreaterThanOrEqual(16)
    expect(OBS_KINDS.every(k => k.label.length > 0 && k.kind.includes('.'))).toBe(true)
    const groups = new Set(OBS_KINDS.map(k => k.group))
    // 7 nhóm gốc Task 25 luôn đủ (BE chỉ THÊM, không bớt)
    for (const g of ['run', 'db', 'brain', 'tuning', 'reward', 'search', 'impact'] as const) {
      expect(groups.has(g)).toBe(true)
    }
    // Hợp đồng 26-BE: obs.alert → nhóm 'alert' (khi BE đã land)
    const alertDef = obsKindDef('obs.alert')
    if (alertDef) expect(alertDef.group).toBe('alert')
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

// ==================== B. observation-tab wiring (source-scan — PIN UPDATE Task 26: 4 panel) ====================

describe('r97 · B — observation-tab.tsx wiring (§C.5 — Task 26 refactor 4 panel)', () => {
  test('B1 cấu trúc 4 panel: export OBS_MODES + ObsMode + 4 panel component (single-source nhãn selector SECTION 1)', () => {
    expect(tab).toContain("export type ObsMode = 'neurons' | 'timeline' | 'traces' | 'golden'")
    expect(tab).toContain('export const OBS_MODES')
    // 4 chế độ đúng nhãn chỉ thị user
    expect(tab).toContain("{ id: 'neurons', label: 'Hoạt động nơ-ron' }")
    expect(tab).toContain("{ id: 'timeline', label: 'Timeline sự kiện' }")
    expect(tab).toContain("{ id: 'traces', label: 'Vết suy luận' }")
    expect(tab).toContain("{ id: 'golden', label: 'Kim tuyến runId' }")
    // 4 panel export (mặc định 'neurons' theo spec)
    expect(tab).toContain('export function ObsNeuronsPanel')
    expect(tab).toContain('export function ObsTimelinePanel')
    expect(tab).toContain('export function ObsTracesPanel')
    expect(tab).toContain('export function ObsGoldenPanel')
    // KHÔNG còn component Task 25 (đã tách panel — chống hồi quy cấu trúc cũ)
    expect(tab).not.toContain('export function ObservationTabContent')
  })

  test('B2 poll thích ứng 2,5s/15s + visibilitychange (tái dùng nguyên logic Task 25 — KHÔNG viết lại từ đầu)', () => {
    expect(tab).toContain('POLL_ACTIVE_MS = 2_500')
    expect(tab).toContain('POLL_IDLE_MS = 15_000')
    expect(tab).toContain('visibilitychange')
    expect(tab).toContain("document.visibilityState === 'hidden'")
    // Hook chia sẻ 3 panel events (timeline/golden/traces) — 1 nguồn logic poll
    expect(tab).toContain('useObsFeed')
    expect(tab).toContain("kind: 'timeline' | 'golden' | 'traces'")
    // fetch timeline template literal (query động theo mode) — PIN UPDATE
    // 2026-11-05: bọc fetchWithTransientRetry (429 gateway retry — user report
    // console error HTTP 429; template URL + signal giữ nguyên)
    expect(tab).toContain('fetchWithTransientRetry(`/api/observation/timeline?${q.toString()}`')
  })

  test('B3 neurons panel: bảng activation thật từ CÙNG activity prop của đài (không fetch riêng) + chips Agent/ĐANG TRAIN + dòng backprop TRUNG THỰC', () => {
    // Bảng: mỗi lớp 1 hàng — nhãn + units + min/max/mean |a| + thanh cường độ
    expect(tab).toContain('min |a|')
    expect(tab).toContain('max |a|')
    expect(tab).toContain('mean |a|')
    expect(tab).toContain('Cường độ')
    // Lớp input hiện tên đặc trưng top nơ-ron sáng nhất (featureNames có sẵn)
    expect(tab).toContain('Nơ-ron input sáng nhất')
    // Header chips: Agent đang chạy (pulse) + ĐANG TRAIN (training.brain === não chọn)
    expect(tab).toContain('● Agent đang chạy')
    expect(tab).toContain('● ĐANG TRAIN')
    expect(tab).toContain('activity.training.brain === brainKey')
    // Dòng backprop TRUNG THỰC (chỉ thị user TUYỆT ĐỐI KHÔNG tượng trưng)
    expect(tab).toContain('Gradient mẫu thật sẵn sàng')
    expect(tab).toContain('Chưa có gradient thật (não dormant / thiếu nhãn)')
    // neurons panel nhận activity qua props (CÙNG fetch của đài — 1 poller)
    expect(tab).toContain('activity: ObsActivity | null')
    // Đọc cờ ui_observation bằng 1 fetch nhẹ limit=1 (KHÔNG poll riêng)
    expect(tab).toContain('limit=${TRACES_EVENTS_LIMIT}')
  })

  test('B4 timeline panel: filter bar kind/actor/since + alerts24h badge (hợp đồng 26-BE) + obs_ledger cảnh báo', () => {
    expect(tab).toContain('value={kindFilter}')
    expect(tab).toContain('data?.kinds ?? []') // single-source kinds từ API — không hardcode UI
    expect(tab).toContain('value={actorFilter}')
    expect(tab).toContain('value={sinceFilter}')
    // alerts24h (hợp đồng 26-BE — thiếu thì coi như 0, badge khi > 0)
    expect(tab).toContain('alerts24h?: number')
    expect(tab).toContain('cảnh báo 24h')
    // Cảnh báo obs_ledger off (dữ liệu ngừng ghi mới) — trung thực
    expect(tab).toContain('không có sự kiện MỚI được')
    expect(tab).toContain('OBS_LEDGER')
  })

  test('B5 traces panel: lọc ?brain= theo não đang chọn (hợp đồng 26-BE) + chip obs_brain_trace + trung thực trống', () => {
    expect(tab).toContain("q.set('brain', brainKey)")
    expect(tab).toContain('obs_brain_trace=')
    expect(tab).toContain('BrainInferenceTrace')
    // Trạng thái trống TRUNG THỰC (không bịa vết suy luận)
    expect(tab).toContain('Chưa có vết suy luận nào')
  })

  test('B6 golden panel: kim tuyến (C.5-3) — input runId + Theo dõi/Xóa + runSummary + traces join', () => {
    expect(tab).toContain('Kim tuyến runId')
    expect(tab).toContain('runIdInput')
    expect(tab).toContain('startGoldenThread')
    expect(tab).toContain('clearGoldenThread')
    expect(tab).toContain('runSummary')
    expect(tab).toContain('data.traces') // vết suy diễn não của run (C.4 join)
    expect(tab).toContain('đang chạy') // trạng thái run chưa kết thúc
    expect(tab).toContain('aria-label="Xóa kim tuyến"')
  })

  test('B7 drill-down payload Dialog (precedent tuning-param-dialog)', () => {
    expect(tab).toContain('Dialog open={detail !== null}')
    expect(tab).toContain('JSON.stringify(detail.payload, null, 2)')
    expect(tab).toContain('seq {detail?.seq}')
  })

  test('B8 long-list + touch + a11y: max-h-96 scroll · min-h-[44px] · aria-live · role region (4 panel)', () => {
    expect(tab).toContain('max-h-96 overflow-y-auto')
    expect(tab).toContain('min-h-[44px]')
    expect(tab).toContain('aria-live="polite"')
    expect(tab).toContain('role="region"')
    expect(tab).toContain('aria-label="Quan sát vận hành')
    expect(tab).toContain('aria-label="Quan sát hoạt động nơ-ron')
    expect(tab).toContain('aria-label="Quan sát vết suy luận não')
    expect(tab).toContain('aria-label="Quan sát kim tuyến runId')
  })

  test('B9 off-state cờ ui_observation: nút bật nhanh qua neural-architecture (4 panel dùng chung ObsOffBox)', () => {
    expect(tab).toContain('ui_observation')
    expect(tab).toContain('obs_ledger') // chip trạng thái
    expect(tab).toContain("fetch('/api/neural-architecture'")
    expect(tab).toContain("{ action: 'set', key: 'ui_observation', value: 'on' }")
    expect(tab).toContain('Bật ngay')
    expect(tab).toContain('ObsOffBox')
  })

  test('B10 import kinds từ lib (single-source doctrine #9 — KHÔNG định nghĩa kind trong UI)', () => {
    expect(tab).toContain("from '@/lib/observation/kinds'")
    expect(tab).not.toContain("kind: 'run.start',") // không khai báo kind mới trong UI
    // FB-OBS-R1-07: bỏ bản sao map 16-kind cục bộ — chip màu tra obsKindDef
    // single-source (thêm kind mới ở kinds.ts tự đúng màu, không trùng lặp map)
    expect(tab).not.toContain('KIND_CLASS_MAP')
    expect(tab).not.toContain('KIND_FALLBACK')
    expect(tab).toContain('obsKindDef(kind)?.group')
  })

  test('B11 lỗi tải phải hiển thị cả khi chưa có data (FB-OBS-R1-12 — không treo spinner vô hạn)', () => {
    // trước đây loadError chỉ render trong nhánh ĐÃ có data (data≠null) —
    // fetch hỏng kéo dài → spinner "Đang tải…" vô hạn, không bao giờ hiện lỗi
    expect(tab).toContain('— thử lại')
    expect(tab).toMatch(/initialLoading &&[\s\S]*?loadError/)
  })
})

// ==================== C. brain-tab — Task 26: selector SECTION 1 + panel SECTION 2 (chỉ thị user 2026-10-13) ====================

describe('r97 · C — tab Quan sát tích hợp VÀO ô Chọn não & kiến trúc (Task 26 — chỉ thị user 2026-10-13)', () => {
  test('C1 SECTION 1: selector "Chế độ quan sát" 4 nút (OBS_MODES + obsMode mặc định neurons + tablist pattern)', () => {
    // Import 4 panel + OBS_MODES từ observation-tab (single-source)
    expect(brainTab).toContain("from '@/components/smolab/observation-tab'")
    expect(brainTab).toContain('OBS_MODES')
    // State obsMode — useState đủ (không localStorage), mặc định 'neurons'
    expect(brainTab).toContain("useState<ObsMode>('neurons')")
    // Khối selector nằm trong SECTION 1 (cùng Card Brain Studio, border-t)
    expect(brainTab).toContain('Chế độ quan sát')
    expect(brainTab).toContain('aria-label="Chế độ quan sát"')
    expect(brainTab).toContain('border-t border-stone-800/70')
    // Tablist pattern console (role tab + aria-selected + min-h-44 mobile)
    expect(brainTab).toContain('role="tablist"')
    expect(brainTab).toContain('aria-selected={obsMode === m.id}')
  })

  test('C2 SECTION 2: PANEL QUAN SÁT NGAY DƯỚI ĐÀI — 4 panel render theo obsMode (mount/unmount → poll dừng)', () => {
    expect(brainTab).toContain("obsMode === 'neurons'")
    expect(brainTab).toContain("obsMode === 'timeline'")
    expect(brainTab).toContain("obsMode === 'traces'")
    expect(brainTab).toContain("obsMode === 'golden'")
    // neurons dùng CÙNG activity fetch của đài (1 poller duy nhất — B5)
    expect(brainTab).toContain('ObsNeuronsPanel activity={activity}')
    // BrainStage nhận backprop/training (hợp đồng 26-BE — đường ngược vàng)
    expect(brainTab).toContain('backprop={activity?.backprop ?? null}')
    expect(brainTab).toContain('training={activity?.training ?? null}')
  })

  test('C3 SECTION 3 KHÔNG còn tab Quan sát — PIN UPDATE Task 26: union 4 giá trị + KHÔNG ObservationTabContent (chống hồi quy)', () => {
    expect(brainTab).toContain("'train' | 'tuning' | 'log' | 'ref'")
    expect(brainTab).not.toContain("'train' | 'tuning' | 'log' | 'ref' | 'observation'")
    expect(brainTab).not.toContain("['observation', 'Quan sát']")
    expect(brainTab).not.toContain("consoleTab === 'observation'")
    expect(brainTab).not.toContain('ObservationTabContent')
    expect(brainTab).not.toContain('onOpenBrainTab')
    expect(tab).not.toContain('onOpenBrainTab')
    expect(tab).not.toContain('Mở tab BRAIN')
  })

  test('C4 smolab-module KHÔNG còn tab riêng cấp module (chống hồi quy — chỉ đăng ký qua SECTION 1 selector)', () => {
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
