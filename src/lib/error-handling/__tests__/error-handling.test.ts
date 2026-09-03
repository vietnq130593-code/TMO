/**
 * Layer 5: Error Handling — Unit Tests
 *
 * Test các module: detectError, analyzeRootCause, detectLoop, recoverFromError, handleStepError
 */

// @ts-ignore — vitest is a dev dependency, not available in production build
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { detectError, detectMultipleErrors, parseTypeScriptOutput, parseESLintOutput, isCriticalError, isBlockingError, getHighestSeverity } from '../error-detector'
import { analyzeRootCause, analyzeRootCauseQuick } from '../root-cause-analyzer'
import { detectLoop, isAntiPatternFix, shouldAllowRetry, createEscalationMessage } from '../loop-detector'
import { recoverFromError, selectFixStrategy, selectRecoveryStrategy } from '../error-recovery'
import { handleStepError, buildErrorRecord } from '../error-pipeline'
import type { ErrorClassification, ErrorRecord, WorklogEntry, ErrorHandlingInput } from '../types'

// ==================== MOCK DATA ====================

const mockErrorClassification: ErrorClassification = {
  errorType: 'type',
  severity: 'high',
  message: 'Property "foo" does not exist on type "Bar"',
  file: 'src/test.ts',
  line: 10,
  column: 5,
  timestamp: new Date(),
}

const mockWorklog: WorklogEntry[] = [
  {
    sessionId: 'test-session',
    agentName: 'MEGATRON',
    position: 'TL',
    step: 'analyze',
    timestamp: new Date(),
    summary: 'Test worklog',
    completed: [],
    inProgress: [],
    issues: [],
    suggestions: [],
    concerns: [],
    codeLocationMap: { filesToRead: [], filesToSkip: [], dependencies: [], readingStrategy: 'full' },
    nextSteps: [],
    outputForNext: '',
  },
]

const mockPreviousErrors: ErrorRecord[] = [
  {
    id: 'err-1',
    timestamp: new Date(Date.now() - 1000 * 60 * 5), // 5 minutes ago
    errorType: 'type',
    severity: 'high',
    message: 'Property "foo" does not exist on type "Bar"',
    file: 'src/test.ts',
    line: 10,
    fixApplied: false,
    loopDetected: false,
    loopCount: 0,
  },
]

// ==================== ERROR DETECTOR TESTS ====================

