/**
 * ALISTA — Barrel export (v1.2)
 *
 * Kỹ sư Bảo trì Hệ thống TMO — ca 23h30 hàng ngày, budget 6h, pipeline tuần tự.
 *
 * Module tổ chức:
 *   types.ts              — shared types + STEP_LABELS / STEP_ICONS / makeDedupeKey
 *   collectors.ts         — 7 collector fail-open (Tools/Runs/Escal/Domain/3Layers/Self/DB)
 *   rules.ts              — deterministic rules → Findings[] (per check)
 *   proposals.ts          — LLM synthesis (kimi-k3) + dedupe + createSelfDirectionProposal
 *                          + follow-up mode (⟲ FOLLOW-UP, key `<base>:v<N>`) (v1.2)
 *   comprehensive-check.ts — pipeline tuần tự 7 bước + deadline 6h + globalState Map
 *   proposal-verify.ts    — follow-up verification loop (v1.2): notify khi proposal
 *                          hoàn tất → re-check → đề xuất mới nếu chưa triệt để
 *   alista-scheduler.ts   — 60s tick, cửa sổ 23:30→05:30+1 catch-up, sweep follow-up
 *   db-backup-core.ts     — (P3-c task 31-f) lõi THUẦN: lịch 03:00 VN + gate +
 *                          diễn dịch response + chọn artifact freshness (test r119)
 *   db-backup.ts          — (P3-c task 31-f) executor backup SQLite hằng ngày
 *                          (CronJob row executor='DB-BACKUP', gọi trong tick
 *                          alista-scheduler bước 1d) + collector freshness ⑦(i)
 *
 * Public API (sử dụng ngoài module):
 *   - runComprehensiveCheck, getCheckState, listChecks, isAlistaCheckInFlight — cho API route
 *   - startAlistaScheduler, ensureAlistaCronJob — cho instrumentation
 *   - notifyAlistaProposalCompleted, sweepCompletedAlistaProposals, parseAlistaKey —
 *     cho hook hoàn tất proposal Self-Direction (dynamic import chống circular)
 *   - types: CheckResult, StepEntry, Finding, CheckTrigger
 */

export type {
  CheckId, CheckTrigger, CollectorResult, Finding, ProposalInput,
  CreatedProposal, StepStatus, StepEntry, CheckResult,
} from './types'
export { STEP_LABELS, STEP_ICONS, makeDedupeKey, baseKeyOf } from './types'

// Internal APIs (cho comprehensive-check + scheduler + API route)
export {
  runComprehensiveCheck,
  getCheckState,
  listChecks,
  isAlistaCheckInFlight,
} from './comprehensive-check'

export {
  startAlistaScheduler,
  ensureAlistaCronJob,
} from './alista-scheduler'

// v1.2 — Follow-up verification loop (hook từ orchestrator + automation-proposals)
export {
  notifyAlistaProposalCompleted,
  sweepCompletedAlistaProposals,
  parseAlistaKey,
} from './proposal-verify'
