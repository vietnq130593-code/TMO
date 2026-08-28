/**
 * Layer 5.3: Error Recovery
 *
 * Sửa lỗi đúng cách — không chỉ "make it work" mà "make it right".
 * 4 chiến lược: Surgical, Refactoring, Redesign, Rollback.
 */

import type {
  ErrorClassification,
  RootCauseAnalysis,
  ErrorRecoveryResult,
  FixStrategy,
  ErrorContext,
} from './types'

// ==================== STRATEGY SELECTION ====================

/**
 * Chọn chiến lược sửa lỗi dựa trên root cause và error type.
 */
export function selectFixStrategy(
  classification: ErrorClassification,
  rootCause: RootCauseAnalysis
): FixStrategy {
  const { errorType } = classification
  const { confidence, rootCause: cause } = rootCause

  // Low confidence → Rollback (không chắc nguyên nhân)
  if (confidence < 0.3) {
    return 'rollback'
  }

  // Compile errors thường là surgical
  if (errorType === 'compile') {
    return 'surgical'
  }

  // Type errors → surgical hoặc refactoring
  if (errorType === 'type') {
    if (cause.includes('interface') || cause.includes('type definition')) {
      return 'refactoring'
    }
    return 'surgical'
  }

  // Runtime errors → surgical (null check, optional chaining)
  if (errorType === 'runtime') {
    if (cause.includes('undefined') || cause.includes('null')) {
      return 'surgical'
    }
    return 'refactoring'
  }

  // Hydration errors → refactoring (thay đổi cách render)
  if (errorType === 'hydration') {
    return 'refactoring'
  }

  // API errors → surgical (fix endpoint, params)
  if (errorType === 'api') {
    return 'surgical'
  }

  // Network errors → surgical (fix config)
  if (errorType === 'network') {
    return 'surgical'
  }

  // Logic errors → redesign (algorithm sai)
  if (errorType === 'logic') {
    return 'redesign'
  }

  // Lint warnings → surgical
  if (errorType === 'lint') {
    return 'surgical'
  }

  // Default
  return 'surgical'
}

// ==================== FIX APPLICATION ====================

/**
 * Apply surgical fix — sửa đúng dòng lỗi.
 */