describe('Error Detector', () => {
  describe('detectError', () => {
    it('should detect TypeScript type error', () => {
      const error = detectError('Property "foo" does not exist on type "Bar"')
      expect(error.errorType).toBe('type')
      expect(error.severity).toBe('high')
    })

    it('should detect compile error', () => {
      const error = detectError('SyntaxError: Unexpected token')
      expect(error.errorType).toBe('compile')
      expect(error.severity).toBe('critical')
    })

    it('should detect runtime error', () => {
      const error = detectError('Cannot read property "foo" of undefined')
      expect(error.errorType).toBe('runtime')
      expect(error.severity).toBe('critical')
    })

    it('should detect API error', () => {
      const error = detectError('404 Not Found')
      expect(error.errorType).toBe('api')
      expect(error.severity).toBe('high')
    })

    it('should detect network error', () => {
      const error = detectError('Network Error: CORS policy')
      expect(error.errorType).toBe('network')
      expect(error.severity).toBe('high')
    })

    it('should extract file and line from error message', () => {
      const error = detectError('Error at src/test.ts:10:5')
      expect(error.file).toBe('src/test.ts')
      expect(error.line).toBe(10)
      expect(error.column).toBe(5)
    })

    it('should return unknown for unrecognized error', () => {
      const error = detectError('Some random error message')
      expect(error.errorType).toBe('unknown')
      expect(error.severity).toBe('high')
    })
  })

  describe('detectMultipleErrors', () => {
    it('should detect multiple errors from output', () => {
      const output = `
        SyntaxError: Unexpected token
        TypeError: Cannot read property of undefined
        404 Not Found
      `
      const errors = detectMultipleErrors(output)
      expect(errors.length).toBeGreaterThan(0)
      expect(errors.some(e => e.errorType === 'compile')).toBe(true)
      expect(errors.some(e => e.errorType === 'runtime')).toBe(true)
    })
  })

  describe('parseTypeScriptOutput', () => {
    it('should parse TypeScript compiler output', () => {
      const output = `src/test.ts(10,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`
      const errors = parseTypeScriptOutput(output)
      expect(errors.length).toBe(1)
      expect(errors[0].errorType).toBe('type')
      expect(errors[0].file).toBe('src/test.ts')
      expect(errors[0].line).toBe(10)
      expect(errors[0].column).toBe(5)
    })
  })

  describe('parseESLintOutput', () => {
    it('should parse ESLint output', () => {
      const output = `  10:5  error  Unexpected token  semi`
      const errors = parseESLintOutput(output)
      expect(errors.length).toBe(1)
      expect(errors[0].errorType).toBe('lint')
      expect(errors[0].line).toBe(10)
      expect(errors[0].column).toBe(5)
    })
  })

  describe('isCriticalError', () => {
    it('should return true for critical errors', () => {
      expect(isCriticalError({ ...mockErrorClassification, severity: 'critical' })).toBe(true)
    })

    it('should return false for non-critical errors', () => {
      expect(isCriticalError({ ...mockErrorClassification, severity: 'high' })).toBe(false)
    })
  })

  describe('isBlockingError', () => {
    it('should return true for critical and high severity', () => {
      expect(isBlockingError({ ...mockErrorClassification, severity: 'critical' })).toBe(true)
      expect(isBlockingError({ ...mockErrorClassification, severity: 'high' })).toBe(true)
    })

    it('should return false for medium and low severity', () => {
      expect(isBlockingError({ ...mockErrorClassification, severity: 'medium' })).toBe(false)
      expect(isBlockingError({ ...mockErrorClassification, severity: 'low' })).toBe(false)
    })
  })

  describe('getHighestSeverity', () => {
    it('should return the highest severity', () => {
      const errors: ErrorClassification[] = [
        { ...mockErrorClassification, severity: 'low' },
        { ...mockErrorClassification, severity: 'high' },
        { ...mockErrorClassification, severity: 'medium' },
      ]
      expect(getHighestSeverity(errors)).toBe('high')
    })

    it('should return critical if present', () => {
      const errors: ErrorClassification[] = [
        { ...mockErrorClassification, severity: 'low' },
        { ...mockErrorClassification, severity: 'critical' },
        { ...mockErrorClassification, severity: 'medium' },
      ]
      expect(getHighestSeverity(errors)).toBe('critical')
    })
  })
})

// ==================== ROOT CAUSE ANALYZER TESTS ====================

describe('Root Cause Analyzer', () => {
  describe('analyzeRootCauseQuick', () => {
    it('should return quick analysis for low severity', () => {
      const classification = { ...mockErrorClassification, severity: 'low' as const }
      const result = analyzeRootCauseQuick(classification)
      expect(result.hypothesis).toContain('Quick analysis')
      expect(result.confidence).toBeLessThan(0.5)
    })
  })

  describe('analyzeRootCause', () => {
    it('should analyze root cause with worklog context', async () => {
      const result = await analyzeRootCause(
        new Error('Test error'),
        mockErrorClassification,
        mockWorklog
      )
      expect(result.hypothesis).toBeDefined()
      expect(result.rootCause).toBeDefined()
      expect(result.confidence).toBeGreaterThanOrEqual(0)
      expect(result.confidence).toBeLessThanOrEqual(1)
    })
  })
})

// ==================== LOOP DETECTOR TESTS ====================

