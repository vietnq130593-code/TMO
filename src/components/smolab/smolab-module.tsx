'use client'

// ========================================================================
// smolab-module — Module Smolab (Single Agent Chat)
// PERF-SPLIT 2026-09-03: trích xuất nguyên vẹn từ src/app/page.tsx (không đổi logic)
// ========================================================================

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { Network, CheckCircle2, XCircle, Loader2, Brain, Zap, Check, ChevronDown, Activity, AlertTriangle, Play, ShieldOff, MessageSquare, Send, Trash2, Search, Sparkles, X, AlertCircle, ThumbsUp, ThumbsDown, Wrench, Radio, BookMarked, Plus, Download, Pencil, Users, User, Code2, Square, Thermometer, ClipboardList, Mic, AudioLines, Volume2, OctagonX, Scale } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { toast } from '@/hooks/use-toast'
import { useVoiceLive, type VoiceLiveStatus } from '@/hooks/use-voice-live'
import OpusReviewCard, { opusDecisionBadgeClass, type OpusReviewSerialized } from '@/components/opus/opus-review-card'
import { toast as sonnerToast } from 'sonner'
import { AGENT_COLORS, POSITION_COLORS } from '@/lib/agent-constants'
import { CodeTabContent } from '@/components/smolab/code-tab'
import { AI_TOOL_EVENT_NAME, extractJsonStringField, extractJsonNumberField, pathFileName } from '@/components/smolab/smolab-shared'
import { KnowledgeTabContent } from '@/components/smolab/knowledge-tab'
import { MemoryTabContent } from '@/components/smolab/memory-tab'
import { LearningTabContent } from '@/components/smolab/learning-tab'
import { ChannelsTabContent } from '@/components/smolab/channels-tab'
import { SkillsTabContent } from '@/components/smolab/skills-tab'
import { AutomationTabContent } from '@/components/smolab/automation-tab'
import MarkdownText from './markdown-text'


// ==================== SMOLAB MODULE (Phase 1: Chat Tab) ====================

export interface SmolabMessage {
  id: string
  role: 'user' | 'assistant' | 'tool_call' | 'error' | 'opencode_progress' | 'opencode_result' | 'agent_run'
  content: string
  timestamp: Date
  model?: string
  provider?: string
  sources?: Array<{ type: string; content: string; documentTitle?: string }>
  confidence?: number
  durationMs?: number
  toolName?: string
  feedback?: 'positive' | 'negative' | null
  opencodeSessionId?: string
  opencodeStep?: string
  opencodeDetail?: string
  opencodeResult?: {
    filesChanged: string[]
    additions: number
    deletions: number
    diagnostics: number
    kbUsed: boolean
  }
  enrichment?: {
    score: number
    entitiesFound: number
    documentsFound: number
    correctionsFound: number
    insightsFound: number
  }
  agentName?: string
  agentPosition?: string
  agentAvatar?: string
  isTeamMessage?: boolean
  toolCallInfo?: { tool: string; detail: string }
  iterationInfo?: string // ReAct loop iteration progress (e.g., "Vòng 2/3")
  // Phase 3: Frontend Suggestion Card (C2 — Smart TL Bridge)
  isWorkflowSuggestion?: boolean // True if this message is a TL suggestion card
  suggestionText?: string // Short suggestion from TL
  routingMode?: string // A (Visual) | B (Backend) | C (Hybrid)
  routingTier?: number // 1 (Simple) | 2 (Medium) | 3 (Complex)
  routingScore?: number // 3-9 complexity score
  assessmentRouting?: { // Full routing decision for workflow
    mode: 'A' | 'B' | 'C'
    tier: 1 | 2 | 3
    score: number
    reasoning: string
    parts: Array<{ name: string; type: 'visual' | 'backend'; description: string; dependency: string[] }>
    spec: string
  }
  suggestionRejected?: boolean // True if user rejected the suggestion
  // ===== Agent Run (Thought Process — user request 2026-08-31) =====
  /** runId trong agent-run-tracker — panel live poll theo id này */
  runId?: string
  /** Summary tĩnh (từ message metadata sau reload — events in-memory đã mất) */
  agentRunSummary?: AgentRunSummaryData
  /** GĐ4 CI-5 (Task 14-e) — job durable goal-loop đang chạy: message là
   *  PLACEHOLDER (⏳ hàng đợi nền), sẽ được THAY THẾ bằng câu trả lời thật
   *  (result.content) khi poll /api/goal-loop-jobs thấy job completed. */
  goalLoopJobId?: string
  // ===== OPUS (Task 13-c) — metadata JSON gốc từ backend ChatMessage =====
  // Directive message của Opus (role='user' + metadata.opusDirective=true)
  // render thành OPUS DIRECTIVE CARD thay vì user bubble thường.
  metadata?: Record<string, unknown> & {
    opusDirective?: boolean
    opusReviewId?: string
    decision?: string
    triggerMode?: string
  }
}


export interface SmolabSession {
  id: string
  sessionId: string
  title: string
  model?: string | null
  messageCount: number
  updatedAt: string
  agentProfileId?: string | null
  teamMode?: string | null
  teamName?: string | null
  tasks?: Array<{ id: string; type: string; status: string; progress: number; inputSummary?: string | null }>
  /** USER REQUEST 2026-09-01 — agent/team đang chạy dở ở session này (chấm xanh live) */
  hasActiveRun?: boolean
}


// ==================== AGENT RUN — THOUGHT PROCESS PANEL (user request 2026-08-31) ====================
//
// Muốn TẤT CẢ agents (độc lập + team) hiển thị trong cửa sổ chat một khối
// "Thought Process" (mặc định ĐÓNG, bấm mới mở) giống Claude Code / Z.ai Code:
//   - Thought Process: tư duy từng vòng ReAct
//   - Todos: ✓ xong / ◐ đang làm / ○ chờ
//   - Tiến trình live: đã đọc bao nhiêu file, chạy bao nhiêu lệnh, KẾT QUẢ THẬT
//   - Trạng thái Done khi hoàn thành

/** CI-2 (Task 11-a/11-b) — Todo gắn per-run (per-task isolation).
 *  Nguồn: DB Todo (serializeTodo của /api/todos + /api/agent-run) — mỗi run
 *  chỉ thấy todo của ĐÚNG runId mình; runId=null = todo legacy tiền CI-2.
 *  status: pending | in_progress | blocked | completed | failed | archived
 *  ('archived' = đã lưu trữ — panel ẩn, chỉ đếm "N đã lưu trữ"). */
export interface RunTodoData {
  id: string
  sessionId?: string
  /** Run sở hữu todo — null = legacy (tạo trước CI-2, không thuộc run nào) */
  runId?: string | null
  agentRole?: string
  content: string
  status: string
  priority?: string
  parentId?: string | null
  position?: number
  /** Thời điểm lưu trữ — != null → ẩn khỏi panel (đã bị run mới archive) */
  archivedAt?: string | null
  createdAt?: string
  updatedAt?: string
}


export interface AgentRunEventData {
  id: string
  ts: number
  type: 'run_start' | 'thought' | 'tool' | 'todo_update' | 'run_end'
  text?: string
  iteration?: number
  tool?: string
  argsSummary?: string
  resultPreview?: string
  success?: boolean
  durationMs?: number
  todos?: Array<{ id: string; content: string; status: string; priority?: string; parentId?: string | null }>
  /** USER REQUEST 2026-08-31: run_end bị dừng bởi người dùng (bấm nút Dừng) */
  cancelled?: boolean
}


export interface AgentRunCountersData {
  iterations: number
  toolCalls: number
  filesRead: number
  commandsRun: number
  editsMade: number
  searches: number
}


export interface AgentRunData {
  runId: string
  sessionId: string
  agentName: string
  agentPosition?: string
  step?: string
  task?: string
  mode: 'standalone' | 'team'
  startedAt: number
  endedAt?: number
  status: 'running' | 'done' | 'error' | 'cancelled'
  events: AgentRunEventData[]
  counters: AgentRunCountersData
  lastTodos?: Array<{ id: string; content: string; status: string; priority?: string; parentId?: string | null }>
  /** CI-2 (Task 11-a): todo DB của ĐÚNG runId này (orderBy position, kèm theo
   *  mỗi run item từ GET /api/agent-run) — panel Thought Process (11-b) ưu
   *  tiên nguồn này thay vì danh sách session-wide. Fail-open [] khi lỗi DB. */
  todos?: RunTodoData[]
}


/** Summary tĩnh gắn vào assistant message (persist qua DB metadata) */
export interface AgentRunSummaryData {
  agentName: string
  status: string
  iterations: number
  toolCalls: number
  filesRead: number
  commandsRun: number
  editsMade?: number
  durationMs?: number
  todos?: Array<{ id: string; content: string; status: string; priority?: string }>
  /** THOUGHT STEPS PERSIST (fix 2026-09-08): quá trình thực thi được lưu vào
   * message metadata → sau reload/app-restart vẫn xem được Thought Process.
   * FIX 2026-10-22: tool event mang thêm tool/args/ok/dur/result — render
   * timeline ĐẦY ĐỦ như panel live (trước đây chỉ 🔧 + text rỗng). */
  events?: Array<{
    type: string
    ts?: number
    text: string
    tool?: string
    args?: string
    ok?: boolean
    dur?: number
    result?: string
  }>
}


/** Icon theo tool — timeline Thought Process */
export const RUN_TOOL_ICONS: Record<string, string> = {
  shell: '$',
  run_bg: '$',
  opencode: '⌨️',
  file_read: '📖',
  file_list: '📁',
  file_edit: '✏️',
  file_multi_edit: '✏️',
  file_delete: '🗑️',
  grep: '🔍',
  todo_write: '📋',
  todo_read: '📋',
  knowledge_search: '🧠',
  knowledge_graph: '🕸️',
  knowledge_write: '✍️',
  tavily: '🌐',
  serper: '🌐',
  jina: '🌐',
  web_search: '🌐',
  web_fetch: '🌐',
  git_commit: '📦',
  git_push: '📤',
  git_pull: '📥',
  run_tests: '🧪',
  create_custom_tool: '🔨',
  delete_custom_tool: '🗑️',
  list_custom_tools: '🔧',
}


export function runToolIcon(tool?: string): string {
  if (!tool) return '🔧'
  return RUN_TOOL_ICONS[tool] || '🔧'
}


