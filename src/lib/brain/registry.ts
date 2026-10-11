/**
 * BRAIN REGISTRY — single-source (doctrine #9) cho panel "Não vận hành"
 * (tab Database > Kiến trúc) + GET /api/brain.
 * ======================================================================
 *
 * Áp dụng sớm PHẦN UI của BRAIN-P1 theo chỉ thị user (P/S, 2026-10-12) —
 * xem `docs/BLUEPRINT-BRAIN-P1-P5.md` §4.1 (v0.2). Nền toán MLP + pipeline
 * train (mlp.ts / activations.ts / losses.ts / optimizers.ts / init.ts)
 * CHƯA triển khai — chờ user duyệt; API/UI chỉ HIỂN THỊ trạng thái theo
 * số liệu thật, không thay đổi hành vi runtime nào (điểm dừng an toàn P1).
 *
 * Module THUẦN HẰNG SỐ — không import db (an toàn cả client bundle lẫn
 * bun:test). Mọi ngưỡng hardcode kèm chú thích nguồn (doctrine #1):
 * BLUEPRINT-BRAIN-P1-P5 §2 — đo live ngày 2026-10-11 (EvalResult=4,
 * AgentRunRecord=20, QEntry=1, ArbiterVerdict=10 → cả 3 brain NGỦ).
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
  }
}

/** 1 brain trong response GET /api/brain. */
export interface BrainStatusEntry extends BrainSpec {
  lifecycle: BrainLifecycle
  signals: BrainSignalStatus[]
  /** Các phiên bản đã train (mới nhất trước) — ban đầu rỗng */
  models: BrainModelSummary[]
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
    role: 'Dự đoán P(success) / E[tokens] / E[latency] của một cấu hình KHÔNG chạy thật — replay-eval (bước leo Level 2).',
    phase: 'BRAIN-P3',
    flag: 'REPLAY_EVAL',
    inputModes: ['pca-128', 'mrl-512', 'full-2048'],
    defaultInputMode: 'pca-128',
    planned: {
      layers: [
        { units: 128, activation: '' },
        { units: 32, activation: 'tanh' },
        { units: 3, activation: 'sigmoid/linear' },
      ],
      loss: 'BCE + Huber',
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
    inputModes: ['pca-128', 'mrl-512'],
    defaultInputMode: 'pca-128',
    planned: {
      layers: [
        { units: 128, activation: '' },
        { units: 32, activation: 'tanh' },
        { units: 0, activation: 'softmax', unitsLabel: '×|A|' },
      ],
      loss: 'CE (policy)',
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
 * Nền toán BRAIN-P1 ĐÃ triển khai (2026-10-12 — src/lib/brain/{mlp,
 * activations,losses,init,optimizers}.ts + test r84 41/41 PASS) nhưng
 * pipeline train TỪNG BRAIN (P2 calibration-v3 / P3 surrogate / P4 policy)
 * chưa có → cờ vẫn false: nút "Huấn luyện lại" chỉ bật khi brain tương ứng
 * có job train thật + đủ mẫu ngưỡng. Đặt true khi pipeline brain đầu tiên
 * (P2) triển khai.
 */
export const BRAIN_TRAINING_IMPLEMENTED = false