async function applySurgicalFix(
  classification: ErrorClassification,
  rootCause: RootCauseAnalysis,
  context: ErrorContext
): Promise<{ success: boolean; description: string }> {
  const { errorType, message, file, line } = classification

  // Nếu không có file → không thể surgical fix
  if (!file) {
    return { success: false, description: 'Không xác định được file để surgical fix' }
  }

  try {
    const fs = await import('fs/promises')
    const path = await import('path')
    const resolvedPath = path.resolve(process.cwd(), file)

    // Đọc file
    let content: string
    try {
      content = await fs.readFile(resolvedPath, 'utf-8')
    } catch {
      return { success: false, description: `Không thể đọc file ${file}` }
    }

    let modified = false
    let newContent = content

    // Surgical fixes theo error type
    if (errorType === 'type' && message.includes('does not exist')) {
      // Thêm optional chaining hoặc type assertion
      const propertyMatch = message.match(/Property '([^']+)' does not exist/)
      if (propertyMatch) {
        const prop = propertyMatch[1]
        // Tìm và thay thế: obj.prop → obj?.prop hoặc (obj as any).prop
        const regex = new RegExp(`(\\.${prop})(?!\\?)`, 'g')
        if (regex.test(newContent)) {
          newContent = newContent.replace(regex, `?.${prop}`)
          modified = true
        }
      }
    }

    if (errorType === 'runtime' && (message.includes('Cannot read property') || message.includes('undefined'))) {
      // Thêm optional chaining — chỉ sửa dòng có lỗi nếu có line number
      // Hoặc sửa an toàn: chỉ match variable access (không phải keyword)
      const safePattern = /(?<![\w$])([a-z_$][\w$]*)\.([a-z_$][\w$]*)(?!\s*\()/g
      const safeReplacement = '$1?.$2'

      // Nếu có line number → chỉ sửa dòng đó
      if (line) {
        const lines = newContent.split('\n')
        if (lines[line - 1]) {
          const originalLine = lines[line - 1]
          const fixedLine = originalLine.replace(safePattern, safeReplacement)
          if (fixedLine !== originalLine) {
            lines[line - 1] = fixedLine
            newContent = lines.join('\n')
            modified = true
          }
        }
      } else {
        // Nếu không có line → sửa toàn bộ file nhưng chỉ match safe pattern
        const testContent = newContent.replace(safePattern, safeReplacement)
        if (testContent !== newContent) {
          newContent = testContent
          modified = true
        }
      }
    }

    if (errorType === 'compile' && message.includes('Cannot find module')) {
      // Thêm import hoặc cài đặt package
      const moduleMatch = message.match(/Cannot find module '([^']+)'/)
      if (moduleMatch) {
        const moduleName = moduleMatch[1]
        return {
          success: false,
          description: `Missing module: ${moduleName}. Cần cài đặt: npm install ${moduleName}`,
        }
      }
    }

    if (errorType === 'api' && message.includes('404')) {
      return {
        success: false,
        description: 'API 404: Endpoint không tồn tại. Cần tạo route hoặc sửa URL.',
      }
    }

    // Ghi lại file nếu có thay đổi
    if (modified) {
      await fs.writeFile(resolvedPath, newContent, 'utf-8')
      return {
        success: true,
        description: `Surgical fix applied to ${file}: ${errorType} error`,
      }
    }

    return {
      success: false,
      description: `Không thể tự động apply surgical fix cho ${errorType} error ở ${file}`,
    }
  } catch (err) {
    return {
      success: false,
      description: `Lỗi khi apply surgical fix: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Apply refactoring fix — sửa cấu trúc code.
 */
async function applyRefactoringFix(
  classification: ErrorClassification,
  rootCause: RootCauseAnalysis,
  context: ErrorContext
): Promise<{ success: boolean; description: string }> {
  const { errorType, file } = classification

  // Refactoring thường cần nhiều thay đổi → không thể tự động hoàn toàn
  // Đề xuất refactoring plan cho agent

  const refactoringPlans: Record<string, string> = {
    type: 'Refactor: Normalize type definitions, extract shared interfaces, hoặc update type guards.',
    hydration: 'Refactor: Đảm bảo server/client render consistency. Sử dụng useEffect cho client-only code.',
    runtime: 'Refactor: Thêm error boundaries, improve null checking, hoặc restructure data flow.',
    logic: 'Refactor: Extract logic thành functions riêng, thêm unit tests, hoặc rewrite algorithm.',
  }

  const plan = refactoringPlans[errorType] || 'Refactor: Review và restructure code liên quan.'

  return {
    success: false, // Refactoring cần agent thực hiện
    description: `Refactoring plan: ${plan} (File: ${file || 'unknown'})`,
  }
}

/**
 * Apply redesign fix — thay đổi approach.
 */
async function applyRedesignFix(
  classification: ErrorClassification,
  rootCause: RootCauseAnalysis,
  context: ErrorContext
): Promise<{ success: boolean; description: string }> {
  const { errorType, file } = classification

  return {
    success: false, // Redesign cần agent thực hiện
    description: `Redesign required: ${errorType} error ở ${file || 'unknown'} cần thay đổi approach. ` +
      `Root cause: ${rootCause.rootCause.slice(0, 200)}. ` +
      `Cần redesign và re-implement.`,
  }
}

/**
 * Apply rollback fix — revert về state trước đó.
 */
async function applyRollbackFix(
  classification: ErrorClassification,
  context: ErrorContext
): Promise<{ success: boolean; description: string }> {
  const { filesModified } = context

  if (filesModified.length === 0) {
    return {
      success: false,
      description: 'Không có filesModified để rollback',
    }
  }

  try {
    // Sử dụng git để revert files
    const { exec } = await import('child_process')
    const { promisify } = await import('util')
    const execAsync = promisify(exec)

    for (const file of filesModified) {
      try {
        await execAsync(`git checkout -- "${file}"`, { cwd: process.cwd() })
      } catch {
        // Nếu git fail, thông báo
        return {
          success: false,
          description: `Git rollback failed for ${file}. Cần manual revert.`,
        }
      }
    }

    return {
      success: true,
      description: `Rollback thành công: ${filesModified.join(', ')}`,
    }
  } catch (err) {
    return {
      success: false,
      description: `Rollback failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

// ==================== RE-VERIFICATION ====================

/**
 * Chạy re-verification sau khi fix.
 */
async function runReVerification(
  file: string | undefined,
  strategy: FixStrategy
): Promise<{ passed: boolean; details: string }> {
  // Nếu là redesign hoặc rollback → không cần re-verify ngay
  if (strategy === 'redesign' || strategy === 'rollback') {
    return {
      passed: true,
      details: `${strategy} fix — cần manual verification sau khi implement`,
    }
  }

  // Nếu không có file → không thể verify
  if (!file) {
    return {
      passed: false,
      details: 'Không có file để re-verify',
    }
  }

  try {
    // Chạy static verification trên file đã sửa
    // Lazy import to avoid circular dependency
    // NOTE: module '../verification' CHƯA tồn tại trong codebase — dùng biến string
    // cho dynamic import (giữ nguyên runtime: import fail → catch → passed:false).
    const verificationModule: string = '../verification'
    const { runStaticVerification } = await import(verificationModule)
    const result = await runStaticVerification({
      runLint: true,
      runTypeCheck: true,
      runImportCheck: false,
      timeout: 30000,
    })

    if (result.passed) {
      return {
        passed: true,
        details: `Static verification passed for ${file}`,
      }
    } else {
      return {
        passed: false,
        details: `Static verification failed: ${result.errors.join('; ')}`,
      }
    }
  } catch (err) {
    return {
      passed: false,
      details: `Re-verification error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

// ==================== MAIN FUNCTION ====================

/**
 * Sửa lỗi dựa trên root cause và error classification.
 *
 * @param classification - Kết quả phân loại lỗi
 * @param rootCause - Kết quả phân tích nguyên nhân gốc
 * @param context - Context xung quanh lỗi
 * @returns ErrorRecoveryResult
 */
export async function recoverFromError(
  classification: ErrorClassification,
  rootCause: RootCauseAnalysis,
  context: ErrorContext
): Promise<ErrorRecoveryResult> {
  const startTime = Date.now()

  // 1. Chọn strategy
  const strategy = selectFixStrategy(classification, rootCause)

  // 2. Apply fix theo strategy
  let fixResult: { success: boolean; description: string }

  switch (strategy) {
    case 'surgical':
      fixResult = await applySurgicalFix(classification, rootCause, context)
      break
    case 'refactoring':
      fixResult = await applyRefactoringFix(classification, rootCause, context)
      break
    case 'redesign':
      fixResult = await applyRedesignFix(classification, rootCause, context)
      break
    case 'rollback':
      fixResult = await applyRollbackFix(classification, context)
      break
    default:
      fixResult = { success: false, description: 'Unknown strategy' }
  }

  // 3. Re-verification
  const reVerification = await runReVerification(classification.file, strategy)

  // 4. Kết hợp kết quả
  const success = fixResult.success && reVerification.passed

  return {
    strategy,
    fixDescription: fixResult.description,
    reVerification,
    success,
    failureReason: success ? undefined : `${fixResult.description} | ${reVerification.details}`,
  }
}

/**
 * Recovery lightweight — chỉ chọn strategy, không apply fix.
 * Dùng khi autoFix = false.
 */
export function selectRecoveryStrategy(
  classification: ErrorClassification,
  rootCause: RootCauseAnalysis
): { strategy: FixStrategy; reasoning: string } {
  const strategy = selectFixStrategy(classification, rootCause)

  const reasoningMap: Record<FixStrategy, string> = {
    surgical: 'Lỗi đơn giản, chỉ cần sửa đúng dòng lỗi',
    refactoring: 'Cần sửa cấu trúc code để fix root cause',
    redesign: 'Architecture sai, cần thay đổi approach',
    rollback: 'Không chắc nguyên nhân, an toàn nhất là revert',
  }

  return {
    strategy,
    reasoning: reasoningMap[strategy],
  }
}