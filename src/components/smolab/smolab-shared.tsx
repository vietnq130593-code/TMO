'use client'

// ========================================================================
// smolab-shared — Shared symbols cho Smolab tabs (types/constants/helpers/AgentRunPanel)
// PERF-SPLIT 2026-09-03: trích xuất nguyên vẹn từ src/app/page.tsx (không đổi logic)
// ========================================================================




// ==================== PHASE 7: AI TOOL EVENT BRIDGE (module helpers) ====================
//
// The code-team workflow SSE stream (/api/code-team/workflow) emits
//   data: {"type":"tool_call"|"tool_result","agent":"MEGATRON","position":"TL",
//          "tool":"<name>","detail":"<escaped-JSON-string>","result":"OK"|"Error","duration":N}
// The REAL data lives in `detail` (a JSON string, truncated at 200/500 chars);
// `result` is only 'OK'|'Error'. file tools put the path in detail.path, shell
// the command in detail.command, opencode the action in detail.action.
//
// The stream reader (chat submit handler) re-dispatches every tool_call/
// tool_result as this window CustomEvent; CodeTabContent listens and reacts
// (auto-open file in editor, echo AI commands in the terminal, auto-open the
// Preview panel when the AI starts a dev server...).

export const AI_TOOL_EVENT_NAME = 'tmo-ai-tool-event'


/** Basic JSON string unescape (\n \t \" \\ \/ \uXXXX) for regex-extracted values. */
export function unescapeJsonString(s: string): string {
  try {
    return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
      .replace(/\\"/g, '"').replace(/\\\//g, '/').replace(/\\\\/g, '\\')
  } catch {
    return s
  }
}


/** Regex-extract a JSON string field from a (possibly truncated) raw JSON string. */
export function extractJsonStringField(raw: unknown, field: string): string | null {
  try {
    const s = String(raw ?? '')
    const m = s.match(new RegExp('"' + field + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'))
    return m ? unescapeJsonString(m[1]) : null
  } catch {
    return null
  }
}


/** Regex-extract a JSON number field from a (possibly truncated) raw JSON string. */
export function extractJsonNumberField(raw: unknown, field: string): number | null {
  try {
    const s = String(raw ?? '')
    const m = s.match(new RegExp('"' + field + '"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)'))
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}


/** Basename of a path (works for both / and \ separators). */
export function pathFileName(p: unknown): string {
  const s = typeof p === 'string' ? p : ''
  if (!s) return 'file'
  const parts = s.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || s
}

