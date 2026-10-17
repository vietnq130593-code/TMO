/**
 * EVO (BLUEPRINT-EVO-NAO-P1-P5 §4.2/§4.3) — TYPES CHUNG của block engine
 * ============================================================================
 *
 * Module 0-import (thuần type + 1 const) — tách riêng để blocks.ts và moe.ts
 * cùng dùng mà KHÔNG tạo vòng import (check:imports chặn vòng mới):
 *   block-types.ts (0 import) ← blocks.ts ← moe.ts? KHÔNG — moe.ts imports
 *   block-types.ts; blocks.ts imports moe.ts (giá trị) + block-types.ts
 *   (types) — đồ thị một chiều: blocks → moe → block-types.
 */

/** Loại block — ĐÚNG thứ tự encoding §4.2 slot layer-type (r105 pin). */
export const EVO_BLOCK_TYPES = ['identity', 'mlp', 'attention', 'ssm', 'moe', 'gated'] as const

export type EvoBlockType = (typeof EVO_BLOCK_TYPES)[number]

/** Spec 1 block — decode từ encoding [96..131] (search-space.ts decodeEvoCandidate). */
export interface EvoBlockSpec {
  type: EvoBlockType
  /** attention — chiều token/đầu: 32 | 64 | 128 (mặc định 64). */
  headDim?: number
  /** ssm — kích thước trạng thái N: 8 | 16 (mặc định 8). */
  ssmN?: number
  /** mlp/moe — hệ số nở hidden = expansion × d (mặc định 1). */
  expansion?: number
  /** moe — số expert top-k: 2 | 3 | 4 (mặc định 2). */
  moeK?: number
  /** dropout 0–0.3 — CHỈ metadata (H4: benchmark tất định, không dropout). */
  dropout?: number
  /** gated — hệ số nhánh residual 0.5–2.0 (mặc định 1). */
  residualScale?: number
}

/** Block xử lý chuỗi — tham số là VIEW vào buffer phẳng CHUNG toàn mạng. */
export interface EvoBlock {
  readonly spec: EvoBlockSpec
  readonly paramCount: number
  /** Gắn view buffer params/grads tại offset (gọi 1 lần trước initParams). */
  attach(params: Float64Array, grads: Float64Array, offset: number): void
  /** Khởi tạo tham số tất định (viết vào buffer — sau attach). */
  initParams(rng: () => number): void
  /** Block giữ nguyên chiều token d? */
  readonly preservesDim: boolean
  /** Chiều token block xử lý. */
  readonly tokenDim: number
  forwardSeq(seq: readonly Float64Array[]): Float64Array[]
  /** gradOut [L][d] → gradIn [L][d]; tích lũy param grads vào buffer. */
  backwardSeq(gradOut: readonly Float64Array[]): Float64Array[]
  /** MoE only — aux loss chuỗi forward gần nhất (0 với block khác). */
  readonly lastAuxLoss?: number
}
