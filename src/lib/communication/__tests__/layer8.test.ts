/**
 * Layer 8: Communication System — Unit Tests
 *
 * Tests for:
 *   - ProgressReporter (8.1)
 *   - ClarificationEngine (8.2)
 *   - Workflow pause/resume integration
 */

// vitest may not be installed; skip tests if not available
// @ts-ignore - vitest may not be installed
const vitest = await import('vitest').catch(() => null)
const { describe, it, expect, vi, beforeEach } = (vitest || {}) as any
import { createProgressReporter } from '../progress-reporter'
import { createClarificationEngine } from '../clarification-engine'
import type { StepProgressInput, ClarificationContext, ClarificationResponse, ClarificationGap } from '../types'

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

// ==================== CLARIFICATION ENGINE TESTS ====================

describe('ClarificationEngine (8.2)', () => {
  let engine: ReturnType<typeof createClarificationEngine>

  beforeEach(() => {
    engine = createClarificationEngine({
      language: 'vi',
      verbosity: 'normal',
      emoji: true,
      maxQuestionsPerSession: 3,
    })
  })

  describe('needsClarification', () => {
    it('should detect ambiguity when intent confidence is low', () => {
      const context: ClarificationContext = {
        intentResult: {
          taskType: 'unknown',
          confidence: 0.3,
          summary: 'Unclear request',
          constraints: {},
          ambiguities: ['ambiguous requirement'],
          implicitRequirements: [],
        } as any,
        solutionDesign: undefined,
        codebaseConventions: [],
        askedQuestions: [],
        questionCount: 0,
      }

      const decision = engine.needsClarification(context)

      expect(decision.needsClarification).toBe(true)
      expect(decision.gaps.length).toBeGreaterThan(0)
      expect(decision.gaps[0].type).toBe('ambiguous')
    })

    it('should not need clarification for high-confidence intent', () => {
      const context: ClarificationContext = {
        intentResult: {
          taskType: 'feature',
          confidence: 0.95,
          summary: 'Clear request',
          constraints: {},
          ambiguities: [],
          implicitRequirements: [],
        } as any,
        solutionDesign: undefined,
        codebaseConventions: [],
        askedQuestions: [],
        questionCount: 0,
      }

      const decision = engine.needsClarification(context)

      expect(decision.needsClarification).toBe(false)
      expect(decision.gaps.length).toBe(0)
    })

    it('should detect missing information when no intent result', () => {
      const context: ClarificationContext = {
        intentResult: undefined as any,
        solutionDesign: undefined,
        codebaseConventions: [],
        askedQuestions: [],
        questionCount: 0,
      }

      const decision = engine.needsClarification(context)

      expect(decision.needsClarification).toBe(true)
      expect(decision.gaps[0].type).toBe('missing_info')
    })

    it('should not exceed max questions per session', () => {
      const context: ClarificationContext = {
        intentResult: {
          taskType: 'feature',
          confidence: 0.3,
          summary: 'Unclear',
          constraints: {},
          ambiguities: ['ambiguous'],
          implicitRequirements: [],
        } as any,
        solutionDesign: undefined,
        codebaseConventions: [],
        askedQuestions: [],
        questionCount: 3, // Already at max
      }

      const decision = engine.needsClarification(context)

      expect(decision.needsClarification).toBe(false)
    })
  })

  describe('formatQuestion', () => {
    it('should format a question with options', () => {
      const gap: ClarificationGap = {
        type: 'ambiguous',
        description: 'Framework chưa rõ',
        options: ['React', 'Vue', 'Angular'],
      }

      const request = engine.formatQuestion(gap)

      expect(request.id).toBeDefined()
      expect(request.gap.description).toContain('Framework chưa rõ')
      expect(request.options).toEqual(['React', 'Vue', 'Angular'])
      expect(request.formattedQuestion).toContain('❓')
    })

    it('should format a question without options', () => {
      const gap: ClarificationGap = {
        type: 'missing_info',
        description: 'Thiếu thông tin về database',
      }

      const request = engine.formatQuestion(gap)

      expect(request.gap.description).toContain('Thiếu thông tin về database')
      expect(request.options).toEqual([])
    })
  })

  describe('shouldSuppressQuestion', () => {
    it('should suppress duplicate questions', () => {
      const gap: ClarificationGap = {
        type: 'ambiguous',
        description: 'Framework chưa rõ',
        options: ['React', 'Vue'],
      }

      const context: ClarificationContext = {
        intentResult: undefined as any,
        solutionDesign: undefined,
        codebaseConventions: [],
        askedQuestions: ['Framework chưa rõ'],
        questionCount: 1,
      }

      const shouldSuppress = engine.shouldSuppressQuestion(gap, context)

      expect(shouldSuppress).toBe(true)
    })

    it('should not suppress new questions', () => {
      const gap: ClarificationGap = {
        type: 'ambiguous',
        description: 'Framework chưa rõ',
        options: ['React', 'Vue'],
      }

      const context: ClarificationContext = {
        intentResult: undefined as any,
        solutionDesign: undefined,
        codebaseConventions: [],
        askedQuestions: ['Other question'],
        questionCount: 1,
      }

      const shouldSuppress = engine.shouldSuppressQuestion(gap, context)

      expect(shouldSuppress).toBe(false)
    })
  })

  describe('resolveClarification', () => {
    it('should resolve with selected option', () => {
      const request = engine.formatQuestion({
        type: 'ambiguous',
        description: 'Framework?',
        options: ['React', 'Vue'],
      })

      const response: ClarificationResponse = {
        requestId: request.id,
        selectedOption: 'React',
        updatedContext: 'User selected React',
        isFollowUp: false,
      }

      const result = engine.resolveClarification(request, response)

      expect(result.resolved).toBe(true)
      expect(result.updatedContext).toContain('React')
    })

    it('should handle free-text answers', () => {
      const request = engine.formatQuestion({
        type: 'missing_info',
        description: 'Mô tả chi tiết?',
      })

      const response: ClarificationResponse = {
        requestId: request.id,
        selectedOption: 'I want a dashboard with charts',
        updatedContext: 'User wants dashboard',
        isFollowUp: false,
      }

      const result = engine.resolveClarification(request, response)

      expect(result.resolved).toBe(true)
    })
  })
})

// ==================== INTEGRATION TESTS ====================

describe('Layer 8 Integration', () => {
  it('should handle full clarification flow', () => {
    const engine = createClarificationEngine({
      language: 'vi',
      verbosity: 'normal',
      emoji: true,
      maxQuestionsPerSession: 3,
    })

    // Step 1: Detect ambiguity
    const context: ClarificationContext = {
      intentResult: {
        taskType: 'unknown',
        confidence: 0.3,
        summary: 'Unclear',
        constraints: {},
        ambiguities: ['framework'],
        implicitRequirements: [],
      } as any,
      solutionDesign: undefined,
      codebaseConventions: [],
      askedQuestions: [],
      questionCount: 0,
    }

    const decision = engine.needsClarification(context)
    expect(decision.needsClarification).toBe(true)

    // Step 2: Format question
    const request = engine.formatQuestion(decision.gaps[0])
    expect(request.options.length).toBeGreaterThan(0)

    // Step 3: Simulate user response
    const response: ClarificationResponse = {
      requestId: request.id,
      selectedOption: request.options[0],
      updatedContext: `User selected: ${request.options[0]}`,
      isFollowUp: false,
    }

    // Step 4: Resolve
    const result = engine.resolveClarification(request, response)
    expect(result.resolved).toBe(true)

    // Step 5: Check follow-up
    expect(result.followUpNeeded).toBe(false)
  })

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