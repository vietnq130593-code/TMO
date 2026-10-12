/**
 * BRAIN REGISTRY — single-source (doctrine #9) cho panel "Não vận hành"
 * (tab Database > Kiến trúc) + GET /api/brain.
 * ======================================================================
 *
 * Áp dụng sớm PHẦN UI của BRAIN-P1 theo chỉ thị user (P/S, 2026-10-12) —
 * xem `docs/BLUEPRINT-BRAIN-P1-P5.md` §4.1. Từ BRAIN-P2 (2026-10-12):
 * pipeline train Brain-A "V3" đã sống ở src/lib/brain/calibration-v3.ts
 * (kế thừa pattern thăng cấp V2 — 5-fold CV ngặt, fail-open tuyệt đối).
 *
 * Module THUẦN HẰNG SỐ — không import db (an toàn cả client bundle lẫn
 * bun:test). Mọi ngưỡng hardcode kèm chú thích nguồn (doctrine #1):
 * BLUEPRINT-BRAIN-P1-P5 §2 — đo live ngày 2026-10-11 (EvalResult=4,
 * AgentRunRecord=20, QEntry=1, ArbiterVerdict=10 → cả 3 brain NGỦ).
 * BRAIN-P3 (2026-10-12): pipeline Brain-B "Vọng" đã sống ở
 * src/lib/brain/brains/surrogate.ts — 3 MLP đầu-ra-riêng (success BCE /
 * tokens Huber / duration Huber trong log1p space) + replay-eval
 * POST /api/brain/replay (READ-ONLY, bootstrap CI) + cờ replay_eval.
 * BRAIN-P4 (2026-10-12 — blueprint v0.9, Q1 user chốt): pipeline Brain-C
 * "Lệnh" đã sống ở src/lib/brain/brains/policy.ts — mixture
 * π = λ·π_Q + (1−λ)·π_net (λ = 1−min(n/200, WilsonLB)) + composite
 * reward LOG-ONLY (src/lib/brain/reward.ts — đợt quan sát 1) + steering
 * 3 cơ quan kill-switch policy_organ_* + report GET /api/brain/policy.
 */

// ==================== TYPES ====================

export type BrainKey = 'calibration_v3' | 'surrogate' | 'policy'

/**
 * Vòng đời brain — hiển thị NGỦ / THỨC TỈNH / ACTIVE:
 *  - dormant: chưa đủ mẫu ngưỡng (hành vi y hệt hiện tại — không rủi ro)
 *  - awake  : đủ mẫu ngưỡng, có thể train (chưa có bản active)
 *  - active : có bản BrainModel active — tham gia runtime khi cờ phase bật
 */
export type BrainLifecycle = 'dormant' | 'awake' | 'active'

/** Một lớp trong kiến trúc MLP dự kiến (spec khởi điểm của phase tương ứng). */
export interface BrainLayerSpec {
  /** Số unit; 0 = động theo không gian hành động (hiển thị unitsLabel) */
  units: number
  /** Tên hàm kích hoạt; '' = lớp đầu vào (không activation) */
  activation: string
  /** Nhãn hiển thị thay vì số unit (vd "×|A|") */
  unitsLabel?: string
}

/** Điều kiện thức tỉnh — đếm thật từ bảng SQLite tương ứng. */
export interface BrainSignalSpec {
  /** Khóa đếm — khớp khóa trong response /api/brain (signals[].key) */
  key: string
  /** Bảng nguồn SQLite (chú thích hiển thị) */
  table: string
  /** Nhãn tiếng Việt */
  label: string
  /** Ngưỡng mẫu tối thiểu để brain có thể thức tỉnh */
  min: number
  /** Chú thích nguồn ngưỡng (doctrine #1 — hardcode từ dữ liệu/blueprint) */
  source: string
}

export interface BrainSpec {
  key: BrainKey
  /** Tên hiệu: A "V3" · B "Vọng" · C "Lệnh" (blueprint §1) */
  name: string
  /** Brain-A/B/C + vai trò ngắn */
  title: string
  role: string
  /** Phase blueprint sẽ triển khai brain này */
  phase: string
  /** Cờ runtime sẽ bật khi brain tham gia (mặc định OFF) */
  flag: string
  /** Key tuning-store của cờ (chỉ brain đã có cờ thật trong TUNING_SPECS) */
  flagTuningKey?: string
  /** Các chế độ đầu vào ablation (blueprint §3.2) */
  inputModes: string[]
  defaultInputMode: string
  /** Kiến trúc MLP khởi điểm (blueprint §4.2–4.4) */
  planned: { layers: BrainLayerSpec[]; loss: string }
  /** Mọi điều kiện thức tỉnh phải đạt (AND) */
  signals: BrainSignalSpec[]
}

// ==================== SHARED API TYPES (route + UI cùng import) ====================

