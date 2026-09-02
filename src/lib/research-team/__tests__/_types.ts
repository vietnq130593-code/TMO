/**
 * Shared types cho 18 TC files + golden-run.
 *
 * Mỗi TC export async function run() → TestResult. KHÔNG throw — fail gracefully
 * return passed=false với details mô tả nguyên nhân.
 */

export interface TestResult {
  /** Tên TC (vd 'TC-01 classify ambiguous') */
  name: string
  /** true nếu TC pass, false nếu fail */
  passed: boolean
  /** Chi tiết assert + debug info (single-line, joined by ' | ') */
  details: string
}
