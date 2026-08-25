/**
 * Layer 5.1: Error Detection
 *
 * Phát hiện và phân loại lỗi từ execution result.
 * Parse error messages để xác định error type, severity, file, line.
 */

import type { ErrorClassification, ErrorType, ErrorSeverity } from './types'

// ==================== ERROR PATTERNS ====================

/** Patterns để nhận diện từng loại lỗi */
const ERROR_PATTERNS: { type: ErrorType; patterns: RegExp[] }[] = [
  {
    type: 'compile',
    patterns: [
      /SyntaxError/i,
      /Unexpected token/i,
      /Cannot find module/i,
      /Module not found/i,
      /ParseError/i,
      /Invalid syntax/i,
      /Expected/i,
    ],
  },
  {
    type: 'type',
    patterns: [
      /TS[0-9]{4,5}/i,
      /Type ['"][^'"]+['"] is not assignable/i,
      /Property ['"][^'"]+['"] does not exist/i,
      /Cannot find name/i,
      /is not assignable to type/i,
      /Parameter ['"][^'"]+['"] implicitly has/i,
      /No overload matches/i,
      /Generic type ['"][^'"]+['"] requires/i,
    ],
  },
  {
    type: 'lint',
    patterns: [
      /eslint/i,
      /prettier/i,
      /unused/i,
      /is defined but never used/i,
      /is declared but its value is never read/i,
      /prefer-/i,
      /no-undef/i,
      /no-unused-vars/i,
    ],
  },
  {
    type: 'runtime',
    patterns: [
      /Cannot read propert(y|ies)\b[^\n]*\bof (undefined|null)/i,
      /undefined is not a function/i,
      /is not a function/i,
      /null is not an object/i,
      /ReferenceError/i,
      /TypeError/i,
      /RangeError/i,
      /Error: .* is not defined/i,
      /Cannot access ['"][^'"]+['"] before initialization/i,
    ],
  },
  {
    type: 'logic',
    patterns: [
      /assertion failed/i,
      /expected .* but got/i,
      /does not match/i,
      /incorrect/i,
      /wrong/i,
      /invalid result/i,
      /returned unexpected/i,
    ],
  },
  {
    type: 'hydration',
    patterns: [
      /Hydration failed/i,
      /did not match/i,
      /Text content does not match/i,
      /Hydration mismatch/i,
      /server and client/i,
      /Server\/Client mismatch/i,
    ],
  },
  {
    type: 'api',
    patterns: [
      /404 Not Found/i,
      /500 Internal Server Error/i,
      /401 Unauthorized/i,
      /403 Forbidden/i,
      /ECONNREFUSED/i,
      /ETIMEDOUT/i,
      /timeout/i,
      /fetch failed/i,
      /Response status: [0-9]{3}/i,
      /API error/i,
      /Bad Request/i,
    ],
  },
  {
    type: 'network',
    patterns: [
      /CORS/i,
      /Network Error/i,
      /fetch failed/i,
      /ENOTFOUND/i,
      /ECONNRESET/i,
      /socket hang up/i,
      /connection refused/i,
      /DNS/i,
    ],
  },
]

/** Severity mapping theo error type */
const SEVERITY_MAP: Record<ErrorType, ErrorSeverity> = {
  compile: 'critical',
  type: 'high',
  lint: 'medium',
  runtime: 'critical',
  logic: 'high',
  hydration: 'medium',
  api: 'high',
  network: 'high',
  unknown: 'high',
  // Layer 9 P1.2 taxonomy — transient nhẹ hơn (tự hồi), systematic theo mức
  'transient_network': 'medium',
  'transient_ratelimit': 'low',
  'transient_server': 'medium',
  'systematic_tool_rejected': 'high',
  'systematic_parse': 'high',
  'systematic_permission': 'critical',
  'systematic_notfound': 'medium',
}

// ==================== FILE/LINE EXTRACTION ====================