/** Trạng thái 1 điều kiện thức tỉnh sau khi đếm thật. */
export interface BrainSignalStatus extends BrainSignalSpec {
  /** Số mẫu hiện có; null = đếm lỗi (fail-open, hiển thị "—") */
  current: number | null
  ok: boolean
}

/** Bản tóm tắt 1 dòng BrainModel (không kéo weightsJson ra API). */
export interface BrainModelSummary {
  id: string
  brain: string
  version: number
  inputMode: string
  active: boolean
  trainedAt: string
  /** Trích chọn từ trainMetaJson — fail-open parse */
  meta: {
    nSamples?: number
    cvScore?: number
    ciLow?: number
    ciHigh?: number
    metric?: string
    /** BRAIN-P2 — Brier CV của baseline đối chứng (V2 với Brain-A) */
    brierBaseline?: number
    /** true khi bản này thắng đối chứng CV (chính là active) */
    improved?: boolean
    /** BRAIN-UX §9.4 — |gradient| trung bình từng lớp (từ mlp.FitResult —
     * chế độ lan truyền ngược UX-3, độ dày cạnh theo dữ liệu thật) */
    gradAbsMean?: number[]
    /** BRAIN-UX — train từ bản nháp UX-2 (useDraft) — provenance */
    draftUsed?: boolean
  }
}

/** 1 brain trong response GET /api/brain. */
export interface BrainStatusEntry extends BrainSpec {
  lifecycle: BrainLifecycle
  signals: BrainSignalStatus[]
  /** Các phiên bản đã train (mới nhất trước) — ban đầu rỗng */
  models: BrainModelSummary[]
  /** BRAIN-P2 — đã có pipeline train thật (nút Huấn luyện lại bật khi đủ mẫu) */
  trainable: boolean
  /**
   * BRAIN-UX §9.1-3 (editor UX-1) — số chiều đầu vào HIỆN TẠI cho bộ đếm tham
   * số. null = chưa đo được (brain động chưa train: hiển thị "—", kiểm tra
   * trần tham số rơi xuống mlp.validateSpec lúc train — điểm chặn thật).
   * inputDimExact=false: ước tính từ DB (có thể lệch filter usable lúc train).
   */
  inputDim?: number | null
  inputDimExact?: boolean
  /**
   * FB-BRAIN-UX-R1-02 — số unit lớp output HIỆN TẠI từ bản active (đọc lớp
   * cuối cùng specJson — vd |A| thật của policy); null khi chưa train/động.
   * Dùng cho bộ đếm tham số editor (validateBrainDraft outputUnitsOverride).
   */
  outputDim?: number | null
}

export interface BrainApiResponse {
  /** false cho tới khi nền toán BRAIN-P1 được duyệt + triển khai */
  trainingImplemented: boolean
  brains: BrainStatusEntry[]
  generatedAt: string
}

// ==================== REGISTRY (single-source) ====================

export const BRAIN_REGISTRY: readonly BrainSpec[] = [
  {
    key: 'calibration_v3',
    name: 'V3',
    title: 'Brain-A · Calibration V3',
    role: 'Chuẩn hoá độ tin cậy kiến thức KB — MLP 2 lớp thay logistic V2 khi thắng đối chứng 5-fold CV (Brier).',
    phase: 'BRAIN-P2',
    flag: 'CALIBRATION_V3',
    flagTuningKey: 'calibration_v3',
    inputModes: ['features-10', 'pca-128', 'mrl-512'],
    defaultInputMode: 'features-10',
    planned: {
      layers: [
        { units: 10, activation: '' },
        { units: 16, activation: 'tanh' },
        { units: 1, activation: 'sigmoid' },
      ],
      loss: 'BCE (log-loss)',
    },
    signals: [
      {
        key: 'evalResults',
        table: 'EvalResult',
        label: 'Eval KB (nhãn faithfulness)',
        min: 30,
        source: 'MIN_TRAIN_SAMPLES_V2 = 30 (calibration-multifeature.ts:53)',
      },
    ],
  },
  {
    key: 'surrogate',
    name: 'Vọng',
    title: 'Brain-B · Surrogate Predictor',
    role: 'Dự đoán P(success) / E[tokens] / E[latency] của một cấu hình KHÔNG chạy thật — 3 MLP đầu-ra-riêng + replay-eval bootstrap CI (bước leo Level 2).',
    phase: 'BRAIN-P3',
    flag: 'REPLAY_EVAL',
    flagTuningKey: 'replay_eval',
    inputModes: ['runs-features', 'pca-128', 'mrl-512', 'full-2048'],
    defaultInputMode: 'runs-features',
    planned: {
      layers: [
        { units: 0, activation: '', unitsLabel: '1-hot cfg' },
        { units: 16, activation: 'tanh' },
        { units: 1, activation: 'sigmoid/linear ×3' },
      ],
      loss: 'BCE + Huber (3 đầu riêng)',
    },
    signals: [
      {
        key: 'agentRuns',
        table: 'AgentRunRecord',
        label: 'Run thật (kết cục + tokens)',
        min: 60,
        source: 'BLUEPRINT-BRAIN §2 — đối chứng bootstrap CI',
      },
    ],
  },
  {
    key: 'policy',
    name: 'Lệnh',
    title: 'Brain-C · Policy Head',
    role: 'Chọn model/chiến lược theo đặc trưng nhiệm vụ — mixture π = λ·softmax(Q/τ) + (1−λ)·π_net; thiếu dữ liệu nghe Q nguyên vẹn.',
    phase: 'BRAIN-P4',
    flag: 'RUNTIME_POLICY',
    flagTuningKey: 'runtime_policy',
    inputModes: ['task-features', 'pca-128', 'mrl-512'],
    defaultInputMode: 'task-features',
    planned: {
      layers: [
        { units: 0, activation: '', unitsLabel: '1-hot nhiệm vụ' },
        { units: 32, activation: 'tanh' },
        { units: 0, activation: 'softmax', unitsLabel: '×|A| model' },
      ],
      loss: 'CE (policy — reward-weighted imitation)',
    },
    signals: [
      {
        key: 'qEntries',
        table: 'QEntry',
        label: 'Q-entry đã học',
        min: 30,
        source: 'BLUEPRINT-BRAIN §2 — policy head',
      },
      {
        key: 'verdicts',
        table: 'ArbiterVerdict',
        label: 'Phán quyết trọng tài',
        min: 50,
        source: 'BLUEPRINT-BRAIN §2 — composite reward',
      },
    ],
  },
]

