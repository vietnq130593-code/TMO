/**
 * Layer 8.1: Progress Reporter
 *
 * Định dạng báo cáo tiến độ từ ProgressState → user-readable strings.
 * Nguyên tắc: Transparent, Concise, Actionable.
 *
 * Các functions đều là pure functions (không có side effects ngoài state tracking).
 */

import type {
  ProgressReporter as IProgressReporter,
  CommunicationConfig,
  ProgressReportInput,
  StepProgressInput,
  CommunicationState,
} from './types'
import type { StepState } from '@/lib/state-management/types'
import type { StepStatus } from '@/lib/code-team/types'
import type { ErrorRecord } from '@/lib/error-handling'

// ==================== CONSTANTS ====================

/** Thời gian tối thiểu giữa 2 báo cáo cho cùng một step (ms) */
const MIN_REPORT_INTERVAL_MS = 30_000 // 30 giây

/** Số lượng báo cáo tối đa lưu trong history */
const MAX_HISTORY_SIZE = 20

/** Emoji mapping theo StepStatus */
const STATUS_EMOJI: Record<StepStatus, string> = {
  pending: '⏳',
  in_progress: '🔄',
  completed: '✅',
  failed: '❌',
  skipped: '⏭ Bỏ qua', // ROUND-38 fix G2: 'Wagering' là artifact autocorrect vô nghĩa
}

/** Màu/mô tả theo severity */
const SEVERITY_LABEL: Record<string, string> = {
  critical: '🔴 CRITICAL',
  high: '🟠 HIGH',
  medium: '🟡 MEDIUM',
  low: '🟢 LOW',
}

// ==================== FACTORY ====================

/**
 * Tạo ProgressReporter instance.
 * @param config - Cấu hình communication (default: vi, normal, emoji=true)
 */