describe('Loop Detector', () => {
  describe('detectLoop', () => {
    it('should detect no loop for first occurrence', () => {
      const result = detectLoop(mockErrorClassification, [])
      expect(result.isLoop).toBe(false)
      expect(result.loopCount).toBe(0)
    })

    it('should detect loop for repeated error', () => {
      const result = detectLoop(mockErrorClassification, mockPreviousErrors)
      expect(result.isLoop).toBe(true)
      expect(result.loopCount).toBeGreaterThan(0)
    })

    it('should suggest pivot strategy after loop', () => {
      const result = detectLoop(mockErrorClassification, mockPreviousErrors)
      if (result.isLoop) {
        expect(result.pivotStrategy).toBeDefined()
      }
    })

    it('should escalate after 3+ occurrences', () => {
      const manyErrors = Array(3).fill(null).map((_, i) => ({
        ...mockPreviousErrors[0],
        id: `err-${i}`,
        timestamp: new Date(Date.now() - 1000 * 60 * (i + 1)),
      }))
      const result = detectLoop(mockErrorClassification, manyErrors)
      expect(result.shouldEscalate).toBe(true)
    })
  })

  describe('isAntiPatternFix', () => {
    it('should detect @ts-ignore as anti-pattern', () => {
      const result = isAntiPatternFix('// @ts-ignore')
      expect(result.isAntiPattern).toBe(true)
    })

    it('should detect empty catch as anti-pattern', () => {
      const result = isAntiPatternFix('try { ... } catch (e) { }')
      expect(result.isAntiPattern).toBe(true)
    })

    it('should not flag normal fix as anti-pattern', () => {
      const result = isAntiPatternFix('Fixed the null check')
      expect(result.isAntiPattern).toBe(false)
    })
  })

  describe('shouldAllowRetry', () => {
    it('should allow retry if not loop', () => {
      const loopResult = detectLoop(mockErrorClassification, [])
      expect(shouldAllowRetry(loopResult, 3)).toBe(true)
    })

    it('should not allow retry if max retries reached', () => {
      const manyErrors = Array(4).fill(null).map((_, i) => ({
        ...mockPreviousErrors[0],
        id: `err-${i}`,
        timestamp: new Date(Date.now() - 1000 * 60 * (i + 1)),
      }))
      const loopResult = detectLoop(mockErrorClassification, manyErrors)
      expect(shouldAllowRetry(loopResult, 3)).toBe(false)
    })
  })

  describe('createEscalationMessage', () => {
    it('should create escalation message', () => {
      const loopResult = detectLoop(mockErrorClassification, mockPreviousErrors)
      const message = createEscalationMessage(loopResult, mockErrorClassification)
      expect(message).toContain('Tôi đã thử sửa lỗi này')
      expect(message).toContain(mockErrorClassification.message)
    })
  })
})

// ==================== ERROR RECOVERY TESTS ====================

describe('Error Recovery', () => {
  describe('selectFixStrategy', () => {
    it('should select surgical for compile errors', () => {
      const classification = { ...mockErrorClassification, errorType: 'compile' as const }
      const rootCause = { hypothesis: 'Test', verification: 'Test', rootCause: 'Test', confidence: 0.8, relatedFiles: [], duration: 0 }
      expect(selectFixStrategy(classification, rootCause)).toBe('surgical')
    })

    it('should select redesign for logic errors', () => {
      const classification = { ...mockErrorClassification, errorType: 'logic' as const }
      const rootCause = { hypothesis: 'Test', verification: 'Test', rootCause: 'Test', confidence: 0.8, relatedFiles: [], duration: 0 }
      expect(selectFixStrategy(classification, rootCause)).toBe('redesign')
    })

    it('should select rollback for low confidence', () => {
      const classification = { ...mockErrorClassification }
      const rootCause = { hypothesis: 'Test', verification: 'Test', rootCause: 'Test', confidence: 0.2, relatedFiles: [], duration: 0 }
      expect(selectFixStrategy(classification, rootCause)).toBe('rollback')
    })
  })

  describe('selectRecoveryStrategy', () => {
    it('should return strategy and reasoning', () => {
      const rootCause = { hypothesis: 'Test', verification: 'Test', rootCause: 'Test', confidence: 0.8, relatedFiles: [], duration: 0 }
      const result = selectRecoveryStrategy(mockErrorClassification, rootCause)
      expect(result.strategy).toBeDefined()
      expect(result.reasoning).toBeDefined()
    })
  })

  describe('recoverFromError', () => {
    it('should attempt to recover from error', async () => {
      // NOTE: confidence < 0.3 → 'rollback' strategy, which skips the repo-wide
      // static re-verification (tsc) — keeps this unit test fast and deterministic.
      const rootCause = { hypothesis: 'Test', verification: 'Test', rootCause: 'Test', confidence: 0.2, relatedFiles: [], duration: 0 }
      const context = {
        agentPosition: 'TL',
        step: 'analyze',
        filesModified: [],
        toolCallsLog: [],
      }
      const result = await recoverFromError(mockErrorClassification, rootCause, context)
      expect(result.strategy).toBe('rollback')
      expect(result.fixDescription).toBeDefined()
    })
  })
})