/**
 * Prune policy (blueprint A2): sau mỗi lần train thành công, mỗi brain chỉ
 * giữ bản active + N bản mới nhất — tiền lệ prune TUNING_CHANGE_LOG_CAP.
 */
export const BRAIN_VERSIONS_KEEP = 5

/**
 * Brain đã có pipeline train THẬT (BRAIN-P2: Brain-A — calibration-v3.ts;
 * BRAIN-P3: Brain-B — brains/surrogate.ts; BRAIN-P4: Brain-C —
 * brains/policy.ts). Nút "Huấn luyện lại" chỉ bật cho brain nằm trong danh
 * sách này VÀ đủ mẫu ngưỡng.
 */
export const BRAIN_TRAINABLE_KEYS: readonly BrainKey[] = ['calibration_v3', 'surrogate', 'policy']

/**
 * Nền toán BRAIN-P1 đã triển khai (2026-10-12 — src/lib/brain/{mlp,
 * activations,losses,init,optimizers}.ts + test r84 41/41 PASS) VÀ pipeline
 * train của CẢ 3 brain đã có: BRAIN-P2 (Brain-A calibration-v3.ts + POST
 * /api/brain/train + test r85) · BRAIN-P3 (Brain-B brains/surrogate.ts +
 * POST /api/brain/replay + test r86) · BRAIN-P4 (Brain-C brains/policy.ts
 * + reward.ts LOG-ONLY + GET /api/brain/policy + cờ runtime_policy + 3 cờ
 * organ kill-switch + test r87): true kể từ đây.
 */
export const BRAIN_TRAINING_IMPLEMENTED = true

// ==================== BADGE TỔNG NHÃN (blueprint §9.2 v0.4) ====================

/** Hình dạng tối thiểu của signal cần cho phép tính tổng nhãn. */
export interface LabelSignalLike {
  key: string
  current: number | null
}

/**
 * Tổng nhãn vận hành tích lũy — "nguyên liệu dạy não" (blueprint §9.2 v0.4):
 * cộng theo KHÓA signal duy nhất (nhiều brain cùng đọc 1 bảng không đếm
 * trùng); current null (đếm lỗi) bị bỏ — fail-open.
 *
 * Khi KHÔNG còn nguồn nào đếm được (mọi current null, hoặc không có brain
 * nào) → trả NULL để UI ẩn badge (FB-BRAIN-P1-R1-12): hiển thị "0 nhãn"
 * lúc đó là nói sai — 0 nghĩa là "đếm được và bằng 0", còn mọi-null nghĩa
 * là "đếm lỗi/không dữ liệu". Thuần dữ liệu — client/server dùng chung.
 */
export function computeLabelTotal(
  brains: readonly { signals: readonly LabelSignalLike[] }[] | null | undefined,
): number | null {
  if (!brains || brains.length === 0) return null
  const bySource = new Map<string, number>()
  let anyCounted = false
  for (const b of brains) {
    for (const s of b.signals) {
      if (s.current === null) continue
      bySource.set(s.key, s.current)
      anyCounted = true
    }
  }
  if (!anyCounted) return null
  let total = 0
  for (const v of bySource.values()) total += v
  return total
}