/** Trích xuất file path từ error message */
function extractFilePath(message: string): string | undefined {
  // Pattern: /path/to/file.ts:line:column hoặc /path/to/file.tsx:line
  const filePattern = /(?:at\s+)?([^\s(]+[.](?:ts|tsx|js|jsx|mjs|cjs)(?::\d+:\d+)?)/i
  const match = message.match(filePattern)
  if (match) {
    return match[1].split(':')[0] // Bỏ phần :line:column
  }
  return undefined
}

/** Trích xuất line number từ error message */
function extractLineNumber(message: string): number | undefined {
  const linePattern = /:(\d+):(\d+)/ // file.ts:line:column
  const match = message.match(linePattern)
  if (match) {
    return parseInt(match[1], 10)
  }
  return undefined
}

/** Trích xuất column number từ error message */
function extractColumnNumber(message: string): number | undefined {
  const colPattern = /:\d+:(\d+)/ // file.ts:line:column
  const match = message.match(colPattern)
  if (match) {
    return parseInt(match[1], 10)
  }
  return undefined
}

// ==================== MAIN FUNCTION ====================

/**
 * Phát hiện và phân loại lỗi từ error message.
 *
 * @param error - Error object hoặc string message
 * @returns ErrorClassification với type, severity, file, line
 */
export function detectError(error: unknown): ErrorClassification {
  const normalized: Error | string =
    error instanceof Error ? error : typeof error === 'string' ? error : String(error)
  const message = typeof normalized === 'string' ? normalized : normalized.message
  const stack = typeof normalized === 'string' ? undefined : normalized.stack

  // 1. Xác định error type dựa trên patterns
  let detectedType: ErrorType = 'unknown'

  for (const { type, patterns } of ERROR_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(message)) {
        detectedType = type
        break
      }
    }
    if (detectedType !== 'unknown') break
  }

  // 2. Xác định severity
  const severity = SEVERITY_MAP[detectedType]

  // 3. Trích xuất file, line, column
  const file = extractFilePath(message)
  const line = extractLineNumber(message)
  const column = extractColumnNumber(message)

  return {
    errorType: detectedType,
    severity,
    message: message.slice(0, 1000), // Giới hạn độ dài
    file,
    line,
    column,
    stack: stack ? stack.slice(0, 2000) : undefined,
    timestamp: new Date(),
  }
}


/**
 * Parse TypeScript compiler output format.
 * Format: "src/file.ts(10,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'."
 */
export function parseTypeScriptOutput(output: string): ErrorClassification[] {
  const errors: ErrorClassification[] = []
  const pattern = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm
  let match: RegExpExecArray | null

  while ((match = pattern.exec(output)) !== null) {
    const [, file, lineStr, columnStr, severity, code, message] = match
    errors.push({
      errorType: 'type',
      severity: severity === 'error' ? 'high' : 'medium',
      message: `${code}: ${message}`,
      file: file.trim(),
      line: parseInt(lineStr, 10),
      column: parseInt(columnStr, 10),
      timestamp: new Date(),
    })
  }

  return errors
}

/**
 * Parse ESLint output format.
 * Format: "  10:5  error  Message text  rule-name"
 */
export function parseESLintOutput(output: string): ErrorClassification[] {
  const errors: ErrorClassification[] = []
  const lines = output.split('\n')

  for (const line of lines) {
    const match = line.match(/^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(.+)$/)
    if (match) {
      const [, lineStr, columnStr, severity, message, rule] = match
      errors.push({
        errorType: 'lint',
        severity: severity === 'error' ? 'high' : 'low',
        message: `${message} (${rule})`,
        line: parseInt(lineStr, 10),
        column: parseInt(columnStr, 10),
        timestamp: new Date(),
      })
    }
  }

  return errors
}

/**
 * Detect nhiều lỗi từ tool output (e.g., TypeScript, ESLint).
 * Tự động detect format và parse phù hợp.
 */
export function detectMultipleErrors(output: string): ErrorClassification[] {
  // Auto-detect format
  if (output.includes('error TS') && output.includes('.ts(')) {
    return parseTypeScriptOutput(output)
  }

  if (output.includes('error') && output.includes('  ') && output.match(/^\s*\d+:\d+/m)) {
    return parseESLintOutput(output)
  }

  // Fallback: line-by-line detection
  const errors: ErrorClassification[] = []
  const lines = output.split('\n')

  for (const line of lines) {
    const classification = detectError(line)
    if (classification.errorType !== 'unknown') {
      errors.push(classification)
    }
  }

  return errors
}

/**
 * Kiểm tra xem lỗi có phải critical không (block pipeline).
 */
export function isCriticalError(error: ErrorClassification): boolean {
  return error.severity === 'critical'
}

/**
 * Kiểm tra xem lỗi có phải blocking không (critical hoặc high).
 */
export function isBlockingError(error: ErrorClassification): boolean {
  return error.severity === 'critical' || error.severity === 'high'
}

/**
 * Lấy severity cao nhất từ danh sách lỗi.
 */
export function getHighestSeverity(errors: ErrorClassification[]): ErrorSeverity {
  const severityOrder: ErrorSeverity[] = ['critical', 'high', 'medium', 'low']
  let highest: ErrorSeverity = 'low'

  for (const error of errors) {
    const index = severityOrder.indexOf(error.severity)
    const currentIndex = severityOrder.indexOf(highest)
    if (index < currentIndex) {
      highest = error.severity
    }
  }

  return highest
}
