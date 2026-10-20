/**
 * Balanced JSON Extraction Utility (pure function — zero dependencies)
 *
 * Extracted from worklog.ts (2026-08-29) so lightweight consumers like
 * tool-calls.ts (OpenClaw chat ReAct loop) don't have to pull in the heavy
 * worklog module (Prisma DB + full agents registry) just to parse JSON.
 *
 * This also fixes "Module not found: Can't resolve '@/lib/code-team/worklog'"
 * build errors on machines whose working tree is missing worklog.ts —
 * the chat route now resolves independently of that module.
 */

/**
 * Find balanced JSON object containing a specific key.
 * Avoids greedy over-match by tracking brace depth.
 *
 * - If requiredKey is a non-empty string, finds the JSON object that CONTAINS
 *   that key (walks backwards from the key to the opening brace).
 * - If requiredKey is '' (empty), extracts the JSON object starting at the
 *   FIRST opening brace of the text (no key requirement) — used by
 *   parseToolCallsFromOutput to extract tool_call arguments.
 * - Correctly ignores braces inside JSON string values, e.g.
 *   {"summary": "Code with {braces} in description"} does NOT count inner braces.
 */
export function findBalancedJson(text: string, requiredKey: string): string | null {
  // FIX 2026-08-28: requiredKey rỗng (được parseToolCallsFromOutput dùng) nghĩa là
  // "KHÔNG yêu cầu key — extract JSON object bắt đầu từ brace đầu tiên của text".
  // Trước đây `indexOf('""')` luôn -1 → return null → ReAct loop KHÔNG BAO GIỜ
  // parse được tool_call → agent không thực thi được tool nào (silent no-op).
  let startBrace = -1

  if (requiredKey === '') {
    startBrace = text.indexOf('{')
    if (startBrace === -1) return null
  } else {
    // Find the start of a JSON object that contains the required key
    const keyIndex = text.indexOf(`"${requiredKey}"`)
    if (keyIndex === -1) return null

    // Walk backwards from the key to find the opening brace
    let depth = 0
    for (let i = keyIndex; i >= 0; i--) {
      if (text[i] === '}') depth++
      if (text[i] === '{') {
        depth--
        if (depth < 0) {
          startBrace = i
          break
        }
      }
    }
    if (startBrace === -1) return null
  }

  // Walk forward from the opening brace to find the matching closing brace
  // IMPORTANT: Track whether we're inside a string to avoid counting braces inside string values
  // e.g., {"summary": "Code with {braces} in description"} should NOT count the inner braces
  let depth = 0
  let inString = false
  let escape = false

  for (let i = startBrace; i < text.length; i++) {
    const ch = text[i]

    if (escape) {
      escape = false
      continue
    }

    if (ch === '\\' && inString) {
      escape = true
      continue
    }

    if (ch === '"') {
      inString = !inString
      continue
    }

    // Only count braces outside of strings
    if (!inString) {
      if (ch === '{') depth++
      if (ch === '}') {
        depth--
        if (depth === 0) {
          return text.slice(startBrace, i + 1)
        }
      }
    }
  }

  return null
}

/**
 * F3 (OBS P3 — user duyệt fix F1-F6 2026-10-20): cắt khối reasoning mà model
 * lồng vào CONTENT trước khi parse verdict JSON. Bằng chứng (phiên quan sát
 * OBSERVE-PROTOCOL-1): trọng tài delegation call ✓ 6,380 tokens nhưng parse
 * NULL — model reasoning viết suy luận dài trong content quanh JSON; các dấu
 * '{' rác/không cân bằng trong prose suy luận làm findBalancedJson (đi ngược
 * từ key về brace mở) nhặt nhầm vùng → JSON.parse fail → "trọng tài chưa
 * chấm". Chỉ cắt khối ĐÃ ĐÓNG (an toàn: JSON nằm sau khối think đóng vẫn được
 * tìm thấy bình thường); text không có khối reasoning → trả NGUYÊN VẸN.
 * Pure function — không throw.
 */
export function stripReasoningBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
}
