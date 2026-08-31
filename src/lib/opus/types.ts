/**
 * OPUS (Task 13-b) — TYPES CHO SERVICE LAYER CTO META-AGENT
 * ============================================================
 *
 * Contract JSON verdict của Opus (bắt buộc theo §X OPUS_INSTRUCTION trong
 * opus-agent.ts — KHÔNG sửa file đó, types ở đây mirror đúng schema):
 *
 *   decision      : 1 trong 5 động từ CONTINUE | FIX | REDIRECT | ESCALATE | STOP
 *   summary       : 1-2 câu tổng kết cho Mr. Architect
 *   axes          : 5 trục đánh giá 0-10 (spec/process/verification/risk/honesty)
 *   issues        : các vấn đề ghi nhận vào Issue Ledger (BẮT BUỘC có evidence)
 *   directive     : chỉ đạo 6 trường cho bước kế tiếp
 *   rationale     : lý do quyết định (đọc hiểu trong 10 giây)
 *   evidenceRefs  : tham chiếu bằng chứng đã dùng
 *   stopAssessment: đánh giá predicate 4 điều kiện dừng (auto mode)
 *
 * Parse + normalize + fail-safe xem reviewer.ts.
 */

// ==================== DECISION (5 ĐỘNG TỪ) ====================

export type OpusDecision = 'CONTINUE' | 'FIX' | 'REDIRECT' | 'ESCALATE' | 'STOP'

export const OPUS_DECISIONS: readonly OpusDecision[] = [
  'CONTINUE',
  'FIX',
  'REDIRECT',
  'ESCALATE',
  'STOP',
] as const

// ==================== ISSUE (ISSUE LEDGER) ====================

export type OpusIssueSeverity = 'blocking' | 'major' | 'minor' | 'nit'

export const OPUS_ISSUE_SEVERITIES: readonly OpusIssueSeverity[] = [
  'blocking',
  'major',
  'minor',
  'nit',
] as const

export interface OpusIssue {
  /** Tiêu đề ngắn 1 dòng — key dedupe của Issue Ledger (cùng session + open) */
  title: string
  /** blocking | major | minor | nit — blocking/major open chặn predicate STOP */
  severity: OpusIssueSeverity
  /** Trích dẫn bằng chứng cụ thể (tool output / dòng log / diff hunk) — BẮT BUỘC */
  evidence: string
  /** 1 câu gợi ý cách sửa (optional) */
  suggestedFix?: string
}

// ==================== AXES (5 TRỤC ĐÁNH GIÁ 0-10) ====================

export interface OpusAxis {
  /** 0-10 (clamp khi parse) */
  score: number
  /** 1 câu giải thích */
  note: string
}

/** 5 trục theo đúng thứ tự §IV OPUS_INSTRUCTION */
export interface OpusAxes {
  specCompliance: OpusAxis
  processQuality: OpusAxis
  verification: OpusAxis
  riskDebt: OpusAxis
  reportHonesty: OpusAxis
}

// ==================== DIRECTIVE (6 TRƯỜNG §VI) ====================

export interface OpusDirective {
  /** Mục tiêu 1 câu, đo được */
  goal: string
  /** Vì sao bước này (nối về issue/bằng chứng đã dẫn) */
  rationale: string
  /** Phạm vi cho phép/cấm */
  scope: string
  /** Giao agent/team nào + gợi ý cách tiếp cận */
  delegation: string
  /** Checklist nghiệm thu máy-verify được */
  acceptanceCriteria: string[]
  /** Đề xuất giới hạn vòng/tool calls (advisory ±50%) */
  budgetHint?: string
}

// ==================== STOP ASSESSMENT (PREDICATE 4 ĐIỀU KIỆN §VII) ====================

export interface OpusStopAssessment {
  /** (1) Issue Ledger không còn blocking/major open */
  ledgerClean: boolean
  /** (2) Chuỗi kiểm định toàn xanh (bằng chứng máy) */
  verificationGreen: boolean
  /** (3) Yêu cầu gốc Mr. Architect được đáp ứng đầy đủ */
  specSatisfied: boolean
  /** (4) Vòng review cuối không mở thêm issue blocking mới */
  noNewBlocking: boolean
  /** CẢ 4 điều kiện thỏa (= STOP hợp lệ) */
  allMet: boolean
  notes?: string
}

// ==================== VERDICT (JSON ĐẦY ĐỦ TỪ MODEL) ====================

export interface OpusVerdict {
  decision: OpusDecision
  summary: string
  axes: OpusAxes
  issues: OpusIssue[]
  directive: OpusDirective
  rationale: string
  evidenceRefs: string[]
  stopAssessment: OpusStopAssessment
}