// ==================== ERROR PIPELINE TESTS ====================

describe('Error Pipeline', () => {
  describe('buildErrorRecord', () => {
    it('should build error record from classification', () => {
      const rootCause = { hypothesis: 'Test', verification: 'Test', rootCause: 'Test', confidence: 0.8, relatedFiles: [], duration: 0 }
      const recovery = { strategy: 'surgical' as const, fixDescription: 'Test fix', reVerification: { passed: true, details: 'Test' }, success: true }
      const loopStatus = { isLoop: false, loopCount: 0, previousAttempts: [], shouldEscalate: false }
      
      const record = buildErrorRecord(mockErrorClassification, rootCause, recovery, loopStatus)
      
      expect(record.id).toBeDefined()
      expect(record.errorType).toBe('type')
      expect(record.severity).toBe('high')
      expect(record.fixApplied).toBe(true)
      expect(record.loopDetected).toBe(false)
    })
  })

  describe('handleStepError', () => {
    it('should handle step error and return report', async () => {
      const input: ErrorHandlingInput = {
        sessionId: 'test-session',
        stepId: 'TL/analyze',
        error: new Error('Test error'),
        context: {
          agentPosition: 'TL',
          step: 'analyze',
          filesModified: [],
          toolCallsLog: [],
        },
        previousErrors: [],
        worklog: [],
        options: {
          maxRetries: 3,
          autoFix: true,
          escalateOnLoop: true,
        },
      }

      const report = await handleStepError(input)
      
      expect(report.sessionId).toBe('test-session')
      expect(report.stepId).toBe('TL/analyze')
      expect(report.detected).toBeDefined()
      expect(report.rootCause).toBeDefined()
      expect(report.recovery).toBeDefined()
      expect(report.loopStatus).toBeDefined()
      expect(report.finalAction).toBeDefined()
      expect(report.summary).toBeDefined()
      expect(report.duration).toBeGreaterThanOrEqual(0)
    })

    it('should detect loop for repeated errors', async () => {
      const previousErrors: ErrorRecord[] = [
        {
          id: 'err-prev',
          timestamp: new Date(Date.now() - 1000 * 60 * 5),
          errorType: 'type',
          severity: 'high',
          message: 'Property "foo" does not exist on type "Bar"',
          file: 'src/test.ts',
          line: 10,
          fixApplied: false,
          loopDetected: false,
          loopCount: 0,
        },
      ]

      const input: ErrorHandlingInput = {
        sessionId: 'test-session',
        stepId: 'TL/analyze',
        error: new Error('Property "foo" does not exist on type "Bar"'),
        context: {
          agentPosition: 'TL',
          step: 'analyze',
          filesModified: [],
          toolCallsLog: [],
        },
        previousErrors,
        worklog: [],
        options: {
          maxRetries: 3,
          autoFix: true,
          escalateOnLoop: true,
        },
      }

      const report = await handleStepError(input)
      
      // Should detect loop since same error occurred before
      expect(report.loopStatus.loopCount).toBeGreaterThan(0)
    })

    it('should escalate when max retries reached', async () => {
      const previousErrors: ErrorRecord[] = Array(4).fill(null).map((_, i) => ({
        id: `err-${i}`,
        timestamp: new Date(Date.now() - 1000 * 60 * (i + 1)),
        errorType: 'type',
        severity: 'high',
        message: 'Property "foo" does not exist on type "Bar"',
        file: 'src/test.ts',
        line: 10,
        fixApplied: false,
        loopDetected: true,
        loopCount: i + 1,
      }))

      const input: ErrorHandlingInput = {
        sessionId: 'test-session',
        stepId: 'TL/analyze',
        error: new Error('Property "foo" does not exist on type "Bar"'),
        context: {
          agentPosition: 'TL',
          step: 'analyze',
          filesModified: [],
          toolCallsLog: [],
        },
        previousErrors,
        worklog: [],
        options: {
          maxRetries: 3,
          autoFix: true,
          escalateOnLoop: true,
        },
      }

      const report = await handleStepError(input)
      
      expect(report.finalAction).toBe('ESCALATE')
      expect(report.loopStatus.shouldEscalate).toBe(true)
    })
  })
})