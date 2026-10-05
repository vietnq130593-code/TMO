/**
 * Layer 8: Communication System — Unit Tests
 *
 * Tests for:
 *   - ProgressReporter (8.1)
 *   - Workflow pause/resume integration
 */

// vitest may not be installed; skip tests if not available
// @ts-ignore - vitest may not be installed
const vitest = await import('vitest').catch(() => null)
const { describe, it, expect, vi, beforeEach } = (vitest || {}) as any
import { createProgressReporter } from '../progress-reporter'
import type { StepProgressInput } from '../types'
// ==================== PROGRESS REPORTER TESTS ====================

describe('ProgressReporter (8.1)', () => {
  let reporter: ReturnType<typeof createProgressReporter>

  beforeEach(() => {
    reporter = createProgressReporter({
      language: 'vi',
      verbosity: 'normal',
      emoji: true,
      maxQuestionsPerSession: 3,
    })
  })

  describe('generateReport', () => {
    it('should generate a progress report for a completed step', () => {
      const input: StepProgressInput = {
        stepId: 'TL/analyze',
        stepName: 'Phân tích routing',
        status: 'completed',
        progress: 25,
        message: 'Hoàn thành: Phân tích routing',
        details: { agent: 'MEGATRON', position: 'TL', step: 'analyze', duration: 5000, content: 'Routing: Mode B, Tier 2' },
      }

      const report = reporter.generateReport(input)

      // Contract: stepIndex = progress %, totalSteps = 100, status passthrough
      expect(report).toBeDefined()
      expect(report?.formattedReport).toContain('✅')
      expect(report?.formattedReport).toContain('Phân tích routing')
      expect(report?.stepIndex).toBe(25)
      expect(report?.totalSteps).toBe(100)
      expect(report?.status).toBe('completed')
    })

    it('should throttle repeated in_progress reports (30s window)', () => {
      const input: StepProgressInput = {
        stepId: 'TL/analyze',
        stepName: 'Phân tích routing',
        status: 'in_progress',
        progress: 25,
        message: 'Đang chạy: Phân tích routing',
      }

      const firstReport = reporter.generateReport(input)
      const secondReport = reporter.generateReport(input)

      expect(firstReport).toBeDefined()
      expect(secondReport).toBeNull()
    })

    it('should never throttle completed steps', () => {
      const input: StepProgressInput = {
        stepId: 'TL/analyze',
        stepName: 'Phân tích routing',
        status: 'completed',
        progress: 25,
        message: 'Hoàn thành: Phân tích routing',
      }

      reporter.generateReport(input)
      const secondReport = reporter.generateReport(input)

      expect(secondReport).toBeDefined()
      expect(secondReport?.stepIndex).toBe(25)
    })

    it('should always allow error steps regardless of throttle', () => {
      const input: StepProgressInput = {
        stepId: 'TL/analyze',
        stepName: 'Phân tích routing',
        status: 'failed',
        progress: 25,
        message: 'Lỗi: Phân tích routing',
      }

      reporter.generateReport(input)
      const secondReport = reporter.generateReport(input)

      expect(secondReport).toBeDefined()
      expect(secondReport?.status).toBe('failed')
    })
  })

  describe('formatFinalReport', () => {
    it('should format a final report with all stats', () => {
      const progressInput = {
        planId: 'test-session',
        totalSteps: 6,
        completedSteps: 6,
        failedSteps: 0,
        steps: {},
        totalTokensUsed: 15000,
        totalTokensBudgeted: 20000,
        totalTimeSpent: 120000,
        startedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
        errors: [],
      }

      const finalReport = reporter.formatFinalReport(progressInput)

      expect(finalReport).toContain('HOÀN THÀNH WORKFLOW')
      expect(finalReport).toContain('6/6')
      expect(finalReport).toContain('15.000') // vi-VN number format
      expect(finalReport).toContain('20.000')
      expect(finalReport).toContain('2m 0s')
    })

    it('should include error summary when errors exist', () => {
      const progressInput = {
        planId: 'test-session',
        totalSteps: 6,
        completedSteps: 5,
        failedSteps: 1,
        steps: {},
        totalTokensUsed: 15000,
        totalTokensBudgeted: 20000,
        totalTimeSpent: 120000,
        startedAt: new Date().toISOString(),
        lastUpdatedAt: new Date().toISOString(),
        errors: [
          { id: 'err-1', timestamp: new Date(), errorType: 'logic' as any, severity: 'high' as any, message: 'Lỗi 1', fixApplied: false, loopDetected: false, loopCount: 0 },
          { id: 'err-2', timestamp: new Date(), errorType: 'syntax' as any, severity: 'medium' as any, message: 'Lỗi 2', fixApplied: true, loopDetected: false, loopCount: 0 },
        ],
      }

      const finalReport = reporter.formatFinalReport(progressInput)

      expect(finalReport).toContain('Vấn đề:')
    })
  })
})
// ==================== INTEGRATION TESTS ====================
// ROUND-37 V4: ClarificationEngine tests đã XOÁ cùng module (dead scaffolding
// — chưa từng có caller sản xuất). Còn ProgressReporter — giờ LIVE qua
// workflow-engine (SSE progress_report/final_report).

describe('Layer 8 Integration', () => {
  it('should throttle progress reports', () => {
    const reporter = createProgressReporter({
      language: 'vi',
      verbosity: 'normal',
      emoji: true,
      maxQuestionsPerSession: 3,
    })

    // Contract: only in_progress reports are throttled (30s window);
    // completed/failed/skipped are always reported.
    const input: StepProgressInput = {
      stepId: 'TL/analyze',
      stepName: 'Phân tích',
      status: 'in_progress',
      progress: 25,
      message: 'Đang chạy',
    }

    const report1 = reporter.generateReport(input)
    const report2 = reporter.generateReport(input)

    expect(report1).toBeDefined()
    expect(report2).toBeNull()
  })
})