export function createProgressReporter(config?: Partial<CommunicationConfig>): IProgressReporter {
  const cfg: CommunicationConfig = {
    language: config?.language ?? 'vi',
    verbosity: config?.verbosity ?? 'normal',
    emoji: config?.emoji ?? true,
    maxQuestionsPerSession: config?.maxQuestionsPerSession ?? 3,
  }

  const state: CommunicationState = {
    pendingClarifications: [],
    reportHistory: [],
    questionCount: 0,
    lastReportTimestamp: {},
  }

  // ==================== INTERNAL HELPERS ====================

  /** Lấy emoji theo status (nếu emoji disabled thì trả về '') */
  function getEmoji(emoji: string): string {
    return cfg.emoji ? emoji : ''
  }

  /** Format số với dấu phân cách hàng nghìn */
  function formatNumber(n: number): string {
    return n.toLocaleString(cfg.language === 'vi' ? 'vi-VN' : 'en-US')
  }

  /** Format thời gian: "Xm Ys" hoặc "Xs" */
  function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = seconds % 60
    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`
    }
    return `${seconds}s`
  }

  /** Format token usage: "1,234 / 2,000" — ROUND-45: budget ≤ 0 nghĩa là
   *  KHÔNG GIỚI HẠN (thiết kế gốc của user) → hiển thị "2,054,446 (không
   *  giới hạn)" thay vì "2,054,446 / 200,000" gây hiểu lầm hệ thống đang
   *  giới hạn token trong khi step thực tế không bị cắt. */
  function formatTokenUsage(used: number, budgeted: number): string {
    if (!Number.isFinite(budgeted) || budgeted <= 0) {
      return `${formatNumber(used)} ${t('(unlimited)', '(không giới hạn)')}`
    }
    return `${formatNumber(used)} / ${formatNumber(budgeted)}`
  }

  /** Format danh sách file, truncate nếu > 5 items */
  function formatFilesList(files: string[] | undefined, maxItems = 5): string {
    if (!files || files.length === 0) return ''
    const lines = files.slice(0, maxItems).map(f => `    → ${f}`)
    if (files.length > maxItems) {
      lines.push(`    ... và ${files.length - maxItems} file khác`)
    }
    return lines.join('\n')
  }

  /** Lấy label theo ngôn ngữ */
  function t(en: string, vi: string): string {
    return cfg.language === 'vi' ? vi : en
  }

  // ==================== PUBLIC METHODS ====================

  const reporter: IProgressReporter = {
    formatStepReport(step: StepState, stepIndex: number, totalSteps: number): string {
      const emoji = cfg.emoji ? STATUS_EMOJI[step.status] : ''
      const header = `${emoji} Step ${stepIndex}/${totalSteps}: [${step.type}] ${step.description}`

      const lines: string[] = [header]

      // Detail lines based on verbosity
      if (cfg.verbosity !== 'minimal' && step.result) {
        const result = step.result

        if (result.filesCreated && result.filesCreated.length > 0) {
          lines.push(`  ${t('Created:', 'Đã tạo:')}`)
          lines.push(formatFilesList(result.filesCreated))
        }

        if (result.filesModified && result.filesModified.length > 0) {
          lines.push(`  ${t('Modified:', 'Đã sửa:')}`)
          lines.push(formatFilesList(result.filesModified))
        }

        if (result.summary) {
          lines.push(`  ${t('Summary:', 'Tóm tắt:')} ${result.summary}`)
        }
      }

      // Error info (always show if exists, regardless of verbosity)
      if (step.errors && step.errors.length > 0) {
        const errorCount = step.errors.length
        lines.push(`  ${getEmoji('⚠️')} ${t('Errors:', 'Lỗi:')} ${errorCount}`)
        if (cfg.verbosity === 'verbose') {
          for (const err of step.errors.slice(0, 3)) {
            lines.push(`    - ${err.message || err.errorType || 'Unknown error'}`)
          }
        }
      }

      // Token usage
      if (step.tokensUsed !== undefined && step.tokensBudgeted !== undefined) {
        lines.push(`  ${getEmoji('📊')} ${t('Tokens:', 'Token:')} ${formatTokenUsage(step.tokensUsed, step.tokensBudgeted)}`)
      }

      // Time spent
      if (step.timeSpent !== undefined && step.timeSpent > 0) {
        lines.push(`  ${getEmoji('⏱️')} ${t('Time:', 'Thời gian:')} ${formatDuration(step.timeSpent)}`)
      }

      const report = lines.join('\n')

      // Save to history
      state.reportHistory.push(report)
      if (state.reportHistory.length > MAX_HISTORY_SIZE) {
        state.reportHistory.shift()
      }

      return report
    },

    formatFinalReport(progress: ProgressReportInput): string {
      const lines: string[] = []

      // Header
      const headerEmoji = cfg.emoji ? '📋' : ''
      lines.push(`${headerEmoji} ${t('WORKFLOW COMPLETE', 'HOÀN THÀNH WORKFLOW')}`)
      lines.push('')

      // Overall stats
      const percentage = progress.totalSteps > 0
        ? Math.round((progress.completedSteps / progress.totalSteps) * 100)
        : 0

      lines.push(`${t('Progress:', 'Tiến độ:')} ${progress.completedSteps}/${progress.totalSteps} (${percentage}%)`)
      lines.push(`${t('Failed:', 'Thất bại:')} ${progress.failedSteps}`)
      lines.push(`${t('Tokens:', 'Token:')} ${formatTokenUsage(progress.totalTokensUsed, progress.totalTokensBudgeted)}`)
      lines.push(`${t('Time:', 'Thời gian:')} ${formatDuration(progress.totalTimeSpent)}`)
      lines.push('')

      // Per-step breakdown
      if (cfg.verbosity !== 'minimal') {
        lines.push(`${t('Steps:', 'Các bước:')}`)
        const stepEntries = Object.entries(progress.steps)
        for (let i = 0; i < stepEntries.length; i++) {
          const [stepId, step] = stepEntries[i]
          const stepNum = i + 1
          const emoji = cfg.emoji ? STATUS_EMOJI[step.status] : ''
          lines.push(`  ${emoji} Step ${stepNum}: [${step.type}] ${step.description} — ${step.status}`)
        }
        lines.push('')
      }

      // Issues summary
      if (progress.errors.length > 0) {
        lines.push(`${getEmoji('🚨')} ${t('Issues:', 'Vấn đề:')}`)
        const bySeverity: Record<string, ErrorRecord[]> = {}
        for (const err of progress.errors) {
          const sev = err.severity || 'unknown'
          if (!bySeverity[sev]) bySeverity[sev] = []
          bySeverity[sev].push(err)
        }
        for (const [sev, errs] of Object.entries(bySeverity)) {
          lines.push(`  ${SEVERITY_LABEL[sev] || sev}: ${errs.length}`)
        }
        lines.push('')
      }

      // Next steps recommendation
      if (progress.failedSteps > 0) {
        lines.push(`${getEmoji('👉')} ${t('Next: Review failed steps and retry.', 'Tiếp theo: Xem lại các bước thất bại và thử lại.')}`)
      } else {
        lines.push(`${getEmoji('✅')} ${t('All steps completed successfully.', 'Tất cả các bước đã hoàn thành thành công.')}`)
      }

      return lines.join('\n')
    },

    formatErrorReport(error: ErrorRecord, stepContext: string): string {
      const lines: string[] = []
      const emoji = cfg.emoji ? '❌' : ''

      lines.push(`${emoji} ${t('ERROR', 'LỖI')} — ${stepContext}`)
      lines.push(`  ${t('Type:', 'Loại:')} ${error.errorType || 'unknown'}`)
      lines.push(`  ${t('Severity:', 'Mức độ:')} ${SEVERITY_LABEL[error.severity] || error.severity || 'unknown'}`)
      lines.push(`  ${t('Message:', 'Thông báo:')} ${error.message || 'No message'}`)

      if (error.rootCause && cfg.verbosity === 'verbose') {
        lines.push(`  ${t('Root Causeheld:', 'Nguyên nhân gốc:')} ${error.rootCause}`)
      }

      if (error.fixDescription) {
        lines.push(`  ${t('Fix:', 'Sửa:')} ${error.fixDescription}`)
      }

      return lines.join('\n')
    },

    shouldReport(step: StepState): boolean {
      // Always report completed, failed, or skipped steps
      if (step.status === 'completed' || step.status === 'failed' || step.status === 'skipped') {
        return true
      }

      // For in_progress: only report if > 30s since last report for this step
      const lastReport = state.lastReportTimestamp[step.id]
      if (lastReport) {
        const elapsed = Date.now() - new Date(lastReport).getTime()
        if (elapsed < MIN_REPORT_INTERVAL_MS) {
          return false
        }
      }

      return true
    },

    getHistory(): string[] {
      return [...state.reportHistory]
    },

    recordReportTimestamp(stepId: string): void {
      state.lastReportTimestamp[stepId] = new Date().toISOString()
    },

    generateReport(input: StepProgressInput): { formattedReport: string; stepIndex: number; totalSteps: number; status: StepStatus } | null {
      // Throttle check: skip if shouldReport returns false
      const mockStep = { id: input.stepId, status: input.status } as StepState
      if (!this.shouldReport(mockStep)) {
        return null
      }

      const { stepId, stepName, status, progress, message, details } = input
      const timestamp = new Date().toISOString()
      const emoji = cfg.emoji ? STATUS_EMOJI[status] : ''
      const lang = cfg.language

      let report = ''
      if (lang === 'vi') {
        report = `${emoji} [${timestamp}] Bước ${stepId}: ${stepName}\n`
        report += `   Trạng thái: ${status} | Tiến độ: ${progress}%\n`
        if (message) report += `   ${message}\n`
        if (details) {
          report += `   Chi tiết: ${JSON.stringify(details, null, 2)}\n`
        }
      } else {
        report = `${emoji} [${timestamp}] Step ${stepId}: ${stepName}\n`
        report += `   Status: ${status} | Progress: ${progress}%\n`
        if (message) report += `   ${message}\n`
        if (details) {
          report += `   Details: ${JSON.stringify(details, null, 2)}\n`
        }
      }

      // Record report
      state.reportHistory.push(report)
      state.lastReportTimestamp[stepId] = timestamp

      return {
        formattedReport: report,
        stepIndex: progress,
        totalSteps: 100,
        status,
      }
    },
  }

  return reporter
}