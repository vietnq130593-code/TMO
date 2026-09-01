/**
 * ALISTA — Barrel export (v1.1)
 *
 * Kỹ sư Bảo trì Hệ thống TMO — ca 23h30 hàng ngày, budget 6h, pipeline tuần tự.
 *
 * Module tổ chức:
 *   types.ts              — shared types + STEP_LABELS / STEP_ICONS / makeDedupeKey
 *   collectors.ts         — 7 collector fail-open (Tools/Runs/Escal/Domain/3Layers/Self/DB)
 *   rules.ts              — deterministic rules → Findings[] (per check)
 *   proposals.ts         — LLM synthesis (kimi-k3) + dedupe + createSelfDirectionProposal
 *   comprehensive-check.ts — pipeline tuần tự 7 bước + deadline 6h + globalState Map
 *   alista-scheduler.ts   — 60s tick, cửa sổ 23:30-23:59 (tz HN), gate 1-lần/ngày
 *
 * Public API (sử dụng ngoài module):
 *   - runComprehensiveCheck, getCheckState, listChecks — cho API route
 *   - startAlistaScheduler, ensureAlistaCronJob — cho instrumentation
 *   - types: CheckResult, StepEntry, Finding, CheckTrigger
 */

export type {
  CheckId, CheckTrigger, CollectorResult, Finding, ProposalInput,
  CreatedProposal, StepStatus, StepEntry, CheckResult,
} from './types'
export { STEP_LABELS, STEP_ICONS, makeDedupeKey } from './types'

// Internal APIs (cho comprehensive-check + scheduler + API route)
export {
  runComprehensiveCheck,
  getCheckState,
  listChecks,
} from './comprehensive-check'

export {
  startAlistaScheduler,
  ensureAlistaCronJob,
} from './alista-scheduler'