export function fmtRunDuration(ms?: number): string {
  if (!ms || ms < 0) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`
}


/** Panel Thought Process — render bên trong message flow (role 'agent_run') */
export function AgentRunPanel({ run, todos }: { run: AgentRunData; todos: RunTodoData[] }) {
  // Mặc định ĐÓNG — bấm tiêu đề mới mở (user request: như Claude Code)
  const [open, setOpen] = useState(false)

  const running = run.status === 'running'
  const elapsed = (run.endedAt || Date.now()) - run.startedAt
  const c = run.counters
  // CI-2 (Task 11-b) — PER-TASK TODO ISOLATION: panel chỉ hiện todo của ĐÚNG
  // run này, ưu tiên theo thứ tự:
  //   (1) run.todos — DB per-runId từ /api/agent-run (11-a)
  //   (2) run.lastTodos — snapshot in-memory của tracker
  //   (3) prop todos (session-wide) — CHỈ còn fallback CUỐI cho dữ liệu legacy
  //       (runId=null, tạo trước CI-2) và đã lọc bỏ todo thuộc run khác →
  //       task cũ không còn trộn (bleed) vào panel task mới.
  const legacyTodos = todos.filter(t => !t.runId)
  const sourceTodos: RunTodoData[] = (run.todos && run.todos.length > 0)
    ? run.todos
    : ((run.lastTodos && run.lastTodos.length > 0) ? run.lastTodos : legacyTodos)
  // Ẩn todo đã lưu trữ (status 'archived' hoặc archivedAt != null) — run mới
  // archive todo mở của run cũ (archiveStaleRunTodos, 11-a) → panel cũ sạch.
  const todoList = sourceTodos.filter(t => t.status !== 'archived' && !t.archivedAt)
  const archivedCount = sourceTodos.length - todoList.length
  const doneCount = todoList.filter(t => t.status === 'completed').length

  // Hoạt động mới nhất — hiện ngay ở header (collapsed) để thấy "đang làm gì"
  const lastTool = [...run.events].reverse().find(e => e.type === 'tool')
  const lastThought = [...run.events].reverse().find(e => e.type === 'thought')
  const lastActivity = lastTool
    ? `${runToolIcon(lastTool.tool)} ${lastTool.argsSummary || lastTool.tool || ''}`
    : lastThought?.text

  const agentColor = AGENT_COLORS[run.agentName]?.text
    || (run.agentPosition ? POSITION_COLORS[run.agentPosition]?.text : undefined)
    || 'text-stone-200'

  return (
    <div className="max-w-[88%] w-full rounded-xl border border-stone-700/60 bg-slate-950/60 overflow-hidden">
      {/* Header — bấm để mở/thu gọn */}
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-slate-900/60 transition-colors text-left"
        aria-expanded={open}
        title={open ? 'Thu gọn Thought Process' : 'Mở Thought Process'}
      >
        <Brain className="h-3.5 w-3.5 text-violet-400 flex-shrink-0" />
        <span className="text-[13px] font-semibold text-stone-100">Thought Process</span>
        <span className={`text-[12px] font-medium ${agentColor}`}>{run.agentName}</span>
        {run.agentPosition && <span className="text-[11px] text-stone-400">({run.agentPosition})</span>}

        {/* Trạng thái */}
        {running ? (
          <span className="flex items-center gap-1 text-[11px] text-amber-300 flex-shrink-0">
            <Loader2 className="h-3 w-3 animate-spin" />
            Đang chạy · {fmtRunDuration(elapsed)}
          </span>
        ) : run.status === 'done' ? (
          <span className="flex items-center gap-1 text-[11px] text-emerald-400 flex-shrink-0">
            <CheckCircle2 className="h-3 w-3" /> Done
          </span>
        ) : run.status === 'cancelled' ? (
          <span className="flex items-center gap-1 text-[11px] text-orange-400 flex-shrink-0">
            <Square className="h-3 w-3" /> Đã dừng
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[11px] text-red-400 flex-shrink-0">
            <XCircle className="h-3 w-3" /> Lỗi
          </span>
        )}

        {/* Counters — tiến trình live ngay ở header */}
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-stone-400 flex-shrink-0">
          {c.iterations > 0 && <span>🔁 {c.iterations}</span>}
          {c.toolCalls > 0 && <span>🔧 {c.toolCalls}</span>}
          {c.filesRead > 0 && <span title={`${c.filesRead} file đã đọc`}>📖 {c.filesRead}</span>}
          {c.commandsRun > 0 && <span title={`${c.commandsRun} lệnh đã chạy`}>💻 {c.commandsRun}</span>}
          {c.editsMade > 0 && <span>✏️ {c.editsMade}</span>}
          {c.searches > 0 && <span>🔍 {c.searches}</span>}
          {!running && elapsed > 0 && <span>⏱ {fmtRunDuration(elapsed)}</span>}
          <ChevronDown className={`h-3 w-3 transition-transform ${open ? '' : '-rotate-90'}`} />
        </span>
      </button>

      {/* Live activity — luôn hiện khi đang chạy (kể cả collapsed) */}
      {running && lastActivity && !open && (
        <div className="px-3 pb-1.5 -mt-0.5 flex items-center gap-1.5 text-[11px] text-stone-400">
          <span className="text-amber-400/80">→</span>
          <span className="truncate">{lastActivity.slice(0, 90)}</span>
        </div>
      )}

      {open && (
        <div className="px-3 pb-2.5 space-y-2 border-t border-stone-700/40 pt-2">
          {/* Todos — TASK 21-d (user request 2026-10-21): hiển thị TẤT CẢ todo
              dạng CÂY (todo con lồng dưới todo cha qua parentId), todo hoàn
              thành đánh dấu ✓ + gạch ngang ("đóng" — việc đã xong rõ ràng,
              việc đang sống nổi bật), giữ nguyên thứ tự position của agent. */}
          {todoList.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <ClipboardList className="h-3 w-3 text-emerald-400" />
                <span className="text-[12px] font-medium text-stone-200">Todos</span>
                <span className="text-[11px] text-stone-400">{doneCount}/{todoList.length}</span>
                <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden ml-1">
                  <div
                    className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all duration-500"
                    style={{ width: `${todoList.length > 0 ? Math.round((doneCount / todoList.length) * 100) : 0}%` }}
                  />
                </div>
              </div>
              <div className="max-h-64 overflow-y-auto space-y-0.5 pr-1" style={{ scrollbarWidth: 'thin' }}>
                {(() => {
                  // Xây cây từ danh sách phẳng: todo con (parentId trỏ todo cha
                  // cùng run) lồng dưới cha; parent lạc (không có trong list)
                  // được nâng lên làm gốc — không mất todo nào.
                  const byId = new Map(todoList.map(t => [t.id, t]))
                  const childrenOf = new Map<string, RunTodoData[]>()
                  const roots: RunTodoData[] = []
                  for (const t of todoList) {
                    if (t.parentId && byId.has(t.parentId)) {
                      const arr = childrenOf.get(t.parentId) || []
                      arr.push(t)
                      childrenOf.set(t.parentId, arr)
                    } else {
                      roots.push(t)
                    }
                  }
                  const renderNode = (t: RunTodoData, depth: number): React.ReactNode => {
                    const st = t.status
                    const icon = st === 'completed' ? '✓' : st === 'in_progress' ? '◐' : st === 'failed' ? '✗' : st === 'blocked' ? '⚠' : '○'
                    const color = st === 'completed' ? 'text-emerald-500' : st === 'in_progress' ? 'text-amber-300' : st === 'failed' ? 'text-red-400' : st === 'blocked' ? 'text-orange-400' : 'text-stone-400'
                    const kids = childrenOf.get(t.id) || []
                    return (
                      <div key={t.id}>
                        <div
                          className="flex items-start gap-1.5 py-0.5 pr-1"
                          style={{ paddingLeft: depth > 0 ? `${depth * 18 + 2}px` : '2px' }}
                        >
                          {depth > 0 && <span className="text-[11px] leading-5 text-stone-600 flex-shrink-0 select-none">└</span>}
                          <span className={`text-[13px] leading-5 flex-shrink-0 ${color} ${st === 'in_progress' ? 'animate-pulse' : ''}`}>{icon}</span>
                          <span className={`text-[12px] leading-5 flex-1 break-words ${st === 'completed' ? 'text-stone-500 line-through' : 'text-stone-200'}`}>{t.content}</span>
                          {kids.length > 0 && <span className="text-[10px] leading-5 text-stone-500 flex-shrink-0">{kids.length}</span>}
                        </div>
                        {kids.map(k => renderNode(k, depth + 1))}
                      </div>
                    )
                  }
                  return (
                    <>
                      {roots.map(r => renderNode(r, 0))}
                      {/* CI-2 — todo đã lưu trữ của run này (bị run sau archive hoặc
                          crash-close): gọn 1 dòng xám, không chiếm chỗ */}
                      {archivedCount > 0 && (
                        <div className="px-1 py-0.5 text-[11px] text-stone-500">▸ {archivedCount} đã lưu trữ</div>
                      )}
                    </>
                  )
                })()}
              </div>
            </div>
          )}

          {/* Timeline — thoughts + tools + kết quả thật */}
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <Activity className="h-3 w-3 text-cyan-400" />
              <span className="text-[12px] font-medium text-stone-200">Quá trình thực thi</span>
              <span className="text-[11px] text-stone-400">{run.events.filter(e => e.type !== 'todo_update').length} sự kiện</span>
            </div>
            <div className="max-h-80 overflow-y-auto space-y-1 pr-1" style={{ scrollbarWidth: 'thin' }}>
              {run.task && (
                <div className="text-[11px] text-stone-400 px-1">
                  🎯 Nhiệm vụ: <span className="text-stone-300">{run.task.slice(0, 160)}</span>
                </div>
              )}
              {run.events.map(e => {
                if (e.type === 'thought') {
                  return (
                    <div key={e.id} className="px-2 py-1.5 rounded bg-slate-900/50 border-l-2 border-violet-500/50">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-[11px] text-violet-300">💭 Suy nghĩ</span>
                        {e.iteration != null && <span className="text-[10px] text-stone-500">Vòng {e.iteration}</span>}
                        <span className="text-[10px] text-stone-500 ml-auto">{new Date(e.ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                      </div>
                      <p className="text-[12px] leading-5 text-stone-300 italic whitespace-pre-wrap line-clamp-6">{e.text}</p>
                    </div>
                  )
                }
                if (e.type === 'tool') {
                  return (
                    <div key={e.id} className="px-2 py-1.5 rounded bg-slate-900/40 border-l-2 border-cyan-500/40">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[12px] flex-shrink-0">{runToolIcon(e.tool)}</span>
                        <span className="text-[11px] font-mono text-cyan-200 flex-shrink-0">{e.tool}</span>
                        {e.argsSummary && <span className="text-[11px] text-stone-300 truncate max-w-[45%]">{e.argsSummary}</span>}
                        <span className={`text-[11px] flex-shrink-0 ${e.success ? 'text-emerald-400' : 'text-red-400'}`}>{e.success ? '✓' : '✗'}</span>
                        {e.durationMs != null && <span className="text-[10px] text-stone-500 ml-auto flex-shrink-0">{fmtRunDuration(e.durationMs)}</span>}
                      </div>
                      {/* KẾT QUẢ THẬT — minh bạch: lệnh thật + output thật */}
                      {e.resultPreview && (
                        <pre className="mt-1 text-[11px] leading-4 text-stone-400 whitespace-pre-wrap max-h-24 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>{e.resultPreview}</pre>
                      )}
                    </div>
                  )
                }
                if (e.type === 'run_end') {
                  return (
                    <div key={e.id} className={`flex items-center gap-1.5 px-2 py-1 text-[12px] ${e.cancelled ? 'text-orange-400' : e.success ? 'text-emerald-400' : 'text-red-400'}`}>
                      {e.cancelled ? <Square className="h-3 w-3" /> : e.success ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                      {e.cancelled ? 'Đã dừng' : e.success ? 'Done' : 'Lỗi'}{e.text ? ` — ${e.text}` : ''}
                    </div>
                  )
                }
                return null
              })}
              {running && (
                <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-amber-300/90">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Đang thực thi...
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}


/** Summary bar tĩnh — hiện trên assistant message sau khi reload session */
export function AgentRunSummaryBar({ summary }: { summary: AgentRunSummaryData }) {
  const ok = summary.status !== 'error' && summary.status !== 'cancelled'
  const statusLabel = summary.status === 'cancelled' ? '⏹ Đã dừng' : ok ? '✓ Done' : '✗ Lỗi'
  const statusColor = summary.status === 'cancelled' ? 'text-orange-400' : ok ? 'text-emerald-400' : 'text-red-400'
  const events = summary.events || []
  return (
    <div className="mb-1.5 pb-1.5 border-b border-stone-700/40">
      <div className="flex items-center gap-2 flex-wrap text-[11px] text-stone-400">
        <Brain className="h-3 w-3 text-violet-400" />
        <span className="text-stone-300">{summary.agentName}</span>
        <span className={statusColor}>{statusLabel}</span>
        {summary.iterations > 0 && <span>🔁 {summary.iterations} vòng</span>}
        {summary.toolCalls > 0 && <span>🔧 {summary.toolCalls} tool</span>}
        {summary.filesRead > 0 && <span>📖 {summary.filesRead} file</span>}
        {summary.commandsRun > 0 && <span>💻 {summary.commandsRun} lệnh</span>}
        {summary.editsMade != null && summary.editsMade > 0 && <span>✏️ {summary.editsMade}</span>}
        {summary.durationMs != null && summary.durationMs > 0 && <span>⏱ {fmtRunDuration(summary.durationMs)}</span>}
      </div>
      {events.length > 0 && (
        <details className="mt-1 group">
          <summary className="cursor-pointer text-[11px] text-violet-300/90 hover:text-violet-200 select-none">
            🧠 Xem quá trình thực thi ({events.length} bước — đã lưu, survives restart)
          </summary>
          {/* FIX 2026-10-22 (user bug report "Thought Progress biến mất / không
              thấy tên tool"): render timeline ĐẦY ĐỦ như panel live — tool event
              có TÊN TOOL (mono) + args + ✓/✗ + duration + kết quả preview;
              thought event dạng khối 💭. Bản ghi CŨ (chỉ có text) → fallback
              render 1 dòng như trước (không mất dữ liệu). */}
          <div className="mt-1 max-h-72 overflow-y-auto space-y-1 border border-stone-700/40 rounded bg-stone-900/40 p-1.5" style={{ scrollbarWidth: 'thin' }}>
            {events.map((e, i) => {
              // Tool event ĐẦY ĐỦ (bản ghi mới 2026-10-22) — có tên tool
              if (e.type === 'tool' && e.tool) {
                return (
                  <div key={i} className="px-2 py-1.5 rounded bg-slate-900/40 border-l-2 border-cyan-500/40">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[12px] flex-shrink-0">{RUN_TOOL_ICONS[e.tool] || '🔧'}</span>
                      <span className="text-[11px] font-mono text-cyan-200 flex-shrink-0">{e.tool}</span>
                      {e.args && <span className="text-[11px] text-stone-300 truncate max-w-[45%]">{e.args}</span>}
                      <span className={`text-[11px] flex-shrink-0 ${e.ok ? 'text-emerald-400' : 'text-red-400'}`}>{e.ok ? '✓' : '✗'}</span>
                      {e.dur != null && <span className="text-[10px] text-stone-500 ml-auto flex-shrink-0">{fmtRunDuration(e.dur)}</span>}
                    </div>
                    {e.result && (
                      <pre className="mt-1 text-[11px] leading-4 text-stone-400 whitespace-pre-wrap max-h-20 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>{e.result}</pre>
                    )}
                  </div>
                )
              }
              // Thought event — khối 💭 như panel live
              if (e.type === 'thought') {
                return (
                  <div key={i} className="px-2 py-1.5 rounded bg-slate-900/50 border-l-2 border-violet-500/50">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="text-[11px] text-violet-300">💭 Suy nghĩ</span>
                    </div>
                    <p className="text-[12px] leading-5 text-stone-300 italic whitespace-pre-wrap line-clamp-6">{e.text}</p>
                  </div>
                )
              }
              // Bản ghi CŨ (không có tool name) / sự kiện khác — fallback 1 dòng
              return (
                <div key={i} className="text-[11px] leading-relaxed text-stone-300 px-1">
                  {e.type === 'tool' ? '🔧' : e.type === 'thought' ? '💭' : '•'} {e.text || (e.type === 'tool' ? '(bản ghi cũ — thiếu tên tool)' : '')}
                </div>
              )
            })}
          </div>
        </details>
      )}
    </div>
  )
}


// ==================== GĐ4 CI-5 (Task 14-e) — DURABLE GOAL LOOP JOB MONITOR ====================
//
// POST /api/openclaw/chat khi ENABLE_DURABLE_GOAL_LOOP=true trả về TỨC THÌ
// { durable: true, jobId, content: "⏳ Tác vụ đã vào hàng đợi nền…" } — goal
// loop chạy NGOÀI HTTP request (worker nền, checkpoint mỗi vòng, sống sót
// qua restart; finalize lưu ChatMessage assistant thật vào phiên). Frontend:
//   (1) sendMessage append PLACEHOLDER message (goalLoopJobId) — KHÔNG coi
//       là lỗi, spinner tắt như request đã xong (job chạy nền);
//   (2) poll GET /api/goal-loop-jobs?jobId= mỗi 3s — cập nhật progressHint
//       ("chu kỳ N · X vòng · Y tool calls") vào placeholder + panel;
//   (3) job completed → THAY placeholder bằng câu trả lời thật (result.content)
//       + refreshAgentRuns() để Thought Process panel pick up run (worker
//       cùng process ghi run tracker — mirror inline path);
//   (4) failed → thông báo lỗi tiếng Việt; cancelled → ⏹ (không phải lỗi);
//   (5) Panel "Tác vụ nền" theo dõi mọi job của phiên đang mở (re-attach khi
//       mở lại phiên — đóng tab/restart KHÔNG mất tác vụ, đúng B8-b).
// Khi response KHÔNG có durable/jobId (flag OFF / đường thường) → toàn bộ
// mảng này DORMANT — hành vi cũ 100% giữ nguyên.

/** Job item từ GET /api/goal-loop-jobs (mirror GoalLoopJobApiItem của route —
 *  KHÔNG chứa input/checkpoint raw). */
export interface GoalLoopJobApiData {
  id: string
  sessionId: string
  messageId: string | null
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  cyclesDone: number
  progressHint: string | null
  stopReason: string | null
  error: string | null
  attempts: number
  cancelRequested: boolean
  cancelRequestedAt: string | null
  heartbeatAt: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  ageMs: number
  stallWarning: boolean
  /** CHỈ khi completed — projection kết quả (content = câu trả lời thật) */
  result?: {
    content: string
    goalLoop?: unknown
    taskSummary?: string
    agentName?: string
  } | null
}


/** Job state client-side — API item + agentName client (server chỉ trả tên
 *  trong result khi completed; khi đang chạy dùng tên seed client lúc gửi). */
export interface GoalLoopJobViewData extends GoalLoopJobApiData {
  agentName?: string
}


/** Badge màu theo trạng thái job (panel Tác vụ nền + placeholder). */
export const GOAL_LOOP_STATUS_META: Record<GoalLoopJobViewData['status'], { label: string; badgeClass: string }> = {
  queued: { label: 'Đang chờ', badgeClass: 'bg-stone-800/70 text-stone-300 border border-stone-600/40' },
  running: { label: 'Đang chạy', badgeClass: 'bg-emerald-950/60 text-emerald-300 border border-emerald-500/40 animate-pulse' },
  completed: { label: 'Hoàn tất', badgeClass: 'bg-emerald-900/50 text-emerald-300 border border-emerald-500/50' },
  failed: { label: 'Lỗi', badgeClass: 'bg-red-950/60 text-red-300 border border-red-500/40' },
  cancelled: { label: 'Đã dừng', badgeClass: 'bg-amber-950/60 text-amber-300 border border-amber-500/40' },
}


/** Tuổi "không tín hiệu sống" của job (phút, làm tròn ≥1) — cảnh báo stall. */
export function goalLoopStallMinutes(job: GoalLoopJobViewData): number {
  const ref = job.heartbeatAt || job.startedAt || job.createdAt
  const ms = ref ? Date.now() - Date.parse(ref) : job.ageMs
  return Math.max(1, Math.round((Number.isFinite(ms) ? ms : job.ageMs) / 60000))
}


/**
 * Thay message placeholder (goalLoopJobId) bằng message thật khi job terminal.
 * Placeholder đã mất (vd tail reload giữa chừng) → append thông báo ở cuối
 * thay vì chen lại giữa dòng chat. Pure function — gọi trong setMessages.
 */
export function replaceDurablePlaceholder(
  prev: SmolabMessage[],
  jobId: string,
  patch: { role: SmolabMessage['role']; content: string } & Partial<SmolabMessage>,
): SmolabMessage[] {
  const idx = prev.findIndex(m => m.goalLoopJobId === jobId)
  if (idx === -1) {
    return [...prev, {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      ...patch,
      goalLoopJobId: undefined,
    }]
  }
  const next = [...prev]
  next[idx] = { ...next[idx], ...patch, goalLoopJobId: undefined }
  return next
}


/**
 * Placeholder bubble trong message flow — job durable đang chạy (14-e Mảnh 2+3):
 * spinner + progressHint live + cảnh báo stall (KHÔNG tự hủy) + nút Dừng riêng
 * (touch target 44px — nút Gửi/Dừng chính không đổi vì isLoading đã tắt).
 */
export function DurableGoalLoopBubble({
  msg, job, onCancel,
}: {
  msg: SmolabMessage
  job: GoalLoopJobViewData
  onCancel: (jobId: string) => void
}) {
  const cancelling = job.cancelRequested
  const queued = job.status === 'queued'
  return (
    <div className="max-w-[85%] p-2.5 bg-slate-950/50 border border-emerald-400/35 border-l-2 border-l-emerald-400">
      <div className="flex items-center gap-1.5 mb-1">
        <Loader2 className="h-3 w-3 animate-spin text-emerald-400" aria-hidden="true" />
        <span className="text-[11px] text-emerald-300 font-medium">⚙️ Tác vụ nền</span>
        {job.agentName && <span className="text-[10px] text-stone-400 truncate">{job.agentName}</span>}
        <Badge className={`text-[9px] h-3.5 px-1.5 ${GOAL_LOOP_STATUS_META[job.status]?.badgeClass || ''}`}>
          {GOAL_LOOP_STATUS_META[job.status]?.label || job.status}
        </Badge>
      </div>
      <p className="text-base whitespace-pre-wrap leading-relaxed text-stone-100">
        {cancelling
          ? '⏳ Đang yêu cầu dừng… (agent sẽ kết thúc ở bước an toàn gần nhất)'
          : queued
          ? (msg.content || '⏳ Tác vụ đã vào hàng đợi nền — đang chờ worker nhận…')
          : `⏳ Đang chạy — ${job.progressHint || 'đang khởi động…'}`}
      </p>
      {job.stallWarning && !cancelling && (
        <p className="mt-1 text-[11px] text-amber-400">
          ⚠ Không có tín hiệu sống {goalLoopStallMinutes(job)} phút — job vẫn đang chạy, không tự hủy
        </p>
      )}
      <div className="flex items-center gap-2 mt-2 pt-1.5 border-t border-emerald-500/15">
        <Button
          size="sm"
          variant="outline"
          onClick={() => onCancel(job.id)}
          disabled={cancelling}
          aria-label={`Dừng tác vụ nền của ${job.agentName || 'Agent'}`}
          title={cancelling ? 'Đang yêu cầu dừng…' : 'Dừng tác vụ nền này'}
          className="h-11 min-w-[44px] px-4 border-red-400/40 bg-red-950/30 text-red-300 hover:bg-red-900/50 hover:text-red-200 hover:border-red-400/60"
        >
          <Square className="h-3 w-3 fill-current" aria-hidden="true" />
          <span className="text-[12px]">Dừng</span>
        </Button>
        <span className="text-[10px] text-stone-400 ml-auto">
          {fmtRunDuration(job.ageMs) || 'mới'} · job {job.id.slice(0, 8)}…
        </span>
      </div>
    </div>
  )
}


/**
 * Panel "Tác vụ nền" (roadmap CI-5 B7) — chỉ render khi có job của phiên đang
 * mở (active, hoặc vừa terminal — purge khỏi state sau 15s → panel tự ẩn,
 * KHÔNG chiếm không gian khi rảnh). Mỗi job: tên agent, badge trạng thái,
 * progressHint, tuổi, ⚠ stall, nút hủy riêng (touch target 44px).
 */
export function GoalLoopJobsPanel({
  jobs, onCancel,
}: {
  jobs: GoalLoopJobViewData[]
  onCancel: (jobId: string) => void
}) {
  const activeCount = jobs.filter(j => j.status === 'queued' || j.status === 'running').length
  return (
    <div
      className="flex-shrink-0 mx-3 mt-2 p-2.5 chamfer-sm bg-slate-950/60 border border-emerald-400/30"
      role="region"
      aria-label={`Tác vụ nền — ${activeCount} đang chạy`}
    >
      <div className="flex items-center gap-1.5 mb-2">
        <Activity className="h-3 w-3 text-emerald-400" aria-hidden="true" />
        <span className="text-[11px] font-medium text-emerald-300 uppercase tracking-wider">Tác vụ nền</span>
        <span className="text-[10px] text-stone-400 truncate">
          {activeCount > 0 ? `${activeCount} đang chạy — chạy tiếp kể cả khi đóng tab` : 'vừa kết thúc'}
        </span>
      </div>
      <div className="space-y-1.5 max-h-44 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
        {jobs.map(job => {
          const meta = GOAL_LOOP_STATUS_META[job.status] || GOAL_LOOP_STATUS_META.queued
          const active = job.status === 'queued' || job.status === 'running'
          return (
            <div key={job.id} className="flex items-center gap-2 p-1.5 bg-slate-900/40 border border-stone-700/40">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[12px] text-stone-200 font-medium truncate">{job.agentName || 'Agent'}</span>
                  <Badge className={`text-[9px] h-3.5 px-1.5 ${meta.badgeClass}`}>{meta.label}</Badge>
                  {job.attempts > 0 && (
                    <span className="text-[9px] text-amber-400/80" title={`Đã tự thử lại ${job.attempts} lần sau crash`}>↻ {job.attempts}</span>
                  )}
                  {job.stallWarning && (
                    <span className="text-[10px] text-amber-400" title={`Không cập nhật tín hiệu sống ${goalLoopStallMinutes(job)} phút — job vẫn chạy`}>
                      ⚠ {goalLoopStallMinutes(job)} phút không tín hiệu
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-stone-400 truncate">
                  {job.status === 'queued'
                    ? 'Đang chờ worker nhận…'
                    : job.status === 'running'
                    ? (job.progressHint || 'đang khởi động…')
                    : job.status === 'failed'
                    ? `Lỗi${job.error ? `: ${String(job.error).slice(0, 80)}` : ''}`
                    : job.status === 'cancelled'
                    ? 'Đã dừng theo yêu cầu'
                    : 'Hoàn tất — câu trả lời đã vào khung chat'}
                  {' · '}{fmtRunDuration(job.ageMs) || 'mới'}
                </div>
              </div>
              {active && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onCancel(job.id)}
                  disabled={job.cancelRequested}
                  aria-label={`Dừng tác vụ nền của ${job.agentName || 'Agent'}`}
                  title={job.cancelRequested ? 'Đang yêu cầu dừng…' : 'Dừng tác vụ nền này'}
                  className="h-11 w-11 p-0 shrink-0 border-red-400/40 bg-red-950/30 text-red-300 hover:bg-red-900/50 hover:text-red-200 hover:border-red-400/60"
                >
                  <Square className="h-3 w-3 fill-current" aria-hidden="true" />
                </Button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}


export const SMOLAB_MODEL_GROUPS = [
  {
    provider: 'NVIDIA',
    icon: '🎮',
    models: [
      // 2 extraction cores (user directive 2026-09-05 — kimi-k3 bị cấm cho extraction)
      { id: 'nvidia/nemotron-3-ultra-550b-a55b', label: 'nemotron-3-ultra-550b (extraction chính)' },
      { id: 'openai/gpt-oss-120b', label: 'gpt-oss-120b (extraction fallback)' },
      // FIX 2026-09-30 → 2026-10-16 (USER DIRECTIVE): minimax-m3 = lõi chính
      // TẠM THỜI (duy nhất khả dụng) — kimi-k3 + deepseek-v4 xuống fallback.
      { id: 'minimaxai/minimax-m3', label: 'MiniMax M3 (lõi chính — tạm thời)' },
      { id: 'moonshotai/kimi-k3', label: 'Kimi K3 (fallback #1)' },
      { id: 'deepseek-ai/deepseek-v4-pro-0813', label: 'DeepSeek V4 Pro (fallback #2)' },
      { id: 'deepseek-ai/deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash (fallback #3)' },
    ],
  },
]


export const SMOLAB_TABS = [
  { id: 'knowledge', label: 'Knowledge', icon: Brain, color: 'cyan' },
  { id: 'memory', label: 'Memory', icon: Thermometer, color: 'rose' },
  { id: 'learning', label: 'Learning', icon: BookMarked, color: 'amber' },
  // TASK 22 (user directive 2026-09-30 #4): đổi tên tab "Skills" → "Tools/Skills"
  // — panel này giờ là trung tâm của CẢ tools (75 builtin + custom) lẫn skills
  // (filesystem + DB), đồng thời Tools Registry hiển thị matrix agents↔tools.
  // (FIX 2026-09-02 audit Omega #7: đếm lại — builtin thực tế là 75, không phải 74)
  { id: 'skills', label: 'Tools/Skills', icon: Wrench, color: 'violet' },
  { id: 'automation', label: 'Automation', icon: Zap, color: 'orange' },
  { id: 'channels', label: 'Channels', icon: Radio, color: 'teal' },
  { id: 'code', label: 'Code', icon: Code2, color: 'emerald' },
]


export const TAB_COLOR_CLASSES: Record<string, { active: string; hover: string }> = {
  emerald: { active: 'from-emerald-500/80 to-teal-600/80', hover: 'hover:text-emerald-400' },
  cyan: { active: 'from-cyan-500/80 to-sky-600/80', hover: 'hover:text-cyan-400' },
  amber: { active: 'from-amber-500/80 to-yellow-600/80', hover: 'hover:text-amber-400' },
  violet: { active: 'from-violet-500/80 to-purple-600/80', hover: 'hover:text-violet-400' },
  orange: { active: 'from-orange-500/80 to-red-600/80', hover: 'hover:text-orange-400' },
  teal: { active: 'from-teal-500/80 to-emerald-600/80', hover: 'hover:text-teal-400' },
  rose: { active: 'from-rose-500/80 to-pink-600/80', hover: 'hover:text-rose-400' },
}


export const SMOLAB_SUGGESTIONS = [
  'Knowledge Base chứa những gì?',
  'Mối quan hệ giữa ML và Neural Network',
  'Các kỹ thuật bảo mật phổ biến',
]


/** Human-friendly chat bubble for an AI tool call (rich Vietnamese labels). */
export function formatToolBubble(tool: string, detail?: string): string {
  try {
    const raw = typeof detail === 'string' ? detail : ''
    if (tool === 'file_read') {
      const p = extractJsonStringField(raw, 'path') || extractJsonStringField(raw, 'filePath') || extractJsonStringField(raw, 'file_path')
      return p ? `📖 Đang đọc ${pathFileName(p)}` : '📖 Đang đọc file'
    }
    if (tool === 'file_edit' || tool === 'file_multi_edit') {
      const p = extractJsonStringField(raw, 'path') || extractJsonStringField(raw, 'filePath') || extractJsonStringField(raw, 'file_path')
      const editCount = (raw.match(/"old_string"/g) || []).length
        || (raw.match(/"new_string"/g) || []).length
        || (tool === 'file_edit' ? 1 : 0)
      const n = editCount > 1 ? ` (${editCount} edits)` : ''
      return p ? `✏️ Đang sửa ${pathFileName(p)}${n}` : `✏️ Đang sửa file${n}`
    }
    if (tool === 'shell' || tool === 'gateway_exec') {
      const cmd = extractJsonStringField(raw, 'command')
      if (cmd) return `▶️ ${cmd.slice(0, 60)}${cmd.length > 60 ? '…' : ''}`
    }
    if (tool === 'start_preview') {
      const port = extractJsonNumberField(raw, 'port')
      return port ? `▶️ Start preview (port ${port})` : '▶️ Start preview'
    }
    if (tool === 'stop_preview') return '⏹️ Stop preview'
    return `🔧 ${tool}`
  } catch {
    return `🔧 ${tool}`
  }
}


// ==================== SMOLAB CHAT CONTEXT PERSISTENCE (user request 2026-09-01) ====================
// User rời module Smolab (sang Database/Agents) rồi quay lại → phải thấy
// ĐÚNG phiên làm việc lúc rời đi (agent/team đã chọn + session đang mở),
// kể cả agent đang chạy dở (task tiếp tục chạy nền — xem inFlightChatsRef).
export const SMOLAB_CTX_KEY = 'smolab-chat-context-v1'


export function readSmolabContext(): {
  chatMode?: 'single' | 'multi'
  selectedAgentId?: string | null
  selectedTeam?: string | null
  currentSessionId?: string
  selectedModel?: string
} {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(SMOLAB_CTX_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}


export default function SmolabModule({ sidebarOpen }: { sidebarOpen: boolean }) {
  // Chat state — KHỞI TẠO TỪ localStorage (restore phiên làm việc cũ)
  const restoredCtx = useMemo(() => readSmolabContext(), [])
  const [messages, setMessages] = useState<SmolabMessage[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  // 2026-10-27 (user directive — trần prompt THEO TÁC VỤ): 'auto' = trần mặc
  // định hệ thống; 'unlimited' = -1 KHÔNG GIỚI HẠN cho đúng tác vụ sắp gửi.
  const [promptBudgetMode, setPromptBudgetMode] = useState<'auto' | 'unlimited'>('auto')
  // MODEL POLICY 2026-10-16: minimax-m3 là mặc định (agents độc lập + chat —
  // lõi chính tạm thời, duy nhất khả dụng); kimi/ds là failover backup
  const [selectedModel, setSelectedModel] = useState(restoredCtx.selectedModel || 'minimaxai/minimax-m3')
  const [activeSmolabTab, setActiveSmolabTab] = useState('knowledge')
  const [gatewayOnline, setGatewayOnline] = useState(false)
  const [sessions, setSessions] = useState<SmolabSession[]>([])
  const [currentSessionId, setCurrentSessionId] = useState(restoredCtx.currentSessionId || '')
  const [showSessionSelect, setShowSessionSelect] = useState(false)
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [sessionSearchQuery, setSessionSearchQuery] = useState('')
  const [feedbackLoading, setFeedbackLoading] = useState<string | null>(null)
  const [loadingMessages, setLoadingMessages] = useState(false)
  // USER REQUEST 2026-09-01: bump để refresh danh sách session ngay khi tác vụ
  // nền kết thúc (chấm xanh "đang chạy" phải biến mất kịp thời, không chờ 30s)
  const [sessionsRefreshTick, setSessionsRefreshTick] = useState(0)

  // ===== OPUS (Task 13-c) — ⚖️ CTO meta-agent review mode trong chat =====
  // mode: manual (bấm nút review sau mỗi run) | auto (Opus tự review & hành
  // động sau mỗi run — chỉ dừng khi hoàn hảo; kill switch là phanh duy nhất).
  // killed: OpusSettings.killed TOÀN HỆ THỐNG (không theo session).
  const [opusMode, setOpusMode] = useState<'manual' | 'auto'>('manual')
  const [opusKilled, setOpusKilled] = useState(false)
  const [opusStatusLoading, setOpusStatusLoading] = useState(false)
  const [showOpusModeMenu, setShowOpusModeMenu] = useState(false)
  // messageId (assistant) → review — Review Card render ngay dưới message đó
  const [opusReviews, setOpusReviews] = useState<Map<string, OpusReviewSerialized>>(new Map())
  // messageId đang chạy review (30-120s — KHÔNG timeout ở UI)
  const [opusReviewLoading, setOpusReviewLoading] = useState<string | null>(null)
  // reviewId đã ban hành chỉ đạo (nút → badge "Đã ban hành ✓")
  const [opusDispatched, setOpusDispatched] = useState<Set<string>>(new Set())

  // ===== Agent Run — Thought Process + Todos + Progress (user request 2026-08-31) =====
  // agentRuns: runId → dữ liệu run mới nhất (poll từ /api/agent-run mỗi 1.2s
  // trong lúc agent đang chạy). Panel render trong message flow (role 'agent_run').
  const [agentRuns, setAgentRuns] = useState<Record<string, AgentRunData>>({})
  // CI-2 (11-b): sessionTodos giờ chỉ còn là fallback CUỐI trong panel Thought
  // Process (todo legacy runId=null) — ưu tiên run.todos per-runId (11-a).
  const [sessionTodos, setSessionTodos] = useState<RunTodoData[]>([])
  const agentRunsRef = useRef<Record<string, AgentRunData>>({})
  const isLoadingRef = useRef(false)
  useEffect(() => { agentRunsRef.current = agentRuns })
  useEffect(() => { isLoadingRef.current = isLoading })
  // Clear run data khi đổi session (panel messages cũng bị thay bởi session load)
  useEffect(() => { setAgentRuns({}); setSessionTodos([]) }, [currentSessionId])

  // ===== GĐ4 CI-5 (Task 14-e) — Durable goal-loop jobs: state + poll =====
  // goalLoopJobs: jobId → view mới nhất (poll GET /api/goal-loop-jobs?jobId=
  // mỗi 3s khi job active — mirror poller agent-run 1.2s). Chỉ chứa job của
  // PHIÊN ĐANG MỞ: đổi phiên → clear (job vẫn chạy nền server-side; mở lại
  // phiên → loadSessionTail re-attach + poll tiếp — đóng tab không mất tác vụ).
  const [goalLoopJobs, setGoalLoopJobs] = useState<Record<string, GoalLoopJobViewData>>({})
  const goalLoopJobsRef = useRef<Record<string, GoalLoopJobViewData>>({})
  // Số lần poll lỗi liên tiếp theo jobId — 5 lần → dừng poll + log console
  const goalLoopFailsRef = useRef<Record<string, number>>({})
  useEffect(() => { goalLoopJobsRef.current = goalLoopJobs })
  useEffect(() => { setGoalLoopJobs({}) }, [currentSessionId])

  // ===== USER REQUEST 2026-08-31 — DỪNG tác vụ Agents bằng nút Gửi + chống kẹt "Đang suy nghĩ" =====
  // chatAbortRef: AbortController của fetch đang chờ (chat + team workflow SSE).
  //   Bấm nút Gửi khi đang chạy → abort client-side + POST /api/agent-run hủy server-side.
  // stoppingRef: phân biệt "user chủ động dừng" (không hiện error) với lỗi thật.
  // timedOutRef: hard-timeout client 20 phút — không bao giờ kẹt "Đang suy nghĩ" vĩnh viễn
  //   (bug report: request treo → isLoading true mãi → đổi phiên vẫn "Đang suy nghĩ").
  const currentSessionIdRef = useRef('')
  const chatAbortRef = useRef<AbortController | null>(null)
  const stoppingRef = useRef(false)
  const timedOutRef = useRef(false)
  // Thời điểm user bấm DỪNG gần nhất — refreshAgentRuns dùng cửa sổ 5s này để
  // biết run 'cancelled' vừa xảy ra do USER STOP (không reload tail — giữ thông
  // báo ⏹) hay là run bị cancel cũ (reload bình thường).
  const lastStoppedAtRef = useRef(0)
  useEffect(() => { currentSessionIdRef.current = currentSessionId })

  // ===== TASK 53 — REALTIME HEARTBEAT refs (user request 2026-09-28) =====
  // latestDbMessageRef: message DB (id cuid — KHÔNG chứa '-') MỚI NHẤT client
  // đang hiển thị = cursor afterId cho delta fetch của heartbeat realtime.
  // CHỈ được cập nhật bởi đường load TỪ DB (loadSessionTail / delta append) —
  // message client tự append (crypto.randomUUID, có '-') không tính.
  const latestDbMessageRef = useRef<{ id: string } | null>(null)
  // loadSessionTail đang fetch/replace state — heartbeat NGHỈ trong lúc đó
  // để không đua append-delta với replace-tail (mất message vừa append).
  const sessionTailLoadingRef = useRef(false)
  // Thời điểm user vừa bấm đổi mode/kill Opus ở client — heartbeat không đè
  // optimistic update trong cửa sổ 5s này (PATCH đang bay)
  const lastOpusModeActionRef = useRef(0)

  // Restore persisted Smolab tab AFTER mount to avoid hydration mismatch.
  const smolabTabRestoredRef = useRef(false)
  useEffect(() => {
    if (!smolabTabRestoredRef.current) {
      smolabTabRestoredRef.current = true
      try {
        const saved = localStorage.getItem('graphrag-smolab-tab')
        if (saved) {
          // If saved tab was removed (e.g. 'chat-settings'), redirect to 'knowledge'
          const validTabs = SMOLAB_TABS.map(t => t.id)
          const validTab = validTabs.includes(saved) ? saved : 'knowledge'
          setActiveSmolabTab(validTab)
          if (validTab !== saved) localStorage.setItem('graphrag-smolab-tab', validTab)
        }
      } catch { /* ignore */ }
    }
  }, [])

  // Phase D: Agent/Team chat mode — restore từ context cũ
  const [chatMode, setChatMode] = useState<'single' | 'multi'>(
    restoredCtx.chatMode === 'multi' ? 'multi' : 'single'
  )
  const [smolabAgents, setSmolabAgents] = useState<any[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(restoredCtx.selectedAgentId || null)
  const [selectedTeam, setSelectedTeam] = useState<string | null>(
    restoredCtx.selectedTeam === 'code' || restoredCtx.selectedTeam === 'research' ? restoredCtx.selectedTeam : null
  ) // 'code' | 'research'
  const [showAgentSelect, setShowAgentSelect] = useState(false)
  const [showTeamSelect, setShowTeamSelect] = useState(false)

  // Smolab task tracking — background task polling (Phase 6)
  const [activeTaskIds, setActiveTaskIds] = useState<Map<string, string>>(new Map()) // sessionId → taskId
  const [taskPolling, setTaskPolling] = useState(false)


  // canChat — PHẢI chọn Agent/Team trước khi chat (Phase 5)
  const canChat = (chatMode === 'single' && !!selectedAgentId) || (chatMode === 'multi' && !!selectedTeam)

  // Resize panel state — persisted via localStorage so positions survive module switches
  const SMOLAB_STORAGE_PREFIX = 'smolab_layout_'
  const readStored = <T,>(key: string, fallback: T): T => {
    if (typeof window === 'undefined') return fallback
    try {
      const raw = localStorage.getItem(SMOLAB_STORAGE_PREFIX + key)
      if (raw === null) return fallback
      return JSON.parse(raw) as T
    } catch { return fallback }
  }

  const [chatPanelWidth, setChatPanelWidth] = useState(() => readStored('chatPanelWidth', 400))
  const isDragging = useRef(false)
  const dragStartX = useRef(0)
  const dragStartWidth = useRef(0)
  const smolabContainerRef = useRef<HTMLDivElement>(null)

  // Outer edge resize state — absolute viewport positions
  // smolabLeft = distance from viewport left edge to module left edge
  // smolabRight = distance from viewport right edge to module right edge
  // smolabTop = distance from viewport top (below header) to module top edge
  const SIDEBAR_WIDTH_OPEN = 224 // w-56 = 14rem = 224px
  const SIDEBAR_WIDTH_CLOSED = 48  // w-12 = 3rem = 48px
  const HEADER_HEIGHT = 56
  // FIX 2026-08-28 (post-reset review): connection status bar (footer, z-40, ~33px)
  // overlaps the bottom of the Smolab module (z-15) — the chat input row / nút
  // Gửi-Dừng bị chìm ~21px dưới status bar → click center trúng status bar, không
  // trúng nút (user không dừng được agent). Module height giờ trừ thêm chiều cao
  // status bar để input row nằm HOÀN TOÀN phía trên footer.
  const STATUS_BAR_HEIGHT = 34
  const MIN_MODULE_WIDTH = 300
  const MIN_MODULE_HEIGHT = 200

  const sidebarWidth = sidebarOpen ? SIDEBAR_WIDTH_OPEN : SIDEBAR_WIDTH_CLOSED
  // Default left = sidebar width (right edge of sidebar)
  const [smolabLeft, setSmolabLeft] = useState<number | null>(() => readStored<number | null>('smolabLeft', null))
  const [smolabRight, setSmolabRight] = useState<number | null>(() => readStored<number | null>('smolabRight', null))
  const [smolabTop, setSmolabTop] = useState<number | null>(() => readStored<number | null>('smolabTop', null))
  const [smolabHeight, setSmolabHeight] = useState<number | null>(() => readStored<number | null>('smolabHeight', null))

  // Effective values (resolve null to defaults)
  const effectiveLeft = smolabLeft !== null ? smolabLeft : sidebarWidth
  const effectiveRight = smolabRight !== null ? smolabRight : 0
  const effectiveTop = smolabTop !== null ? smolabTop : 0
  const effectiveHeight = smolabHeight !== null ? smolabHeight : (window.innerHeight - HEADER_HEIGHT - STATUS_BAR_HEIGHT - effectiveTop)

  const isDraggingLeft = useRef(false)
  const isDraggingRight = useRef(false)
  const isDraggingBottom = useRef(false)
  const isDraggingTop = useRef(false)
  const dragStartLeft = useRef(0)
  const dragStartRight = useRef(0)
  const dragStartTop = useRef(0)
  const dragStartHeight = useRef(0)
  const dragStartY = useRef(0) // shared for top & bottom edge dragging
  const smolabOuterRef = useRef<HTMLDivElement>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const chatInputRef = useRef<HTMLInputElement>(null)
  // V1 FIX: Ref to skip message loading when session ID is set programmatically (e.g. sendMessage creates new session)
  // This prevents the useEffect from wiping messages that were just added to state
  const skipMessageLoadRef = useRef(false)

  // ===== USER REQUEST 2026-09-01 — LAZY-LOAD HISTORY + BACKGROUND TASKS =====
  // Lazy-load: mặc định chỉ load 3 lượt trao đổi CUỐI (exchanges=3); lượt thứ 4
  // trở đi phải kéo lên đầu khung chat mới load thêm (cursor = id message cũ
  // nhất đang hiển thị) → session dài không còn render hàng nghìn message mỗi lần mở.
  const [hasMoreMessages, setHasMoreMessages] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const oldestLoadedIdRef = useRef<string | null>(null)
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const isNearBottomRef = useRef(true) // user đang ở cuối chat? → auto-scroll
  const lastScrollTopRef = useRef(0) // chống trigger load-older bởi auto-scroll animation

  // Per-session background tasks: sessionId → AbortController của fetch đang
  // chờ (single chat JSON + team workflow SSE). ĐỔI PHIÊN KHÔNG ABORT — task
  // của phiên cũ chạy tiếp nền (server lưu response vào DB); quay lại phiên
  // đang chạy → spinner + Thought Process poll tự resume.
  const inFlightChatsRef = useRef<Map<string, AbortController>>(new Map())

  // Restore context KHÔNG chạy effect reset lần đầu (mount) — nếu không
  // currentSessionId restore bị effect đổi-agent wipe mất ngay.
  // true = lần chạy đầu tiên (mount) chưa được tiêu thụ
  const contextMountRef = useRef(true)

  // Sync spinner + stop-button controller theo phiên đang mở
  const syncSpinnerToSession = useCallback((sid: string) => {
    const controller = inFlightChatsRef.current.get(sid)
    chatAbortRef.current = controller ?? null
    setIsLoading(!!controller)
  }, [])

  // Persist context mỗi khi đổi — quay lại module Smolab là về đúng phiên cũ
  useEffect(() => {
    try {
      localStorage.setItem(SMOLAB_CTX_KEY, JSON.stringify({
        chatMode,
        selectedAgentId,
        selectedTeam,
        currentSessionId,
        selectedModel,
      }))
    } catch { /* ignore */ }
  }, [chatMode, selectedAgentId, selectedTeam, currentSessionId, selectedModel])

  // Persist layout positions to localStorage on every change
  useEffect(() => {
    try { localStorage.setItem(SMOLAB_STORAGE_PREFIX + 'chatPanelWidth', JSON.stringify(chatPanelWidth)) } catch {}
  }, [chatPanelWidth, SMOLAB_STORAGE_PREFIX])
  useEffect(() => {
    try { localStorage.setItem(SMOLAB_STORAGE_PREFIX + 'smolabLeft', JSON.stringify(smolabLeft)) } catch {}
  }, [smolabLeft, SMOLAB_STORAGE_PREFIX])
  useEffect(() => {
    try { localStorage.setItem(SMOLAB_STORAGE_PREFIX + 'smolabRight', JSON.stringify(smolabRight)) } catch {}
  }, [smolabRight, SMOLAB_STORAGE_PREFIX])
  useEffect(() => {
    try { localStorage.setItem(SMOLAB_STORAGE_PREFIX + 'smolabTop', JSON.stringify(smolabTop)) } catch {}
  }, [smolabTop, SMOLAB_STORAGE_PREFIX])
  useEffect(() => {
    try { localStorage.setItem(SMOLAB_STORAGE_PREFIX + 'smolabHeight', JSON.stringify(smolabHeight)) } catch {}
  }, [smolabHeight, SMOLAB_STORAGE_PREFIX])

  // Resize handlers
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDragging.current = true
    dragStartX.current = e.clientX
    dragStartWidth.current = chatPanelWidth
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    // Add overlay to prevent iframe/content stealing mouse events
    const overlay = document.createElement('div')
    overlay.id = 'resize-overlay'
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:col-resize;'
    document.body.appendChild(overlay)
  }, [chatPanelWidth])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return
      const delta = e.clientX - dragStartX.current
      const containerWidth = smolabContainerRef.current?.offsetWidth || 1200
      const MIN_CHAT = 280
      const MAX_CHAT = containerWidth - 400 // leave at least 400px for tab content
      const newWidth = Math.min(MAX_CHAT, Math.max(MIN_CHAT, dragStartWidth.current + delta))
      setChatPanelWidth(newWidth)
    }
    const handleMouseUp = () => {
      if (!isDragging.current) return
      isDragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      const overlay = document.getElementById('resize-overlay')
      if (overlay) overlay.remove()
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  // Left edge resize handler (absolute viewport positioning)
  const handleLeftEdgeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDraggingLeft.current = true
    dragStartX.current = e.clientX
    dragStartLeft.current = effectiveLeft
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const overlay = document.createElement('div')
    overlay.id = 'resize-overlay-left'
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:col-resize;'
    document.body.appendChild(overlay)
  }, [effectiveLeft])

  // Right edge resize handler (absolute viewport positioning)
  const handleRightEdgeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDraggingRight.current = true
    dragStartX.current = e.clientX
    dragStartRight.current = effectiveRight
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const overlay = document.createElement('div')
    overlay.id = 'resize-overlay-right'
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:col-resize;'
    document.body.appendChild(overlay)
  }, [effectiveRight])

  // Bottom edge resize handler
  const handleBottomEdgeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDraggingBottom.current = true
    dragStartY.current = e.clientY
    dragStartHeight.current = smolabHeight ?? (window.innerHeight - HEADER_HEIGHT - STATUS_BAR_HEIGHT - effectiveTop)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    const overlay = document.createElement('div')
    overlay.id = 'resize-overlay-bottom'
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:row-resize;'
    document.body.appendChild(overlay)
  }, [smolabHeight, effectiveTop])

  // Top edge resize handler
  const handleTopEdgeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDraggingTop.current = true
    dragStartY.current = e.clientY
    dragStartTop.current = effectiveTop
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    const overlay = document.createElement('div')
    overlay.id = 'resize-overlay-top'
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:row-resize;'
    document.body.appendChild(overlay)
  }, [effectiveTop])

  // Mouse move/up for left, right, top, bottom edge dragging (viewport-based)
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const vw = window.innerWidth
      const vh = window.innerHeight

      if (isDraggingLeft.current) {
        // Left edge: dragging right → module narrows (left increases), dragging left → module widens (left decreases)
        const delta = e.clientX - dragStartX.current
        const newLeft = dragStartLeft.current + delta
        // Min: 0 (flush to screen left edge)
        // Max: vw - effectiveRight - MIN_MODULE_WIDTH (must leave room for module content)
        const maxLeft = vw - effectiveRight - MIN_MODULE_WIDTH
        setSmolabLeft(Math.min(maxLeft, Math.max(0, newLeft)))
      }
      if (isDraggingRight.current) {
        // Right edge: dragging left → module narrows (right increases), dragging right → module widens (right decreases)
        const delta = e.clientX - dragStartX.current
        const newRight = dragStartRight.current - delta
        // Min: 0 (flush to screen right edge)
        // Max: vw - effectiveLeft - MIN_MODULE_WIDTH (must leave room for module content)
        const maxRight = vw - effectiveLeft - MIN_MODULE_WIDTH
        setSmolabRight(Math.min(maxRight, Math.max(0, newRight)))
      }
      if (isDraggingBottom.current) {
        // Bottom edge: dragging down → taller, dragging up → shorter
        const delta = e.clientY - dragStartY.current
        const maxH = vh - HEADER_HEIGHT - STATUS_BAR_HEIGHT - effectiveTop
        const newHeight = Math.min(maxH, Math.max(MIN_MODULE_HEIGHT, dragStartHeight.current + delta))
        setSmolabHeight(newHeight)
      }
      if (isDraggingTop.current) {
        // Top edge: dragging down → module shrinks from top (top increases), dragging up → module grows (top decreases)
        const delta = e.clientY - dragStartY.current
        const newTop = dragStartTop.current + delta
        // Min: 0 (flush to header bottom)
        // Max: vh - HEADER_HEIGHT - MIN_MODULE_HEIGHT
        const maxTop = vh - HEADER_HEIGHT - MIN_MODULE_HEIGHT
        setSmolabTop(Math.min(maxTop, Math.max(0, newTop)))
      }
    }
    const handleMouseUp = () => {
      let didStop = false
      if (isDraggingLeft.current) {
        isDraggingLeft.current = false
        didStop = true
        const overlay = document.getElementById('resize-overlay-left')
        if (overlay) overlay.remove()
      }
      if (isDraggingRight.current) {
        isDraggingRight.current = false
        didStop = true
        const overlay = document.getElementById('resize-overlay-right')
        if (overlay) overlay.remove()
      }
      if (isDraggingBottom.current) {
        isDraggingBottom.current = false
        didStop = true
        const overlay = document.getElementById('resize-overlay-bottom')
        if (overlay) overlay.remove()
      }
      if (isDraggingTop.current) {
        isDraggingTop.current = false
        didStop = true
        const overlay = document.getElementById('resize-overlay-top')
        if (overlay) overlay.remove()
      }
      if (didStop) {
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [effectiveRight, effectiveLeft, effectiveTop])

  // Check gateway status
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const res = await fetch('/api/openclaw/status')
        if (res.ok) {
          const data = await res.json()
          setGatewayOnline(data.status === 'online')
        }
      } catch { setGatewayOnline(false) }
    }
    checkStatus()
    const interval = setInterval(checkStatus, 15000)
    return () => clearInterval(interval)
  }, [])

  // Load sessions on mount — respects current agent/team filter
  useEffect(() => {
    const loadSessions = async () => {
      try {
        let url = '/api/openclaw/sessions?action=list'
        // If an agent is selected in single mode, filter by agentProfileId
        if (chatMode === 'single' && selectedAgentId) {
          url += `&agentProfileId=${selectedAgentId}`
        }
        // If a team is selected in multi mode, filter by teamName
        if (chatMode === 'multi' && selectedTeam) {
          url += `&teamName=${selectedTeam}`
        }
        const res = await fetch(url)
        if (res.ok) {
          const data = await res.json()
          setSessions(data.sessions || [])
        }
      } catch {}
    }
    loadSessions()
    const interval = setInterval(loadSessions, 30000) // Refresh every 30s
    return () => clearInterval(interval)
  }, [chatMode, selectedAgentId, selectedTeam, sessionsRefreshTick])

  const [agentsLoadError, setAgentsLoadError] = useState<string | null>(null)

  // Fetch agents for Smolab on mount
  useEffect(() => {
    const loadAgents = async () => {
      try {
        setAgentsLoadError(null)
        const res = await fetch('/api/agents?enabled=true')
        if (res.ok) {
          const data = await res.json()
          setSmolabAgents(data.agents || [])
        } else {
          const errData = await res.json().catch(() => ({}))
          const errMsg = errData.error || errData.details || `Lỗi ${res.status}`
          console.warn('[Smolab] Failed to load agents:', errMsg)
          setAgentsLoadError(errMsg)
        }
      } catch (err) {
        console.warn('[Smolab] Failed to load agents:', err)
        setAgentsLoadError('Không thể kết nối tới server. Kiểm tra dev server đang chạy?')
      }
    }
    loadAgents()
    const interval = setInterval(loadAgents, 30000) // Refresh every 30s
    return () => clearInterval(interval)
  }, [])

  // Auto-scroll to bottom — USER REQUEST 2026-09-01 (lazy-load): CHỈ scroll
  // xuống khi user đang ở gần cuối chat. Đang kéo lên đọc tin nhắn cũ → giữ
  // nguyên vị trí (append tin mới / prepend tin cũ đều không giật màn hình).
  useEffect(() => {
    if (isNearBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, isLoading])

  // ===== V1 + 2026-09-01: Load TAIL of messages when switching sessions =====
  // LAZY-LOAD (user request 2026-09-01): chỉ load 3 lượt trao đổi CUỐI. Lượt
  // cũ hơn phải kéo lên đầu khung chat mới load (loadOlderMessages). Phiên dài
  // không còn mount toàn bộ DOM → mở session luôn nhanh.
  // Đồng thời RESUME tác vụ nền: nếu session này còn run đang chạy trên server
  // (user rời đi lúc agent đang làm dở) → bật lại spinner + Thought Process
  // poll; run kết thúc → reload tail từ DB (xem refreshAgentRuns).
  // USER BUG REPORT 2026-09-06 ("Thought Process của yêu cầu nào thì hiện sau
  // yêu cầu đó, đừng dồn tất cả sau yêu cầu cuối cùng"):
  // Panel Thought Process là client-only state — KHÔNG nằm trong DB messages.
  // Trước đây khi load session (mở lại / refresh / reload nền), messages chỉ có
  // user/assistant → poller thấy knownRunIds rỗng → chèn panel của TẤT CẢ 10
  // run cũ (vẫn còn trong registry server) vào CUỐI khung chat, ngay sau yêu
  // cầu MỚI NHẤT. Fix: khi load xong DB messages, fetch luôn runs của session
  // và MERGE panel vào đúng vị trí — ngay sau user message (anchor) đã khởi
  // tạo run đó (timestamp user message <= startedAt + slack). Run không tìm
  // được anchor (thuộc lượt trao đổi cũ hơn phần tail đã load) → bỏ qua.
  const mergeAgentRunPanels = useCallback((msgs: SmolabMessage[], runs: AgentRunData[]): SmolabMessage[] => {
    if (runs.length === 0) return msgs
    const SLACK_MS = 5000 // dung sai lệch clock client/server
    let out = [...msgs]
    for (const r of runs) {
      if (!r.runId) continue
      // Đã có panel của run này → skip (idempotent)
      if (out.some(m => m.role === 'agent_run' && m.runId === r.runId)) continue
      // Tìm anchor: user message CUỐI CÙNG có timestamp <= startedAt + slack
      let anchorIdx = -1
      for (let i = out.length - 1; i >= 0; i--) {
        const m = out[i]
        if (m.role === 'user') {
          const ts = m.timestamp instanceof Date ? m.timestamp.getTime() : 0
          if (ts <= r.startedAt + SLACK_MS) { anchorIdx = i; break }
        }
      }
      // Chưa thấy anchor (run chạy trước mọi user message đang hiển thị —
      // ví dụ load-older chưa kéo tới) → sẽ hiện khi kéo tải lịch sử; bỏ qua.
      if (anchorIdx === -1) continue
      const panel: SmolabMessage = {
        id: `ar_${r.runId}`,
        role: 'agent_run' as const,
        content: '',
        timestamp: new Date(r.startedAt || Date.now()),
        runId: r.runId,
      }
      // Chèn NGAY SAU anchor (sau các panel cùng anchor đã chèn trước đó)
      // → [user msg, panel, (assistant reply)...]
      out = [...out.slice(0, anchorIdx + 1), panel, ...out.slice(anchorIdx + 1)]
    }
    return out
  }, [])

  // ===== TASK 53 — RE-ATTACH durable goal-loop jobs của session (idempotent) =====
  // Trích từ loadSessionTail (GĐ4 CI-5 14-e) để heartbeat realtime tái sử dụng:
  // fetch danh sách job queued/running của session → merge state + chèn
  // placeholder "⏳ Tác vụ nền" đúng chỗ (ngay sau user message khởi tạo job).
  // Job terminal KHÔNG attach (assistant message do worker finalize đã nằm
  // trong DB tail/delta).
  const attachSessionGoalLoopJobs = useCallback(async (sid: string) => {
    try {
      const jobsRes = await fetch(`/api/goal-loop-jobs?sessionId=${encodeURIComponent(sid)}`)
      if (!jobsRes.ok) return
      const jobsData = await jobsRes.json().catch(() => null) as { ok?: boolean; jobs?: GoalLoopJobApiData[] } | null
      const toAttach = (jobsData?.ok && Array.isArray(jobsData.jobs))
        ? jobsData.jobs.filter(j => !!j?.id && (j.status === 'queued' || j.status === 'running'))
        : []
      if (toAttach.length === 0 || currentSessionIdRef.current !== sid) return
      setGoalLoopJobs(prev => {
        const next = { ...prev }
        for (const j of toAttach) {
          next[j.id] = {
            ...j,
            result: j.result ?? null,
            agentName: prev[j.id]?.agentName || j.result?.agentName,
          }
        }
        return next
      })
      // Placeholder message trong khung chat (nếu chưa có) — chèn NGAY
      // SAU user message khởi tạo job (job.messageId = id ChatMessage DB)
      // để đúng dòng chat; không tìm thấy anchor → append cuối.
      setMessages(prev => {
        let next = prev
        for (const j of toAttach) {
          if (next.some(m => m.goalLoopJobId === j.id)) continue
          const placeholderMsg: SmolabMessage = {
            id: `glj_${j.id}`,
            role: 'assistant',
            content: '⏳ Tác vụ nền đang chạy…',
            timestamp: new Date(j.startedAt || j.createdAt || Date.now()),
            goalLoopJobId: j.id,
          }
          const anchorIdx = j.messageId ? next.findIndex(m => m.id === j.messageId) : -1
          next = anchorIdx >= 0
            ? [...next.slice(0, anchorIdx + 1), placeholderMsg, ...next.slice(anchorIdx + 1)]
            : [...next, placeholderMsg]
        }
        return next
      })
    } catch { /* best-effort — job attach thất bại không chặn gì */ }
  }, [])

  const loadSessionTail = useCallback(async (sid: string, opts?: { silent?: boolean }) => {
    if (!sid) {
      setMessages([])
      setHasMoreMessages(false)
      oldestLoadedIdRef.current = null
      latestDbMessageRef.current = null
      return
    }
    sessionTailLoadingRef.current = true // TASK 53 — heartbeat nghỉ trong lúc replace tail
    if (!opts?.silent) setLoadingMessages(true)
    try {
      const [msgRes, fbRes] = await Promise.all([
        fetch(`/api/chat-messages?sessionId=${encodeURIComponent(sid)}&exchanges=3`),
        fetch(`/api/openclaw/feedback?sessionId=${encodeURIComponent(sid)}`).catch(() => null),
      ])
      if (!msgRes.ok) throw new Error(`HTTP ${msgRes.status}`)
      const data = await msgRes.json()

      // FIX (user request 2026-08-27): restore feedback (👍/👎) state từ
      // LearningLog — trước đây feedback chỉ nằm trong state React nên bị
      // reset khi reload/switch session, trông như hệ thống không ghi nhận.
      let feedbackMap: Record<string, 'positive' | 'negative'> = {}
      try {
        if (fbRes?.ok) {
          const fbData = await fbRes.json()
          if (fbData?.feedback && typeof fbData.feedback === 'object') {
            feedbackMap = fbData.feedback as Record<string, 'positive' | 'negative'>
          }
        }
      } catch { /* feedback restore là best-effort */ }

      if (data.messages && Array.isArray(data.messages) && data.messages.length > 0) {
        const loaded: SmolabMessage[] = data.messages.map((m: {
          id: string
          role: string
          content: string
          model?: string | null
          provider?: string | null
          metadata?: string | null
          createdAt: string
        }) => {
          // Parse metadata JSON if present (handle both single and double-stringified data for backward compat)
          let parsedMeta: Record<string, unknown> | undefined
          if (m.metadata) {
            try {
              const first = JSON.parse(m.metadata)
              // If double-stringified (legacy data), first parse returns a string — parse again
              parsedMeta = typeof first === 'string' ? JSON.parse(first) : first
            } catch { /* ignore */ }
          }
          return {
            id: m.id,
            role: (['user', 'assistant', 'tool_call', 'error'].includes(m.role) ? m.role : 'assistant') as SmolabMessage['role'],
            content: m.content,
            timestamp: new Date(m.createdAt),
            model: m.model || undefined,
            provider: m.provider || undefined,
            sources: parsedMeta?.sources as Array<{ type: string; content: string; documentTitle?: string }> | undefined,
            confidence: parsedMeta?.confidence as number | undefined,
            toolName: parsedMeta?.toolName as string | undefined,
            toolCallInfo: parsedMeta?.toolCallInfo as { tool: string; detail: string } | undefined,
            agentName: parsedMeta?.agentName as string | undefined,
            agentPosition: parsedMeta?.agentPosition as string | undefined,
            isTeamMessage: parsedMeta?.isTeamMessage as boolean | undefined,
            // Thought Process summary (user request 2026-08-31) — persist qua
            // chat message metadata; render AgentRunSummaryBar khi reload
            agentRunSummary: parsedMeta?.agentRun as SmolabMessage['agentRunSummary'],
            // OPUS (Task 13-c) — giữ metadata gốc: directive message của Opus
            // (opusDirective/opusReviewId/decision) render thành OPUS DIRECTIVE CARD
            metadata: parsedMeta as SmolabMessage['metadata'],
            // Khôi phục trạng thái like/dislike đã ghi nhận trước đó
            feedback: (feedbackMap[m.id] as 'positive' | 'negative') ?? null,
          }
        })
        setMessages(loaded)
        setHasMoreMessages(!!data.hasMore)
        oldestLoadedIdRef.current = data.oldestId || loaded[0]?.id || null
        // TASK 53 — cursor delta cho heartbeat realtime (message DB mới nhất)
        latestDbMessageRef.current = loaded.length > 0 ? { id: loaded[loaded.length - 1].id } : null

        // ===== MERGE Thought Process panels (bug fix 2026-09-06) =====
        // Fetch runs của session + chèn panel vào đúng vị trí (ngay sau user
        // message khởi tạo run) + nạp dữ liệu vào agentRuns để panel render.
        // Run đang chạy (resume tác vụ nền) cũng được merge — panel hiện đúng
        // chỗ ngay khi mở lại session.
        try {
          const runRes = await fetch(`/api/agent-run?sessionId=${encodeURIComponent(sid)}&limit=10`)
          if (runRes.ok) {
            const runData = await runRes.json() as { ok?: boolean; runs?: AgentRunData[] } | null
            if (runData?.ok && Array.isArray(runData.runs) && runData.runs.length > 0) {
              const runs = runData.runs
              setAgentRuns(prev => {
                const next = { ...prev }
                for (const r of runs) if (r?.runId) next[r.runId] = r
                return next
              })
              setMessages(prev => mergeAgentRunPanels(prev, runs))
            }
          }
        } catch { /* best-effort — panel merge thất bại không chặn session load */ }
      } else {
        setMessages([])
        setHasMoreMessages(false)
        oldestLoadedIdRef.current = null
        latestDbMessageRef.current = null
      }
      isNearBottomRef.current = true // mở session → đứng ở cuối
      lastScrollTopRef.current = 0 // chống false-trigger load-older khi scrollTop bị clamp về 0 (nội dung mới ngắn hơn)
    } catch (err) {
      console.error('[Smolab] Failed to load session messages:', err)
      setMessages([])
      setHasMoreMessages(false)
      oldestLoadedIdRef.current = null
      latestDbMessageRef.current = null
    } finally {
      sessionTailLoadingRef.current = false // TASK 53 — heartbeat hoạt động lại
      if (!opts?.silent) setLoadingMessages(false)

      // ===== RESUME TÁC VỤ NỀN (user request 2026-09-01) =====
      // Session này có run đang chạy trên server (agent làm dở lúc user rời
      // đi / refresh trang) → bật spinner + poll để Thought Process hiện tiếp.
      // KHÔNG bật nếu fetch của phiên này vẫn đang chờ trong client (spinner
      // đã đúng trạng thái rồi).
      // 2026-09-06: runs đã fetch ở trên cho merge — chỉ cần hasActive check.
      try {
        const runRes = await fetch(`/api/agent-run?sessionId=${encodeURIComponent(sid)}&limit=5`)
        if (runRes.ok) {
          const runData = await runRes.json()
          if (runData?.hasActive && !inFlightChatsRef.current.has(sid)) {
            setIsLoading(true)
          }
        }
      } catch { /* best-effort */ }

      // ===== GĐ4 CI-5 (14-e) — RE-ATTACH durable goal-loop jobs của session =====
      // (TASK 53: trích thành attachSessionGoalLoopJobs — heartbeat realtime
      // cũng gọi lại khi phát hiện job mới của phiên)
      attachSessionGoalLoopJobs(sid).catch(() => { /* best-effort */ })
    }
  }, [mergeAgentRunPanels, attachSessionGoalLoopJobs])

  // Kéo lên đầu chat → load thêm N lượt trao đổi CŨ hơn (prepend + giữ vị trí đọc)
  const loadOlderMessages = useCallback(async () => {
    const sid = currentSessionIdRef.current
    if (!sid || !oldestLoadedIdRef.current || loadingOlder || !hasMoreMessages) return
    setLoadingOlder(true)
    try {
      const el = chatScrollRef.current
      const prevScrollHeight = el?.scrollHeight ?? 0
      const prevScrollTop = el?.scrollTop ?? 0

      const res = await fetch(
        `/api/chat-messages?sessionId=${encodeURIComponent(sid)}&exchanges=3&beforeId=${encodeURIComponent(oldestLoadedIdRef.current)}`
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()

      if (data.messages && Array.isArray(data.messages) && data.messages.length > 0) {
        setMessages(prev => {
          // Dedupe theo id (an toàn khi reload đan xen load-older)
          const existingIds = new Set(prev.map(m => m.id))
          const older: SmolabMessage[] = data.messages
            .filter((m: { id: string }) => !existingIds.has(m.id))
            .map((m: {
              id: string
              role: string
              content: string
              model?: string | null
              provider?: string | null
              metadata?: string | null
              createdAt: string
            }) => {
              let parsedMeta: Record<string, unknown> | undefined
              if (m.metadata) {
                try {
                  const first = JSON.parse(m.metadata)
                  parsedMeta = typeof first === 'string' ? JSON.parse(first) : first
                } catch { /* ignore */ }
              }
              return {
                id: m.id,
                role: (['user', 'assistant', 'tool_call', 'error'].includes(m.role) ? m.role : 'assistant') as SmolabMessage['role'],
                content: m.content,
                timestamp: new Date(m.createdAt),
                model: m.model || undefined,
                provider: m.provider || undefined,
                toolCallInfo: parsedMeta?.toolCallInfo as { tool: string; detail: string } | undefined,
                agentName: parsedMeta?.agentName as string | undefined,
                agentPosition: parsedMeta?.agentPosition as string | undefined,
                isTeamMessage: parsedMeta?.isTeamMessage as boolean | undefined,
                agentRunSummary: parsedMeta?.agentRun as SmolabMessage['agentRunSummary'],
                // OPUS (Task 13-c) — giữ metadata gốc cho directive card của Opus
                metadata: parsedMeta as SmolabMessage['metadata'],
              }
            })
          return [...older, ...prev]
        })
        // BUG FIX 2026-09-06: history cũ hơn đã load → panel Thought Process của
        // các run cũ (trước đó bị skip vì anchor chưa hiển thị) giờ tìm được
        // anchor — merge lại từ dữ liệu run đã có trong agentRuns state.
        setMessages(prev => mergeAgentRunPanels(prev, Object.values(agentRunsRef.current)))
        oldestLoadedIdRef.current = data.oldestId || oldestLoadedIdRef.current
        setHasMoreMessages(!!data.hasMore)

        // Giữ nguyên vị trí đọc: bù scrollHeight tăng thêm sau khi prepend
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const el2 = chatScrollRef.current
            if (el2) {
              el2.scrollTop = el2.scrollHeight - prevScrollHeight + prevScrollTop
            }
          })
        })
      } else {
        // Hết tin cũ — tắt nút load thêm
        setHasMoreMessages(false)
      }
    } catch (err) {
      console.error('[Smolab] Failed to load older messages:', err)
    } finally {
      setLoadingOlder(false)
    }
  }, [loadingOlder, hasMoreMessages, mergeAgentRunPanels])

  // Scroll handler: track gần cuối (auto-scroll) + chạm đầu → load cũ hơn.
  // CHỐNG AUTO-TRIGGER: chỉ load khi user THẬT SỰ cuộn lên qua ngưỡng (scrollTop
  // trước đó > 60 và giờ ≤ 60). Auto-scroll animation lúc mở session bắt đầu ở
  // scrollTop=0 → không tính (trước đó = 0) → không tự load 1 trang cũ mỗi lần mở.
  const handleChatScroll = useCallback(() => {
    const el = chatScrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    isNearBottomRef.current = nearBottom
    const prevTop = lastScrollTopRef.current
    lastScrollTopRef.current = el.scrollTop
    if (!nearBottom && prevTop > 60 && el.scrollTop <= 60) {
      loadOlderMessages()
    }
  }, [loadOlderMessages])

  const prevSessionIdRef = useRef('')
  useEffect(() => {
    // Skip if session ID hasn't actually changed (prevents re-fetch on re-render)
    if (prevSessionIdRef.current === currentSessionId) return
    prevSessionIdRef.current = currentSessionId

    // Skip when session ID is set programmatically (sendMessage/startWorkflow) to avoid wiping in-flight messages
    if (skipMessageLoadRef.current) {
      skipMessageLoadRef.current = false
      // Session mới tạo client-side (chưa có message trong DB) — reset lazy state
      setHasMoreMessages(false)
      oldestLoadedIdRef.current = null
      return
    }

    loadSessionTail(currentSessionId)
  }, [currentSessionId, loadSessionTail])

  // CHUẨN HÓA lazy-load state khi đổi phiên: (a) scrollTop bị clamp về 0 khi
  // nội dung mới ngắn hơn → scroll event với prevTop cũ (lớn) → false-trigger
  // load-older; (b) cursor (oldestLoadedIdRef) + hasMore của phiên CŨ không
  // được dùng cho phiên MỚI → reset ngay (loadSessionTail sẽ set lại sau fetch).
  useEffect(() => {
    lastScrollTopRef.current = 0
    oldestLoadedIdRef.current = null
    setHasMoreMessages(false)
  }, [currentSessionId])

  // ===== Agent Run poller — Thought Process + Todos live (user request 2026-08-31) =====
  // Single-agent chat là stream:false (await JSON) → poll là cơ chế live:
  // mỗi 1.2s lấy runs + todos của session đang mở, cập nhật panel trong chat.
  // Chỉ fetch khi (a) đang chờ response (isLoading) hoặc (b) có run đang chạy
  // — run đã đóng giữ nguyên dữ liệu cuối (client state, không re-fetch).
  // Team mode: startWorkflow cũng set isLoading → runs của từng agent step
  // được bắt và render panel riêng cho mỗi agent (giống single mode).
  //
  // USER REQUEST 2026-09-01 (background tasks): run chuyển running → kết thúc
  // mà KHÔNG có fetch nào đang chờ cho session này (user rời đi rồi quay lại,
  // server chạy xong nền) → reload tail từ DB để hiện response + tắt spinner.
  const refreshAgentRuns = useCallback(async () => {
    if (!currentSessionId) return
    const sid = currentSessionId
    try {
      const [runsRes, todosRes] = await Promise.all([
        fetch(`/api/agent-run?sessionId=${encodeURIComponent(sid)}&limit=10`).catch(() => null),
        fetch(`/api/todos?sessionId=${encodeURIComponent(sid)}`).catch(() => null),
      ])

      if (runsRes?.ok) {
        const d = await runsRes.json().catch(() => null) as { ok?: boolean; runs?: AgentRunData[]; hasActive?: boolean } | null
        if (d?.ok && Array.isArray(d.runs)) {
          // 0. USER REQUEST 2026-09-01: phát hiện run vừa KẾT THÚC mà client
          //    không có fetch nào đang chờ cho session (tác vụ chạy nền xong)
          const hadRunning = Object.values(agentRunsRef.current).some(r => r.status === 'running')
          const stillRunning = d.runs.some(r => r.status === 'running')
          // FIX 2026-08-27: user vừa bấm DỪNG (stoppingRef) → KHÔNG reload tail —
          // reload sẽ replace messages bằng DB tail và XÓA mất thông báo ⏹ vừa
          // chèn (client-only). Client state đã đúng (spinner tắt + ⏹ + panel
          // "Đã dừng" ở poll kế). Chỉ reload khi run kết thúc THẬT ở nền.
          const justStoppedByUser = (Date.now() - lastStoppedAtRef.current < 5000) && d.runs.some(r => r.status === 'cancelled')
          if (hadRunning && !stillRunning && !justStoppedByUser && !inFlightChatsRef.current.has(sid) && sid === currentSessionIdRef.current) {
            // Server đã chạy xong và lưu DB → reload tail để hiện response;
            // spinner (isLoading) do resume lúc mở session → tắt bây giờ.
            if (isLoadingRef.current) setIsLoading(false)
            loadSessionTail(sid, { silent: true }).catch(() => {})
            setSessionsRefreshTick(t => t + 1) // cập nhật chấm "đang chạy" ở dropdown
          } else if (!stillRunning && !d.hasActive && !inFlightChatsRef.current.has(sid) && isLoadingRef.current && sid === currentSessionIdRef.current) {
            // Edge: mở session lúc hasActive=true nhưng run kết thúc TRƯỚC lần
            // poll đầu → không có "hadRunning" → vẫn phải tắt spinner
            setIsLoading(false)
          } else if (justStoppedByUser) {
            // User vừa dừng → chỉ cập nhật chấm "đang chạy" ở dropdown
            setSessionsRefreshTick(t => t + 1)
          }

          if (d.runs.length > 0) {
          // 1. Cập nhật dữ liệu run (kèm safeguard: run "running" quá 30 phút
          //    coi như lỗi client-side — tránh poller kẹt vĩnh viễn).
          //    GOAL LOOP (2026-09-01): nâng 10' → 30' vì vòng lặp mục tiêu dài hạn
          //    chạy hợp pháp nhiều chu kỳ (budget mặc định 12', env có thể tăng).
          setAgentRuns(prev => {
            const next = { ...prev }
            // GĐ4 CI-5 (14-e): durable goal-loop job đang chạy → run có thể
            // HỢP PHÁP chạy rất lâu (CI-1 không giới hạn chu kỳ) → nâng ngưỡng
            // safeguard 30' → 24h, tránh panel hiện "error" oan khi job nền
            // chạy dài. Không có job durable → giữ nguyên ngưỡng cũ.
            const durableGoalLoopActive = Object.values(goalLoopJobsRef.current)
              .some(j => j.status === 'queued' || j.status === 'running')
            const staleRunThresholdMs = durableGoalLoopActive ? 24 * 60 * 60_000 : 30 * 60_000
            for (const raw of d.runs!) {
              let run = raw
              if (run.status === 'running' && Date.now() - (run.startedAt || 0) > staleRunThresholdMs) {
                run = { ...run, status: 'error' as const, endedAt: Date.now() }
              }
              next[run.runId] = run
            }
            // Reconcile: run client đang "running" nhưng server KHÔNG trả về nữa
            // (server restart / run bị LRU purge) → đánh dấu error để poller
            // không quay vô hạn và panel không kẹt "Đang chạy"
            const serverRunIds = new Set(d.runs!.map(r => r.runId))
            for (const [rid, run] of Object.entries(next)) {
              if (run.status === 'running' && !serverRunIds.has(rid)) {
                next[rid] = { ...run, status: 'error' as const, endedAt: Date.now() }
              }
            }
            return next
          })
          // 2. Insert panel message cho run mới — USER BUG REPORT 2026-08-31
          //    ("Thought Process phải hiện ra lúc SUY NGHĨ XONG và tiến đến bước
          //    thực thi tiếp theo"): panel KHÔNG hiện ngay khi gửi tin nhắn nữa —
          //    chỉ chèn khi run đã có event thought/tool/todo ĐẦU TIÊN (= agent
          //    nghĩ xong bước 1, bắt đầu thực thi) hoặc run đã kết thúc.
          const hasVisibleActivity = (r: AgentRunData) =>
            r.status !== 'running' ||
            (r.events || []).some(e => e.type === 'thought' || e.type === 'tool' || e.type === 'todo_update')
          setMessages(prev => {
            // GUARD 2026-09-01: user đã đổi phiên giữa chừng → KHÔNG chèn panel
            // của session cũ vào phiên mới
            if (currentSessionIdRef.current !== sid) return prev
            const knownRunIds = new Set(prev.filter(m => m.role === 'agent_run').map(m => m.runId))
            // BUG FIX 2026-09-06 ("đừng dồn Thought Process sau yêu cầu cuối"):
            // Chỉ chèn panel của run THUỘC yêu cầu HIỆN TẠI — run.startedAt phải
            // >= timestamp của user message cuối cùng (-5s dung sai clock).
            // Run cũ hơn (thuộc các yêu cầu trước đó, panel có thể đã bị mất do
            // reload) sẽ KHÔNG bị chèn lại vào cuối chat — merge lúc load session
            // đã đặt chúng đúng chỗ.
            let lastUserTs = 0
            for (let i = prev.length - 1; i >= 0; i--) {
              if (prev[i].role === 'user') {
                lastUserTs = prev[i].timestamp instanceof Date ? prev[i].timestamp.getTime() : 0
                break
              }
            }
            const newRuns = d.runs!.filter(r =>
              r.runId && !knownRunIds.has(r.runId) && hasVisibleActivity(r) &&
              r.startedAt >= lastUserTs - 5000
            )
            if (newRuns.length === 0) return prev
            const panels: SmolabMessage[] = newRuns.map(r => ({
              id: `ar_${r.runId}`,
              role: 'agent_run' as const,
              content: '',
              timestamp: new Date(r.startedAt || Date.now()),
              runId: r.runId,
            }))
            // Nếu message cuối đã là assistant reply (response về trước poll —
            // xảy ra với ReAct nhanh không tool) thì chèn panel TRƯỚC reply
            const last = prev[prev.length - 1]
            if (last && last.role === 'assistant' && !last.isTeamMessage) {
              return [...prev.slice(0, -1), ...panels, last]
            }
            return [...prev, ...panels]
          })
          }
        }
      }

      if (todosRes?.ok) {
        const td = await todosRes.json().catch(() => null) as {
          ok?: boolean
          todos?: Array<{ id: string; content: string; status: string; priority?: string; parentId?: string | null; runId?: string | null; archivedAt?: string | null }>
        } | null
        if (td?.ok && Array.isArray(td.todos)) {
          setSessionTodos(td.todos.map(t => ({
            id: String(t.id),
            content: String(t.content || ''),
            status: String(t.status || 'pending'),
            priority: t.priority ? String(t.priority) : undefined,
            // TASK 21-d — giữ parentId (render cây todo con lồng todo cha)
            parentId: t.parentId != null ? String(t.parentId) : null,
            // CI-2 (11-a): giữ runId + archivedAt — panel dùng để lọc chỉ còn
            // todo legacy (runId=null) làm fallback + ẩn todo đã lưu trữ
            runId: t.runId != null ? String(t.runId) : null,
            archivedAt: t.archivedAt != null ? String(t.archivedAt) : null,
          })))
        }
      }
    } catch { /* offline — retry ở interval sau */ }
  }, [currentSessionId, loadSessionTail])

  useEffect(() => {
    if (!currentSessionId) return
    const poll = async () => {
      if (document.hidden) return
      const anyRunning = Object.values(agentRunsRef.current).some(r => r.status === 'running')
      // GĐ4 CI-5 (14-e): job durable goal-loop đang chạy → poll tiếp để
      // Thought Process panel hiện LIVE trong lúc job nền chạy (worker cùng
      // process ghi run tracker — runs của session trả về như đường inline).
      const anyDurableJob = Object.values(goalLoopJobsRef.current)
        .some(j => j.sessionId === currentSessionIdRef.current && (j.status === 'queued' || j.status === 'running'))
      if (!isLoadingRef.current && !anyRunning && !anyDurableJob) return
      await refreshAgentRuns()
    }
    poll()
    const interval = setInterval(poll, 1200)
    return () => { clearInterval(interval) }
  }, [currentSessionId, refreshAgentRuns])

  // ===== GĐ4 CI-5 (Task 14-e) — Durable goal-loop job: poll + terminal + cancel =====
  // Áp dụng 1 lần poll GET /api/goal-loop-jobs?jobId= vào state + xử lý chuyển
  // TERMINAL (completed/failed/cancelled): thay placeholder bằng kết quả thật
  // (completed), thông báo lỗi (failed) hoặc ⏹ (cancelled — không phải lỗi).
  const applyGoalLoopJobUpdate = useCallback((job: GoalLoopJobApiData) => {
    const prevJob = goalLoopJobsRef.current[job.id]
    const wasActive = !!prevJob && (prevJob.status === 'queued' || prevJob.status === 'running')
    const isTerminal = job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled'

    setGoalLoopJobs(prev => {
      const existing = prev[job.id]
      return {
        ...prev,
        [job.id]: {
          ...job,
          result: job.result ?? null,
          // Giữ tên agent client-side (server chỉ trả tên trong result khi completed)
          agentName: existing?.agentName || job.result?.agentName,
        },
      }
    })

    if (!wasActive || !isTerminal) return

    // ===== TERMINAL — chỉ đụng messages khi user còn đang ở phiên của job =====
    const sid = job.sessionId
    const onSession = currentSessionIdRef.current === sid
    if (job.status === 'completed') {
      const content = job.result?.content ? String(job.result.content) : ''
      if (onSession) {
        if (content) {
          setMessages(prev => {
            const already = prev.some(m => m.role === 'assistant' && m.content === content && m.goalLoopJobId !== job.id)
            const idx = prev.findIndex(m => m.goalLoopJobId === job.id)
            if (idx >= 0) {
              // Placeholder còn → THAY bằng câu trả lời thật (KHÔNG reload);
              // tail reload đã bring message thật về (race finalize) → bỏ
              // placeholder để không nhân đôi.
              const next = [...prev]
              if (already) next.splice(idx, 1)
              else next[idx] = { ...next[idx], goalLoopJobId: undefined, content }
              return next
            }
            if (already) return prev
            // Placeholder đã mất (vd silent reload giữa chừng) → append cuối
            return [...prev, {
              id: crypto.randomUUID(),
              role: 'assistant' as const,
              content,
              timestamp: new Date(),
            }]
          })
          // SAFETY NET: silent reload của agent-run poller có thể ĐÈ mất
          // message thật (race với finalize lưu DB) → 2.5s sau chắc chắn
          // message kết quả còn trong khung chat (idempotent).
          window.setTimeout(() => {
            setMessages(prev => {
              if (currentSessionIdRef.current !== sid) return prev
              if (prev.some(m => m.role === 'assistant' && m.content === content)) return prev
              return [...prev, {
                id: crypto.randomUUID(),
                role: 'assistant' as const,
                content,
                timestamp: new Date(),
              }]
            })
          }, 2500)
        }
        // Thought Process panel pick up run của job (worker cùng process ghi
        // run tracker — mirror inline path gọi refreshAgentRuns sau response)
        refreshAgentRuns().catch(() => {})
      }
      setSessionsRefreshTick(t => t + 1)
    } else if (job.status === 'failed') {
      const errMsg = `❌ Tác vụ nền thất bại${job.error ? `: ${String(job.error).slice(0, 300)}` : ' (không rõ nguyên nhân)'}${job.attempts > 0 ? ` — đã thử lại ${job.attempts} lần sau crash.` : ''}`
      if (onSession) {
        setMessages(prev => replaceDurablePlaceholder(prev, job.id, { role: 'error', content: errMsg }))
      }
      setSessionsRefreshTick(t => t + 1)
    } else if (job.status === 'cancelled') {
      if (onSession) {
        setMessages(prev => replaceDurablePlaceholder(prev, job.id, {
          role: 'assistant',
          content: '⏹ Tác vụ nền đã dừng theo yêu cầu của bạn.',
        }))
      }
      setSessionsRefreshTick(t => t + 1)
    }

    // Purge khỏi state sau 15s — panel còn kịp thấy badge kết thúc rồi tự ẩn
    window.setTimeout(() => {
      setGoalLoopJobs(prev => {
        if (!prev[job.id]) return prev
        const next = { ...prev }
        delete next[job.id]
        return next
      })
    }, 15000)
  }, [refreshAgentRuns])

  // Poll 1 job — lỗi mạng: retry thầm lặng ở interval sau (KHÔNG toast spam);
  // 5 lần liên tiếp → dừng poll + log console + placeholder chuyển thông báo.
  const pollGoalLoopJob = useCallback(async (jobId: string) => {
    try {
      const res = await fetch(`/api/goal-loop-jobs?jobId=${encodeURIComponent(jobId)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json().catch(() => null) as { ok?: boolean; job?: GoalLoopJobApiData } | null
      if (!data?.ok || !data.job?.id) throw new Error('job response không hợp lệ')
      delete goalLoopFailsRef.current[jobId]
      applyGoalLoopJobUpdate(data.job)
    } catch {
      const fails = (goalLoopFailsRef.current[jobId] || 0) + 1
      goalLoopFailsRef.current[jobId] = fails
      if (fails >= 5) {
        console.warn(`[GoalLoop] job ${jobId}: dừng poll sau ${fails} lần lỗi liên tiếp — tác vụ vẫn chạy trên server`)
        const sid = goalLoopJobsRef.current[jobId]?.sessionId
        delete goalLoopFailsRef.current[jobId]
        setGoalLoopJobs(prev => {
          if (!prev[jobId]) return prev
          const next = { ...prev }
          delete next[jobId]
          return next
        })
        if (sid && currentSessionIdRef.current === sid) {
          setMessages(prev => replaceDurablePlaceholder(prev, jobId, {
            role: 'error',
            content: '⚠️ Mất kết nối theo dõi tác vụ nền (5 lần lỗi liên tiếp). Tác vụ vẫn chạy trên server — mở lại phiên này để xem kết quả khi hoàn tất.',
          }))
        }
      }
      // else: retry thầm lặng ở interval sau
    }
  }, [applyGoalLoopJobUpdate])

  // Nút Dừng của 1 job durable — POST /api/goal-loop-jobs {jobId, cancel}.
  // Optimistic: placeholder + panel hiện "Đang yêu cầu dừng…" ngay; poll kế
  // (≤3s) thấy status cancelled → ⏹ thay placeholder.
  const cancelGoalLoopJob = useCallback((jobId: string) => {
    setGoalLoopJobs(prev => (prev[jobId]
      ? { ...prev, [jobId]: { ...prev[jobId], cancelRequested: true } }
      : prev))
    fetch('/api/goal-loop-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, action: 'cancel' }),
    }).catch(() => {
      // Lỗi mạng — rollback optimistic flag (job vẫn đang chạy)
      setGoalLoopJobs(prev => (prev[jobId]
        ? { ...prev, [jobId]: { ...prev[jobId], cancelRequested: false } }
        : prev))
      toast({ title: 'Không gửi được yêu cầu dừng', description: 'Lỗi kết nối — thử lại sau', variant: 'destructive' })
    })
  }, [])

  // Seed job state NGAY từ response chat durable (trước lần poll đầu) —
  // placeholder + panel hiện "Đang chờ" tức thì; poll effect tự bắt đầu.
  const seedGoalLoopJob = useCallback((jobId: string, sessionId: string, agentName: string) => {
    setGoalLoopJobs(prev => {
      if (prev[jobId]) return prev
      return {
        ...prev,
        [jobId]: {
          id: jobId,
          sessionId,
          messageId: null,
          status: 'queued',
          cyclesDone: 0,
          progressHint: null,
          stopReason: null,
          error: null,
          attempts: 0,
          cancelRequested: false,
          cancelRequestedAt: null,
          heartbeatAt: null,
          createdAt: new Date().toISOString(),
          startedAt: null,
          completedAt: null,
          ageMs: 0,
          stallWarning: false,
          result: null,
          agentName,
        },
      }
    })
  }, [])

  // Job active của PHIÊN ĐANG MỞ — key chuỗi id ổn định (progressHint/ageMs
  // đổi KHÔNG restart interval; job terminal / đổi phiên → key đổi → dọn poll).
  const goalLoopActiveKey = useMemo(() => Object.values(goalLoopJobs)
    .filter(j => j.sessionId === currentSessionId && (j.status === 'queued' || j.status === 'running'))
    .map(j => j.id)
    .sort()
    .join(','), [goalLoopJobs, currentSessionId])

  // Poller 3s (vòng LLM 60-120s — 3s đủ mượt; mirror poller agent-run:
  // document.hidden skip + clearInterval cleanup). DỌN poll khi: job terminal
  // / user đổi phiên / component unmount.
  useEffect(() => {
    if (!goalLoopActiveKey) return
    const ids = goalLoopActiveKey.split(',').filter(Boolean)
    const poll = async () => {
      if (document.hidden) return
      for (const id of ids) {
        const job = goalLoopJobsRef.current[id]
        if (!job || (job.status !== 'queued' && job.status !== 'running')) continue
        await pollGoalLoopJob(id)
      }
    }
    poll()
    const interval = setInterval(poll, 3000)
    return () => { clearInterval(interval) }
  }, [goalLoopActiveKey, pollGoalLoopJob])

  // Job list cho panel "Tác vụ nền" — job của phiên đang mở (active + terminal
  // chưa purge 15s), cũ nhất trước.
  const goalLoopPanelJobs = useMemo(() => Object.values(goalLoopJobs)
    .filter(j => j.sessionId === currentSessionId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)), [goalLoopJobs, currentSessionId])

  // ===== USER REQUEST 2026-08-31 — DỪNG tác vụ Agents bằng cách bấm nút Gửi lần nữa =====
  // Khi agent đang chạy (isLoading), nút Gửi biến thành nút DỪNG:
  //   1. Abort fetch đang chờ của PHIÊN ĐANG MỞ (chat JSON + team SSE) — spinner tắt NGAY
  //   2. POST /api/agent-run {sessionId} → server: mọi run running → 'cancelled'
  //      + ReAct loops + chuỗi xoay vòng key LLM cắt ngang sớm
  //   3. Thông báo ⏹ trong chat + refresh panel về trạng thái "Đã dừng"
  // 2026-09-01: tác vụ ở CÁC PHIÊN KHÁC đang chạy nền KHÔNG bị ảnh hưởng —
  // nút Dừng chỉ chặn phiên mình đang xem.
  const stopAgentTask = useCallback(() => {
    const sid = currentSessionIdRef.current || currentSessionId
    // 1+2. Hủy client-side (phiên hiện tại) + server-side
    stoppingRef.current = true
    lastStoppedAtRef.current = Date.now()
    try { chatAbortRef.current?.abort() } catch { /* ignore */ }
    chatAbortRef.current = null
    if (sid) {
      inFlightChatsRef.current.delete(sid)
      fetch('/api/agent-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid }),
      }).catch(() => {})
    }
    // 3. UI state
    setIsLoading(false)
    setMessages(prev => [...prev, {
      id: crypto.randomUUID(),
      role: 'error',
      content: '⏹ Đã dừng tác vụ Agents theo yêu cầu của bạn. Agent sẽ kết thúc ở bước an toàn gần nhất.',
      timestamp: new Date(),
    }])
    toast({ title: '⏹ Đã dừng tác vụ', description: 'Agents đang dừng ở bước an toàn gần nhất', duration: 2500 })
    // Panel cập nhật sang "Đã dừng" ở lần poll kế tiếp
    refreshAgentRuns().catch(() => {})
  }, [currentSessionId, refreshAgentRuns])

  // Abort request đang chờ của PHIÊN HIỆN TẠI + tắt spinner — dùng khi user
  // CHỦ ĐỘNG kết thúc ngữ cảnh hiện tại (xóa phiên / clear chat / đổi mode).
  // Lưu ý 2026-09-01: ĐỔI PHIÊN / ĐỔI AGENT / RỜI MODULE không còn gọi hàm này —
  // task chạy nền tiếp (user request: agents độc lập tiếp tục công việc dở).
  const abortInFlightChat = useCallback(() => {
    const sid = currentSessionIdRef.current
    stoppingRef.current = true // request cũ bị abort → catch KHÔNG hiện error
    try { chatAbortRef.current?.abort() } catch { /* ignore */ }
    chatAbortRef.current = null
    if (sid) inFlightChatsRef.current.delete(sid)
    setIsLoading(false)
  }, [])

  // TẮT spinner + gỡ controller của phiên hiện tại NHƯNG KHÔNG ABORT — task
  // của phiên cũ chạy tiếp nền; server vẫn lưu response vào DB (user request
  // 2026-09-01: rời module/đổi agent → agents vẫn làm dở đến khi xong).
  const detachFromInFlightChat = useCallback(() => {
    chatAbortRef.current = null
    setIsLoading(false)
  }, [])

  // Đổi phiên chat (user action) — USER REQUEST 2026-09-01: KHÔNG abort task
  // của phiên cũ nữa. Task chạy tiếp nền (controller giữ trong inFlightChatsRef);
  // response do server lưu DB — quay lại phiên cũ sẽ thấy (đang chạy → spinner +
  // Thought Process tự resume; đã xong → reload từ DB).
  const switchToSession = useCallback((sid: string) => {
    if (sid === currentSessionId) return
    setCurrentSessionId(sid)
    // Spinner/nút Dừng theo PHIÊN MỚI: phiên mới có task đang chạy (background)
    // → spinner bật lại; không có → spinner tắt (phiên cũ chạy nền không cản)
    syncSpinnerToSession(sid)
  }, [currentSessionId, syncSpinnerToSession])

  // Close dropdown menus on click outside
  // Use mousedown (not click) so the handler fires BEFORE React's onClick + stopPropagation
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      // Only close if the click target is NOT inside any dropdown or toggle button
      const target = e.target as HTMLElement
      if (target.closest('[data-dropdown-toggle]') || target.closest('[data-dropdown-menu]')) return
      setShowAgentSelect(false)
      setShowTeamSelect(false)
      setShowSessionSelect(false)
      setShowOpusModeMenu(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // ==================== OPUS (Task 13-c) — ⚖️ CTO meta-agent review ====================
  // 4 mảnh: (1) nút chế độ + kill switch ở header chat, (2) nút "Opus review"
  // manual dưới like/dislike, (3) Review Card dưới message đã review,
  // (4) OPUS DIRECTIVE CARD trong message flow (metadata.opusDirective).

  // Status Opus của phiên — fetch khi load + mỗi lần đổi session
  // (mode theo AgentSession; killed là settings toàn hệ thống)
  const fetchOpusStatus = useCallback(async (sid: string) => {
    if (!sid) return
    setOpusStatusLoading(true)
    try {
      const res = await fetch(`/api/opus/status?sessionId=${encodeURIComponent(sid)}`)
      if (res.ok) {
        const data = await res.json()
        setOpusMode(data.mode === 'auto' ? 'auto' : 'manual')
        setOpusKilled(!!data.killed)
      }
    } catch { /* fail-open — giữ state cũ (server chưa nạp schema mới → 500) */ }
    setOpusStatusLoading(false)
  }, [])

  // TASK 53 — fetch reviews của phiên (trích từ effect dưới để heartbeat
  // realtime tái sử dụng khi fingerprint báo có review mới do auto loop tạo
  // server-side — Review Card hiện ngay dưới message được review)
  const fetchOpusReviews = useCallback(async (sid: string) => {
    try {
      const res = await fetch(`/api/opus/reviews?sessionId=${encodeURIComponent(sid)}&limit=20`)
      if (!res.ok) return
      const data = await res.json()
      if (Array.isArray(data.reviews)) {
        setOpusReviews(prev => {
          const next = new Map(prev)
          for (const rv of data.reviews) {
            if (rv?.messageId) next.set(rv.messageId, rv as OpusReviewSerialized)
          }
          return next
        })
      }
    } catch { /* best-effort — review cũ không tải được thì coi như chưa review */ }
  }, [])

  // Reset state review theo phiên + fetch status + khôi phục review cũ của phiên
  // (GET /api/opus/reviews — Review Card + trạng thái "đã review" sống sót qua F5)
  useEffect(() => {
    setOpusReviews(new Map())
    setOpusDispatched(new Set())
    setOpusReviewLoading(null)
    if (!currentSessionId) return
    void fetchOpusStatus(currentSessionId)
    void fetchOpusReviews(currentSessionId)
  }, [currentSessionId, fetchOpusStatus, fetchOpusReviews])

  // ==================== TASK 53 — REALTIME HEARTBEAT (user request 2026-09-28) ====================
  // "Mở chế độ Tự động review của Opus thì phải chuyển module khác rồi quay
  // lại mới thấy review mới nhất + những gì agents triển khai" — nguyên nhân:
  // mọi dữ liệu (messages/reviews/jobs/runs) trước đây chỉ fetch MỘT LẦN khi
  // mở session, trong khi vòng auto chạy hoàn toàn server-side (review →
  // directive message → goal-loop job → agent run). Heartbeat poll 1 endpoint
  // fingerprint nhẹ /api/opus/activity mỗi 3s (auto) / 8s (manual); phần nào
  // của fingerprint đổi → refresh ĐÚNG phần đó:
  //   message mới → delta fetch afterId | review mới → refetch reviews
  //   job mới    → attach placeholder    | run mới   → refreshAgentRuns
  //   mode/killed → sync header (THAY poller /api/opus/status 8s cũ ở trên)
  type OpusActivityData = {
    ok?: boolean
    mode?: string
    killed?: boolean
    messageCount?: number
    latestMessageAt?: string | null
    reviewCount?: number
    latestReviewAt?: string | null
    activeJobIds?: string[]
    activeRunCount?: number
    latestRunAt?: number | null
  }
  type ActivitySnapshot = { mc: number; ma: string; rc: number; ra: string; jobs: string; runs: number; runAt: number }
  // Fingerprint lần beat gần nhất (null = chưa có baseline — beat đầu vẫn chạy
  // 1 vòng check để bắt message đến giữa lúc loadSessionTail và beat đầu)
  const activitySnapshotRef = useRef<ActivitySnapshot | null>(null)
  // Delta liên tục rỗng dù fingerprint báo message mới (cursor hết hạn — message
  // bị xóa giữa chừng) → sau 2 lần → full tail reload tự chữa
  const emptyDeltaStreakRef = useRef(0)

  // ===== Delta append: message MỚI HƠN cursor (KHÔNG reload tail) =====
  // Giữ nguyên history user đã kéo lên + không giật scroll (auto-follow chỉ
  // khi user đang ở cuối — effect scroll hiện có xử lý qua isNearBottomRef).
  // Dedupe 2 lớp:
  //   (a) theo id — message DB đã hiển thị (từ tail load / delta trước đó)
  //   (b) ADOPT client copy — message client tự append sau khi gửi chat / job
  //       hoàn tất có id crypto.randomUUID() (chứa '-'); DB copy cùng
  //       role+content đến sau → THAY client copy (nâng cấp metadata:
  //       sources / agentRun / Opus directive card) thay vì nhân đôi bong bóng.
  const appendDeltaMessages = useCallback(async (sid: string): Promise<boolean> => {
    const afterId = latestDbMessageRef.current?.id
    if (!afterId) return false
    const res = await fetch(`/api/chat-messages?sessionId=${encodeURIComponent(sid)}&afterId=${encodeURIComponent(afterId)}`)
    if (!res.ok) return false
    const data = await res.json().catch(() => null) as {
      messages?: Array<{
        id: string
        role: string
        content: string
        model?: string | null
        provider?: string | null
        metadata?: string | null
        createdAt: string
      }>
    } | null
    const rows = Array.isArray(data?.messages) ? data!.messages! : []
    if (rows.length === 0) return false

    const mapped: SmolabMessage[] = rows.map(m => {
      let parsedMeta: Record<string, unknown> | undefined
      if (m.metadata) {
        try {
          const first = JSON.parse(m.metadata)
          // Double-stringified (legacy) → parse thêm 1 lần — mirror loadSessionTail
          parsedMeta = typeof first === 'string' ? JSON.parse(first) : first
        } catch { /* ignore */ }
      }
      return {
        id: m.id,
        role: (['user', 'assistant', 'tool_call', 'error'].includes(m.role) ? m.role : 'assistant') as SmolabMessage['role'],
        content: m.content,
        timestamp: new Date(m.createdAt),
        model: m.model || undefined,
        provider: m.provider || undefined,
        sources: parsedMeta?.sources as Array<{ type: string; content: string; documentTitle?: string }> | undefined,
        confidence: parsedMeta?.confidence as number | undefined,
        toolName: parsedMeta?.toolName as string | undefined,
        toolCallInfo: parsedMeta?.toolCallInfo as { tool: string; detail: string } | undefined,
        agentName: parsedMeta?.agentName as string | undefined,
        agentPosition: parsedMeta?.agentPosition as string | undefined,
        isTeamMessage: parsedMeta?.isTeamMessage as boolean | undefined,
        agentRunSummary: parsedMeta?.agentRun as SmolabMessage['agentRunSummary'],
        metadata: parsedMeta as SmolabMessage['metadata'],
        feedback: null,
      }
    })

    setMessages(prev => {
      if (currentSessionIdRef.current !== sid) return prev
      let next = prev
      for (const msg of mapped) {
        if (next.some(x => x.id === msg.id)) continue // (a) id-dedupe
        const adoptIdx = next.findIndex(x => x.id.includes('-') && x.role === msg.role && x.content === msg.content)
        if (adoptIdx >= 0) {
          next = [...next]
          next[adoptIdx] = { ...msg, feedback: next[adoptIdx].feedback ?? null } // (b) adopt
          continue
        }
        next = [...next, msg]
      }
      return next
    })
    latestDbMessageRef.current = { id: rows[rows.length - 1].id }
    return true
  }, [])

  // ===== 1 beat: fetch fingerprint → so sánh với beat trước → refresh đúng phần đổi =====
  const heartbeatOnce = useCallback(async () => {
    const sid = currentSessionIdRef.current
    if (!sid || document.hidden) return
    if (sessionTailLoadingRef.current) return // đang load/replace tail — không đua append
    try {
      const res = await fetch(`/api/opus/activity?sessionId=${encodeURIComponent(sid)}`)
      if (!res.ok) return
      const d = await res.json().catch(() => null) as OpusActivityData | null
      if (!d?.ok) return

      // mode/killed: server là nguồn sự thật — trừ 5s sau khi user vừa bấm
      // đổi mode/kill ở client (optimistic đang chờ PATCH về)
      if (Date.now() - lastOpusModeActionRef.current > 5000) {
        if (d.mode) setOpusMode(d.mode === 'auto' ? 'auto' : 'manual')
        if (typeof d.killed === 'boolean') setOpusKilled(d.killed)
      }

      const snap: ActivitySnapshot = {
        mc: Number(d.messageCount ?? 0),
        ma: String(d.latestMessageAt ?? ''),
        rc: Number(d.reviewCount ?? 0),
        ra: String(d.latestReviewAt ?? ''),
        jobs: Array.isArray(d.activeJobIds) ? d.activeJobIds.join(',') : '',
        runs: Number(d.activeRunCount ?? 0),
        runAt: Number(d.latestRunAt ?? 0),
      }
      const hadBaseline = activitySnapshotRef.current !== null
      const prev: ActivitySnapshot = activitySnapshotRef.current ?? { mc: 0, ma: '', rc: 0, ra: '', jobs: '', runs: 0, runAt: 0 }
      activitySnapshotRef.current = snap
      if (hadBaseline &&
          prev.mc === snap.mc && prev.ma === snap.ma && prev.rc === snap.rc &&
          prev.ra === snap.ra && prev.jobs === snap.jobs && prev.runs === snap.runs && prev.runAt === snap.runAt) {
        return // không đổi gì
      }

      // 1) MESSAGES — message mới (auto loop directive / kết quả agent) hoặc bị xóa
      if (prev.mc !== snap.mc || prev.ma !== snap.ma) {
        const cursorId = latestDbMessageRef.current?.id
        if (!cursorId || snap.mc < prev.mc) {
          // Chưa có cursor (session trống ở client) hoặc message bị XÓA → full tail
          emptyDeltaStreakRef.current = 0
          await loadSessionTail(sid, { silent: true })
        } else if (!inFlightChatsRef.current.has(sid)) {
          // Client đang tự gửi chat trong phiên này → bỏ lượt delta (client tự
          // append response; beat sau sẽ adopt DB copy thay client copy)
          const productive = await appendDeltaMessages(sid)
          if (productive) {
            emptyDeltaStreakRef.current = 0
            setSessionsRefreshTick(t => t + 1) // preview danh sách session cập nhật
            refreshAgentRuns().catch(() => {}) // Thought Process panel của run mới
          } else if (hadBaseline) {
            // Fingerprint đổi mà delta rỗng 2 lần liên tiếp → cursor lệch → full reload tự chữa
            emptyDeltaStreakRef.current++
            if (emptyDeltaStreakRef.current >= 2) {
              emptyDeltaStreakRef.current = 0
              await loadSessionTail(sid, { silent: true })
            }
          }
        }
      }
      // 2) REVIEWS — Opus review mới (auto loop review xong → Review Card)
      if (prev.rc !== snap.rc || prev.ra !== snap.ra) {
        await fetchOpusReviews(sid)
      }
      // 3) JOBS — goal-loop job mới do server enqueue → attach placeholder + poll
      if (prev.jobs !== snap.jobs) {
        await attachSessionGoalLoopJobs(sid)
      }
      // 4) RUNS — run mới bắt đầu/kết thúc giữa 2 beat → refresh panels + todos
      if (prev.runs !== snap.runs || prev.runAt !== snap.runAt) {
        refreshAgentRuns().catch(() => {})
      }
    } catch { /* offline / server restart — thử lại ở beat sau */ }
  }, [loadSessionTail, appendDeltaMessages, fetchOpusReviews, attachSessionGoalLoopJobs, refreshAgentRuns])

  // Reset baseline khi đổi phiên (fingerprint mới; loadSessionTail nạp state)
  useEffect(() => {
    activitySnapshotRef.current = null
    emptyDeltaStreakRef.current = 0
  }, [currentSessionId])

  // Poll interval: 3s khi auto mode (realtime — review 30-120s, directive /
  // job / run cập nhật ≤3s), 8s khi manual (bắt tác vụ nền khởi tạo từ nơi
  // khác). Ẩn tab → skip beat (mirror poller agent-run); dọn interval khi
  // unmount / đổi phiên / đổi mode.
  useEffect(() => {
    if (!currentSessionId) return
    const beat = () => { heartbeatOnce().catch(() => {}) }
    beat() // baseline ngay khi mở session + bắt gap từ lúc tail load xong
    const interval = setInterval(beat, opusMode === 'auto' ? 3000 : 8000)
    return () => clearInterval(interval)
  }, [currentSessionId, opusMode, heartbeatOnce])

  // Đổi chế độ review: PATCH /api/opus/review-mode — optimistic update +
  // revert khi lỗi + toast (bật auto → server tự unkill)
  const handleOpusModeChange = useCallback(async (mode: 'manual' | 'auto') => {
    setShowOpusModeMenu(false)
    if (!currentSessionId || mode === opusMode) return
    lastOpusModeActionRef.current = Date.now() // TASK 53 — heartbeat không đè optimistic 5s
    const prevMode = opusMode
    const prevKilled = opusKilled
    setOpusMode(mode) // optimistic
    if (mode === 'auto') setOpusKilled(false) // optimistic — PATCH auto tự unkill
    try {
      const res = await fetch('/api/opus/review-mode', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: currentSessionId, mode }),
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({} as { error?: string }))
        throw new Error(errData?.error || `HTTP ${res.status}`)
      }
      const data = await res.json()
      setOpusMode(data.mode === 'auto' ? 'auto' : 'manual')
      setOpusKilled(!!data.killed)
      toast({
        title: mode === 'auto' ? '⚖️ Opus: chế độ Tự động' : '⚖️ Opus: chế độ Thủ công',
        description: mode === 'auto'
          ? 'Opus tự review & hành động sau mỗi run — chỉ dừng khi hoàn hảo.'
          : 'Bấm nút "Opus review" sau mỗi run để Opus phán xét.',
        duration: 3000,
      })
    } catch (err) {
      setOpusMode(prevMode) // revert optimistic
      setOpusKilled(prevKilled)
      toast({
        title: 'Không đổi được chế độ Opus',
        description: err instanceof Error ? err.message : 'Lỗi hệ thống — thử lại sau.',
        variant: 'destructive',
        duration: 4000,
      })
    }
  }, [currentSessionId, opusMode, opusKilled])

  // Kill switch (phanh khẩn cấp auto mode): POST /api/opus/kill
  const handleOpusKill = useCallback(async (action: 'kill' | 'reset') => {
    lastOpusModeActionRef.current = Date.now() // TASK 53 — heartbeat không đè optimistic 5s
    try {
      const res = await fetch('/api/opus/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({} as { error?: string }))
        throw new Error(errData?.error || `HTTP ${res.status}`)
      }
      const data = await res.json()
      setOpusKilled(!!data.killed)
      if (action === 'kill') {
        toast({
          title: '🛑 Đã kích hoạt phanh khẩn cấp Opus',
          description: 'Auto mode ngưng toàn hệ thống — mở menu Opus để gỡ phanh chạy lại.',
          duration: 4000,
        })
      } else {
        toast({ title: 'Đã gỡ phanh Opus', description: 'Opus được phép chạy lại ở chế độ tự động.', duration: 3000 })
      }
    } catch (err) {
      toast({
        title: 'Không đổi được kill switch Opus',
        description: err instanceof Error ? err.message : 'Lỗi hệ thống — thử lại sau.',
        variant: 'destructive',
        duration: 4000,
      })
    }
  }, [])

  // Gỡ phanh & chạy lại (khi killed): POST kill reset → PATCH review-mode auto
  // (PATCH auto tự unkill thêm lần nữa — idempotent)
  const handleOpusResume = useCallback(async () => {
    setShowOpusModeMenu(false)
    try {
      const killRes = await fetch('/api/opus/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset' }),
      })
      if (!killRes.ok) throw new Error(`HTTP ${killRes.status}`)
      setOpusKilled(false)
    } catch (err) {
      toast({
        title: 'Không gỡ được phanh Opus',
        description: err instanceof Error ? err.message : 'Lỗi hệ thống.',
        variant: 'destructive',
        duration: 4000,
      })
      return
    }
    if (currentSessionId && opusMode !== 'auto') {
      await handleOpusModeChange('auto') // tự toast + set state
    } else {
      toast({ title: '⚖️ Opus chạy lại', description: 'Phanh đã gỡ — chế độ tự động tiếp tục.', duration: 3000 })
    }
  }, [currentSessionId, opusMode, handleOpusModeChange])

  // "Opus review" (manual): POST /api/opus/review — chạy 30-120s, KHÔNG timeout
  // UI. 409 = có review khác đang chạy. Key map = messageId client + messageId
  // DB resolved (review card sống sót qua reload session).
  const handleOpusReview = useCallback(async (messageId: string) => {
    if (!currentSessionId) {
      toast({ title: 'Chưa có phiên chat', description: 'Opus review cần một phiên chat đã lưu.', variant: 'destructive', duration: 3000 })
      return
    }
    const sid = currentSessionId
    setOpusReviewLoading(messageId)
    try {
      const res = await fetch('/api/opus/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, messageId }),
      })
      if (res.status === 409) {
        toast({ title: 'Opus đang review — chờ chút', description: 'Một vòng review khác của phiên này vẫn đang chạy.', duration: 3000 })
        return
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({} as { error?: string }))
        throw new Error(errData?.error || `HTTP ${res.status}`)
      }
      const data = await res.json()
      // User đã đổi phiên trong lúc chờ → không áp kết quả vào phiên mới
      if (currentSessionIdRef.current !== sid) return
      if (data?.review) {
        const rv = data.review as OpusReviewSerialized
        setOpusReviews(prev => {
          const next = new Map(prev)
          next.set(messageId, rv)
          if (rv.messageId && rv.messageId !== messageId) next.set(rv.messageId, rv)
          return next
        })
        toast({
          title: `⚖️ Opus phán quyết: ${rv.decision}`,
          description: rv.verdict?.summary || 'Xem Review Card chi tiết dưới tin nhắn.',
          duration: 4000,
        })
      }
      // Response có `message` (auto-dispatch khi server đang auto mode) →
      // refresh tail để directive message hiện trong chat
      if (data?.message) {
        void loadSessionTail(sid, { silent: true }).catch(() => {})
      }
    } catch (err) {
      toast({
        title: 'Opus review thất bại',
        description: err instanceof Error ? err.message : 'Lỗi hệ thống — thử lại sau.',
        variant: 'destructive',
        duration: 4000,
      })
    } finally {
      setOpusReviewLoading(null)
    }
  }, [currentSessionId, loadSessionTail])

  // Assistant message cuối cùng của session — nút "Opus review" disable khi
  // message ĐÓ đã có review (review lại được khi có assistant message mới hơn)
  const lastAssistantMsgId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return messages[i].id
    }
    return null
  }, [messages])

  // Review đã ban hành = reviewId có directive message trong chat (metadata
  // opusDirective) — suy ra từ messages, sống sót qua F5 + mọi reload
  const opusDispatchedFromChat = useMemo(() => {
    const s = new Set<string>()
    for (const m of messages) {
      if (m.metadata?.opusDirective === true && typeof m.metadata?.opusReviewId === 'string') {
        s.add(m.metadata.opusReviewId)
      }
    }
    return s
  }, [messages])


  // Clear session search when dropdown closes
  useEffect(() => {
    if (!showSessionSelect) setSessionSearchQuery('')
  }, [showSessionSelect])

  // Fetch sessions filtered by agent — using isolated API (Phase 7)
  const fetchSessionsForAgent = useCallback(async (agentProfileId: string) => {
    try {
      const res = await fetch(`/api/smolab/sessions?mode=single&agentProfileId=${agentProfileId}`)
      if (res.ok) {
        const data = await res.json()
        setSessions(data.sessions || [])
      }
    } catch {}
  }, [])

  // Fetch sessions filtered by team — using isolated API (Phase 7)
  const fetchSessionsForTeam = useCallback(async (teamName: string) => {
    try {
      const res = await fetch(`/api/smolab/sessions?mode=multi&teamName=${teamName}`)
      if (res.ok) {
        const data = await res.json()
        setSessions(data.sessions || [])
      }
    } catch {}
  }, [])

  // Phase 7: Reset + reload sessions khi đổi Agent/Team
  // USER REQUEST 2026-09-01: (a) BỎ qua lần chạy ĐẦU TIÊN (mount) — context
  // vừa restore từ localStorage sẽ bị wipe mất nếu reset ở đây; (b) KHÔNG
  // abort task đang chạy của agent/team cũ — task chạy tiếp nền theo phiên
  // của nó (user: "agents độc lập hoặc team vẫn tiếp tục xử lý công việc dở").
  useEffect(() => {
    if (contextMountRef.current) {
      contextMountRef.current = false
      // Mount: chỉ load sessions cho context đã restore — KHÔNG reset gì cả
      if (chatMode === 'single' && selectedAgentId) {
        fetchSessionsForAgent(selectedAgentId)
      } else if (chatMode === 'multi' && selectedTeam) {
        fetchSessionsForTeam(selectedTeam)
      }
      return
    }

    // Đổi agent/team/mode THẬT SỰ: reset view (messages/session), tắt spinner
    // nhưng task cũ vẫn chạy nền (controller giữ trong inFlightChatsRef)
    detachFromInFlightChat()
    setMessages([])
    setCurrentSessionId('')
    setHasMoreMessages(false)
    oldestLoadedIdRef.current = null
    setActiveTaskIds(new Map())
    setTaskPolling(false)
    setSessions([])

    // Load sessions cho agent/team mới
    if (chatMode === 'single' && selectedAgentId) {
      fetchSessionsForAgent(selectedAgentId)
    } else if (chatMode === 'multi' && selectedTeam) {
      fetchSessionsForTeam(selectedTeam)
    }
  }, [selectedAgentId, selectedTeam, chatMode, fetchSessionsForAgent, fetchSessionsForTeam, detachFromInFlightChat])

  // USER REQUEST 2026-09-01: validate context restore sau khi agents load —
  // agent đã restore có còn tồn tại (enabled) không? Không còn → reset lựa
  // chọn để tránh chat với agent ảo (context mồ côi khi DB đổi máy/xóa agent).
  useEffect(() => {
    if (smolabAgents.length === 0) return
    if (chatMode === 'single' && selectedAgentId && !smolabAgents.some((a: any) => a.id === selectedAgentId)) {
      console.warn('[Smolab] Restored agent no longer exists — resetting selection')
      setSelectedAgentId(null)
      setCurrentSessionId('')
      setMessages([])
    }
  }, [smolabAgents, chatMode, selectedAgentId])

  // Phase 6: Task polling — check mỗi 2 giây khi có task đang chạy
  useEffect(() => {
    if (!taskPolling || activeTaskIds.size === 0) return

    const pollInterval = setInterval(async () => {
      let anyRunning = false

      for (const [sessionId, taskId] of activeTaskIds) {
        try {
          const res = await fetch(`/api/smolab/tasks/${taskId}`)
          if (!res.ok) continue
          const data = await res.json()
          const task = data.task

          if (task.status === 'completed') {
            // Task xong → load messages mới
            const msgRes = await fetch(`/api/chat-messages?sessionId=${encodeURIComponent(sessionId)}`)
            if (msgRes.ok) {
              const msgData = await msgRes.json()
              const loaded: SmolabMessage[] = msgData.messages.map((m: any) => ({
                id: m.id,
                role: m.role === 'user' ? 'user' : 'assistant',
                content: m.content,
                timestamp: new Date(m.createdAt),
                model: m.model,
                provider: m.provider,
              }))
              setMessages(loaded)
            }

            // Remove khỏi tracking
            setActiveTaskIds(prev => {
              const next = new Map(prev)
              next.delete(sessionId)
              return next
            })

            // Toast nếu KHÔNG phải session hiện tại (task nền hoàn thành)
            if (sessionId !== currentSessionId) {
              sonnerToast.success('Task hoàn thành', {
                description: `Phiên "${sessionId.slice(0, 8)}..." đã xong`,
              })
            }

          } else if (task.status === 'failed') {
            if (sessionId === currentSessionId) {
              const errMsg: SmolabMessage = {
                id: `error_${Date.now()}`,
                role: 'error',
                content: `Lỗi: ${task.error || 'Unknown error'}`,
                timestamp: new Date(),
              }
              setMessages(prev => [...prev, errMsg])
            }

            setActiveTaskIds(prev => {
              const next = new Map(prev)
              next.delete(sessionId)
              return next
            })

          } else if (task.status === 'running' || task.status === 'pending') {
            anyRunning = true
          }
        } catch {
          // Ignore poll errors
        }
      }

      // Dừng polling nếu không còn task nào đang chạy
      if (!anyRunning) {
        setTaskPolling(false)
      }
    }, 2000) // Poll mỗi 2 giây

    return () => clearInterval(pollInterval)
  }, [taskPolling, activeTaskIds, currentSessionId])

  const createNewSession = useCallback(async () => {
    try {
      const body: Record<string, unknown> = { title: 'Cuộc trò chuyện mới', model: selectedModel }

      // Phase D: Include agent/team info in session creation
      if (chatMode === 'single' && selectedAgentId) {
        body.agentProfileId = selectedAgentId
        body.teamMode = 'single'
        const agent = smolabAgents.find((a: any) => a.id === selectedAgentId)
        if (agent) {
          body.model = agent.model
          body.provider = agent.provider
          body.title = agent.name
        }
      } else if (chatMode === 'multi' && selectedTeam) {
        body.teamName = selectedTeam
        body.teamMode = 'multi'
        const tl = smolabAgents.find((a: any) => a.team === selectedTeam && a.position === 'TL' && a.enabled)
        if (tl) {
          body.model = tl.model
          body.provider = tl.provider
          body.title = `Team ${selectedTeam === 'code' ? 'Code' : 'Research'}`
          body.agentProfileId = tl.id
        }
      }

      const res = await fetch('/api/openclaw/sessions?action=create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        const data = await res.json()
        skipMessageLoadRef.current = true  // V1 FIX: skip useEffect to avoid wiping new session
        setCurrentSessionId(data.sessionId)
        setMessages([])
        // Refresh sessions list so the new session appears in the dropdown
        if (chatMode === 'single' && selectedAgentId) {
          fetchSessionsForAgent(selectedAgentId)
        } else if (chatMode === 'multi' && selectedTeam) {
          fetchSessionsForTeam(selectedTeam)
        } else {
          // No filter — reload all sessions
          try {
            const allRes = await fetch('/api/openclaw/sessions?action=list')
            if (allRes.ok) {
              const allData = await allRes.json()
              setSessions(allData.sessions || [])
            }
          } catch {}
        }
      }
    } catch {}
  }, [selectedModel, chatMode, selectedAgentId, selectedTeam, smolabAgents, fetchSessionsForAgent, fetchSessionsForTeam])

  // ===== SESSION RENAME & DELETE =====
  const renameSession = useCallback(async (sessionId: string, newTitle: string) => {
    try {
      const res = await fetch('/api/openclaw/sessions?action=rename', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, title: newTitle }),
      })
      if (res.ok) {
        // Update local sessions list immediately
        setSessions(prev => prev.map(s => s.sessionId === sessionId ? { ...s, title: newTitle } : s))
        setRenamingSessionId(null)
        setRenameValue('')
      }
    } catch {}
  }, [])

  const deleteSession = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`/api/openclaw/sessions?action=delete&sessionId=${sessionId}`, {
        method: 'DELETE',
      })
      if (res.ok) {
        // Hủy task chạy nền của PHIÊN BỊ XÓA (abort client + cancel server-side)
        const controller = inFlightChatsRef.current.get(sessionId)
        try { controller?.abort() } catch { /* ignore */ }
        inFlightChatsRef.current.delete(sessionId)
        fetch('/api/agent-run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        }).catch(() => {})

        // Remove from local list
        setSessions(prev => prev.filter(s => s.sessionId !== sessionId))
        // If deleted the current session, reset (+ abort request đang chờ)
        if (currentSessionId === sessionId) {
          skipMessageLoadRef.current = true  // V1 FIX: skip useEffect on reset
          abortInFlightChat()
          setCurrentSessionId('')
          setMessages([])
        }
      }
    } catch {}
  }, [currentSessionId])

  const startRenaming = useCallback((sessionId: string, currentTitle: string) => {
    setRenamingSessionId(sessionId)
    setRenameValue(currentTitle)
  }, [])

  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent, sessionId: string) => {
    if (e.key === 'Enter' && renameValue.trim()) {
      renameSession(sessionId, renameValue.trim())
    } else if (e.key === 'Escape') {
      setRenamingSessionId(null)
      setRenameValue('')
    }
  }, [renameValue, renameSession])

  // Export session messages as JSON
  const exportSession = useCallback(async (sessionId: string, title: string) => {
    try {
      const res = await fetch(`/api/chat-messages?sessionId=${sessionId}`)
      if (!res.ok) throw new Error('Failed to fetch messages')
      const data = await res.json()
      const messages = (data.messages || []).map((msg: { role: string; content: string; createdAt?: string; timestamp?: string }) => ({
        role: msg.role,
        content: msg.content,
        timestamp: msg.createdAt || msg.timestamp || null,
      }))
      const exportData = {
        sessionTitle: title,
        sessionId,
        exportedAt: new Date().toISOString(),
        messages,
      }
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const date = new Date().toISOString().slice(0, 10)
      const safeTitle = title.replace(/[^a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF]/g, '_').slice(0, 50)
      a.href = url
      a.download = `chat-export-${safeTitle}-${date}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      sonnerToast.success('Xuất phiên thành công', { description: `Đã xuất ${messages.length} tin nhắn` })
    } catch {
      sonnerToast.error('Xuất phiên thất bại', { description: 'Không thể tải tin nhắn từ phiên này' })
    }
  }, [])

  // ===== WORKFLOW TRIGGER (Critical Issues Resolution) =====
  // Keyword chính thức để khởi động workflow multi-agents: "tiến hành triển khai"
  // Không mở rộng thêm keywords — giữ đúng 1 keyword chính thức để rõ ràng và discoverable
  const WORKFLOW_TRIGGER_KEYWORD = 'tiến hành triển khai'

  function isWorkflowTrigger(text: string): boolean {
    const lower = text.toLowerCase().trim()
    return lower.includes(WORKFLOW_TRIGGER_KEYWORD)
  }

  const startWorkflow = useCallback(async (text: string, routing?: SmolabMessage['assessmentRouting'], options?: { skipUserMsg?: boolean }) => {
    // Auto-create session if none
    let sessionId = currentSessionId
    if (!sessionId) {
      sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      skipMessageLoadRef.current = true  // V1 FIX: skip useEffect to avoid wiping in-flight messages
      setCurrentSessionId(sessionId)
    }

    // Add user message (skip if already added by TL Assessment flow)
    const userMsg: SmolabMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    }
    if (!options?.skipUserMsg) {
      setMessages(prev => [...prev, userMsg])
    }
    setInput('')
    setIsLoading(true)

    // USER REQUEST 2026-08-31: AbortController cho workflow SSE — nút Dừng
    // (stopAgentTask) abort stream client-side + POST /api/agent-run hủy
    // pipeline server-side (các agent step dừng ở ranh giới an toàn gần nhất).
    // NO HARD TIMEOUT (user directive 2026-09-01: "làm gì có cái gọi là thời
    // gian chờ") — workflow chạy tới khi xong; user luôn có nút Dừng.
    // 2026-09-01: controller lưu theo sessionId — đổi phiên/rời module KHÔNG
    // abort; workflow chạy tiếp nền (server continueOnDisconnect=true + events
    // đã persist DB) — quay lại phiên sẽ thấy tiến độ/kết quả.
    stoppingRef.current = false
    timedOutRef.current = false
    const controller = new AbortController()
    chatAbortRef.current = controller
    inFlightChatsRef.current.set(sessionId, controller)
    // Hard-timeout removed — was 30 min, now unlimited. User can always press Stop.

    // GUARD 2026-09-01: mọi setMessages trong SSE loop chỉ được áp dụng khi
    // user đang NGHIÊN CỨU session này — tránh tin nhắn của workflow nền rơi
    // vào phiên khác user vừa mở
    const isActiveSession = () => currentSessionIdRef.current === sessionId

    // Add workflow start indicator
    const startMsg: SmolabMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '🔄 Code Team đang khởi động workflow...',
      timestamp: new Date(),
      isTeamMessage: true,
      agentName: 'SYSTEM',
      agentPosition: 'TL',
      agentAvatar: '👑',
    }
    setMessages(prev => [...prev, startMsg])

    try {
      // When skipUserMsg, user message already exists in messages state (from TL Assessment flow)
      const chatMessages = (options?.skipUserMsg ? messages : [...messages, userMsg])
        .filter((m: SmolabMessage) => m.role === 'user' || m.role === 'assistant')
        .map((m: SmolabMessage) => ({ role: m.role, content: m.content }))

      const workflowBody: Record<string, unknown> = {
        messages: chatMessages,
        sessionId,
        userRequest: text,
        teamName: selectedTeam || undefined,
      }
      // Phase 3: Pass pre-computed routing from TL Assessment if available
      if (routing) {
        workflowBody.routing = routing
      }

      const res = await fetch('/api/code-team/workflow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(workflowBody),
        signal: controller.signal, // USER REQUEST 2026-08-31: nút Dừng abort stream này
      })

      if (!res.ok) {
        throw new Error(`Workflow API error: ${res.status}`)
      }

      if (!res.body) {
        throw new Error('No response body')
      }

      // Read SSE stream
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let currentAgentMsgId: string | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        // Keep the last potentially incomplete line in the buffer
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()

          // Skip heartbeat lines
          if (trimmed.startsWith(':')) continue

          // Parse SSE data lines
          if (!trimmed.startsWith('data: ')) continue

          const jsonStr = trimmed.slice(6)
          let event: Record<string, unknown>
          try {
            event = JSON.parse(jsonStr)
          } catch {
            continue
          }

          const eventType = event.type as string

          // Phase 7: re-dispatch AI tool events on the window so CodeTabContent
          // can react (auto-open file / terminal echo / preview auto-open).
          // Defensive — NEVER break the SSE loop.
          if (eventType === 'tool_call' || eventType === 'tool_result') {
            try {
              window.dispatchEvent(new CustomEvent(AI_TOOL_EVENT_NAME, {
                detail: {
                  type: eventType,
                  tool: event.tool,
                  detail: typeof event.detail === 'string' ? event.detail : undefined,
                  result: typeof event.result === 'string' ? event.result : undefined,
                  // TASK 41 — abs path server-resolved (file tools): UI mở ĐÚNG file
                  // agents vừa đọc/sửa theo workspace root thật của server (không
                  // đoán bằng localStorage workspaceRoot — có thể lệch root).
                  absPath: typeof event.absPath === 'string' ? event.absPath : undefined,
                },
              }))
            } catch { /* never break the stream */ }
          }

          switch (eventType) {
            case 'workflow_start': {
              // Update the start indicator message
              if (isActiveSession()) setMessages(prev => prev.map(m =>
                m.id === startMsg.id
                  ? { ...m, content: `🚀 Code Team workflow đã bắt đầu (Session: ${(event.sessionId as string || '').slice(0, 8)}...)` }
                  : m
              ))
              break
            }

            case 'agent_start': {
              const agentName = event.agent as string
              const agentPosition = event.position as string
              const agentAvatar = event.avatar as string
              const agentMsg: SmolabMessage = {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: '',
                timestamp: new Date(),
                isTeamMessage: true,
                agentName,
                agentPosition,
                agentAvatar,
              }
              currentAgentMsgId = agentMsg.id
              if (isActiveSession()) setMessages(prev => [...prev, agentMsg])
              break
            }

            case 'agent_chunk': {
              if (!currentAgentMsgId) break
              // REPLACE content (not append) — each ReAct iteration returns FULL LLM output,
              // not incremental deltas. Appending would duplicate text across iterations.
              const chunkContent = event.content as string
              if (isActiveSession()) setMessages(prev => prev.map(m =>
                m.id === currentAgentMsgId
                  ? { ...m, content: chunkContent }
                  : m
              ))
              break
            }

            case 'agent_complete': {
              if (!currentAgentMsgId) break
              const completeContent = event.content as string
              const duration = event.duration as number | undefined
              if (isActiveSession()) setMessages(prev => prev.map(m =>
                m.id === currentAgentMsgId
                  ? { ...m, content: completeContent || m.content, durationMs: duration }
                  : m
              ))
              currentAgentMsgId = null
              break
            }

            case 'tool_call': {
              const toolAgentName = event.agent as string
              const toolAgentPosition = event.position as string
              const toolName = event.tool as string
              const toolDetail = event.detail as string
              const toolMsg: SmolabMessage = {
                id: crypto.randomUUID(),
                role: 'assistant',
                // Phase 7: rich bubble — 📖 file / ✏️ edit / ▶️ command
                content: formatToolBubble(toolName, toolDetail),
                timestamp: new Date(),
                isTeamMessage: true,
                agentName: toolAgentName,
                agentPosition: toolAgentPosition,
                agentAvatar: '🔧',
                toolCallInfo: { tool: toolName, detail: toolDetail || '' },
              }
              if (isActiveSession()) setMessages(prev => [...prev, toolMsg])
              break
            }

            case 'tool_result': {
              // Handled by the Phase 7 window event bridge above
              // (AI_TOOL_EVENT_NAME) — CodeTabContent refreshes the file tree /
              // editor / preview panel from there.
              break
            }

            case 'checkpoint': {
              const checkpointStep = event.step as string
              const checkpointDecision = event.decision as string | undefined
              const checkpointReasoning = event.reasoning as string | undefined
              const checkpointMsg: SmolabMessage = {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: `📋 Checkpoint: Step ${checkpointStep}${checkpointDecision ? ` → ${checkpointDecision}` : ''}${checkpointReasoning ? `\n${checkpointReasoning}` : ''}`,
                timestamp: new Date(),
                isTeamMessage: true,
                agentName: 'CHECKPOINT',
                agentPosition: 'TL',
                agentAvatar: '📋',
              }
              if (isActiveSession()) setMessages(prev => [...prev, checkpointMsg])
              break
            }

            case 'workflow_done': {
              const totalDuration = event.totalDuration as number | undefined
              // FIX 2026-09-15 #1 (P1 — audit Team Code): message cuối tôn trọng
              // THẬT event.status (mirror route.ts) — trước đây mọi kết thúc đều
              // hiển thị "✅ Workflow hoàn thành!" kể cả escalated/failed.
              const wfStatus = String(event.status || 'completed')
              const durSuffix = totalDuration ? ` (${(totalDuration / 1000).toFixed(1)}s)` : ''
              let doneContent: string
              let doneAvatar: string
              if (wfStatus === 'completed') {
                doneContent = `✅ Workflow hoàn thành!${durSuffix}`
                doneAvatar = '✅'
              } else if (wfStatus === 'completed_with_errors') {
                doneContent = `⚠️ Workflow hoàn thành kèm cảnh báo chất lượng (quality gate bắt lỗi lint/tsc) — đọc các bước để khắc phục.${durSuffix}`
                doneAvatar = '⚠️'
              } else if (wfStatus === 'escalated') {
                doneContent = `🔴 Workflow dừng sớm — TL ESCALATE (vấn đề đã được gửi tới Omega orchestrator để tìm cách xử lý).${durSuffix}`
                doneAvatar = '🔴'
              } else if (wfStatus === 'failed') {
                doneContent = `❌ Workflow thất bại — đọc các bước phía trên để biết lỗi ở đâu.${durSuffix}`
                doneAvatar = '❌'
              } else {
                doneContent = `⏹ Workflow kết thúc (${wfStatus}).${durSuffix}`
                doneAvatar = '⏹'
              }
              const doneMsg: SmolabMessage = {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: doneContent,
                timestamp: new Date(),
                isTeamMessage: true,
                agentName: 'SYSTEM',
                agentPosition: 'TL',
                agentAvatar: doneAvatar,
              }
              if (isActiveSession()) setMessages(prev => [...prev, doneMsg])
              break
            }

            case 'omega_escalation': {
              // FIX 2026-09-15 #2 (P2 — audit Team Code): AUTO-ESCALATE → Omega
              // hiển thị trong chat (mirror route.ts persist) — user thấy được
              // Omega đã nhận vấn đề của team và tư vấn gì.
              const advisory = String(event.advisory || '')
              const reason = String(event.reason || 'workflow gặp sự cố')
              if (advisory) {
                const escalationMsg: SmolabMessage = {
                  id: crypto.randomUUID(),
                  role: 'assistant',
                  content: `🧠 **TƯ VẤN TỪ OMEGA ORCHESTRATOR** (auto-escalate — vấn đề: ${reason})\n\n${advisory.slice(0, 2000)}`,
                  timestamp: new Date(),
                  isTeamMessage: true,
                  agentName: (event.agent as string) || 'Omega',
                  agentPosition: 'OMEGA',
                  agentAvatar: '🧠',
                }
                if (isActiveSession()) setMessages(prev => [...prev, escalationMsg])
              }
              break
            }

            case 'iteration': {
              // ReAct loop iteration progress — update current agent message with iteration indicator
              if (currentAgentMsgId) {
                const iterNum = event.iteration as number | undefined
                const maxIter = event.maxIterations as number | undefined
                const iterText = maxIter ? ` (Vòng ${iterNum}/${maxIter})` : ` (Vòng ${iterNum})`
                if (isActiveSession()) setMessages(prev => prev.map(m =>
                  m.id === currentAgentMsgId
                    ? { ...m, iterationInfo: iterText }
                    : m
                ))
              }
              break
            }

            case 'error': {
              const errorMsg = event.message as string
              const errorAgent = event.agent as string | undefined
              const errMsg: SmolabMessage = {
                id: crypto.randomUUID(),
                role: 'error',
                content: `❌ Workflow Error${errorAgent ? ` (${errorAgent})` : ''}: ${errorMsg}`,
                timestamp: new Date(),
              }
              if (isActiveSession()) setMessages(prev => [...prev, errMsg])
              break
            }
          }
        }
      }
    } catch (err) {
      // USER REQUEST 2026-08-31: user bấm DỪNG → không hiện "Workflow failed"
      // (stopAgentTask đã hiện thông báo ⏹ rồi)
      // 2026-09-01 GUARD: user đã đổi phiên → im lặng (không nhảy error vào phiên mới)
      if (stoppingRef.current || currentSessionIdRef.current !== sessionId) {
        // Đã dừng bởi user hoặc user đang ở phiên khác — im lặng
      } else {
        const errorMsg = err instanceof Error ? err.message : String(err)
        const errMsg: SmolabMessage = {
          id: crypto.randomUUID(),
          role: 'error',
          content: `❌ Workflow failed: ${errorMsg}`,
          timestamp: new Date(),
        }
        setMessages(prev => [...prev, errMsg])
      }
    } finally {
      // hardTimeoutId removed — no hard timeout (user directive)
      inFlightChatsRef.current.delete(sessionId)
      if (chatAbortRef.current === controller) chatAbortRef.current = null
      stoppingRef.current = false
      timedOutRef.current = false
      // 2026-09-01: spinner theo PHIÊN ĐANG MỞ (phiên khác vẫn chạy nền)
      setIsLoading(inFlightChatsRef.current.has(currentSessionIdRef.current))
    }
  }, [messages, currentSessionId, setCurrentSessionId, setMessages, setInput, setIsLoading, selectedTeam])

  // ===== RESEARCH TEAM WORKFLOW (Task 19 — user request 2026-09-03) =====
  // Chat Smolab ↔ Team Research (mirror startWorkflow của team code): MỌI
  // message team research điều qua /api/research-team/workflow SSE —
  // CLASSIFY → mission MS-... → NEMESIS lifecycle stream (G1/G2/G3 realtime)
  // → final report + Proposal duyệt qua prompt ("duyệt P-..."). Mọi thứ chuyển
  // giao bằng prompt — KHÔNG cần màn hình Missions UI (user directive).
  const startResearchWorkflow = useCallback(async (text: string) => {
    // Auto-create session if none (mirror startWorkflow)
    let sessionId = currentSessionId
    if (!sessionId) {
      sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      skipMessageLoadRef.current = true
      setCurrentSessionId(sessionId)
    }

    const userMsg: SmolabMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setIsLoading(true)

    // AbortController — nút Dừng abort stream client-side (pipeline server tiếp
    // tục nền — events đã persist DB, quay lại phiên vẫn thấy kết quả).
    stoppingRef.current = false
    timedOutRef.current = false
    const controller = new AbortController()
    chatAbortRef.current = controller
    inFlightChatsRef.current.set(sessionId, controller)

    const isActiveSession = () => currentSessionIdRef.current === sessionId

    const startMsg: SmolabMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '🔬 Research Team đang khởi động workflow...',
      timestamp: new Date(),
      isTeamMessage: true,
      agentName: 'SYSTEM',
      agentPosition: 'TL',
      agentAvatar: '👑',
    }
    setMessages(prev => [...prev, startMsg])

    try {
      const chatMessages = [...messages, userMsg]
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: m.content }))

      const res = await fetch('/api/research-team/workflow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: chatMessages,
          sessionId,
          userRequest: text,
          teamName: 'research',
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        throw new Error(`Research workflow API error: ${res.status}`)
      }
      if (!res.body) {
        throw new Error('No response body')
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed.startsWith(':')) continue // heartbeat
          if (!trimmed.startsWith('data: ')) continue

          const jsonStr = trimmed.slice(6)
          let event: Record<string, unknown>
          try {
            event = JSON.parse(jsonStr)
          } catch {
            continue
          }

          const eventType = event.type as string

          switch (eventType) {
            case 'workflow_start': {
              if (isActiveSession()) setMessages(prev => prev.map(m =>
                m.id === startMsg.id
                  ? { ...m, content: `🚀 Research Team workflow đã bắt đầu (Session: ${(event.sessionId as string || '').slice(0, 8)}...)` }
                  : m
              ))
              break
            }

            case 'agent_complete': {
              // Mỗi agent_complete của research route là message hoàn chỉnh
              // (stage NEMESIS / clarify / final report) — append bubble mới.
              const content = event.content as string
              if (!content || !content.trim()) break
              const stageMsg: SmolabMessage = {
                id: crypto.randomUUID(),
                role: 'assistant',
                content,
                timestamp: new Date(),
                isTeamMessage: true,
                agentName: (event.agent as string) || 'NEMESIS',
                agentPosition: (event.position as string) || 'TL',
                agentAvatar: (event.avatar as string) || '👑',
              }
              if (isActiveSession()) setMessages(prev => [...prev, stageMsg])
              break
            }

            case 'workflow_done': {
              const totalDuration = event.totalDuration as number | undefined
              const wfStatus = String(event.status || 'completed')
              const durSuffix = totalDuration ? ` (${(totalDuration / 1000).toFixed(1)}s)` : ''
              const missionCode = event.missionCode as string | undefined
              let doneContent: string
              let doneAvatar: string
              if (wfStatus === 'completed') {
                doneContent = `✅ Research Team hoàn thành mission${missionCode ? ` ${missionCode}` : ''}!${durSuffix}`
                doneAvatar = '✅'
              } else if (wfStatus === 'completed_with_errors') {
                doneContent = `⚠️ Mission${missionCode ? ` ${missionCode}` : ''} hoàn thành kèm cảnh báo (fail-open — đọc các bước để biết chi tiết).${durSuffix}`
                doneAvatar = '⚠️'
              } else if (wfStatus === 'needs_clarification') {
                doneContent = `❓ NEMESIS cần làm rõ — trả lời câu hỏi phía trên để mission tiếp tục.${durSuffix}`
                doneAvatar = '❓'
              } else if (wfStatus === 'failed') {
                doneContent = `❌ Research Team workflow thất bại — đọc các bước phía trên để biết lỗi ở đâu.${durSuffix}`
                doneAvatar = '❌'
              } else {
                doneContent = `⏹ Research Team workflow kết thúc (${wfStatus}).${durSuffix}`
                doneAvatar = '⏹'
              }
              const doneMsg: SmolabMessage = {
                id: crypto.randomUUID(),
                role: 'assistant',
                content: doneContent,
                timestamp: new Date(),
                isTeamMessage: true,
                agentName: 'SYSTEM',
                agentPosition: 'TL',
                agentAvatar: doneAvatar,
              }
              if (isActiveSession()) setMessages(prev => [...prev, doneMsg])
              break
            }

            case 'error': {
              const errorMsg = event.message as string
              const errorAgent = event.agent as string | undefined
              const errMsg: SmolabMessage = {
                id: crypto.randomUUID(),
                role: 'error',
                content: `❌ Research Team Error${errorAgent ? ` (${errorAgent})` : ''}: ${errorMsg}`,
                timestamp: new Date(),
              }
              if (isActiveSession()) setMessages(prev => [...prev, errMsg])
              break
            }
          }
        }
      }
    } catch (err) {
      if (stoppingRef.current || currentSessionIdRef.current !== sessionId) {
        // User bấm Dừng hoặc đang ở phiên khác — im lặng (mirror startWorkflow)
      } else {
        const errorMsg = err instanceof Error ? err.message : String(err)
        const errMsg: SmolabMessage = {
          id: crypto.randomUUID(),
          role: 'error',
          content: `❌ Research workflow failed: ${errorMsg}`,
          timestamp: new Date(),
        }
        setMessages(prev => [...prev, errMsg])
      }
    } finally {
      inFlightChatsRef.current.delete(sessionId)
      if (chatAbortRef.current === controller) chatAbortRef.current = null
      stoppingRef.current = false
      timedOutRef.current = false
      setIsLoading(inFlightChatsRef.current.has(currentSessionIdRef.current))
    }
  }, [messages, currentSessionId, setCurrentSessionId, setMessages, setInput, setIsLoading])

  const sendMessage = useCallback(async (queryText?: string) => {
    const text = queryText || input.trim()
    if (!text || isLoading) return

    // === WORKFLOW TRIGGER (Critical Issues Resolution) ===
    // Cách 1: Keyword shortcut — "tiến hành triển khai" → trigger trực tiếp (backward compat)
    if (chatMode === 'multi' && selectedTeam === 'code' && isWorkflowTrigger(text)) {
      await startWorkflow(text)
      return
    }

    // === Cách 2: Smart TL Assessment (Phase 3 — C2 Resolution) ===
    // Khi multi mode + team code → gọi TL Assessment để đánh giá request
    // - CODE_TEAM → Hiển thị Suggestion Card (user chấp nhận/từ chối)
    // - SIMPLE → Chat bình thường (TL có thể trả lời trực tiếp)
    if (chatMode === 'multi' && selectedTeam === 'code') {
      // Add user message first
      const userMsg: SmolabMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
        timestamp: new Date(),
      }
      setMessages(prev => [...prev, userMsg])
      if (!queryText) setInput('')
      setIsLoading(true)

      try {
        // Call TL Assessment API
        const recentHistory = [...messages, userMsg]
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .slice(-6)
          .map(m => ({ role: m.role, content: m.content }))

        const assessRes = await fetch('/api/code-team/assess', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, chatHistory: recentHistory }),
        })

        if (!assessRes.ok) {
          throw new Error(`Assessment API error: ${assessRes.status}`)
        }

        const { assessment, isDirectTrigger } = await assessRes.json()

        // Direct trigger — should not normally reach here (caught by isWorkflowTrigger above),
        // but handle it as safety net
        if (isDirectTrigger) {
          await startWorkflow(text)
          return
        }

        if (assessment.decision === 'CODE_TEAM') {
          // TL suggests Code Team workflow → Show Suggestion Card
          // Build parts based on routing mode (matching assessmentToRoutingDecision in tl-bridge.ts)
          const routingMode = assessment.routing?.mode || 'B'
          let parts: NonNullable<SmolabMessage['assessmentRouting']>['parts']
          if (routingMode === 'A') {
            // Pure Visual
            parts = [{ name: 'visual', type: 'visual' as const, description: text, dependency: [] }]
          } else if (routingMode === 'C') {
            // Hybrid — visual + backend
            parts = [
              { name: 'visual', type: 'visual' as const, description: `Phần giao diện UI/UX: ${text}`, dependency: [] },
              { name: 'backend', type: 'backend' as const, description: `Phần backend/logic: ${text}`, dependency: ['visual'] },
            ]
          } else {
            // Pure Backend (Mode B)
            parts = [{ name: 'backend', type: 'backend' as const, description: text, dependency: [] }]
          }

          const assessmentRouting: SmolabMessage['assessmentRouting'] = assessment.routing
            ? {
                mode: assessment.routing.mode,
                tier: assessment.routing.tier,
                score: assessment.routing.score,
                reasoning: assessment.routing.reasoning || '',
                parts,
                spec: text,
              }
            : undefined

          const suggestionMsg: SmolabMessage = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: '',
            timestamp: new Date(),
            isTeamMessage: true,
            agentName: 'MEGATRON',
            agentPosition: 'TL',
            agentAvatar: '👑',
            isWorkflowSuggestion: true,
            suggestionText: assessment.suggestion || 'MEGATRON đề xuất sử dụng Code Team để xử lý yêu cầu này.',
            routingMode: assessment.routing?.mode,
            routingTier: assessment.routing?.tier,
            routingScore: assessment.routing?.score,
            assessmentRouting: assessmentRouting,
          }
          setMessages(prev => [...prev, suggestionMsg])
          // LIVE VOICE: trả về nội dung để chế độ Live đọc thành giọng nói
          return assessment.suggestion || 'MEGATRON đề xuất sử dụng Code Team để xử lý yêu cầu này.'
        } else {
          // SIMPLE → TL can answer directly or show normal chat
          const tlAnswer: SmolabMessage = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: assessment.directAnswer || assessment.reasoning || 'Tôi hiểu yêu cầu của bạn. Bạn có thể hỏi thêm chi tiết hoặc sử dụng "tiến hành triển khai" để khởi động Code Team.',
            timestamp: new Date(),
            isTeamMessage: true,
            agentName: 'MEGATRON',
            agentPosition: 'TL',
            agentAvatar: '👑',
          }
          setMessages(prev => [...prev, tlAnswer])
          // LIVE VOICE: trả về nội dung để chế độ Live đọc thành giọng nói
          return tlAnswer.content
        }
      } catch (err) {
        // Assessment failed → show error, suggest keyword fallback
        const errMsg: SmolabMessage = {
          id: crypto.randomUUID(),
          role: 'error',
          content: `⚠️ Không thể đánh giá yêu cầu. ${err instanceof Error ? err.message : 'Lỗi không xác định'}. Bạn có thể dùng "tiến hành triển khai" để khởi động Code Team trực tiếp.`,
          timestamp: new Date(),
        }
        setMessages(prev => [...prev, errMsg])
      } finally {
        setIsLoading(false)
      }
      return // Always return after TL Assessment flow (success or failure)
    }

    // === RESEARCH TEAM WORKFLOW (Task 19 — user request 2026-09-03) ===
    // Team research chat → MỌI message điều qua /api/research-team/workflow SSE
    // (mirror team code): CLASSIFY → mission MS-... → NEMESIS lifecycle stream
    // → final report. Duyệt Proposal = nhắn "duyệt P-..." / "từ chối P-...".
    // Mọi thứ chuyển giao bằng prompt — KHÔNG cần màn hình Missions UI.
    if (chatMode === 'multi' && selectedTeam === 'research') {
      await startResearchWorkflow(text)
      return
    }

    // Auto-create session if none
    let sessionId = currentSessionId
    if (!sessionId) {
      sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      skipMessageLoadRef.current = true  // V1 FIX: skip useEffect to avoid wiping in-flight messages
      setCurrentSessionId(sessionId)
    }

    const userMsg: SmolabMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    }
    setMessages(prev => [...prev, userMsg])
    if (!queryText) setInput('')
    setIsLoading(true)

    // 2026-08-31 — BỎ chỉ báo fake "Đang tìm kiếm Knowledge Base..." (không
    // phản ánh gì thật). Thay bằng: (a) khối Thought Process THẬT (poll
    // /api/agent-run — hiện tư duy/todos/tool + kết quả thật của agent),
    // (b) spinner "Đang suy nghĩ..." cho giai đoạn agent đang nghĩ (chưa có
    // event nào) — panel Thought Process chỉ xuất hiện khi agent NGHĨ XONG
    // bước đầu tiên (user bug report 2026-08-31).
    // (giữ lại làm scaffolding — assertion widening để closure dưới đây không
    // bị TS narrow `toolMsg` thành `null` → `never`)
    const toolMsg = null as SmolabMessage | null

    // USER REQUEST 2026-08-31: AbortController —
    // (a) nút Gửi biến thành nút DỪNG khi đang chạy (stopAgentTask abort),
    // (b) không kẹt "Đang suy nghĩ" vĩnh viễn khi request treo.
    // NO HARD TIMEOUT (user directive 2026-09-01: "làm gì có cái gọi là thời
    // gian chờ") — request chạy tới khi xong; user luôn có nút Dừng.
    // 2026-09-01: controller lưu theo sessionId — user đổi phiên/rời module
    // KHÔNG abort; task chạy tiếp nền, response do server lưu DB.
    stoppingRef.current = false
    timedOutRef.current = false
    const controller = new AbortController()
    chatAbortRef.current = controller
    inFlightChatsRef.current.set(sessionId, controller)
    // Hard-timeout removed — was 20 min, now unlimited. User can always press Stop.

    try {
      const chatMessages = [...messages, userMsg]
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: m.content }))

      // Build chat request body with optional agent injection
      const chatBody: Record<string, unknown> = {
        messages: chatMessages,
        model: selectedModel,
        sessionId,
        stream: false,
      }
      // 2026-10-27 — trần prompt theo tác vụ: bật ∞ → gửi -1 (không giới hạn)
      if (promptBudgetMode === 'unlimited') chatBody.promptBudgetChars = -1

      // Phase D: Inject agent instruction
      if (chatMode === 'single' && selectedAgentId) {
        const agent = smolabAgents.find((a: any) => a.id === selectedAgentId)
        if (agent) {
          chatBody.agentInstruction = agent.instruction
          chatBody.agentTemperature = agent.temperature
          chatBody.agentMaxTokens = agent.maxTokens
          chatBody.agentProfileId = agent.id
          chatBody.agentProfileName = agent.name
          chatBody.agentProvider = agent.provider
          chatBody.agentModel = agent.model
          chatBody.teamMode = 'single'
          chatBody.model = agent.model
        }
      } else if (chatMode === 'multi' && selectedTeam) {
        const tl = smolabAgents.find((a: any) => a.team === selectedTeam && a.position === 'TL' && a.enabled)
        if (tl) {
          chatBody.agentInstruction = tl.instruction
          chatBody.agentTemperature = tl.temperature
          chatBody.agentMaxTokens = tl.maxTokens
          chatBody.agentProfileId = tl.id
          chatBody.agentProfileName = tl.name
          chatBody.agentProvider = tl.provider
          chatBody.agentModel = tl.model
          chatBody.teamMode = 'multi'
          chatBody.teamName = selectedTeam
          chatBody.model = tl.model
        }
      }

      const res = await fetch('/api/openclaw/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chatBody),
        signal: controller.signal, // USER REQUEST 2026-08-31: nút Dừng abort request này
      })

      if (!res.ok) throw new Error(`Chat API error: ${res.status}`)

      const data = await res.json()

      // Thought Process (2026-08-31): response về TRƯỚC khi poll bắt kịp
      // (ReAct nhanh / không tool) → refresh 1 lần để chèn panel + final state
      refreshAgentRuns().catch(() => {})

      // Add real response — GUARD: user đã đổi phiên trong lúc chờ → KHÔNG append
      // vào phiên mới (response đã được server lưu vào DB của phiên gốc — mở lại
      // phiên cũ sẽ thấy).
      if (currentSessionIdRef.current !== sessionId) {
        console.log('[Smolab] Response về sau khi user đổi phiên — bỏ qua append client-side (đã lưu DB)')
        return
      }

      // ===== GĐ4 CI-5 (Task 14-e) — DURABLE GOAL LOOP: server đã ENQUEUE job
      // nền và trả jobId NGAY (ENABLE_DURABLE_GOAL_LOOP=true). KHÔNG coi là
      // lỗi — request đã xong: tắt spinner bình thường (finally), append 1
      // PLACEHOLDER assistant message (goalLoopJobId) sẽ được thay bằng câu
      // trả lời thật khi poll /api/goal-loop-jobs thấy job completed, và
      // KHÔNG append message assistant thứ hai. Response KHÔNG có durable/
      // jobId (flag OFF / đường thường) → nhánh này dormant 100%.
      if (data.durable && data.jobId) {
        const jobId = String(data.jobId)
        const placeholderContent = String(
          data.content || `⏳ Tác vụ đã vào hàng đợi nền (job ${jobId.slice(0, 12)}…) — Phiên chat sẽ tự cập nhật khi hoàn tất.`
        )
        setMessages(prev => [...prev, {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: placeholderContent,
          timestamp: new Date(),
          model: data.model,
          provider: data.provider,
          goalLoopJobId: jobId,
        }])
        // Seed job state (tên agent từ chatBody để panel + placeholder hiển
        // thị ngay) → poll effect 3s tự bắt đầu.
        seedGoalLoopJob(jobId, sessionId, String(chatBody.agentProfileName || 'Agent'))
        // LIVE VOICE: đọc thông báo xếp hàng (kết quả thật đến qua poll)
        return placeholderContent
      }

      // LIVE VOICE (user request 2026-08-28): nội dung câu trả lời — hoisted
      // ra ngoài để return cho useVoiceLive đọc thành giọng nói sau khi xong.
      const content = String(data.content || 'Không thể tạo câu trả lời.')
      setMessages(prev => {
        const withoutTool = toolMsg ? prev.filter(m => m.id !== toolMsg.id) : prev

        // DEDUPE 2026-09-01: user rời phiên rồi quay lại ĐÚNG lúc response về
        // → messages đã reload từ DB (có sẵn response) → không append lần nữa
        if (prev.some(m => m.role === 'assistant' && m.content === content)) {
          return prev
        }

        // OC-3.2: If routed to OpenCode, show progress messages
        if (data.routedTo === 'opencode') {
          const progressMsg: SmolabMessage = {
            id: crypto.randomUUID(),
            role: 'opencode_progress',
            content: data.content || 'OpenCode session đã được tạo',
            timestamp: new Date(),
            model: data.model,
            provider: data.provider,
            opencodeSessionId: data.opencodeSessionId,
            enrichment: data.enrichment,
          }
          return [...withoutTool, progressMsg]
        }

        const assistantMsg: SmolabMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content,
          timestamp: new Date(),
          model: data.model,
          provider: data.provider,
          sources: data.sources,
          confidence: data.confidence,
          // Thought Process summary — persist qua DB metadata, hiện lại bar
          // tĩnh khi reload session (events in-memory đã mất)
          agentRunSummary: data.agentRun as SmolabMessage['agentRunSummary'],
        }
        return [...withoutTool, assistantMsg]
      })
      // LIVE VOICE (user request 2026-08-28): trả về nội dung câu trả lời cho
      // useVoiceLive — đọc thành giọng nói từng câu sau khi agent trả lời xong.
      return content
    } catch (err) {
      // USER REQUEST 2026-08-31 — 3 trường hợp phân biệt rõ ràng:
      //   (a) stoppingRef: user bấm DỪNG → stopAgentTask đã hiện thông báo ⏹ —
      //       KHÔNG thêm error message
      //   (b) timedOutRef: REMOVED — no hard timeout (user directive: "làm gì có
      //       cái gọi là thời gian chờ"). timedOutRef is always false now.
      //   (c) lỗi thật → error message như cũ
      // 2026-09-01 GUARD: user đã đổi phiên → error KHÔNG append vào phiên mới
      const stillOnSession = currentSessionIdRef.current === sessionId
      if (stoppingRef.current) {
        // Đã dừng bởi user — không hiện error
      } else if (!stillOnSession) {
        // User đang ở phiên khác — im lặng (phiên gốc sẽ reload từ DB khi mở lại)
      } else if (timedOutRef.current) {
        // No hard timeout — this branch is dead code but kept for safety.
        // If somehow timedOutRef gets set, just log it without showing a timeout toast.
        console.warn('[Chat] timedOutRef was set but no hard timeout exists — ignoring')
      } else {
        setMessages(prev => {
          const withoutTool = toolMsg ? prev.filter(m => m.id !== toolMsg.id) : prev
          return [...withoutTool, {
            id: crypto.randomUUID(),
            role: 'error',
            content: `Lỗi: ${err instanceof Error ? err.message : 'Unknown error'}`,
            timestamp: new Date(),
          }]
        })
        // Bắt final state của run (nếu có) — tránh panel kẹt "Đang chạy"
        refreshAgentRuns().catch(() => {})
      }
    } finally {
      // hardTimeoutId removed — no hard timeout (user directive)
      inFlightChatsRef.current.delete(sessionId)
      if (chatAbortRef.current === controller) chatAbortRef.current = null
      stoppingRef.current = false
      timedOutRef.current = false
      // 2026-09-01: spinner theo PHIÊN ĐANG MỞ — phiên khác vẫn đang chạy
      // background → isLoading giữ nguyên đúng với phiên đó
      setIsLoading(inFlightChatsRef.current.has(currentSessionIdRef.current))
    }
  }, [input, isLoading, messages, selectedModel, currentSessionId, chatMode, selectedAgentId, selectedTeam, smolabAgents, startWorkflow, refreshAgentRuns, seedGoalLoopJob])

  // ===== LIVE VOICE (user request 2026-08-28) — nút Live cạnh nút Gửi =====
  // Nói tiếng Việt → ASR → văn bản trong khung nhập. Tự gửi khi thỏa CẢ HAI:
  // (1) ngừng nói ≥1s, (2) câu tiếp theo là "xin hết". Agent trả lời → đọc
  // thành giọng nói từng câu → mở mic lại → vòng lặp. Bấm Live lần nữa để tắt.
  const inputVoiceRef = useRef('')
  useEffect(() => { inputVoiceRef.current = input }, [input])

  const voiceLive = useVoiceLive({
    onTranscriptAppend: (text) => {
      setInput(prev => (prev ? `${prev} ${text}` : text))
    },
    onAutoSend: async () => {
      const text = inputVoiceRef.current.trim()
      if (!text) return null
      setInput('')
      const reply = await sendMessage(text)
      return typeof reply === 'string' ? reply : null
    },
  })

  const VOICE_STATUS_META: Record<VoiceLiveStatus, { label: string; className: string }> = {
    off: { label: '', className: 'text-stone-500' },
    starting: { label: 'ĐANG BẬT MICRO...', className: 'text-amber-400' },
    listening: { label: 'ĐANG NGHE', className: 'text-emerald-400' },
    transcribing: { label: 'ĐANG NHẬN DIỆN GIỌNG NÓI...', className: 'text-cyan-400' },
    sending: { label: 'ĐANG GỬI — AGENT ĐANG XỬ LÝ...', className: 'text-amber-400' },
    speaking: { label: 'ĐANG ĐỌC CÂU TRẢ LỜI...', className: 'text-teal-300' },
    error: { label: 'LỖI MICRO', className: 'text-red-400' },
  }

  const handleFeedback = useCallback(async (messageId: string, type: 'positive' | 'negative', msgContent: string) => {
    setFeedbackLoading(messageId)
    try {
      const userMsg = messages.find(m => m.role === 'user' && messages.indexOf(m) < messages.findIndex(m2 => m2.id === messageId))
      const res = await fetch('/api/openclaw/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          messageId,
          sessionId: currentSessionId,
          content: userMsg?.content || '',
          agentResponse: msgContent,
        }),
      })
      // FIX (user request 2026-08-27): kiểm tra res.ok — trước đây lỗi 500 vẫn hiện
      // toast "Cảm ơn phản hồi!" khiến feedback trông như chỉ là giao diện.
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData?.error || `HTTP ${res.status}`)
      }
      setMessages(prev => prev.map(m => m.id === messageId ? { ...m, feedback: type } : m))
      toast({ title: type === 'positive' ? '👍 Cảm ơn phản hồi!' : '👎 Đã ghi nhận góp ý', description: type === 'positive' ? 'Phản hồi giúp Agent cải thiện' : 'Agent sẽ học từ góp ý này', duration: 2000 })
    } catch (err) {
      console.error('[Feedback] Lỗi ghi nhận phản hồi:', err)
      toast({ title: 'Không ghi nhận được phản hồi', description: err instanceof Error ? err.message : 'Lỗi hệ thống — thử lại sau.', variant: 'destructive', duration: 4000 })
    }
    setFeedbackLoading(null)
  }, [messages, currentSessionId])

  // V1/V6 FIX: Clear chat resets to empty session (no need to delete server-side messages — user may want to revisit them)
  const clearChat = useCallback(() => {
    skipMessageLoadRef.current = true  // V1 FIX: skip useEffect on clear
    abortInFlightChat() // FIX 2026-08-31: request đang chờ không theo sang phiên mới
    setMessages([])
    setCurrentSessionId('')
  }, [abortInFlightChat])

  // Get provider display name from model id
  const getModelDisplay = useCallback((modelId: string) => {
    for (const group of SMOLAB_MODEL_GROUPS) {
      const found = group.models.find(m => m.id === modelId)
      if (found) return `${group.icon} ${found.label}`
    }
    return modelId
  }, [])

  // ==================== RENDER ====================
  // Absolute positioning relative to body div (which is already below the header)
  // effectiveTop = distance from body div top to module top edge
  const moduleStyle: React.CSSProperties = {
    position: 'absolute',
    top: effectiveTop + 'px',
    left: effectiveLeft + 'px',
    right: effectiveRight + 'px',
    height: smolabHeight !== null ? smolabHeight + 'px' : `calc(100vh - ${HEADER_HEIGHT + STATUS_BAR_HEIGHT + effectiveTop}px)`,
    minHeight: MIN_MODULE_HEIGHT + 'px',
    zIndex: 15, // Above sidebar (z-10)
  }

  return (
    <div
      ref={smolabOuterRef}
      className="relative"
      style={moduleStyle}
    >
      {/* ===== LEFT OUTER EDGE RESIZE HANDLE ===== */}
      <div
        className="absolute left-0 top-3 bottom-4 w-3 cursor-col-resize group z-20 transition-colors duration-150"
        onMouseDown={handleLeftEdgeMouseDown}
        title="Kéo để thay đổi lề trái"
      >
        {/* Wider hit area for easier grabbing */}
        <div className="absolute inset-y-0 -left-1 -right-2 group-hover:bg-cyan-500/10 transition-colors duration-150" />
        {/* Persistent thin edge line */}
        <div className="absolute right-0 top-0 bottom-0 w-px bg-cyan-500/20 group-hover:bg-cyan-400/60 transition-colors duration-150" />
        {/* Visual dots indicator */}
        <div className="absolute inset-y-0 right-0 w-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-1">
            <div className="w-0.5 h-2.5 bg-cyan-500/25 group-hover:bg-cyan-400/90 rounded-full transition-colors duration-150" />
            <div className="w-0.5 h-2.5 bg-cyan-500/25 group-hover:bg-cyan-400/90 rounded-full transition-colors duration-150" />
            <div className="w-0.5 h-2.5 bg-cyan-500/25 group-hover:bg-cyan-400/90 rounded-full transition-colors duration-150" />
          </div>
        </div>
      </div>

      {/* ===== RIGHT OUTER EDGE RESIZE HANDLE ===== */}
      <div
        className="absolute right-0 top-3 bottom-4 w-3 cursor-col-resize group z-20 transition-colors duration-150"
        onMouseDown={handleRightEdgeMouseDown}
        title="Kéo để thay đổi lề phải"
      >
        {/* Wider hit area for easier grabbing */}
        <div className="absolute inset-y-0 -right-1 -left-2 group-hover:bg-cyan-500/10 transition-colors duration-150" />
        {/* Persistent thin edge line */}
        <div className="absolute left-0 top-0 bottom-0 w-px bg-cyan-500/20 group-hover:bg-cyan-400/60 transition-colors duration-150" />
        {/* Visual dots indicator */}
        <div className="absolute inset-y-0 left-0 w-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-1">
            <div className="w-0.5 h-2.5 bg-cyan-500/25 group-hover:bg-cyan-400/90 rounded-full transition-colors duration-150" />
            <div className="w-0.5 h-2.5 bg-cyan-500/25 group-hover:bg-cyan-400/90 rounded-full transition-colors duration-150" />
            <div className="w-0.5 h-2.5 bg-cyan-500/25 group-hover:bg-cyan-400/90 rounded-full transition-colors duration-150" />
          </div>
        </div>
      </div>

      {/* ===== TOP EDGE RESIZE HANDLE ===== */}
      <div
        className="absolute top-0 left-3 right-3 h-3 cursor-row-resize group z-20 transition-colors duration-150"
        onMouseDown={handleTopEdgeMouseDown}
        title="Kéo để thay đổi lề trên"
      >
        {/* Wider hit area for easier grabbing */}
        <div className="absolute inset-0 -top-1 -bottom-2 group-hover:bg-cyan-500/10 transition-colors duration-150" />
        {/* Persistent thin edge line */}
        <div className="absolute left-0 right-0 bottom-0 h-px bg-cyan-500/20 group-hover:bg-cyan-400/60 transition-colors duration-150" />
        {/* Visual dots indicator */}
        <div className="absolute inset-x-0 bottom-0 h-1.5 flex items-center justify-center">
          <div className="flex items-center gap-1">
            <div className="h-0.5 w-2.5 bg-cyan-500/25 group-hover:bg-cyan-400/90 rounded-full transition-colors duration-150" />
            <div className="h-0.5 w-2.5 bg-cyan-500/25 group-hover:bg-cyan-400/90 rounded-full transition-colors duration-150" />
            <div className="h-0.5 w-2.5 bg-cyan-500/25 group-hover:bg-cyan-400/90 rounded-full transition-colors duration-150" />
          </div>
        </div>
      </div>

      {/* ===== BOTTOM EDGE RESIZE HANDLE ===== */}
      <div
        className="absolute bottom-0 left-3 right-3 h-3 cursor-row-resize group z-20 transition-colors duration-150"
        onMouseDown={handleBottomEdgeMouseDown}
        title="Kéo để thay đổi chiều cao"
      >
        {/* Wider hit area for easier grabbing */}
        <div className="absolute inset-0 -top-2 -bottom-1 group-hover:bg-cyan-500/10 transition-colors duration-150" />
        {/* Persistent thin edge line */}
        <div className="absolute left-0 right-0 top-0 h-px bg-cyan-500/20 group-hover:bg-cyan-400/60 transition-colors duration-150" />
        {/* Visual dots indicator */}
        <div className="absolute inset-x-0 top-0 h-1.5 flex items-center justify-center">
          <div className="flex items-center gap-1">
            <div className="h-0.5 w-2.5 bg-cyan-500/25 group-hover:bg-cyan-400/90 rounded-full transition-colors duration-150" />
            <div className="h-0.5 w-2.5 bg-cyan-500/25 group-hover:bg-cyan-400/90 rounded-full transition-colors duration-150" />
            <div className="h-0.5 w-2.5 bg-cyan-500/25 group-hover:bg-cyan-400/90 rounded-full transition-colors duration-150" />
          </div>
        </div>
      </div>

      {/* ===== MAIN CONTENT AREA ===== */}
      <div ref={smolabContainerRef} className="flex h-full min-h-[200px]">
      {/* ===== LEFT: Chat Panel (resizable) ===== */}
      <div className="flex flex-col flex-shrink-0" style={{ width: chatPanelWidth + 'px', minWidth: '280px' }}>
        <div className="nc-wrap nc-cyan flex flex-col h-full">
          <div className="nc-panel nc-md nc-border-cyan flex flex-col h-full overflow-hidden">

            {/* Agent Header */}
            <div className="flex-shrink-0 p-3 border-b border-cyan-400/35">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  {/* Mode Toggle Button — click to switch Single/Multi */}
                  <button
                    onClick={() => {
                      const newMode = chatMode === 'single' ? 'multi' : 'single'
                      setChatMode(newMode)
                      setSelectedAgentId(null)
                      setSelectedTeam(null)
                      setMessages([])
                      skipMessageLoadRef.current = true
                      // 2026-09-01: KHÔNG abort — task của context cũ chạy tiếp nền
                      // theo phiên của nó; chỉ tắt spinner của view hiện tại
                      detachFromInFlightChat()
                      setCurrentSessionId('')
                      setSessions([])
                      setActiveTaskIds(new Map())
                      setTaskPolling(false)
                    }}
                    className="p-1.5 bg-gradient-to-br from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 transition-colors"
                    title={chatMode === 'single' ? 'Chuyển sang Multi (Team) mode' : 'Chuyển sang Single mode'}
                  >
                    {chatMode === 'single' 
                      ? <User className="h-4 w-4 text-white" /> 
                      : <Users className="h-4 w-4 text-white" />
                    }
                  </button>
                  <div>
                    <span className="text-sm font-semibold text-stone-100">
                      {chatMode === 'single' && selectedAgentId
                        ? (() => { const a = smolabAgents.find((ag: any) => ag.id === selectedAgentId); return a ? `${a.avatar} ${a.name}` : 'OpenClaw Agent' })()
                        : chatMode === 'multi' && selectedTeam
                        ? (selectedTeam === 'code' ? '💻 Code' : '🔬 Research')
                        : 'OpenClaw Agent'
                      }
                    </span>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <div className={`w-2 h-2 ${gatewayOnline ? 'bg-emerald-400' : 'bg-stone-500'} animate-pulse`} />
                      <span className="text-[9px] text-stone-400">{gatewayOnline ? 'Online' : 'Offline'}</span>
                      <span className="text-[9px] text-stone-500 ml-1">• {chatMode === 'single' ? 'Single' : 'Multi'}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {/* OPUS (Task 13-c) — ⚖️ chế độ review CTO meta-agent + kill switch */}
                  <div className="relative flex items-center gap-1">
                    {/* Kill switch — chỉ hiện khi auto mode CHƯA bị dừng (killed →
                        Scale đổi ShieldOff + dropdown có nút gỡ phanh) */}
                    {opusMode === 'auto' && !opusKilled && (
                      <Button
                        variant="ghost" size="sm"
                        className="h-6 w-6 p-0 text-rose-400 hover:text-rose-300 hover:bg-rose-500/10"
                        onClick={() => { void handleOpusKill('kill') }}
                        title="DỪNG OPUS NGAY"
                      >
                        <OctagonX className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button
                      variant="ghost" size="sm"
                      data-dropdown-toggle
                      onClick={(e) => { e.stopPropagation(); setShowOpusModeMenu(!showOpusModeMenu); setShowAgentSelect(false); setShowTeamSelect(false); setShowSessionSelect(false) }}
                      className={`h-6 w-6 p-0 relative ${
                        opusKilled
                          ? 'opacity-50 text-stone-500 hover:text-stone-300'
                          : opusMode === 'auto'
                          ? 'text-amber-400 border border-amber-400/50 hover:bg-amber-500/10'
                          : 'text-stone-400 hover:text-amber-400'
                      }`}
                      title="Opus — chế độ review"
                    >
                      {opusKilled ? <ShieldOff className="h-3.5 w-3.5" /> : <Scale className="h-3.5 w-3.5" />}
                      {opusMode === 'auto' && !opusKilled && (
                        <span className="absolute top-0 right-0 h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                      )}
                    </Button>
                    {showOpusModeMenu && (
                      <div data-dropdown-menu onClick={(e) => e.stopPropagation()} className="absolute top-full right-0 mt-1 z-50 w-60 bg-slate-950/95 border border-amber-400/50">
                        <div className="px-2.5 py-1.5 text-[9px] font-semibold uppercase tracking-wide text-amber-500/70 border-b border-amber-400/20">
                          ⚖️ Opus — chế độ review
                        </div>
                        <button
                          onClick={() => { void handleOpusModeChange('manual') }}
                          className={`w-full text-left px-2.5 py-1.5 hover:bg-amber-500/10 transition-colors flex items-start gap-2 ${opusMode === 'manual' ? 'bg-amber-500/10' : ''}`}
                        >
                          <User className="h-3 w-3 mt-0.5 flex-shrink-0 text-stone-400" />
                          <span className="flex-1">
                            <span className={`text-xs ${opusMode === 'manual' ? 'text-amber-300' : 'text-stone-300'}`}>Thủ công</span>
                            <span className="block text-[10px] text-stone-500">Bấm nút review sau mỗi run</span>
                          </span>
                          {opusMode === 'manual' && <Check className="h-3 w-3 text-amber-400 flex-shrink-0 mt-1" />}
                        </button>
                        <button
                          onClick={() => { void handleOpusModeChange('auto') }}
                          className={`w-full text-left px-2.5 py-1.5 hover:bg-amber-500/10 transition-colors flex items-start gap-2 border-t border-amber-400/10 ${opusMode === 'auto' ? 'bg-amber-500/10' : ''}`}
                        >
                          <Play className="h-3 w-3 mt-0.5 flex-shrink-0 text-stone-400" />
                          <span className="flex-1">
                            <span className={`text-xs ${opusMode === 'auto' ? 'text-amber-300' : 'text-stone-300'}`}>Tự động</span>
                            <span className="block text-[10px] text-stone-500">Opus tự review &amp; hành động — chỉ dừng khi hoàn hảo</span>
                          </span>
                          {opusMode === 'auto' && <Check className="h-3 w-3 text-amber-400 flex-shrink-0 mt-1" />}
                        </button>
                        {/* Gỡ phanh & chạy lại — chỉ hiện khi Opus đang bị dừng khẩn cấp */}
                        {opusKilled && (
                          <button
                            onClick={() => { void handleOpusResume() }}
                            className="w-full text-left px-2.5 py-1.5 hover:bg-rose-500/10 transition-colors flex items-center gap-2 border-t border-rose-400/20"
                          >
                            <Play className="h-3 w-3 flex-shrink-0 text-rose-400" />
                            <span className="text-xs text-rose-300">Gỡ phanh &amp; chạy lại</span>
                          </button>
                        )}
                        {opusStatusLoading && (
                          <div className="px-2.5 py-1 text-[9px] text-stone-500 border-t border-amber-400/10">Đang đồng bộ trạng thái…</div>
                        )}
                      </div>
                    )}
                  </div>
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-stone-400 hover:text-amber-400" onClick={clearChat} title="Xóa chat">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              {/* Single Mode — Agent Selector + Session Selector */}
              {chatMode === 'single' && (
                <div className="flex gap-2">
                  {/* Agent Selector — LUÔN hiển thị, highlight khi chưa chọn (Phase 5) */}
                  <div className="flex-1 relative">
                    <button
                      data-dropdown-toggle
                      onClick={(e) => { e.stopPropagation(); setShowAgentSelect(!showAgentSelect); setShowSessionSelect(false); setShowTeamSelect(false); setShowOpusModeMenu(false) }}
                      className={`chamfer-sm w-full flex items-center justify-between px-2.5 py-1.5 text-xs transition-colors ${!selectedAgentId ? 'border-cyan-500/70 bg-cyan-950/30' : 'border-cyan-400/40 bg-slate-950/50 hover:border-cyan-500/40'} border`}
                    >
                      <span className="text-stone-300 truncate">
                        {selectedAgentId
                          ? (() => { const a = smolabAgents.find((ag: any) => ag.id === selectedAgentId); return a ? `${a.avatar} ${a.name}` : '🔧 Chọn Agent' })()
                          : '🔧 Chọn Agent'
                        }
                      </span>
                      <ChevronDown className="h-3 w-3 text-stone-400 flex-shrink-0 ml-1" />
                    </button>
                    {showAgentSelect && (
                      <div data-dropdown-menu onClick={(e) => e.stopPropagation()} className="absolute top-full left-0 right-0 mt-1 z-50 bg-slate-950/95 border border-cyan-400/50 max-h-64 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                        {/* Đề xuất 1 (2026-08-25): Single mode liệt kê TẤT CẢ agents — nhóm theo
                            "Độc lập" / "💻 Team Code" / "🔬 Team Research" — để user chat 1-1 với
                            bất kỳ agent nào (RAMPAGE, SHOCWAVE...) cho task nhỏ nhanh, không cần
                            khởi động workflow multi-agent. Chat flow đã generic theo selectedAgentId. */}
                        {(() => {
                          const enabledAgents = smolabAgents.filter((a: any) => a.enabled)
                          const standalone = enabledAgents.filter((a: any) => !a.team)
                          const codeTeam = enabledAgents.filter((a: any) => a.team === 'code')
                          const researchTeam = enabledAgents.filter((a: any) => a.team === 'research')
                          const renderAgent = (agent: any, suffix?: string) => (
                            <button key={agent.id}
                              onClick={() => {
                                setSelectedAgentId(agent.id)
                                setShowAgentSelect(false)
                                setSelectedModel(agent.model)
                                // useEffect on selectedAgentId will handle messages/session reset + session fetch
                              }}
                              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-cyan-500/10 transition-colors ${selectedAgentId === agent.id ? 'text-cyan-400' : 'text-stone-300'}`}
                            >
                              {agent.avatar} {agent.name}
                              <span className="text-stone-500 ml-1">({(agent.model || '').split('/').pop() || agent.provider})</span>
                              {suffix && <span className="text-stone-600 ml-1">{suffix}</span>}
                            </button>
                          )
                          return (
                            <>
                              {standalone.length > 0 && (
                                <>
                                  <div className="px-3 py-1 text-[9px] font-semibold uppercase tracking-wide text-cyan-500/70 border-b border-cyan-400/20">Độc lập</div>
                                  {standalone.map((a: any) => renderAgent(a))}
                                </>
                              )}
                              {codeTeam.length > 0 && (
                                <>
                                  <div className="px-3 py-1 text-[9px] font-semibold uppercase tracking-wide text-amber-500/70 border-b border-amber-400/20 border-t border-t-amber-400/10 mt-1">💻 Team Code — chat 1-1</div>
                                  {codeTeam.map((a: any) => renderAgent(a, a.position ? `• ${a.position}` : undefined))}
                                </>
                              )}
                              {researchTeam.length > 0 && (
                                <>
                                  <div className="px-3 py-1 text-[9px] font-semibold uppercase tracking-wide text-violet-400/70 border-b border-violet-400/20 border-t border-t-violet-400/10 mt-1">🔬 Team Research — chat 1-1</div>
                                  {researchTeam.map((a: any) => renderAgent(a, a.position ? `• ${a.position}` : undefined))}
                                </>
                              )}
                            </>
                          )
                        })()}
                        {agentsLoadError && (
                          <div className="px-3 py-2 text-xs text-red-400">
                            <AlertTriangle className="h-3 w-3 inline mr-1" />
                            {agentsLoadError}
                            <button onClick={() => { fetch('/api/agents?enabled=true').then(r => r.ok ? r.json() : Promise.reject()).then(d => setSmolabAgents(d.agents || [])).catch(() => {}) }} className="ml-2 text-cyan-400 hover:underline">Thử lại</button>
                          </div>
                        )}
                        {!agentsLoadError && smolabAgents.filter((a: any) => a.enabled).length === 0 && (
                          <div className="px-3 py-2 text-xs text-stone-500">Chưa có Agent nào. Tạo Agent trong tab Agents.</div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Session Selector (Single) — CHỈ hiện khi đã chọn Agent (Phase 5) */}
                  {selectedAgentId ? (
                  <div className="flex-1 relative">
                    <button
                      data-dropdown-toggle
                      onClick={(e) => { e.stopPropagation(); setShowSessionSelect(!showSessionSelect); setShowAgentSelect(false); setShowTeamSelect(false); setShowOpusModeMenu(false) }}
                      className="chamfer-sm w-full flex items-center justify-between px-2.5 py-1.5 text-xs border border-cyan-400/40 bg-slate-950/50 hover:border-cyan-500/40 transition-colors"
                    >
                      <span className="text-stone-300 truncate">{currentSessionId ? (sessions.find((s: SmolabSession) => s.sessionId === currentSessionId)?.title || `Phiên ${currentSessionId.slice(0, 8)}...`) : '💬 Phiên chat'}</span>
                      <ChevronDown className="h-3 w-3 text-stone-400 flex-shrink-0 ml-1" />
                    </button>
                    {showSessionSelect && (
                      <div data-dropdown-menu onClick={(e) => e.stopPropagation()} className="absolute top-full left-0 right-0 mt-1 z-50 bg-slate-950/95 border border-cyan-400/50 max-h-64 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                        <div className="px-2 py-1.5 border-b border-cyan-400/20">
                          <div className="flex items-center gap-1.5 bg-slate-900/80 rounded px-2 py-1">
                            <Search className="h-3 w-3 text-stone-500 flex-shrink-0" />
                            <input
                              type="text"
                              value={sessionSearchQuery}
                              onChange={(e) => setSessionSearchQuery(e.target.value)}
                              placeholder="Tìm phiên..."
                              className="flex-1 bg-transparent text-xs text-stone-200 outline-none placeholder:text-stone-600"
                            />
                          </div>
                        </div>
                        <button
                          onClick={() => { createNewSession(); setShowSessionSelect(false) }}
                          className="w-full text-left px-3 py-1.5 text-xs text-amber-400 hover:bg-amber-500/10 transition-colors flex items-center gap-2"
                        >
                          <Plus className="h-3 w-3" /> Tạo phiên mới
                        </button>
                        {sessions
                          .filter((s: SmolabSession) => !sessionSearchQuery || s.title.toLowerCase().includes(sessionSearchQuery.toLowerCase()))
                          .length === 0 && sessionSearchQuery && (
                          <div className="px-3 py-2 text-xs text-stone-500 text-center">Không tìm thấy phiên nào</div>
                        )}
                        {sessions
                          .filter((s: SmolabSession) => !sessionSearchQuery || s.title.toLowerCase().includes(sessionSearchQuery.toLowerCase()))
                          .map((s: SmolabSession) => (
                          <div key={s.sessionId}
                            className={`flex items-center gap-1 px-2 py-1 text-xs hover:bg-cyan-500/10 transition-colors ${currentSessionId === s.sessionId ? 'bg-cyan-500/5' : ''}`}
                          >
                            {renamingSessionId === s.sessionId ? (
                              <div className="flex-1 flex items-center gap-1 min-w-0">
                                <input
                                  type="text"
                                  value={renameValue}
                                  onChange={(e) => setRenameValue(e.target.value)}
                                  onKeyDown={(e) => handleRenameKeyDown(e, s.sessionId)}
                                  onBlur={() => renameSession(s.sessionId, renameValue.trim() || s.title)}
                                  className="flex-1 min-w-0 bg-slate-800 border border-cyan-500/40 rounded px-1.5 py-0.5 text-xs text-stone-200 outline-none focus:border-cyan-400"
                                  autoFocus
                                  onClick={(e) => e.stopPropagation()}
                                />
                              </div>
                            ) : (
                              <button
                                onClick={() => { switchToSession(s.sessionId); setShowSessionSelect(false) }}
                                className={`flex-1 min-w-0 text-left truncate ${currentSessionId === s.sessionId ? 'text-cyan-400' : 'text-stone-300'}`}
                              >
                                {s.hasActiveRun && (
                                  <span className="inline-flex items-center gap-1 mr-1 text-emerald-400" title="Agents đang chạy tác vụ ở phiên này">
                                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                    <span className="text-[9px] font-medium">đang chạy</span>
                                  </span>
                                )}
                                {s.title} <span className="text-stone-500">({s.messageCount})</span>
                                {s.tasks && s.tasks.length > 0 && (
                                  <span className="flex items-center gap-0.5 ml-1 text-amber-400">
                                    <Zap className="h-3 w-3" />
                                    <span className="text-[9px]">{s.tasks.length}</span>
                                  </span>
                                )}
                              </button>
                            )}
                            <div className="flex items-center gap-0.5 flex-shrink-0">
                              <button
                                onClick={(e) => { e.stopPropagation(); exportSession(s.sessionId, s.title) }}
                                className="p-0.5 text-stone-500 hover:text-emerald-400 transition-colors"
                                title="Xuất phiên"
                              >
                                <Download className="h-3 w-3" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); startRenaming(s.sessionId, s.title) }}
                                className="p-0.5 text-stone-500 hover:text-cyan-400 transition-colors"
                                title="Đổi tên"
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); deleteSession(s.sessionId) }}
                                className="p-0.5 text-stone-500 hover:text-red-400 transition-colors"
                                title="Xóa phiên"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  ) : (
                    <div className="flex-1 flex items-center justify-center px-2.5 py-1.5 text-xs text-cyan-500/50 border border-cyan-400/15 bg-slate-950/30">
                      Chọn Agent để xem phiên
                    </div>
                  )}
                </div>
              )}

              {/* Multi Mode — Team Selector + Session Selector */}
              {chatMode === 'multi' && (
                <div className="flex gap-2">
                  {/* Team Selector — LUÔN hiển thị, highlight khi chưa chọn (Phase 5) */}
                  <div className="flex-1 relative">
                    <button
                      data-dropdown-toggle
                      onClick={(e) => { e.stopPropagation(); setShowTeamSelect(!showTeamSelect); setShowSessionSelect(false); setShowAgentSelect(false); setShowOpusModeMenu(false) }}
                      className={`chamfer-sm w-full flex items-center justify-between px-2.5 py-1.5 text-xs transition-colors ${!selectedTeam ? 'border-amber-500/70 bg-amber-950/30' : 'border-amber-400/40 bg-slate-950/50 hover:border-amber-500/40'} border`}
                    >
                      <span className="text-stone-300 truncate">
                        {selectedTeam ? (selectedTeam === 'code' ? '💻 Code' : '🔬 Research') : '👥 Chọn Team'}
                      </span>
                      <ChevronDown className="h-3 w-3 text-stone-400 flex-shrink-0 ml-1" />
                    </button>
                    {showTeamSelect && (
                      <div data-dropdown-menu onClick={(e) => e.stopPropagation()} className="absolute top-full left-0 right-0 mt-1 z-50 bg-slate-950/95 border border-amber-400/50">
                        <button
                          onClick={() => { setSelectedTeam('code'); setShowTeamSelect(false) }}
                          className={`w-full text-left px-3 py-2 text-xs hover:bg-amber-500/10 transition-colors ${selectedTeam === 'code' ? 'text-amber-400' : 'text-stone-300'}`}
                        >
                          💻 Code
                          <span className="text-stone-500 ml-1">({smolabAgents.filter((a: any) => a.team === 'code' && a.enabled).length} agents)</span>
                          <div className="flex gap-1 mt-1">
                            {smolabAgents.filter((a: any) => a.team === 'code' && a.enabled).map((a: any) => (
                              <span key={a.id} className="text-[9px] text-stone-500">{a.avatar} {a.position}</span>
                            ))}
                          </div>
                        </button>
                        <button
                          onClick={() => { setSelectedTeam('research'); setShowTeamSelect(false) }}
                          className={`w-full text-left px-3 py-2 text-xs hover:bg-amber-500/10 transition-colors ${selectedTeam === 'research' ? 'text-amber-400' : 'text-stone-300'}`}
                        >
                          🔬 Research
                          <span className="text-stone-500 ml-1">({smolabAgents.filter((a: any) => a.team === 'research' && a.enabled).length} agents)</span>
                          {/* Audit fix 2026-08-25: cảnh báo team trống ngay trong dropdown — tránh chọn team không có agent rồi chat vô ích */}
                          {smolabAgents.filter((a: any) => a.team === 'research' && a.enabled).length === 0 && (
                            <div className="text-[9px] text-amber-500/80 mt-0.5">⚠️ Chưa có agent — tạo trong tab Agents</div>
                          )}
                          <div className="flex gap-1 mt-1">
                            {smolabAgents.filter((a: any) => a.team === 'research' && a.enabled).map((a: any) => (
                              <span key={a.id} className="text-[9px] text-stone-500">{a.avatar} {a.position}</span>
                            ))}
                          </div>
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Session Selector (Multi) — CHỈ hiện khi đã chọn Team (Phase 5) */}
                  {selectedTeam ? (
                  <div className="flex-1 relative">
                    <button
                      data-dropdown-toggle
                      onClick={(e) => { e.stopPropagation(); setShowSessionSelect(!showSessionSelect); setShowTeamSelect(false); setShowAgentSelect(false) }}
                      className="chamfer-sm w-full flex items-center justify-between px-2.5 py-1.5 text-xs border border-amber-400/40 bg-slate-950/50 hover:border-amber-500/40 transition-colors"
                    >
                      <span className="text-stone-300 truncate">{currentSessionId ? (sessions.find((s: SmolabSession) => s.sessionId === currentSessionId)?.title || `Phiên ${currentSessionId.slice(0, 8)}...`) : '💬 Phiên chat'}</span>
                      <ChevronDown className="h-3 w-3 text-stone-400 flex-shrink-0 ml-1" />
                    </button>
                    {showSessionSelect && (
                      <div data-dropdown-menu onClick={(e) => e.stopPropagation()} className="absolute top-full left-0 right-0 mt-1 z-50 bg-slate-950/95 border border-amber-400/50 max-h-64 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                        <div className="px-2 py-1.5 border-b border-amber-400/20">
                          <div className="flex items-center gap-1.5 bg-slate-900/80 rounded px-2 py-1">
                            <Search className="h-3 w-3 text-stone-500 flex-shrink-0" />
                            <input
                              type="text"
                              value={sessionSearchQuery}
                              onChange={(e) => setSessionSearchQuery(e.target.value)}
                              placeholder="Tìm phiên..."
                              className="flex-1 bg-transparent text-xs text-stone-200 outline-none placeholder:text-stone-600"
                            />
                          </div>
                        </div>
                        <button
                          onClick={() => { createNewSession(); setShowSessionSelect(false) }}
                          className="w-full text-left px-3 py-1.5 text-xs text-amber-400 hover:bg-amber-500/10 transition-colors flex items-center gap-2"
                        >
                          <Plus className="h-3 w-3" /> Tạo phiên mới
                        </button>
                        {sessions
                          .filter((s: SmolabSession) => !sessionSearchQuery || s.title.toLowerCase().includes(sessionSearchQuery.toLowerCase()))
                          .length === 0 && sessionSearchQuery && (
                          <div className="px-3 py-2 text-xs text-stone-500 text-center">Không tìm thấy phiên nào</div>
                        )}
                        {sessions
                          .filter((s: SmolabSession) => !sessionSearchQuery || s.title.toLowerCase().includes(sessionSearchQuery.toLowerCase()))
                          .map((s: SmolabSession) => (
                          <div key={s.sessionId}
                            className={`flex items-center gap-1 px-2 py-1 text-xs hover:bg-amber-500/10 transition-colors ${currentSessionId === s.sessionId ? 'bg-amber-500/5' : ''}`}
                          >
                            {renamingSessionId === s.sessionId ? (
                              <div className="flex-1 flex items-center gap-1 min-w-0">
                                <input
                                  type="text"
                                  value={renameValue}
                                  onChange={(e) => setRenameValue(e.target.value)}
                                  onKeyDown={(e) => handleRenameKeyDown(e, s.sessionId)}
                                  onBlur={() => renameSession(s.sessionId, renameValue.trim() || s.title)}
                                  className="flex-1 min-w-0 bg-slate-800 border border-amber-500/40 rounded px-1.5 py-0.5 text-xs text-stone-200 outline-none focus:border-amber-400"
                                  autoFocus
                                  onClick={(e) => e.stopPropagation()}
                                />
                              </div>
                            ) : (
                              <button
                                onClick={() => { switchToSession(s.sessionId); setShowSessionSelect(false) }}
                                className={`flex-1 min-w-0 text-left truncate ${currentSessionId === s.sessionId ? 'text-amber-400' : 'text-stone-300'}`}
                              >
                                {s.hasActiveRun && (
                                  <span className="inline-flex items-center gap-1 mr-1 text-emerald-400" title="Agents đang chạy tác vụ ở phiên này">
                                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                    <span className="text-[9px] font-medium">đang chạy</span>
                                  </span>
                                )}
                                {s.title} <span className="text-stone-500">({s.messageCount})</span>
                                {s.tasks && s.tasks.length > 0 && (
                                  <span className="flex items-center gap-0.5 ml-1 text-amber-400">
                                    <Zap className="h-3 w-3" />
                                    <span className="text-[9px]">{s.tasks.length}</span>
                                  </span>
                                )}
                              </button>
                            )}
                            <div className="flex items-center gap-0.5 flex-shrink-0">
                              <button
                                onClick={(e) => { e.stopPropagation(); exportSession(s.sessionId, s.title) }}
                                className="p-0.5 text-stone-500 hover:text-emerald-400 transition-colors"
                                title="Xuất phiên"
                              >
                                <Download className="h-3 w-3" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); startRenaming(s.sessionId, s.title) }}
                                className="p-0.5 text-stone-500 hover:text-amber-400 transition-colors"
                                title="Đổi tên"
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); deleteSession(s.sessionId) }}
                                className="p-0.5 text-stone-500 hover:text-red-400 transition-colors"
                                title="Xóa phiên"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  ) : (
                    <div className="flex-1 flex items-center justify-center px-2.5 py-1.5 text-sm text-amber-400/70 border border-amber-400/15 bg-slate-950/30">
                      Chọn Team để xem phiên
                    </div>
                  )}
                </div>
              )}

              {/* Agent/Team model indicator */}
              {((chatMode === 'single' && selectedAgentId) || (chatMode === 'multi' && selectedTeam)) && (
                <div className="mt-2 px-2.5 py-1.5 text-[12px] text-stone-400 bg-slate-950/30 border border-stone-700/20">
                  {chatMode === 'single' && selectedAgentId && (() => {
                    const a = smolabAgents.find((ag: any) => ag.id === selectedAgentId)
                    return a ? `🤖 Model: ${a.model} (${a.provider}) • T: ${a.temperature} • 📦 ${a.maxTokens != null && a.maxTokens < 0 ? '∞ tokens' : `${a.maxTokens} tokens`}` : ''
                  })()}
                  {chatMode === 'multi' && selectedTeam && (() => {
                    const tl = smolabAgents.find((ag: any) => ag.team === selectedTeam && ag.position === 'TL' && ag.enabled)
                    return tl ? `👥 TL Model: ${tl.model} (${tl.provider}) • T: ${tl.temperature} • 📦 ${tl.maxTokens != null && tl.maxTokens < 0 ? '∞ tokens' : `${tl.maxTokens} tokens`}` : `⚠️ Team ${selectedTeam === 'code' ? 'Code' : 'Research'} chưa có Team Lead (TL)`
                  })()}
                </div>
              )}
            </div>

            {/* ===== GĐ4 CI-5 (14-e) — Panel "Tác vụ nền" (durable goal-loop job
                monitor — roadmap B7): chỉ hiện khi có job của phiên đang mở
                (active hoặc vừa kết thúc — purge khỏi state sau 15s → panel tự
                ẩn, KHÔNG chiếm không gian khi rảnh). ===== */}
            {goalLoopPanelJobs.length > 0 && (
              <GoalLoopJobsPanel jobs={goalLoopPanelJobs} onCancel={cancelGoalLoopJob} />
            )}

            {/* Messages List — USER REQUEST 2026-09-01: onScroll theo dõi vị trí
                (gần cuối → auto-scroll tin mới; chạm đầu → load tin cũ hơn) */}
            <div
              ref={chatScrollRef}
              onScroll={handleChatScroll}
              className="flex-1 overflow-y-auto p-3 space-y-3"
              style={{ scrollbarWidth: 'thin' }}
            >
              {/* Lazy-load indicator — còn tin cũ hơn → bấm/kéo lên để load */}
              {messages.length > 0 && hasMoreMessages && (
                <div className="flex justify-center py-1">
                  <button
                    onClick={() => loadOlderMessages()}
                    disabled={loadingOlder}
                    className="chamfer-sm text-[12px] px-3 py-1.5 border border-cyan-400/30 bg-slate-950/60 text-stone-300 hover:text-cyan-200 hover:border-cyan-400/60 transition-colors flex items-center gap-1.5"
                  >
                    {loadingOlder ? (
                      <>
                        <div className="h-3 w-3 animate-spin rounded-full border border-cyan-400 border-t-transparent" />
                        Đang tải tin nhắn cũ hơn...
                      </>
                    ) : (
                      <>↑ Xem tin nhắn cũ hơn</>
                    )}
                  </button>
                </div>
              )}
              {loadingMessages ? (
                /* V1 FIX: Loading indicator while fetching session messages */
                <div className="flex items-center justify-center h-full py-8">
                  <div className="flex items-center gap-2 text-stone-400">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
                    <span className="text-sm">Đang tải tin nhắn...</span>
                  </div>
                </div>
              ) : messages.length === 0 ? (
                /* Welcome Screen */
                <div className="flex flex-col items-center justify-center h-full text-center py-8">
                  <div className="p-4 bg-gradient-to-br from-emerald-900/30 to-teal-900/30 border border-emerald-400/35 mb-4">
                    <Sparkles className="h-10 w-10 text-amber-400" />
                  </div>
                  <h3 className="text-base font-bold text-stone-200 mb-1" style={{ fontFamily: "'Cormorant Infant', 'Georgia', serif" }}>
                    {chatMode === 'single' ? 'Single Agent Chat' : 'Multi Agent Team'}
                  </h3>
                  <p className="text-sm text-stone-300 max-w-[240px] mb-4">
                    {chatMode === 'single'
                      ? 'Chọn một Agent để bắt đầu trò chuyện với AI Agent chuyên biệt.'
                      : 'Chọn một Team để các Agents phối hợp làm việc.'}
                  </p>
                  <div className="flex items-center gap-1.5 mb-4">
                    <div className={`w-2 h-2 ${gatewayOnline ? 'bg-emerald-400' : 'bg-red-400'}`} />
                    <span className="text-[12px] text-stone-300">Gateway {gatewayOnline ? 'Online' : 'Offline — Mock Mode'}</span>
                  </div>
                  <div className="flex flex-col gap-2 w-full">
                    {SMOLAB_SUGGESTIONS.map(q => (
                      <button
                        key={q}
                        onClick={() => sendMessage(q)}
                        className="chamfer-sm text-sm px-3 py-2 border border-cyan-400/35 bg-slate-950/50 text-stone-200 hover:border-emerald-300 hover:bg-emerald-900/30 hover:text-emerald-400 transition-colors text-left"
                      >
                        💬 {q}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                /* Message Bubbles */
                /* OPUS (Task 13-c): map bọc React.Fragment — message row + Opus
                   Review Card (nếu message đó đã được review) là 2 phần tử riêng
                   trong space-y-3 → card nằm NGAY DƯỚI message, full column width. */
                messages.map(msg => (
                  <React.Fragment key={msg.id}>
                  <div className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} gap-2`}>
                    {/* Bot icon for assistant/tool/error/opencode — team messages use agent avatar */}
                    {(msg.role === 'assistant' || msg.role === 'tool_call' || msg.role === 'error' || msg.role === 'opencode_progress' || msg.role === 'opencode_result') && (
                      <div className={`flex-shrink-0 w-6 h-6 flex items-center justify-center mt-0.5 ${
                        msg.isTeamMessage && msg.agentName
                          ? (AGENT_COLORS[msg.agentName]?.bg || (msg.agentPosition ? POSITION_COLORS[msg.agentPosition]?.bg : undefined) || 'bg-gradient-to-br from-emerald-900 to-teal-900')
                          : 'bg-gradient-to-br from-emerald-900 to-teal-900'
                      }`}>
                        {msg.isTeamMessage && msg.agentAvatar ? (
                          <span className="text-xs leading-none">{msg.agentAvatar}</span>
                        ) : msg.role === 'tool_call' ? <Search className="h-3 w-3 text-cyan-400" /> :
                         msg.role === 'error' ? <AlertCircle className="h-3 w-3 text-red-400" /> :
                         msg.role === 'opencode_progress' ? <Code2 className="h-3 w-3 text-emerald-400" /> :
                         msg.role === 'opencode_result' ? <CheckCircle2 className="h-3 w-3 text-emerald-400" /> :
                         <Brain className="h-3 w-3 text-emerald-400" />}
                      </div>
                    )}

                    {/* Thought Process panel — live tư duy/todos/kết quả thật của agent (user request 2026-08-31) */}
                    {/* CI-2 (11-b): panel TỰ LẤY todo của run này từ run.todos
                        (per-runId — /api/agent-run, 11-a); sessionTodos chỉ còn
                        là fallback legacy (runId=null), không override nữa. */}
                    {msg.role === 'agent_run' && msg.runId && agentRuns[msg.runId] && (
                      <AgentRunPanel run={agentRuns[msg.runId]} todos={sessionTodos} />
                    )}

                    {/* Team agent message rendering */}
                    {msg.isTeamMessage && msg.agentName ? (
                      <div className={`max-w-[85%] p-3 rounded-xl border ${
                        AGENT_COLORS[msg.agentName]?.border || (msg.agentPosition ? POSITION_COLORS[msg.agentPosition]?.border : undefined) || 'border-cyan-400/35'
                      } ${
                        AGENT_COLORS[msg.agentName]?.bg || (msg.agentPosition ? POSITION_COLORS[msg.agentPosition]?.bg : undefined) || 'bg-slate-950/50'
                      }`}>
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-base">{msg.agentAvatar || '🤖'}</span>
                          <span className={`font-semibold text-sm ${
                            AGENT_COLORS[msg.agentName]?.text || (msg.agentPosition ? POSITION_COLORS[msg.agentPosition]?.text : undefined) || 'text-stone-100'
                          }`}>
                            {msg.agentName}
                          </span>
                          {msg.agentPosition && <span className="text-[11px] text-stone-300">({msg.agentPosition})</span>}
                          {msg.iterationInfo && <span className="text-[11px] text-amber-300/90 ml-1">{msg.iterationInfo}</span>}
                          <span className="text-[11px] text-stone-400 ml-auto">
                            {msg.timestamp.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        {/* Phase 3: Workflow Suggestion Card */}
                        {msg.isWorkflowSuggestion && !msg.suggestionRejected ? (
                          <div className="mt-1.5 p-3 rounded-lg border border-amber-500/30 bg-amber-950/20">
                            <div className="flex items-center gap-2 mb-2">
                              <span className="text-amber-300 text-sm font-medium">🚀 MEGATRON đề xuất Code Team</span>
                            </div>
                            <p className="text-[13px] text-stone-200 mb-2">{msg.suggestionText}</p>
                            {(msg.routingMode || msg.routingTier || msg.routingScore) && (
                              <div className="flex items-center gap-2 text-[11px] text-stone-300 mb-3">
                                {msg.routingMode && <span className="px-1.5 py-0.5 bg-slate-800/60 rounded">Mode {msg.routingMode === 'A' ? 'A (Visual)' : msg.routingMode === 'B' ? 'B (Backend)' : 'C (Hybrid)'}</span>}
                                {msg.routingTier && <span className="px-1.5 py-0.5 bg-slate-800/60 rounded">Tier {msg.routingTier === 1 ? '1 Simple' : msg.routingTier === 2 ? '2 Medium' : '3 Complex'}</span>}
                                {msg.routingScore != null && <span className="px-1.5 py-0.5 bg-slate-800/60 rounded">Score {msg.routingScore}/9</span>}
                              </div>
                            )}
                            <div className="flex gap-2">
                              <button
                                onClick={() => {
                                  // Accept: trigger workflow — let TL do full recon + routing analysis
                                  // (NOT passing pre-computed routing so TL reads files first via Path B)
                                  const userMessages = messages.filter(m => m.role === 'user')
                                  const lastUserMsg = userMessages[userMessages.length - 1]
                                  if (lastUserMsg) {
                                    // Remove the suggestion card, keep the user message
                                    setMessages(prev => prev.filter(m => m.id !== msg.id))
                                    // Pass undefined routing → workflow engine runs TL analyze (Path B)
                                    // where TL uses file_list/grep/file_read to inspect codebase before routing
                                    startWorkflow(lastUserMsg.content, undefined, { skipUserMsg: true })
                                  }
                                }}
                                className="px-3 py-1.5 text-[12px] bg-amber-500/20 text-amber-200 rounded border border-amber-500/30 hover:bg-amber-500/30 transition-colors font-medium"
                              >
                                ✅ Triển khai
                              </button>
                              <button
                                onClick={() => {
                                  // Reject: dismiss suggestion card
                                  setMessages(prev => prev.map(m =>
                                    m.id === msg.id
                                      ? { ...m, isWorkflowSuggestion: false, suggestionRejected: true, content: '✅ Đã hủy Code Team workflow.' }
                                      : m
                                  ))
                                }}
                                className="px-3 py-1.5 text-[12px] bg-slate-700/30 text-stone-300 rounded border border-slate-600/30 hover:bg-slate-700/50 transition-colors"
                              >
                                ❌ Không
                              </button>
                            </div>
                          </div>
                        ) : msg.suggestionRejected ? (
                          <p className="text-base text-stone-300 italic">{msg.content}</p>
                        ) : (
                          <MarkdownText content={msg.content} className="text-xs leading-relaxed text-stone-100" />
                        )}
                        {msg.toolCallInfo && (
                          <div className="mt-2 p-2 rounded-lg bg-slate-950/50 border border-stone-700/50 text-[11px] text-stone-300">
                            {formatToolBubble(msg.toolCallInfo.tool, msg.toolCallInfo.detail)}
                          </div>
                        )}
                        {msg.durationMs && (
                          <div className="text-[10px] text-stone-400 mt-1">{(msg.durationMs / 1000).toFixed(1)}s</div>
                        )}
                      </div>
                    ) : msg.role === 'user' && msg.metadata?.opusDirective === true ? (
                      /* OPUS (Task 13-c) — DIRECTIVE CARD: Opus hành động thay
                         Mr. Architect (role='user' + metadata.opusDirective) —
                         canh phải theo pattern user msg nhưng style riêng amber. */
                      <div className="max-w-[85%] border border-amber-400/45 bg-amber-950/20 p-2.5">
                        <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                          <span className="text-[11px] font-semibold text-amber-300">⚖️ OPUS — CHỈ ĐẠO</span>
                          {typeof msg.metadata.decision === 'string' && msg.metadata.decision && (
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 border ${opusDecisionBadgeClass(msg.metadata.decision)}`}>
                              {msg.metadata.decision}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-stone-200 leading-relaxed custom-scrollbar max-h-72 overflow-y-auto">
                          <MarkdownText content={msg.content} />
                        </div>
                        {msg.metadata.triggerMode === 'auto' && (
                          <div className="text-[9px] text-amber-400/60 mt-1.5">Opus hành động thay Mr. Architect</div>
                        )}
                      </div>
                    ) : msg.role === 'user' ? (
                      /* 2026-10-27 (user directive phiên 3): font tin nhắn người
                         dùng giảm về 12px — đồng bộ cỡ chữ với nội dung agent
                         (Task 25-a) cho nhất quán toàn khung chat. */
                      <div className="max-w-[85%] p-2.5 bg-gradient-to-r from-cyan-600/80 to-teal-700/80 text-white">
                        <p className="text-xs whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                      </div>
                    ) : (msg.goalLoopJobId && goalLoopJobs[msg.goalLoopJobId]
                        && (goalLoopJobs[msg.goalLoopJobId].status === 'queued' || goalLoopJobs[msg.goalLoopJobId].status === 'running')) ? (
                      /* GĐ4 CI-5 (14-e): placeholder job durable đang chạy —
                         spinner + progressHint live + ⚠ stall + nút Dừng riêng.
                         Job terminal → placeholder đã bị THAY bằng message thật
                         (goalLoopJobId đã dọn) → rơi xuống bubble thường. */
                      <DurableGoalLoopBubble
                        msg={msg}
                        job={goalLoopJobs[msg.goalLoopJobId]}
                        onCancel={cancelGoalLoopJob}
                      />
                    ) : (
                    <div className={`max-w-[85%] p-2.5 ${
                      msg.role === 'tool_call'
                      ? 'bg-slate-950/50 border border-cyan-500/15 border-l-2 border-l-cyan-400'
                      : msg.role === 'error'
                      ? 'bg-red-950/30 border border-red-400/35'
                      : msg.role === 'opencode_progress'
                      ? 'bg-emerald-950/30 border border-emerald-400/35 border-l-2 border-l-emerald-400'
                      : msg.role === 'opencode_result'
                      ? 'bg-emerald-950/20 border border-emerald-400/50 border-l-2 border-l-emerald-300'
                      : 'bg-slate-950/50 border border-cyan-400/35 border-l-2 border-l-emerald-400'
                    }`}>
                      {/* Role label */}
                      {msg.role === 'assistant' && (
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="text-[11px] text-stone-300 font-medium">Agent</span>
                          {msg.provider && <Badge className="text-[9px] h-3.5 px-1 bg-stone-950/50 text-stone-300">{msg.provider}</Badge>}
                          {msg.confidence != null && <Badge variant="outline" className="text-[9px] h-3.5 px-1" title={`Confidence từ trọng tài độc lập (goal-loop evaluator) / KB retrieval — Task 20-c`}>{(msg.confidence * 100).toFixed(0)}%</Badge>}
                        </div>
                      )}
                      {/* Thought Process summary bar (reload session) — events in-memory đã mất, chỉ còn summary */}
                      {msg.role === 'assistant' && msg.agentRunSummary && (
                        <AgentRunSummaryBar summary={msg.agentRunSummary} />
                      )}
                      {msg.role === 'tool_call' && (
                        <div className="flex items-center gap-1.5 mb-1">
                          <Loader2 className="h-3 w-3 animate-spin text-cyan-400" />
                          <span className="text-[11px] text-cyan-300">🔍 {msg.content}</span>
                        </div>
                      )}
                      {msg.role === 'error' && (
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="text-[11px] text-red-400">Lỗi</span>
                        </div>
                      )}
                      {msg.role === 'opencode_progress' && (
                        <div className="flex items-center gap-1.5 mb-1">
                          <Loader2 className="h-3 w-3 animate-spin text-emerald-400" />
                          <span className="text-[11px] text-emerald-300 font-medium">🔧 OpenCode Session</span>
                          {msg.opencodeSessionId && <Badge className="text-[9px] h-3.5 px-1 bg-emerald-950/50 text-emerald-300">{msg.opencodeSessionId.slice(0, 8)}</Badge>}
                        </div>
                      )}
                      {msg.role === 'opencode_result' && (
                        <div className="flex items-center gap-1.5 mb-1">
                          <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                          <span className="text-[11px] text-emerald-300 font-medium">✅ OpenCode Hoàn thành</span>
                        </div>
                      )}

                      {/* Content — báo cáo agent: 12px (user request: giảm về 12px) + markdown render sạch (không hiện thô **, `, *) */}
                      {msg.role !== 'tool_call' && (
                        <MarkdownText content={msg.content} className="text-xs leading-relaxed text-stone-100" />
                      )}

                      {/* Sources */}
                      {msg.role === 'assistant' && msg.sources && msg.sources.length > 0 && (
                        <details className="mt-1.5 pt-1.5 border-t border-cyan-500/15">
                          <summary className="text-[11px] text-stone-300 cursor-pointer hover:text-stone-100">Nguồn ({msg.sources.length})</summary>
                          <div className="mt-1 space-y-0.5 max-h-24 overflow-y-auto">
                            {msg.sources.map((s, i) => (
                              <div key={i} className="text-[11px] text-stone-300 flex items-start gap-1">
                                <span>{s.type === 'chunk' ? '📄' : s.type === 'entity' ? '🏷️' : '🔗'}</span>
                                <span className="truncate">{s.content.slice(0, 60)}{s.documentTitle && <span className="text-[10px]"> ({s.documentTitle})</span>}</span>
                              </div>
                            ))}
                          </div>
                        </details>
                      )}

                      {/* OC-3.2: KB Enrichment info for OpenCode progress messages */}
                      {msg.role === 'opencode_progress' && msg.enrichment && (
                        <div className="mt-1.5 pt-1.5 border-t border-emerald-500/15">
                          <div className="flex items-center gap-1.5 mb-1">
                            <span className="text-[11px] text-emerald-300">📊 KB Enrichment</span>
                            <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden">
                              <div className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full" style={{ width: `${Math.round(msg.enrichment.score * 100)}%` }} />
                            </div>
                            <span className="text-[11px] text-emerald-300">{Math.round(msg.enrichment.score * 100)}%</span>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {msg.enrichment.entitiesFound > 0 && <Badge className="text-[9px] h-3.5 px-1 bg-emerald-950/50 text-emerald-300">🏷️ {msg.enrichment.entitiesFound} entities</Badge>}
                            {msg.enrichment.documentsFound > 0 && <Badge className="text-[9px] h-3.5 px-1 bg-cyan-950/50 text-cyan-300">📄 {msg.enrichment.documentsFound} docs</Badge>}
                            {msg.enrichment.correctionsFound > 0 && <Badge className="text-[9px] h-3.5 px-1 bg-amber-950/50 text-amber-300">📝 {msg.enrichment.correctionsFound} corrections</Badge>}
                            {msg.enrichment.insightsFound > 0 && <Badge className="text-[9px] h-3.5 px-1 bg-violet-950/50 text-violet-300">💡 {msg.enrichment.insightsFound} insights</Badge>}
                          </div>
                        </div>
                      )}

                      {/* OC-3.2: Result summary for OpenCode result messages */}
                      {msg.role === 'opencode_result' && msg.opencodeResult && (
                        <div className="mt-1.5 pt-1.5 border-t border-emerald-500/15 space-y-1">
                          <div className="flex flex-wrap gap-1">
                            <Badge className="text-[9px] h-3.5 px-1 bg-emerald-950/50 text-emerald-300">+{msg.opencodeResult.additions} -{msg.opencodeResult.deletions}</Badge>
                            <Badge className="text-[9px] h-3.5 px-1 bg-cyan-950/50 text-cyan-300">📁 {msg.opencodeResult.filesChanged.length} files</Badge>
                            <Badge className="text-[9px] h-3.5 px-1 bg-amber-950/50 text-amber-300">🔧 {msg.opencodeResult.diagnostics} diagnostics</Badge>
                            {msg.opencodeResult.kbUsed && <Badge className="text-[9px] h-3.5 px-1 bg-violet-950/50 text-violet-300">🔍 KB used</Badge>}
                          </div>
                          {msg.opencodeResult.filesChanged.length > 0 && (
                            <div className="text-[11px] text-stone-300">
                              Files: {msg.opencodeResult.filesChanged.join(', ')}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Feedback buttons for assistant messages */}
                      {/* FIX (user request 2026-08-27): dùng `!= null` (loose equality) —
                          msg.feedback là UNDEFINED trên message mới tạo (field optional),
                          và `undefined !== null` là TRUE → nút bị disable VĨNH VIỄN,
                          user không bao giờ bấm được (triệu chứng "chỉ có giao diện").
                          `undefined != null` là FALSE → nút enable đúng. */}
                      {msg.role === 'assistant' && (
                        <div className="flex items-center gap-1 mt-2 pt-1.5 border-t border-cyan-400/25">
                          <button
                            onClick={() => handleFeedback(msg.id, 'positive', msg.content)}
                            disabled={feedbackLoading === msg.id || msg.feedback != null}
                            className={`p-1 transition-colors ${msg.feedback === 'positive' ? 'text-emerald-400' : 'text-stone-500 hover:text-emerald-400'}`}
                            title="Hữu ích"
                          >
                            <ThumbsUp className="h-3 w-3" />
                          </button>
                          <button
                            onClick={() => handleFeedback(msg.id, 'negative', msg.content)}
                            disabled={feedbackLoading === msg.id || msg.feedback != null}
                            className={`p-1 transition-colors ${msg.feedback === 'negative' ? 'text-red-400' : 'text-stone-500 hover:text-red-400'}`}
                            title="Cần cải thiện"
                          >
                            <ThumbsDown className="h-3 w-3" />
                          </button>
                          <span className="text-[10px] text-stone-400 ml-auto">
                            {msg.timestamp.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      )}

                      {/* OPUS (Task 13-c) — nút review thủ công của CTO meta-agent
                          ⚖️ (chỉ manual mode; disable khi message này là assistant
                          message cuối cùng VÀ đã có review — review lại được khi
                          có assistant message mới hơn xuất hiện sau đó) */}
                      {msg.role === 'assistant' && opusMode === 'manual' && (
                        <div className="flex mt-1">
                          <button
                            onClick={() => { void handleOpusReview(msg.id) }}
                            disabled={opusReviewLoading != null || (opusReviews.has(msg.id) && msg.id === lastAssistantMsgId)}
                            className="chamfer-sm border border-amber-400/40 bg-amber-950/20 hover:border-amber-400/70 text-amber-300 text-[10px] px-2 py-0.5 flex items-center gap-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            title="Opus đọc Thought Progress + kết quả rồi phán quyết 5 động từ (30-120s)"
                          >
                            {opusReviewLoading === msg.id ? (
                              <><Loader2 className="h-3 w-3 animate-spin" /> Opus đang đọc Thought Progress…</>
                            ) : (
                              <><Scale className="h-3 w-3" /> Opus review</>
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                    )}

                    {/* User icon — directive message của Opus dùng ⚖️ thay MessageSquare (Task 13-c) */}
                    {msg.role === 'user' && (
                      <div className={`flex-shrink-0 w-6 h-6 flex items-center justify-center mt-0.5 ${msg.metadata?.opusDirective === true ? 'bg-gradient-to-br from-amber-900 to-orange-900' : 'bg-gradient-to-br from-cyan-900 to-teal-900'}`}>
                        {msg.metadata?.opusDirective === true
                          ? <span className="text-xs leading-none">⚖️</span>
                          : <MessageSquare className="h-3 w-3 text-cyan-400" />}
                      </div>
                    )}
                  </div>
                  {/* OPUS (Task 13-c) — Review Card ngay dưới assistant message
                      đã review (full message column width) */}
                  {msg.role === 'assistant' && opusReviews.has(msg.id) && (() => {
                    const opusRv = opusReviews.get(msg.id)!
                    return (
                      <OpusReviewCard
                        review={opusRv}
                        dispatched={opusDispatched.has(opusRv.id) || opusDispatchedFromChat.has(opusRv.id)}
                        onDispatched={() => {
                          // Đã ban hành → đánh dấu + reload tail để directive
                          // message hiện trong chat
                          setOpusDispatched(prev => new Set(prev).add(opusRv.id))
                          if (currentSessionIdRef.current) {
                            void loadSessionTail(currentSessionIdRef.current, { silent: true }).catch(() => {})
                          }
                        }}
                      />
                    )
                  })()}
                  </React.Fragment>
                ))
              )}

              {/* Loading indicator — ẩn khi Thought Process panel đang hiển thị trạng thái chạy */}
              {isLoading && messages[messages.length - 1]?.role !== 'tool_call' && messages[messages.length - 1]?.role !== 'agent_run' && (
                <div className="flex justify-start gap-2">
                  <div className="flex-shrink-0 w-6 h-6 bg-gradient-to-br from-emerald-900 to-teal-900 flex items-center justify-center">
                    <Brain className="h-3 w-3 text-emerald-400" />
                  </div>
                  <div className="bg-slate-950/50 border border-cyan-400/35 p-2.5">
                    <div className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin text-emerald-500" />
                      <span className="text-sm text-stone-300">Đang suy nghĩ...</span>
                    </div>
                  </div>
                </div>
              )}
              {/* Phase 6: Typing indicator khi task đang chạy trong background */}
              {activeTaskIds.has(currentSessionId) && !isLoading && (
                <div className="flex items-center gap-2 px-4 py-2 text-sm text-stone-300">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>{chatMode === 'single' ? (smolabAgents.find((a: any) => a.id === selectedAgentId)?.name || 'Agent') : (selectedTeam === 'code' ? 'Code Team' : 'Research Team')} đang xử lý...</span>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Box — Phase 5: Disable khi chưa chọn Agent/Team */}
            <div className="flex-shrink-0 p-3 border-t border-cyan-400/35">
              {canChat ? (
              <>
              {/* LIVE VOICE (2026-08-28) — thanh trạng thái chế độ Live
                  (hiển thị cả khi lỗi micro để user thấy phản hồi) */}
              {(voiceLive.isLive || voiceLive.status === 'error') && (
                <div className="flex items-center gap-2 mb-2 px-2 py-1 chamfer-sm bg-slate-950/60 border border-cyan-400/25">
                  <span className={`relative flex h-2 w-2 ${voiceLive.status === 'listening' ? '' : 'opacity-60'}`}>
                    <span className={`absolute inline-flex h-full w-full rounded-full ${voiceLive.status === 'listening' ? 'bg-emerald-400 animate-ping' : 'bg-stone-500'} opacity-60`} />
                    <span className={`relative inline-flex rounded-full h-2 w-2 ${voiceLive.status === 'listening' ? 'bg-emerald-500' : 'bg-stone-400'}`} />
                  </span>
                  <span className={`text-[12px] font-mono uppercase tracking-wider ${VOICE_STATUS_META[voiceLive.status].className}`}>
                    {VOICE_STATUS_META[voiceLive.status].label}
                    {voiceLive.error && <span className="ml-1 normal-case">— {voiceLive.error}</span>}
                  </span>
                  {voiceLive.status === 'listening' && (
                    <span className="ml-auto text-[11px] text-stone-400">
                      Ngừng ≥1s rồi nói <span className="text-cyan-200">“xin hết”</span> để gửi
                    </span>
                  )}
                  {(voiceLive.status === 'sending' || voiceLive.status === 'speaking') && (
                    <span className="ml-auto text-[11px] text-stone-400 flex items-center gap-1">
                      {voiceLive.status === 'speaking' ? <Volume2 className="h-2.5 w-2.5" /> : <Loader2 className="h-2.5 w-2.5 animate-spin" />} mic tạm tắt
                    </span>
                  )}
                </div>
              )}
              {voiceLive.isLive && voiceLive.ttsVoiceMissing && (
                <div className="mb-1.5 px-1 text-[11px] text-amber-400/90">
                  ⚠ Trình duyệt chưa có giọng đọc tiếng Việt (vi-VN) — câu trả lời sẽ chỉ hiển thị dạng chữ. Hãy dùng Chrome/Edge hoặc cài thêm giọng vi-VN cho Windows.
                </div>
              )}
              <div className="flex items-center gap-2">
                {/* 2026-10-27 (user directive) — trần prompt THEO TÁC VỤ: nút nhỏ
                    cạnh ô nhập. Mặc định (AUTO) = trần hệ thống; bật ∞ = KHÔNG GIỚI
                    HẠN (-1) cho tác vụ sắp gửi — hợp task lớn cần đầy đủ context. */}
                <button
                  type="button"
                  onClick={() => setPromptBudgetMode(m => (m === 'auto' ? 'unlimited' : 'auto'))}
                  title={promptBudgetMode === 'auto'
                    ? 'Trần prompt: MẶC ĐỊNH hệ thống — bấm để chuyển sang KHÔNG GIỚI HẠN (-1) cho tác vụ này'
                    : 'Trần prompt: KHÔNG GIỚI HẠN (-1) — bấm để quay về MẶC ĐỊNH hệ thống'}
                  aria-label="Chuyển trần prompt của tác vụ"
                  className={`chamfer-sm h-8 px-2 shrink-0 text-[10px] font-semibold tracking-wide border transition-colors ${
                    promptBudgetMode === 'unlimited'
                      ? 'bg-amber-500/20 text-amber-300 border-amber-400/50 hover:bg-amber-500/30'
                      : 'bg-slate-950/60 text-stone-400 border-cyan-400/30 hover:text-stone-200 hover:border-cyan-400/50'
                  }`}
                >
                  {promptBudgetMode === 'unlimited' ? 'PROMPT ∞' : 'PROMPT AUTO'}
                </button>
                <input
                  ref={chatInputRef}
                  type="text"
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }}
                  placeholder={voiceLive.isLive ? 'Nói gì đó… (hoặc gõ tay)' : 'Nhập câu hỏi...'}
                  className="chamfer-sm flex-1 min-w-0 px-3 py-2 text-sm bg-slate-950/60 border border-cyan-400/40 text-stone-100 placeholder:text-stone-400 focus:outline-none focus:border-cyan-500/50 transition-colors"
                  disabled={isLoading}
                />
                {/* LIVE VOICE (2026-08-28) — nút Live cạnh nút Gửi:
                    bấm để bật/tắt chế độ đàm thoại tiếng Việt.
                    - Tắt: icon mic viền cyan
                    - Bật: nền đỏ gradient + sóng âm nhấp nháy  */}
                <Button
                  onClick={voiceLive.toggle}
                  title={voiceLive.isLive ? 'Tắt chế độ Live (dừng mic + đọc)' : 'Bật chế độ Live — nói tiếng Việt, ngừng ≥1s rồi nói “xin hết” để tự gửi'}
                  aria-label={voiceLive.isLive ? 'Tắt chế độ Live' : 'Bật chế độ Live'}
                  className={`chamfer-sm h-8 w-8 p-0 shrink-0 ${
                    voiceLive.isLive
                      ? 'bg-gradient-to-r from-red-600 to-rose-500 hover:from-red-500 hover:to-rose-400 text-white border border-red-400/50 animate-pulse'
                      : 'bg-slate-950/60 hover:bg-slate-900 text-cyan-300 border border-cyan-400/40 hover:border-cyan-400/70'
                  }`}
                >
                  {voiceLive.isLive ? <AudioLines className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                </Button>
                {/* USER REQUEST 2026-08-31: khi agent đang chạy, nút Gửi biến thành
                    nút DỪNG — bấm lần nữa để ngừng tác vụ Agents ngay lập tức
                    (abort request + hủy ReAct/workflow ở server). */}
                {isLoading ? (
                  <Button
                    onClick={stopAgentTask}
                    title="Dừng tác vụ Agents đang chạy"
                    aria-label="Dừng tác vụ Agents đang chạy"
                    className="chamfer-sm h-8 w-8 p-0 bg-gradient-to-r from-red-600 to-orange-600 hover:from-red-500 hover:to-orange-500 text-white border border-red-400/40 animate-pulse"
                  >
                    <Square className="h-3 w-3 fill-current" />
                  </Button>
                ) : (
                  <Button
                    onClick={() => sendMessage()}
                    disabled={!input.trim()}
                    title="Gửi tin nhắn"
                    aria-label="Gửi tin nhắn"
                    className="chamfer-sm h-8 w-8 p-0 bg-gradient-to-r from-emerald-600 to-teal-700 hover:from-emerald-500 hover:to-teal-600 text-white"
                  >
                    <Send className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
              </>
              ) : (
                <div className="flex items-center justify-center h-10 text-stone-500 text-xs gap-2">
                  <Zap className="h-4 w-4 opacity-30" />
                  <span>Chọn Agent hoặc Team để bắt đầu chat</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ===== RESIZE HANDLE ===== */}
      <div
        className="flex-shrink-0 w-2 cursor-col-resize group relative flex items-center justify-center"
        onMouseDown={handleResizeMouseDown}
        title="Kéo để thay đổi kích thước"
      >
        {/* Handle visual indicator */}
        <div className="absolute inset-y-0 -left-1 -right-1 group-hover:bg-cyan-500/10 transition-colors duration-150" />
        <div className="relative flex flex-col items-center gap-0.5">
          <div className="w-0.5 h-3 bg-cyan-500/30 group-hover:bg-cyan-400/80 rounded-full transition-colors duration-150" />
          <div className="w-0.5 h-3 bg-cyan-500/30 group-hover:bg-cyan-400/80 rounded-full transition-colors duration-150" />
          <div className="w-0.5 h-3 bg-cyan-500/30 group-hover:bg-cyan-400/80 rounded-full transition-colors duration-150" />
        </div>
      </div>

      {/* ===== RIGHT: Tab Content (resizable) ===== */}
      <div className="flex flex-col flex-1 min-w-0 sm:min-w-[300px] md:min-w-[400px]">
        <div className="nc-wrap nc-cyan flex flex-col h-full">
          <div className="nc-panel nc-md nc-border-cyan flex flex-col h-full overflow-hidden">

            {/* Tab Bar */}
            <div className="flex-shrink-0 flex border-b border-cyan-400/35">
              {SMOLAB_TABS.map(tab => {
                const IconComp = tab.icon
                const colorClass = TAB_COLOR_CLASSES[tab.color]
                return (
                  <button
                    key={tab.id}
                    onClick={() => {
                      setActiveSmolabTab(tab.id)
                      try { localStorage.setItem('graphrag-smolab-tab', tab.id) } catch { /* ignore */ }
                    }}
                    className={`chamfer-sm flex-1 flex items-center justify-center gap-1.5 px-2 py-2.5 text-[11px] font-medium transition-all border-b-2 ${
                      activeSmolabTab === tab.id
                        ? `bg-gradient-to-r ${colorClass.active} text-white border-b-cyan-400`
                        : `text-stone-400 ${colorClass.hover} border-b-transparent hover:bg-slate-950/30`
                    }`}
                  >
                    <IconComp className="h-3 w-3" />
                    <span className="hidden sm:inline">{tab.label}</span>
                  </button>
                )
              })}
            </div>

            {/* Tab Content */}
            <div className="flex-1 overflow-y-auto p-4" style={{ scrollbarWidth: 'thin' }}>

              {/* Tab: Knowledge Bridge */}
              {activeSmolabTab === 'knowledge' && (
                <KnowledgeTabContent />
              )}
              {activeSmolabTab === 'memory' && (
                <MemoryTabContent />
              )}
              {activeSmolabTab === 'learning' && (
                <LearningTabContent />
              )}
              {activeSmolabTab === 'skills' && (
                <SkillsTabContent />
              )}
              {activeSmolabTab === 'automation' && (
                <AutomationTabContent />
              )}
              {activeSmolabTab === 'channels' && (
                <ChannelsTabContent />
              )}
              {activeSmolabTab === 'code' && (
                <CodeTabContent />
              )}
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>
  )
}

