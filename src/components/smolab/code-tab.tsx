'use client'

// ========================================================================
// code-tab — Tab Code (Smolab) — code-editor suite
// PERF-SPLIT 2026-09-03: trích xuất nguyên vẹn từ src/app/page.tsx (không đổi logic)
// ========================================================================

import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Network, CheckCircle2, XCircle, Loader2, RefreshCw, Brain, Zap, Copy, ChevronDown, ChevronRight, AlertTriangle, FolderOpen, Play, Pause, Server, Clock, FileText, Trash2, Eye, Search, GitBranch, FolderUp, Lightbulb, X, Settings, Plus, RotateCcw, Pencil, Code2, Terminal as TerminalIcon, FolderTree, FileCode, Bug, Monitor, Play as PlayIcon, ArrowRight as ArrowRightIcon, Cpu as CpuIcon, Cable as CableIcon, GitCommit, History, ExternalLink as ExternalLinkIcon, GripHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Dialog } from '@/components/ui/dialog'
import { toast } from '@/hooks/use-toast'
import { authedFetch } from '@/lib/api-auth'
import { CodeEditor, detectLanguage, type OpenFile } from '@/components/code-editor/CodeEditor'
import { DiffViewer } from '@/components/code-editor/DiffViewer'
import { PendingEditModal } from '@/components/code-editor/PendingEditModal'
import { SearchPanel } from '@/components/code-editor/SearchPanel'
import { AI_TOOL_EVENT_NAME, extractJsonStringField, extractJsonNumberField, pathFileName } from '@/components/smolab/smolab-shared'


// ==================== HELPERS ====================

/**
 * FIX 2026-08-28 (Windows cross-platform): rút tên file/thư mục cuối từ path
 * bất kể separator. `path.split('/').pop()` sai trên Windows (backslash) →
 * folderName/badge hiện nguyên path thay vì tên. Chấp nhận cả "/" và "\".
 */
export function baseNameOf(p: string): string {
  const parts = (p || '').split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || p
}


// ==================== CODE TAB (Phase OC-1) ====================

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  extension?: string
  children?: FileNode[]
}


// ===== PREVIEW SESSION PERSISTENCE (user request 2026-10-15) =====
// Bấm Preview → app load qua port 3005+ → rời tab Code (sang tab khác của
// Smolab) hoặc rời hẳn module Smolab → quay lại, chọn tab Code → panel Preview
// phải TỰ KHÔI PHỤC, giao diện app trong thư mục đang chọn vẫn hiển thị.
// Dev server là process DETACHED (spawn qua /api/opencode/preview/start) —
// KHÔNG chết khi tab unmount; chỉ state React của panel bị mất. Vì vậy:
//   - Khi preview chạy thật (port xác định) → persist {root, port, framework}
//     vào localStorage (cùng pattern smolab-chat-context-v1).
//   - Khi CodeTabContent mount lại → đọc session → XÁC MINH dev server còn
//     sống (registry → detect scan tự re-allow port cho proxy) → dựng lại
//     panel + SSE logs + port-ready poll như lần bấm Preview đầu.
//   - Dev server đã tắt thật → xoá session (user bấm Preview lại như bình
//     thường — self-healing, không bao giờ khôi phục một panel chết).
export const PREVIEW_SESSION_KEY = 'smolab-preview-session-v1'

export type PreviewSession = {
  root: string
  port: number
  framework: string | null
  frameworkIcon: string
  devCommand: string | null
  savedAt: number
}


export function CodeTabContent() {
  // Server status
  const [serverOnline, setServerOnline] = useState(false)
  const [serverInfo, setServerInfo] = useState<{
    version: string; port: number; workspace: string; uptime: string; uptimeMs: number;
    sessions: { total: number; active: number; completed: number };
    tools: { available: string[]; count: number };
    lsp: { available: boolean; languages: string[] };
    mcp: { servers: string[]; connected: number };
  } | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [serverActionLoading, setServerActionLoading] = useState(false)

  // File explorer
  const [fileTree, setFileTree] = useState<FileNode[]>([])
  const [treeLoading, setTreeLoading] = useState(false)
  // FILE TREE REALTIME (fix 2026-09-10): token ép reload tree — (a) user chọn
  // lại CÙNG thư mục (workspaceRoot không đổi → effect không chạy → tree trống
  // vĩnh viễn sau setFileTree([])), (b) agents thay đổi file qua tools.
  const [treeReloadToken, setTreeReloadToken] = useState(0)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set(['src']))
  // Phase 8 — Monaco multi-tab state. selectedFile/fileContent/editedContent
  // are now COMPAT DERIVED values (same names, see below) so existing call
  // sites (file-tree highlight, header badges, save/revert buttons) keep working.
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activeFileIndex, setActiveFileIndex] = useState(0)
  const openFilesRef = useRef<OpenFile[]>([])
  useEffect(() => { openFilesRef.current = openFiles })
  const activeOpenFile = openFiles[Math.min(Math.max(activeFileIndex, 0), Math.max(openFiles.length - 1, 0))]
  const selectedFile = activeOpenFile?.path ?? null
  const fileContent: { path: string; content: string; language: string; lines: number; size: number; isBinary?: boolean; truncated?: boolean } | null = activeOpenFile
    ? {
        path: activeOpenFile.path,
        content: activeOpenFile.content,
        language: activeOpenFile.language || 'plaintext',
        lines: activeOpenFile.lines ?? activeOpenFile.content.split('\n').length,
        size: activeOpenFile.size ?? activeOpenFile.content.length,
        isBinary: activeOpenFile.isBinary,
        truncated: activeOpenFile.truncated,
      }
    : null
  const [fileLoading, setFileLoading] = useState(false)
  const [fileSearch, setFileSearch] = useState('')

  // Sessions
  const [sessions, setSessions] = useState<Array<{
    sessionId: string; model: string | null; provider: string | null;
    prompt: string | null; status: string; filesTouched: string[]; toolsUsed: string[];
    createdAt: string;
  }>>([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [newSessionPrompt, setNewSessionPrompt] = useState('')
  // MODEL POLICY 2026-08-27: kimi-k3 mặc định ('deepseek/deepseek-chat' là ID
  // provider đã chết — single-provider NVIDIA architecture)
  const [newSessionModel, setNewSessionModel] = useState('moonshotai/kimi-k3')
  const [creatingSession, setCreatingSession] = useState(false)

  // MCP Bridge
  const [mcpStatus, setMcpStatus] = useState<{
    outbound: { description: string; tools: { name: string; enabled: boolean; source: string }[] };
    inbound: { description: string; tools: { name: string; enabled: boolean; source: string }[] };
    bridgeStatus: string; lastSync: string;
  } | null>(null)
  const [mcpSyncing, setMcpSyncing] = useState(false)
  const [mcpToggling, setMcpToggling] = useState<string | null>(null)

  // ===== Agent Tasks (Todo Progress) — REMOVED 2026-08-31 =====
  // User: khối Thought Process + Todos trong cửa sổ chat (AgentRunPanel, poll
  // /api/agent-run + /api/todos trong SmolabModule) thay thế panel này —
  // "Nếu có tính năng này tôi nghĩ sẽ không cần đến Agents tasks nữa".
  // Todos VẪN được agents ghi qua todo_write + workflow auto-todo (DB) —
  // chỉ gỡ phần hiển thị panel ở tab Code.

  // Terminal
  const [terminalOutput, setTerminalOutput] = useState<string[]>([])
  const [terminalLoading, setTerminalLoading] = useState(false)
  const [terminalCommand, setTerminalCommand] = useState('')
  const [terminalRunning, setTerminalRunning] = useState(false)
  const [terminalHeight, setTerminalHeight] = useState(192)
  const terminalDragRef = useRef<{ startY: number; startH: number } | null>(null)
  // Phase 4: persistent interactive shell (bash -i) session + SSE stream refs
  const terminalSessionIdRef = useRef<string | null>(null)
  const terminalEvtRef = useRef<EventSource | null>(null)
  const terminalBufferRef = useRef<string>('')
  const terminalPrevRootRef = useRef<string | null>(null)
  // Phase 7: scroll anchor for the terminal output panel (AI command echo)
  const terminalViewRef = useRef<HTMLDivElement | null>(null)

  // File Explorer resize
  const [fileExplorerHeight, setFileExplorerHeight] = useState(400)
  const fileExplorerDragRef = useRef<{ startY: number; startH: number } | null>(null)

  // Preview panel
  const [showPreview, setShowPreview] = useState(false)
  const [previewPort, setPreviewPort] = useState<number | null>(null)
  const [previewDetecting, setPreviewDetecting] = useState(false)
  const [previewFramework, setPreviewFramework] = useState<string | null>(null)
  const [previewFrameworkIcon, setPreviewFrameworkIcon] = useState('📦')
  const [previewDevCommand, setPreviewDevCommand] = useState<string | null>(null)
  const [previewAutoStarting, setPreviewAutoStarting] = useState(false)
  const [previewAutoStartAttempted, setPreviewAutoStartAttempted] = useState(false)
  const [previewIframeKey, setPreviewIframeKey] = useState(0)
  // PREVIEW SAME-ORIGIN PROXY (fix 2026-09-10): iframe trỏ /api/opencode/preview/
  // proxy/<port>/ thay vì http://127.0.0.1:<port> — hoạt động cả khi xem app qua
  // HTTPS proxy (127.0.0.1 trong browser = máy user, không có dev server +
  // mixed-content block). previewWaiting: dev server đã start nhưng chưa nhận
  // connection (npm install/compile chậm) — hiện spinner thay vì iframe lỗi.
  const [previewWaiting, setPreviewWaiting] = useState(false)
  const previewProxyUrl = useCallback((port: number, path = '/') =>
    `/api/opencode/preview/proxy/${port}${path.startsWith('/') ? path : `/${path}`}`, [])
  /** Poll dev server QUA PROXY (server-side check — đúng máy với dev server)
   *  cho tới khi sẵn sàng (không 502/403) → remount iframe. Tối đa 45s. */
  const waitForPreviewReady = useCallback(async (port: number) => {
    setPreviewWaiting(true)
    for (let i = 0; i < 90; i++) {
      await new Promise(r => setTimeout(r, 500))
      try {
        const res = await fetch(`/api/opencode/preview/proxy/${port}/`, { signal: AbortSignal.timeout(1500) })
        // 502 = upstream chưa lên · 403 = port không trong allowlist — chưa sẵn sàng
        if (res.status !== 502 && res.status !== 403) {
          setPreviewWaiting(false)
          setPreviewIframeKey(prev => prev + 1)
          return true
        }
      } catch { /* chưa lên — poll tiếp */ }
    }
    setPreviewWaiting(false)
    return false
  }, [])
  const previewAutoStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Phase 3: SSE log stream for the running preview dev server
  const previewEventSrcRef = useRef<EventSource | null>(null)
  const [previewLogs, setPreviewLogs] = useState<string[]>([])

  // LSP Diagnostics (raw: fallback hiển thị khi message rỗng — khớp kiểu LSPDiagnostic từ /api/opencode/lsp/diagnostics)
  const [diagnostics, setDiagnostics] = useState<Array<{
    file?: string; line?: number; column?: number; severity?: string; code?: string; message?: string; raw?: string;
  }>>([])

  // Log modal
  const [showLogs, setShowLogs] = useState(false)
  const [serverLogs, setServerLogs] = useState<string[]>([])

  // Git Integration
  const [gitStatus, setGitStatus] = useState<{
    branch: string; lastCommit: string; modified: string[]; staged: string[]; untracked: string[];
    ahead: number; behind: number; totalChanges: number; available: boolean;
  }>({ branch: '', lastCommit: '', modified: [], staged: [], untracked: [], ahead: 0, behind: 0, totalChanges: 0, available: false })
  const [gitDiff, setGitDiff] = useState('')
  const [gitDiffStats, setGitDiffStats] = useState<{ additions: number; deletions: number; filesChanged: number }>({ additions: 0, deletions: 0, filesChanged: 0 })
  const [gitLoading, setGitLoading] = useState(false)
  const [gitSectionOpen, setGitSectionOpen] = useState(true)

  // Session Timeline
  const [selectedTimelineSession, setSelectedTimelineSession] = useState<string | null>(null)
  const [timelineData, setTimelineData] = useState<{ timeline: Array<{ timestamp: string; event: string; label: string; detail?: string }> }>({ timeline: [] })
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [timelineSectionOpen, setTimelineSectionOpen] = useState(true)

  // Knowledge Context Panel
  const [kbContext, setKbContext] = useState<{
    entities: Array<{ name: string; type: string; description: string }>;
    documents: Array<{ source: string; score: number }>;
    corrections: Array<{ content: string; createdAt: string }>;
    insights: Array<{ content: string; type: string }>;
    enrichmentScore: number;
  }>({ entities: [], documents: [], corrections: [], insights: [], enrichmentScore: 0 })
  const [kbContextLoading, setKbContextLoading] = useState(false)
  const [kbContextQuery, setKbContextQuery] = useState('')
  const [kbSectionOpen, setKbSectionOpen] = useState(true)

  // Diff Viewer toggle
  const [diffViewActive, setDiffViewActive] = useState(false)
  // Phase 9: PendingEdit review (AI edit-before-write approval queue)
  const [pendingEdits, setPendingEdits] = useState<Array<Record<string, unknown>>>([])
  const [showPendingModal, setShowPendingModal] = useState(false)
  // Phase 10: workspace-wide search panel (ripgrep-backed)
  const [showSearchPanel, setShowSearchPanel] = useState(false)

  // Local File Explorer state
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    try { return localStorage.getItem('smolab_layout_opencode_root') } catch { return null }
  })
  const [showFolderPicker, setShowFolderPicker] = useState(false)
  const [folderPickerPath, setFolderPickerPath] = useState('/home/z')
  const [folderPickerItems, setFolderPickerItems] = useState<Array<{ name: string; path: string; type: 'directory' | 'file' }>>([])
  const [folderPickerLoading, setFolderPickerLoading] = useState(false)
  // Native OS folder dialog (user request 2026-08-27 — chọn thư mục qua dialog Windows/macOS/Linux)
  const [nativeFolderLoading, setNativeFolderLoading] = useState(false)
  // Phase 8 compat: dirty-content of the ACTIVE tab (null = không có chỉnh sửa chưa lưu)
  const editedContent = activeOpenFile?.isDirty ? activeOpenFile.content : null
  const [isSaving, setIsSaving] = useState(false)
  const [showNewFileInput, setShowNewFileInput] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [showNewFolderInput, setShowNewFolderInput] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')

  // ---- Data loading ----
  // Persist workspace root to localStorage
  useEffect(() => {
    if (workspaceRoot) {
      try { localStorage.setItem('smolab_layout_opencode_root', workspaceRoot) } catch {}
    } else {
      try { localStorage.removeItem('smolab_layout_opencode_root') } catch {}
    }
  }, [workspaceRoot])

  // Phase 2: folder picker commit — set local workspace + sync to DB as ACTIVE
  // workspace (POST /api/workspace; 409 conflict → PATCH existing → active).
  const handleWorkspaceSelect = useCallback(async (folderPath: string) => {
    setWorkspaceRoot(folderPath)
    if (typeof window !== 'undefined') localStorage.setItem('smolab_layout_opencode_root', folderPath)
    setFileTree([])
    setOpenFiles([])
    setActiveFileIndex(0)
    setShowFolderPicker(false)
    // PREVIEW SESSION (user request 2026-10-15): đổi thư mục → panel preview
    // đang hiển thị app của thư mục CŨ, không còn đúng ngữ cảnh — đóng panel +
    // cắt SSE log (persist effect thấy showPreview=false sẽ tự xoá session).
    setShowPreview(false)
    setPreviewPort(null)
    setPreviewLogs([])
    try { previewEventSrcRef.current?.close() } catch { /* ignore */ }
    previewEventSrcRef.current = null
    // FILE TREE REALTIME (fix 2026-09-10): ép reload tree kể cả khi chọn lại
    // CÙNG thư mục (workspaceRoot không đổi → effect chỉ chạy nhờ token này).
    setTreeReloadToken(t => t + 1)
    toast({ title: `Đã chọn workspace: ${folderPath}` })
    try {
      const folderName = baseNameOf(folderPath) // FIX Windows: split('/') sai với backslash
      const createRes = await authedFetch('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: folderName, rootPath: folderPath }),
      })
      if (createRes.ok) {
        const created = await createRes.json()
        const id = created?.data?.id // response shape: {ok, data} — workspace lives in .data
        if (id) {
          await authedFetch('/api/workspace', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          })
        }
        toast({ title: 'Đã đăng ký workspace active trong DB' })
      } else if (createRes.status === 409) {
        const existing = await createRes.json()
        const id = existing?.data?.id
        if (id) {
          await authedFetch('/api/workspace', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
          })
        }
        toast({ title: 'Workspace đã tồn tại, đã set active' })
      } else {
        // FIX 2026-08-28: parse error từ server để hiển thị nguyên nhân thật
        // (trước đây chỉ toast generic "xem console" — khó chẩn đoán từ phía user).
        const errText = await createRes.text()
        console.error('Workspace register failed:', errText)
        let hint = 'Lỗi đăng ký workspace (xem console)'
        try {
          const parsed = JSON.parse(errText) as { error?: string }
          if (parsed?.error?.includes('TMO_API_TOKEN')) {
            hint = 'Thiếu TMO_API_TOKEN — thêm TMO_API_TOKEN=<random hex> vào .env rồi restart app'
          } else if (parsed?.error) {
            hint = `Lỗi đăng ký workspace: ${parsed.error}`
          }
        } catch { /* body không phải JSON — giữ hint mặc định */ }
        toast({ title: hint, variant: 'destructive' })
      }
    } catch (err) {
      console.error('Workspace register exception:', err)
    }
  }, [])

  // Load folder picker contents
  const loadFolderPicker = useCallback(async (path: string) => {
    setFolderPickerLoading(true)
    try {
      const res = await authedFetch(`/api/opencode/files/browse?path=${encodeURIComponent(path)}&mode=all`)
      const data = await res.json()
      if (data.items) {
        setFolderPickerPath(data.currentPath)
        setFolderPickerItems(data.items)
      }
    } catch {
      setFolderPickerItems([])
    } finally {
      setFolderPickerLoading(false)
    }
  }, [])

  // Save file handler (Phase 8: multi-tab aware — saves openFiles[idx])
  const handleSaveFile = useCallback(async (idx?: number) => {
    const targetIdx = typeof idx === 'number' ? idx : activeFileIndex
    const target = openFiles[targetIdx]
    if (!target) return
    // FIX 2026-08-29 (defense in depth): tab binary/truncated KHÔNG BAO GIỜ được
    // ghi xuống disk — content rỗng (binary) hoặc bị cắt (>2MB) sẽ PHÁ HỦY file gốc.
    // Monaco readOnly đã chặn edit nhưng chặn thêm ở tầng save cho chắc.
    if (target.isBinary) {
      toast({ title: 'Không thể lưu', description: 'File nhị phân không chỉnh sửa được qua editor', variant: 'destructive' })
      return
    }
    if (target.truncated) {
      toast({ title: 'Không thể lưu', description: 'File lớn đang ở chế độ read-only (chỉ hiển thị 2MB đầu) — lưu sẽ mất phần còn lại', variant: 'destructive' })
      return
    }
    setIsSaving(true)
    try {
      const res = await authedFetch('/api/opencode/files/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: target.path, content: target.content }),
      })
      const data = await res.json()
      if (data.success) {
        toast({ title: 'Đã lưu file', description: baseNameOf(target.path) || target.path })
        // originalContent = what was actually saved; if the user typed more
        // while the request was in flight, the tab correctly stays dirty.
        setOpenFiles(prev => prev.map((f, i) => (i === targetIdx
          ? { ...f, originalContent: target.content, isDirty: f.content !== target.content }
          : f)))
        // Metadata refresh (language/lines/size) — best-effort, same GET as handleFileSelect
        if (workspaceRoot) {
          try {
            const readRes = await authedFetch(`/api/opencode/files/read?path=${encodeURIComponent(target.path)}&root=${encodeURIComponent(workspaceRoot)}`)
            const readData = await readRes.json()
            if (readData.content !== undefined) {
              setOpenFiles(prev => prev.map((f, i) => (i === targetIdx
                ? { ...f, language: readData.language ?? f.language, lines: readData.lines ?? f.lines, size: readData.size ?? f.size }
                : f)))
            }
          } catch {}
        }
      } else {
        toast({ title: 'Lỗi lưu file', description: data.error || 'Unknown error', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi lưu file', description: 'Network error', variant: 'destructive' })
    } finally {
      setIsSaving(false)
    }
  }, [activeFileIndex, openFiles, workspaceRoot])

  // Phase 8: Monaco multi-tab handlers
  const handleContentChange = useCallback((idx: number, content: string) => {
    setOpenFiles(prev => prev.map((f, i) => (i === idx ? { ...f, content, isDirty: content !== f.originalContent } : f)))
  }, [])

  const handleCloseFile = useCallback((idx: number) => {
    if (idx < 0 || idx >= openFiles.length) return
    const nextLength = openFiles.length - 1
    setOpenFiles(prev => prev.filter((_, i) => i !== idx))
    setActiveFileIndex(cur => {
      if (cur > idx) return cur - 1
      if (cur === idx) return Math.max(Math.min(cur, nextLength - 1), 0)
      return cur
    })
  }, [openFiles])

  // Phase 8: revert active (or given) tab back to its original content
  const handleRevertFile = useCallback((idx?: number) => {
    const targetIdx = typeof idx === 'number' ? idx : activeFileIndex
    setOpenFiles(prev => prev.map((f, i) => (i === targetIdx ? { ...f, content: f.originalContent, isDirty: false } : f)))
  }, [activeFileIndex])

  const loadFileTree = useCallback(async () => {
    setTreeLoading(true)
    try {
      const url = workspaceRoot
        ? `/api/opencode/files/tree?root=${encodeURIComponent(workspaceRoot)}&depth=3`
        : '/api/opencode/files/tree?depth=3'
      const res = await authedFetch(url)
      const data = await res.json()
      setFileTree(data.tree || [])
    } catch {
      setFileTree([])
    } finally {
      setTreeLoading(false)
    }
  }, [workspaceRoot])

  // Native OS folder picker (user request 2026-08-27): mở dialog Windows/macOS/Linux
  // thật trên máy chạy server → trả về absolute path → set workspace giống tree picker.
  // Sandbox/headless không có display → fallback về tree picker trong app.
  // (Đặt SAU loadFolderPicker/loadFileTree để tránh TDZ trong deps array.)
  const handleNativeFolderPick = useCallback(async () => {
    if (nativeFolderLoading) return
    setNativeFolderLoading(true)
    try {
      const res = await authedFetch('/api/opencode/native-folder', { method: 'POST' })
      const data = await res.json()
      if (data.supported && data.path) {
        await handleWorkspaceSelect(data.path)
        loadFileTree()
      } else if (data.canceled) {
        // User đóng dialog — im lặng, không báo lỗi
      } else if (!data.supported) {
        toast({
          title: 'Dialog hệ thống không khả dụng',
          description: `${data.reason || 'Máy chủ không có giao diện đồ hoạ'} — mở trình duyệt thư mục trong app thay thế.`,
          duration: 5000,
        })
        // Fallback: mở tree picker trong app
        setFolderPickerPath(workspaceRoot || '/home/z')
        loadFolderPicker(workspaceRoot || '/home/z')
        setShowFolderPicker(true)
      }
    } catch (err) {
      console.error('[NativeFolder] Exception:', err)
      toast({ title: 'Lỗi mở dialog hệ thống', variant: 'destructive' })
    } finally {
      setNativeFolderLoading(false)
    }
  }, [nativeFolderLoading, handleWorkspaceSelect, loadFolderPicker, workspaceRoot, loadFileTree])

  // Phase 9: fetch AI edits waiting for review (before/after + approve/reject/apply lifecycle).
  // NOTE: no synchronous setState here — this is also called directly from an
  // effect (30s poll) and react-hooks/set-state-in-effect must stay quiet.
  const loadPendingEdits = useCallback(async () => {
    try {
      const res = await authedFetch('/api/openclaw/pending-edits?status=pending')
      const d = await res.json().catch(() => ({ ok: false }))
      if (d.ok) setPendingEdits(Array.isArray(d.edits) ? d.edits : [])
    } catch { /* offline — keep current list */ }
  }, [])

  // Phase 9: initial load + 30s poll. CodeTabContent only mounts while the
  // Code tab is visible, so being mounted IS the visibility gate. The initial
  // fetch goes through a 0ms timeout so no setState runs synchronously in the
  // effect body (react-hooks/set-state-in-effect stays at baseline).
  useEffect(() => {
    const initial = setTimeout(() => { void loadPendingEdits() }, 0)
    const timer = setInterval(() => { void loadPendingEdits() }, 30000)
    return () => { clearTimeout(initial); clearInterval(timer) }
  }, [loadPendingEdits])

  // Phase 10: rename/move a file or directory (prompt for the new path)
  const handleRenameFile = useCallback(async (filePath: string, name: string) => {
    if (!workspaceRoot) return
    const newPath = window.prompt('Đường dẫn mới:', filePath)
    if (!newPath || !newPath.trim() || newPath.trim() === filePath) return
    try {
      const res = await authedFetch('/api/opencode/files/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPath: filePath, newPath: newPath.trim(), root: workspaceRoot }),
      })
      const data = await res.json()
      if (data.ok) {
        toast({ title: 'Đã đổi tên', description: `${name} → ${String(newPath.split('/').pop())}` })
        // keep open tabs pointing at the new path
        const next = openFilesRef.current.map(f => (f.path === filePath ? { ...f, path: data.newPath || newPath.trim() } : f))
        setOpenFiles(next)
        loadFileTree()
      } else {
        toast({ title: 'Lỗi đổi tên', description: data.error, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi', description: 'Network error', variant: 'destructive' })
    }
  }, [workspaceRoot, loadFileTree])

  // Phase 10: delete a file or directory (confirm first; server has path-escape guard)
  const handleDeleteFile = useCallback(async (filePath: string, name: string) => {
    if (!workspaceRoot) return
    if (!window.confirm(`Xóa ${name}?`)) return
    try {
      const res = await authedFetch('/api/opencode/files/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, root: workspaceRoot }),
      })
      const data = await res.json()
      if (data.ok) {
        toast({ title: 'Đã xóa', description: name })
        const idx = openFilesRef.current.findIndex(f => f.path === filePath)
        if (idx >= 0) handleCloseFile(idx)
        loadFileTree()
      } else {
        toast({ title: 'Lỗi xóa file', description: data.error, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi', description: 'Network error', variant: 'destructive' })
    }
  }, [workspaceRoot, handleCloseFile, loadFileTree])

  // Create new file handler
  const handleCreateFile = useCallback(async () => {
    if (!newFileName.trim() || !workspaceRoot) return
    const trimmed = newFileName.trim()
    const fullPath = trimmed.startsWith('/') ? trimmed : `${workspaceRoot}/${trimmed}`
    try {
      const res = await authedFetch('/api/opencode/files/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: fullPath, content: '' }),
      })
      const data = await res.json()
      if (data.success) {
        toast({ title: 'Đã tạo file', description: newFileName })
        setNewFileName('')
        setShowNewFileInput(false)
        loadFileTree()
      } else {
        toast({ title: 'Lỗi tạo file', description: data.error, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi', description: 'Network error', variant: 'destructive' })
    }
  }, [newFileName, workspaceRoot, loadFileTree])

  // Create new folder handler
  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim() || !workspaceRoot) return
    const trimmed = newFolderName.trim()
    const fullPath = trimmed.startsWith('/') ? trimmed : `${workspaceRoot}/${trimmed}`
    try {
      const res = await authedFetch('/api/opencode/files/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: fullPath }),
      })
      const data = await res.json()
      if (data.success) {
        toast({ title: 'Đã tạo thư mục', description: newFolderName })
        setNewFolderName('')
        setShowNewFolderInput(false)
        loadFileTree()
      } else {
        toast({ title: 'Lỗi tạo thư mục', description: data.error, variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi', description: 'Network error', variant: 'destructive' })
    }
  }, [newFolderName, workspaceRoot, loadFileTree])

  const loadStatus = useCallback(async () => {
    setStatusLoading(true)
    try {
      const res = await authedFetch('/api/opencode/status')
      const data = await res.json()
      setServerOnline(data.online)
      setServerInfo(data.serverInfo)
    } catch {
      setServerOnline(false)
    } finally {
      setStatusLoading(false)
    }
  }, [])

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true)
    try {
      const res = await authedFetch('/api/opencode/sessions')
      const data = await res.json()
      setSessions(data.sessions || [])
    } catch {
      setSessions([])
    } finally {
      setSessionsLoading(false)
    }
  }, [])

  const loadMcpStatus = useCallback(async () => {
    try {
      const res = await authedFetch('/api/opencode/mcp/status')
      const data = await res.json()
      setMcpStatus(data)
    } catch {
      setMcpStatus(null)
    }
  }, [])

  const loadTerminal = useCallback(async () => {
    setTerminalLoading(true)
    try {
      const res = await authedFetch('/api/opencode/terminal')
      const data = await res.json()
      // FIX 2026-08-27: KHÔNG wipe terminal khi server không có output —
      // trước đây `setTerminalOutput([])` xóa luôn các dòng Agent Activity
      // echo (`$ [AI·Omega] ...`) do poll effect ghi vào ngay trước đó
      // (race on mount). Chỉ overwrite khi thực sự có PTY output để restore.
      if (data.output && Array.isArray(data.output) && data.output.length > 0) {
        setTerminalOutput(data.output)
      } else if (data.terminals) {
        const allLines: string[] = []
        for (const lines of Object.values(data.terminals) as string[][]) {
          allLines.push(...lines)
        }
        if (allLines.length > 0) setTerminalOutput(allLines)
      }
      // else: giữ nguyên nội dung hiện tại (AI echo lines / user lines)
    } catch {
      // offline — KHÔNG wipe (giữ AI echo lines)
    } finally {
      setTerminalLoading(false)
    }
  }, [])

  const loadDiagnostics = useCallback(async () => {
    try {
      const res = await authedFetch('/api/opencode/lsp/diagnostics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
      const data = await res.json()
      setDiagnostics(data.diagnostics || [])
    } catch {
      setDiagnostics([])
    }
  }, [])

  const loadGitStatus = useCallback(async () => {
    setGitLoading(true)
    try {
      const res = await authedFetch('/api/opencode/git/status')
      const data = await res.json()
      setGitStatus({
        branch: data.branch || '',
        lastCommit: data.lastCommit || '',
        modified: data.modified || [],
        staged: data.staged || [],
        untracked: data.untracked || [],
        ahead: data.ahead || 0,
        behind: data.behind || 0,
        totalChanges: data.totalChanges || 0,
        available: data.available !== false,
      })
    } catch {
      setGitStatus(prev => ({ ...prev, available: false }))
    } finally {
      setGitLoading(false)
    }
  }, [])

  const loadGitDiff = useCallback(async (staged: boolean = false) => {
    setGitLoading(true)
    try {
      const res = await authedFetch(`/api/opencode/git/diff?staged=${staged}`)
      const data = await res.json()
      setGitDiff(data.diff || '')
      setGitDiffStats({
        additions: data.stats?.additions || 0,
        deletions: data.stats?.deletions || 0,
        filesChanged: data.stats?.filesChanged || 0,
      })
    } catch {
      setGitDiff('Không thể tải diff')
      setGitDiffStats({ additions: 0, deletions: 0, filesChanged: 0 })
    } finally {
      setGitLoading(false)
    }
  }, [])

  const loadTimeline = useCallback(async (sessionId: string) => {
    setTimelineLoading(true)
    setSelectedTimelineSession(sessionId)
    try {
      const res = await authedFetch(`/api/opencode/sessions/${encodeURIComponent(sessionId)}/timeline`)
      const data = await res.json()
      setTimelineData({ timeline: data.timeline || [] })
    } catch {
      setTimelineData({ timeline: [] })
    } finally {
      setTimelineLoading(false)
    }
  }, [])

  const loadKbContext = useCallback(async (query?: string) => {
    setKbContextLoading(true)
    try {
      const url = query ? `/api/opencode/knowledge/enrich?query=${encodeURIComponent(query)}` : '/api/opencode/knowledge/enrich'
      const res = await authedFetch(url)
      const data = await res.json()
      // The API returns { enrichment: { entities, documents, corrections, insights, enrichmentScore } }
      const enrichment = data.enrichment || data
      setKbContext({
        entities: enrichment.entities || [],
        documents: enrichment.documents || [],
        corrections: enrichment.corrections || [],
        insights: enrichment.insights || [],
        enrichmentScore: enrichment.enrichmentScore || 0,
      })
    } catch {
      setKbContext({ entities: [], documents: [], corrections: [], insights: [], enrichmentScore: 0 })
    } finally {
      setKbContextLoading(false)
    }
  }, [])

  // Initial load + polling
  // (queueMicrotask: defer để không gọi setState đồng bộ trong body effect)
  useEffect(() => {
    queueMicrotask(() => {
      loadStatus()
      loadFileTree()
      loadSessions()
      loadMcpStatus()
      loadTerminal()
      loadDiagnostics()
      loadGitStatus()
      loadKbContext()
    })
    const interval = setInterval(() => { loadStatus() }, 30000)
    return () => clearInterval(interval)
  }, [loadStatus, loadFileTree, loadSessions, loadMcpStatus, loadTerminal, loadDiagnostics, loadGitStatus, loadKbContext])

  // 2026-08-29 — Sync active workspace TỪ DB khi localStorage trống (máy mới /
  // browser mới / cleared storage). Trước đây UI chỉ đọc localStorage → desync
  // với backend (agents dùng active workspace trong DB, UI thì rỗng).
  // KHÔNG override nếu localStorage đã có giá trị (tôn trọng lựa chọn local).
  useEffect(() => {
    const t = setTimeout(() => {
      const localRoot = (() => { try { return localStorage.getItem('smolab_layout_opencode_root') } catch { return null } })()
      if (localRoot) return // localStorage có sẵn → đã được set ở state init
      ;(async () => {
        try {
          const res = await authedFetch('/api/workspace')
          if (!res.ok) return
          const d = await res.json().catch(() => null) as { ok?: boolean; data?: { active?: { rootPath?: string } | null } } | null
          const dbRoot = d?.data?.active?.rootPath
          if (d?.ok && dbRoot) {
            setWorkspaceRoot(dbRoot)
            console.log('[Code] Restored workspace from DB active workspace:', dbRoot)
          }
        } catch { /* offline — keep empty state */ }
      })()
    }, 0)
    return () => clearTimeout(t)
  }, [])

  // ===== Agent Activity → Terminal echo (user request 2026-08-27) =====
  // Poll GET /api/agent-activity (server-side ring buffer ghi bởi executeTool)
  // mỗi 2.5s và echo lệnh shell/tool của agents vào ô Terminal. Trước đây
  // terminal echo chỉ xảy ra với SSE event (chế độ Team Code) — single-agent
  // chat (stream:false) thì Terminal trống rỗng dù agent chạy shell thật.
  // Lần mount đầu (since=0) hiện tối đa 30 entry gần nhất = lịch sử agent.
  //
  // 2026-08-31 — hiện CẢ KẾT QUẢ THẬT (resultPreview: stdout/stderr, content
  // preview...) sau lệnh — user nhận biết được kết quả thực tế chứ không phải
  // lệnh chạy giả/kết quả giả.
  const agentActivityTsRef = useRef<number>(0)
  const seenAgentActRef = useRef<Set<string>>(new Set())
  // FILE TREE REALTIME (fix 2026-09-10): loadFileTree đổi theo workspaceRoot —
  // giữ ref luôn trỏ bản mới nhất để poll effect (deps []) gọi được.
  const loadFileTreeRef = useRef(loadFileTree)
  useEffect(() => { loadFileTreeRef.current = loadFileTree }, [loadFileTree])
  // Debounce timer cho tree reload khi agents đụng file (nhiều tool calls liên
  // tiếp trong 1 task → chỉ reload 1 lần sau khi agents ngừng đụng file 1.5s).
  const treeReloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const FILE_MUTATING_TOOLS = new Set([
    'shell', 'run_bg', 'opencode', 'file_edit', 'file_multi_edit', 'file_write', 'file_delete',
    'git_commit', 'git_push', 'git_pull', 'run_tests',
  ])
  useEffect(() => {
    return () => { if (treeReloadTimerRef.current) clearTimeout(treeReloadTimerRef.current) }
  }, [])
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      if (document.hidden) return
      try {
        const res = await authedFetch(`/api/agent-activity?since=${agentActivityTsRef.current}&limit=30`)
        if (!res.ok || cancelled) return
        const d = await res.json().catch(() => null) as {
          ok?: boolean
          entries?: Array<{ id: string; ts: number; agentName?: string; tool: string; detail?: string; success?: boolean; durationMs?: number; resultPreview?: string }>
        } | null
        if (!d?.ok || !Array.isArray(d.entries) || d.entries.length === 0 || cancelled) return

        const lines: string[] = []
        let maxTs = agentActivityTsRef.current
        for (const e of d.entries) {
          if (!e || typeof e.id !== 'string' || seenAgentActRef.current.has(e.id)) continue
          seenAgentActRef.current.add(e.id)
          if (typeof e.ts === 'number' && e.ts > maxTs) maxTs = e.ts
          if (seenAgentActRef.current.size > 500) {
            // Giữ Set nhỏ — xóa nửa cũ
            seenAgentActRef.current = new Set(Array.from(seenAgentActRef.current).slice(-250))
          }
          const who = e.agentName ? `AI·${e.agentName}` : 'AI'
          const dur = typeof e.durationMs === 'number'
            ? (e.durationMs >= 1000 ? `${(e.durationMs / 1000).toFixed(1)}s` : `${e.durationMs}ms`)
            : ''
          const cmd = String(e.detail || '').replace(/\s+/g, ' ').trim()
          // Kết quả thật — tối đa 6 dòng / 400 ký tự, prefix ⎿ (kiểu Claude Code)
          const resultLines = String(e.resultPreview || '').split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.length > 0).slice(0, 6)
          const resultBlock = resultLines.length > 0
            ? resultLines.map(l => `⎿ ${l.slice(0, 200)}`).join('\n').slice(0, 400).split('\n')
            : [] as string[]
          if (e.tool === 'shell' || e.tool === 'run_bg') {
            lines.push(`$ [${who}] ${cmd.slice(0, 160)}`)
            lines.push(e.success
              ? `✓ [${who}] xong${dur ? ` · ${dur}` : ''}`
              : `✗ [${who}] LỖI${dur ? ` · ${dur}` : ''}`)
            lines.push(...resultBlock)
          } else if (e.tool === 'opencode' && /bash|exec/i.test(cmd)) {
            lines.push(`$ [${who}] ${cmd.slice(0, 160)}`)
            lines.push(e.success ? `✓ [${who}] xong${dur ? ` · ${dur}` : ''}` : `✗ [${who}] LỖI${dur ? ` · ${dur}` : ''}`)
            lines.push(...resultBlock)
          } else if (e.tool === 'read_output' || e.tool === 'kill_process' || e.tool === 'run_tests' || e.tool === 'git_commit') {
            const icon = e.tool === 'run_tests' ? '🧪' : e.tool === 'git_commit' ? '📦' : e.tool === 'kill_process' ? '⛔' : '📄'
            lines.push(`[AI] ${icon} ${e.tool} ${cmd.slice(0, 110)}`.trim())
            lines.push(...resultBlock)
          } else if (e.tool === 'file_edit' || e.tool === 'file_multi_edit' || e.tool === 'file_delete' || e.tool === 'file_write') {
            const icon = e.tool === 'file_delete' ? '🗑️' : e.tool === 'file_write' ? '📝' : '✏️'
            lines.push(`[AI] ${icon} ${e.tool === 'file_multi_edit' ? 'file_multi_edit' : e.tool} ${cmd.slice(0, 110)}`)
            lines.push(...resultBlock)
          }
        }
        agentActivityTsRef.current = maxTs
        // FILE TREE REALTIME (fix 2026-09-10): agents vừa đụng file (shell
        // rm/mv/touch, file_edit, file_delete, git...) → debounce reload tree
        // sau 1.5s — File Explorer phản ánh cấu trúc filesystem MỚI NHẤT mà
        // không cần user bấm refresh hay chọn lại thư mục.
        const hasFileMutation = d.entries.some(e => e && typeof e.tool === 'string' && FILE_MUTATING_TOOLS.has(e.tool))
        if (hasFileMutation) {
          if (treeReloadTimerRef.current) clearTimeout(treeReloadTimerRef.current)
          treeReloadTimerRef.current = setTimeout(() => {
            treeReloadTimerRef.current = null
            try { loadFileTreeRef.current() } catch { /* offline — bỏ qua */ }
          }, 1500)
        }
        if (lines.length > 0) {
          setTerminalOutput(prev => {
            const next = [...prev, ...lines]
            return next.length > 600 ? next.slice(-600) : next
          })
          try { terminalViewRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }) } catch { /* ignore */ }
        }
      } catch { /* offline — retry ở interval sau */ }
    }
    poll()
    const interval = setInterval(poll, 2500)
    const onVisible = () => { if (!document.hidden) poll() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // Reload file tree when workspace root changes
  // (queueMicrotask: defer để không gọi setState đồng bộ trong body effect)
  // FILE TREE REALTIME (fix 2026-09-10): thêm treeReloadToken vào deps — chọn
  // lại CÙNG thư mục giờ cũng reload (trước đây workspaceRoot không đổi →
  // effect không chạy → tree đã bị setFileTree([]) xóa sạch mà không load lại).
  useEffect(() => {
    if (workspaceRoot) {
      queueMicrotask(() => { loadFileTree() })
    }
  }, [workspaceRoot, loadFileTree, treeReloadToken])

  // File Explorer drag-to-resize handlers
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!fileExplorerDragRef.current) return
      const delta = e.clientY - fileExplorerDragRef.current.startY
      const newH = Math.max(200, Math.min(900, fileExplorerDragRef.current.startH + delta))
      setFileExplorerHeight(newH)
    }
    const handleMouseUp = () => {
      fileExplorerDragRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  // Terminal drag-to-resize handlers
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!terminalDragRef.current) return
      const delta = e.clientY - terminalDragRef.current.startY
      const newH = Math.max(120, Math.min(900, terminalDragRef.current.startH + delta))
      setTerminalHeight(newH)
    }
    const handleMouseUp = () => {
      terminalDragRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  // ---- Handlers ----
  const handleServerAction = useCallback(async (action: 'restart' | 'stop' | 'start') => {
    setServerActionLoading(true)
    try {
      const res = await authedFetch('/api/opencode/server', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const data = await res.json()
      toast({ title: action === 'restart' ? 'Đang khởi động lại...' : action === 'stop' ? 'Đang dừng server...' : 'Đang khởi động...', description: data.message })
      setTimeout(() => { loadStatus() }, 2000)
    } catch {
      toast({ title: 'Lỗi', description: `Không thể ${action} server`, variant: 'destructive' })
    } finally {
      setServerActionLoading(false)
    }
  }, [loadStatus])

  const handleViewLogs = useCallback(async () => {
    try {
      // Try fetching server logs from the dedicated logs endpoint
      const res = await authedFetch('/api/opencode/terminal')
      const data = await res.json()
      const logs: string[] = []
      // Collect server output lines
      if (data.output && Array.isArray(data.output)) {
        logs.push(...data.output)
      } else if (data.terminals) {
        for (const lines of Object.values(data.terminals) as string[][]) {
          logs.push(...lines)
        }
      }
      // Also try to get server process logs
      try {
        const statusRes = await authedFetch('/api/opencode/status')
        const statusData = await statusRes.json()
        if (statusData.online) {
          logs.push(`[${new Date().toISOString()}] Server Status: Online`)
          if (statusData.serverInfo) {
            logs.push(`  Version: ${statusData.serverInfo.version}`)
            logs.push(`  Uptime: ${statusData.serverInfo.uptime}`)
            logs.push(`  Sessions: ${statusData.serverInfo.sessions?.active || 0} active`)
            logs.push(`  Tools: ${statusData.serverInfo.tools?.count || 0} available`)
            logs.push(`  MCP: ${statusData.serverInfo.mcp?.connected || 0} servers`)
          }
        } else {
          logs.push(`[${new Date().toISOString()}] Server Status: Offline`)
        }
      } catch {}
      setServerLogs(logs.length > 0 ? logs : ['No logs available — server may be offline'])
      setShowLogs(true)
    } catch {
      setServerLogs(['Error fetching logs'])
      setShowLogs(true)
    }
  }, [])

  const handleFileSelect = useCallback(async (path: string, opts?: { refresh?: boolean }) => {
    // Phase 8: multi-tab aware. Name + signature preserved (Phase 7 AI-tool
    // bridge + file tree click depend on it).
    // Phase 7: opts.refresh — force a fresh fetch (the AI edited the file on
    // disk; bust any cache so the editor shows the new content).
    const loadDiagnostics = async () => {
      try {
        const diagRes = await authedFetch('/api/opencode/lsp/diagnostics', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: path }),
        })
        const diagData = await diagRes.json()
        setDiagnostics(diagData.diagnostics || [])
      } catch {}
    }
    const existingIdx = openFilesRef.current.findIndex(f => f.path === path)
    if (existingIdx >= 0) {
      setActiveFileIndex(existingIdx)
      if (!opts?.refresh) {
        // Tab already open — just activate it + reload diagnostics
        await loadDiagnostics()
        return
      }
    }
    setFileLoading(true)
    try {
      const baseUrl = workspaceRoot
        ? `/api/opencode/files/read?path=${encodeURIComponent(path)}&root=${encodeURIComponent(workspaceRoot)}`
        : `/api/opencode/files/read?path=${encodeURIComponent(path)}`
      const url = opts?.refresh ? `${baseUrl}&_=${Date.now()}` : baseUrl
      const res = await authedFetch(url)
      const data = await res.json()
      if (data.content !== undefined) {
        const entry: OpenFile = {
          path,
          content: data.content,
          originalContent: data.content,
          isDirty: false,
          language: data.language,
          lines: data.lines,
          size: data.size,
          // FIX 2026-08-29: binary (VD qdrant.exe) → placeholder + hex preview;
          // text >2MB → truncated read-only tab. Trước đây 2 trường hợp này là
          // toast lỗi đỏ (413 File too large) — symptom user báo trên Windows.
          isBinary: data.isBinary || undefined,
          hexPreview: data.hexPreview,
          truncated: data.truncated || undefined,
          totalSize: data.totalSize,
        }
        if (existingIdx >= 0) {
          // refresh: replace content in the existing tab
          setOpenFiles(prev => prev.map((f, i) => (i === existingIdx ? entry : f)))
        } else {
          // new file: append tab + activate (ref is pre-append → its length IS the new index)
          setOpenFiles(prev => [...prev, entry])
          setActiveFileIndex(Math.max(openFilesRef.current.length, 0))
        }
        // Load diagnostics for this file (binary file không cần LSP)
        if (!data.isBinary) {
          await loadDiagnostics()
        }
      } else {
        // FIX 2026-08-28: read fail (404/413/...) — trước đây im lặng hoàn toàn,
        // user bấm file không thấy gì (không editor, không lỗi). Giờ hiện toast
        // với error từ server để chẩn đoán được (VD Windows path bug, file >1MB...).
        console.error('[FileSelect] read failed:', path, data)
        toast({
          title: 'Không đọc được file',
          description: `${data?.error || `HTTP ${res.status}`} — ${path.split(/[\\/]/).pop()}`,
          variant: 'destructive',
        })
      }
    } catch (err) {
      // FIX 2026-08-28: network/parse exception cũng hiện lỗi (trước đây swallow)
      console.error('[FileSelect] exception:', err)
      toast({ title: 'Lỗi tải file', description: String(err instanceof Error ? err.message : err), variant: 'destructive' })
    } finally {
      setFileLoading(false)
    }
  }, [workspaceRoot])

  const handleCreateSession = useCallback(async () => {
    if (!newSessionPrompt.trim()) return
    setCreatingSession(true)
    try {
      const res = await authedFetch('/api/opencode/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: newSessionPrompt, model: newSessionModel }),
      })
      const data = await res.json()
      if (data.session) {
        toast({ title: 'Session created', description: `Session ${data.session.sessionId?.substring(0, 8)}...` })
        setNewSessionPrompt('')
        loadSessions()
      } else {
        toast({ title: 'Lỗi', description: data.error || 'Failed to create session', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi', description: 'Failed to create session', variant: 'destructive' })
    } finally {
      setCreatingSession(false)
    }
  }, [newSessionPrompt, newSessionModel, loadSessions])

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    try {
      await authedFetch(`/api/opencode/sessions?sessionId=${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
      toast({ title: 'Session deleted' })
      loadSessions()
    } catch {
      toast({ title: 'Lỗi', description: 'Failed to delete session', variant: 'destructive' })
    }
  }, [loadSessions])

  const handlePauseSession = useCallback(async (sessionId: string) => {
    try {
      await authedFetch('/api/opencode/sessions/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      toast({ title: 'Session paused' })
      loadSessions()
    } catch {
      toast({ title: 'Lỗi', description: 'Failed to pause session', variant: 'destructive' })
    }
  }, [loadSessions])

  const handleResumeSession = useCallback(async (sessionId: string) => {
    try {
      await authedFetch('/api/opencode/sessions/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      toast({ title: 'Session resumed' })
      loadSessions()
    } catch {
      toast({ title: 'Lỗi', description: 'Failed to resume session', variant: 'destructive' })
    }
  }, [loadSessions])

  // Phase 4: append a raw SSE chunk as complete lines (partial line stays buffered)
  const appendTerminalChunk = useCallback((chunk: string) => {
    const clean = chunk.replace(/\r/g, '')
    terminalBufferRef.current += clean
    const lines = terminalBufferRef.current.split('\n')
    terminalBufferRef.current = lines.pop() ?? ''
    if (lines.length > 0) {
      setTerminalOutput(prev => [...prev, ...lines].slice(-500))
    }
  }, [])

  // Phase 4: handle one SSE frame from the terminal stream
  const handleTerminalFrame = useCallback((parsed: { type?: string; data?: string; code?: number | null } | null) => {
    if (!parsed) return
    if (parsed.type === 'init') {
      // Replay: replace the panel with the server-side cumulative output
      terminalBufferRef.current = ''
      setTerminalOutput([])
      if (parsed.data) appendTerminalChunk(String(parsed.data))
    } else if (parsed.type === 'chunk' && parsed.data) {
      appendTerminalChunk(String(parsed.data))
    } else if (parsed.type === 'exit') {
      // Shell died — close SSE + clear ref so the next command spawns a fresh shell
      try { terminalEvtRef.current?.close() } catch { /* ignore */ }
      terminalEvtRef.current = null
      terminalSessionIdRef.current = null
      const rest = terminalBufferRef.current
      terminalBufferRef.current = ''
      setTerminalOutput(prev => [...prev, ...(rest ? [rest] : []), `[exit ${parsed.code ?? 'null'}]`].slice(-500))
    }
  }, [appendTerminalChunk])

  // Phase 4: lazily create the persistent shell session + open its SSE stream.
  // Waits for the FIRST init frame (≤2s) before returning so the local `$ cmd`
  // echo isn't immediately wiped by the init replay.
  const ensureTerminalSession = useCallback(async (): Promise<string | null> => {
    if (terminalSessionIdRef.current) return terminalSessionIdRef.current
    try {
      const res = await authedFetch('/api/opencode/terminal/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: workspaceRoot || undefined }),
      })
      const data = await res.json()
      if (!res.ok || !data?.sessionId) throw new Error(data?.error || 'start failed')
      const sid: string = data.sessionId
      terminalSessionIdRef.current = sid

      // Open the SSE stream; resolve once the init frame lands (or 2s timeout)
      await new Promise<void>(resolve => {
        let settled = false
        const finish = (): void => { if (!settled) { settled = true; resolve() } }
        const timer = setTimeout(finish, 2000)
        try {
          // EventSource cannot set headers — auth relies on the HttpOnly
          // tmo_api_token cookie set by /api/auth/setup on mount.
          const es = new EventSource(`/api/opencode/terminal/stream?sessionId=${encodeURIComponent(sid)}`)
          terminalEvtRef.current = es
          es.onmessage = (ev: MessageEvent<string>) => {
            let parsed: { type?: string; data?: string; code?: number | null } | null = null
            try { parsed = JSON.parse(ev.data) } catch { return }
            if (!settled && parsed?.type === 'init') {
              clearTimeout(timer)
              finish()
            }
            handleTerminalFrame(parsed)
          }
          es.onerror = () => {
            // auto-reconnect handles transient drops; just stop waiting
            clearTimeout(timer)
            finish()
          }
        } catch {
          clearTimeout(timer)
          finish()
        }
      })
      return sid
    } catch (err) {
      console.error('Terminal session start failed:', err)
      terminalSessionIdRef.current = null
      return null
    }
  }, [workspaceRoot, handleTerminalFrame])

  // Phase 4: workspace changed — tear down the terminal session (SSE + shell)
  // so the next command spawns a fresh shell in the NEW cwd.
  useEffect(() => {
    const prevRoot = terminalPrevRootRef.current
    terminalPrevRootRef.current = workspaceRoot
    if (prevRoot === workspaceRoot) return
    const oldSid = terminalSessionIdRef.current
    if (!oldSid) return
    terminalSessionIdRef.current = null
    try { terminalEvtRef.current?.close() } catch { /* ignore */ }
    terminalEvtRef.current = null
    void authedFetch('/api/opencode/terminal/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: oldSid }),
    }).catch(() => { /* best-effort */ })
  }, [workspaceRoot])

  // Phase 4: unmount — stop listening (server session reaped by idle cleanup)
  useEffect(() => {
    return () => {
      try { terminalEvtRef.current?.close() } catch { /* ignore */ }
      terminalEvtRef.current = null
    }
  }, [])

  // Phase 4: kill the shell session now; it is lazily re-created on next command
  const handleTerminalRestart = useCallback(() => {
    const oldSid = terminalSessionIdRef.current
    terminalSessionIdRef.current = null
    try { terminalEvtRef.current?.close() } catch { /* ignore */ }
    terminalEvtRef.current = null
    if (oldSid) {
      void authedFetch('/api/opencode/terminal/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: oldSid }),
      }).catch(() => { /* best-effort */ })
    }
    setTerminalOutput(prev => [...prev, '[terminal restarted]'])
    toast({ title: 'Terminal đã dừng', description: 'Shell mới sẽ khởi động ở lệnh kế tiếp' })
  }, [])

  const handleExecuteCommand = useCallback(async () => {
    if (!terminalCommand.trim()) return
    setTerminalRunning(true)
    const cmd = terminalCommand
    setTerminalCommand('')
    // Phase 4: persistent shell — cwd/env/background jobs survive between commands
    const sid = await ensureTerminalSession()
    setTerminalOutput(prev => [...prev, `$ ${cmd}`])
    // BUG FIX 2026-09-06 (user report: "nhập lệnh mà không thấy chạy lệnh gì
    // hết"): path persistent-shell thành công trước đây `return` NGAY mà
    // KHÔNG reset terminalRunning → ô nhập + nút Run bị disable VĨNH VIỄN sau
    // lệnh đầu tiên. Giờ bọc toàn bộ trong try/finally — output vẫn stream qua
    // SSE bất đồng bộ, input mở lại ngay sau khi lệnh được đẩy vào shell.
    try {
      if (sid) {
        try {
          const res = await authedFetch('/api/opencode/terminal/input', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sid, data: `${cmd}\n` }),
          })
          if (res.ok) {
            const data = await res.json()
            if (data?.ok) {
              return // output streams in via SSE (terminalEvtRef)
            }
          }
        } catch { /* fall through to legacy one-shot execute */ }
      }
      // Legacy fallback: one-shot /api/opencode/execute
      try {
        const res = await authedFetch('/api/opencode/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: cmd, cwd: workspaceRoot || undefined }),
        })
        const data = await res.json()
        if (data.output) {
          setTerminalOutput(prev => [...prev, ...data.output.split('\n')])
        }
        if (data.error && !data.success) {
          setTerminalOutput(prev => [...prev, `Error (exit ${data.exitCode ?? 1}): ${data.error}`])
        }
        if (data.source === 'local-exec') {
          // Show source indicator for local execution
          setTerminalOutput(prev => prev.length > 0 && prev[prev.length - 1] !== '' ? prev : [...prev, `[local-exec]`])
        }
      } catch {
        setTerminalOutput(prev => [...prev, 'Error: Failed to execute command'])
      }
    } finally {
      setTerminalRunning(false)
    }
  }, [terminalCommand, workspaceRoot, ensureTerminalSession])

  // Phase 3: subscribe to the dev-server log SSE stream for a workspace root
  const startPreviewLogStream = useCallback((root: string) => {
    try { previewEventSrcRef.current?.close() } catch { /* ignore */ }
    previewEventSrcRef.current = null
    setPreviewLogs([])
    try {
      // EventSource cannot set headers — auth relies on the HttpOnly
      // tmo_api_token cookie set by /api/auth/setup on mount.
      const es = new EventSource(`/api/opencode/preview/stream?root=${encodeURIComponent(root)}`)
      previewEventSrcRef.current = es
      es.onmessage = (ev: MessageEvent<string>) => {
        try {
          const parsed = JSON.parse(ev.data) as { type?: string; data?: string }
          if (parsed?.type === 'init') {
            const lines = String(parsed.data || '').split('\n').filter(Boolean)
            setPreviewLogs(lines)
          } else if (parsed?.type === 'chunk' && parsed.data) {
            const lines = String(parsed.data).split('\n').filter(Boolean)
            if (lines.length > 0) setPreviewLogs(prev => [...prev, ...lines].slice(-200))
          }
        } catch { /* malformed frame — ignore */ }
      }
    } catch (err) {
      console.error('Preview log stream error:', err)
    }
  }, [])

  // Close the preview SSE stream when the tab unmounts
  useEffect(() => {
    return () => {
      try { previewEventSrcRef.current?.close() } catch { /* ignore */ }
      previewEventSrcRef.current = null
    }
  }, [])

  // ===== PREVIEW SESSION RESTORE (user request 2026-10-15) =====
  // Rời tab Code / module Smolab rồi quay lại → panel Preview tự khôi phục.
  // Chạy đúng 1 LẦN mỗi lần CodeTabContent mount (guard ref). Không dùng
  // cleanup/cancel: async có thể hoàn thành sau unmount — setState trên component
  // đã unmount là no-op vô hại (React 18), instance mới mount lại sẽ tự restore
  // bằng guard ref của chính nó.
  // Thứ tự xác minh dev server còn sống:
  //   (a) GET /api/opencode/preview/start?root= — registry (globalThis) trả port
  //       của root này (nhanh, không scan) khi TMO còn nguyên process.
  //   (b) Fallback GET /api/opencode/preview/detect?root= — quét port phổ biến
  //       theo framework + RE-ALLOW port vào proxy allowlist (tự chữa sau khi
  //       TMO restart: allowlist in-memory bị sạch nhưng dev server detached
  //       vẫn chạy).
  //   (c) Cả hai fail → dev server thật sự đã tắt → xoá session (không dựng
  //       panel chết).
  const previewRestoreAttemptedRef = useRef(false)
  useEffect(() => {
    if (previewRestoreAttemptedRef.current) return
    previewRestoreAttemptedRef.current = true
    const restore = async () => {
      let session: PreviewSession | null = null
      try {
        const raw = localStorage.getItem(PREVIEW_SESSION_KEY)
        if (raw) session = JSON.parse(raw) as PreviewSession
      } catch { return }
      if (!session || !session.root || !Number.isInteger(session.port) || session.port <= 0) return
      // Thư mục đang chọn phải khớp session (workspaceRoot khởi tạo sync từ
      // localStorage 'smolab_layout_opencode_root'). Đổi thư mục → handleWorkspace-
      // Select đã đóng panel + xoá session → không khôi phục.
      if (!workspaceRoot || workspaceRoot !== session.root) return
      setPreviewDetecting(true) // spinner "Đang tìm dev server..." trong lúc xác minh
      try {
        let port: number | null = null
        let fw: string | null | undefined
        let fwIcon: string | undefined
        let devCmd: string | null | undefined
        // (a) registry — nhanh, không scan
        try {
          const regRes = await authedFetch(`/api/opencode/preview/start?root=${encodeURIComponent(session.root)}`)
          if (regRes.ok) {
            const regData = await regRes.json().catch(() => null)
            if (regData?.running && typeof regData?.port === 'number' && regData.port > 0) {
              port = regData.port
            }
          }
        } catch { /* ignore */ }
        // (b) detect scan — re-allow port cho proxy (tự chữa sau restart TMO)
        if (!port) {
          try {
            const detRes = await authedFetch(`/api/opencode/preview/detect?root=${encodeURIComponent(session.root)}`)
            if (detRes.ok) {
              const detData = await detRes.json().catch(() => null)
              if (detData) {
                fw = detData.framework
                fwIcon = detData.frameworkIcon
                devCmd = detData.devCommand
                if (typeof detData.detectedPort === 'number' && detData.detectedPort > 0) {
                  port = detData.detectedPort
                }
              }
            }
          } catch { /* ignore */ }
        }
        if (!port) {
          // (c) dev server đã tắt thật — dọn session, user bấm Preview lại
          try { localStorage.removeItem(PREVIEW_SESSION_KEY) } catch { /* ignore */ }
          return
        }
        setShowPreview(true)
        setPreviewAutoStartAttempted(true)
        setPreviewFramework(fw ?? session.framework ?? null)
        setPreviewFrameworkIcon(fwIcon || session.frameworkIcon || '📦')
        setPreviewDevCommand(devCmd ?? session.devCommand ?? null)
        setPreviewLogs([])
        setPreviewPort(port)
        startPreviewLogStream(session.root)
        // Port-ready poll qua proxy → remount iframe khi server nhận connection
        // (dev server đã chạy thì poll xong gần như ngay lập tức)
        void waitForPreviewReady(port)
        toast({ title: '🔄 Đã khôi phục preview', description: `Port ${port} — ${baseNameOf(session.root) || session.root}` })
      } finally {
        setPreviewDetecting(false)
      }
    }
    void restore()
    // Deps: workspaceRoot chỉ cần GIÁ TRỊ LÚC MOUNT (khởi tạo sync từ localStorage);
    // guard ref đảm bảo chỉ chạy lần đầu — các lần deps đổi sau đó là no-op.
  }, [workspaceRoot, startPreviewLogStream, waitForPreviewReady])

  // ===== PREVIEW SESSION PERSIST (user request 2026-10-15) =====
  // Preview đang chạy thật (showPreview + port + root) → lưu session; tắt
  // preview (nút Preview lần 2 / AI stop_preview / đổi thư mục) → xoá session.
  // Skip lần chạy ĐẦU (mount): showPreview=false ban đầu — không được phép
  // xoá session khi restore effect sắp đọc nó (khai báo restore TRƯỚC persist
  // cũng là 1 lớp bảo vệ — effect chạy theo thứ tự khai báo).
  const previewPersistInitRef = useRef(false)
  useEffect(() => {
    try {
      if (showPreview && previewPort && workspaceRoot) {
        const session: PreviewSession = {
          root: workspaceRoot,
          port: previewPort,
          framework: previewFramework,
          frameworkIcon: previewFrameworkIcon || '📦',
          devCommand: previewDevCommand,
          savedAt: Date.now(),
        }
        localStorage.setItem(PREVIEW_SESSION_KEY, JSON.stringify(session))
      } else if (previewPersistInitRef.current && !showPreview) {
        localStorage.removeItem(PREVIEW_SESSION_KEY)
      }
    } catch { /* ignore */ }
    previewPersistInitRef.current = true
  }, [showPreview, previewPort, workspaceRoot, previewFramework, previewFrameworkIcon, previewDevCommand])

  // Smart Preview: detect framework, find port, auto-start dev server, auto-refresh
  const handlePreviewToggle = useCallback(async () => {
    if (showPreview) {
      // OFF — tear everything down (SSE, logs, detached dev-server process)
      setShowPreview(false)
      setPreviewPort(null)
      // Clean up auto-start timer
      if (previewAutoStartTimerRef.current) {
        clearTimeout(previewAutoStartTimerRef.current)
        previewAutoStartTimerRef.current = null
      }
      // Close SSE log stream + clear captured logs
      try { previewEventSrcRef.current?.close() } catch { /* ignore */ }
      previewEventSrcRef.current = null
      setPreviewLogs([])
      // Kill the detached dev-server process group for this workspace
      if (workspaceRoot) {
        try {
          await authedFetch('/api/opencode/preview/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ root: workspaceRoot }),
          })
        } catch (err) {
          console.error('Preview stop failed:', err)
        }
      }
      return
    }
    setShowPreview(true)
    setPreviewAutoStartAttempted(false)
    setPreviewAutoStarting(false)
    if (!workspaceRoot) return
    setPreviewDetecting(true)
    setPreviewPort(null)
    setPreviewFramework(null)
    setPreviewFrameworkIcon('📦')
    setPreviewDevCommand(null)
    setPreviewLogs([])

    try {
      // Step 1: Smart detect — framework, configured port, running ports
      const detectRes = await authedFetch(`/api/opencode/preview/detect?root=${encodeURIComponent(workspaceRoot)}`)
      if (detectRes.ok) {
        const detectData = await detectRes.json()

        // Update framework info
        if (detectData.framework) {
          setPreviewFramework(detectData.framework)
          setPreviewFrameworkIcon(detectData.frameworkIcon || '📦')
        }
        if (detectData.devCommand) {
          setPreviewDevCommand(detectData.devCommand)
        }

        // Step 2: If port already detected, use it immediately
        if (detectData.detectedPort) {
          setPreviewPort(detectData.detectedPort)
          startPreviewLogStream(workspaceRoot)
          setPreviewDetecting(false)
          return
        }

        // Step 3: Auto-start dev server if we have a dev command
        if (detectData.devCommand && !detectData.detectedPort) {
          setPreviewAutoStarting(true)
          setPreviewAutoStartAttempted(true)

          try {
            const startRes = await authedFetch('/api/opencode/preview/start', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                root: workspaceRoot,
                script: detectData.devScript || 'dev',
              }),
            })

            if (startRes.ok) {
              const startData = await startRes.json()
              const startedPort: number | null = startData?.port ?? null

              if (startedPort) {
                // Phase 3: start route picked a free port (>= 3005) for us
                setPreviewPort(startedPort)
                // Tail the dev-server log via SSE
                startPreviewLogStream(workspaceRoot)
                // Port-ready poll QUA PROXY (server-side check): remount iframe
                // khi dev server thật sự nhận connection — không còn timing-race
                // (trước đây poll 127.0.0.1 phía browser + chỉ 12s → app start
                // chậm là iframe kẹt trang lỗi vĩnh viễn).
                void waitForPreviewReady(startedPort)
              } else if (startData.status === 'started' || startData.status === 'already_running') {
                // Legacy path (no port reported) — poll for port with retries
                const maxRetries = 15
                const retryDelay = 2000 // 2s between retries
                let found = false

                for (let i = 0; i < maxRetries; i++) {
                  await new Promise(r => setTimeout(r, retryDelay))
                  // Re-detect to find the newly started port
                  const reDetectRes = await authedFetch(`/api/opencode/preview/detect?root=${encodeURIComponent(workspaceRoot)}`)
                  if (reDetectRes.ok) {
                    const reDetectData = await reDetectRes.json()
                    if (reDetectData.detectedPort) {
                      setPreviewPort(reDetectData.detectedPort)
                      found = true
                      break
                    }
                  }
                }

                if (!found) {
                  // Server started but port not detected yet
                  // Show a helpful message with retry
                }
              }
            }
          } catch {
            // Auto-start failed
          } finally {
            setPreviewAutoStarting(false)
          }
        }
      }
    } catch {
      // Detection failed — fallback: try basic port scan
      // Phase 3: skip TMO's own reserved ports 3000-3004 (self-collision)
      const ports = [3005, 3006, 3007, 3008, 5173, 5174, 8080, 4000, 4200, 8000, 4173]
      for (const port of ports) {
        try {
          const checkRes = await fetch(`http://127.0.0.1:${port}`, { method: 'HEAD', signal: AbortSignal.timeout(1500) })
          if (checkRes.ok) {
            setPreviewPort(port)
            break
          }
        } catch { continue }
      }
    } finally {
      setPreviewDetecting(false)
    }
  }, [showPreview, workspaceRoot, startPreviewLogStream, waitForPreviewReady])

  // ==================== PHASE 7: AI-DRIVEN PREVIEW + TOOL EVENT HANDLING ====================

  /** openAiPreview — mirror of the handlePreviewToggle ON branch, but the AI
   *  already started the dev server (start_preview tool) on a KNOWN port, so
   *  we skip detect/auto-start and wire the panel directly: SSE log stream +
   *  port-ready poll (remount iframe once the server accepts connections). */
  const openAiPreview = useCallback((port: number, root?: string) => {
    if (!port || port <= 0) return
    const previewRoot = (typeof root === 'string' && root) || workspaceRoot || ''
    setShowPreview(true)
    setPreviewDetecting(false)
    setPreviewAutoStarting(false)
    setPreviewAutoStartAttempted(true)
    setPreviewPort(port)
    setPreviewLogs([])
    // Tail the dev-server log (closes any previous stream first)
    if (previewRoot) startPreviewLogStream(previewRoot)
    // Port-ready poll QUA PROXY (same as handlePreviewToggle — 45s, server-side check)
    void waitForPreviewReady(port)
    toast({ title: '🚀 AI đã start preview', description: `Port ${port}` })
  }, [workspaceRoot, startPreviewLogStream, waitForPreviewReady])

  /** handleAIToolEvent — react to AI tool calls streamed from the code-team
   *  workflow (via the 'tmo-ai-tool-event' window CustomEvent dispatched by
   *  the chat submit handler's SSE reader):
   *    tool_call  file_read/file_edit*    → open the file in the editor + toast
   *    tool_call  shell / opencode(bash)  → echo `$ [AI] cmd` in the Terminal
   *    tool_result file_edit* (OK)        → refresh tree + reload file + toast ✅
   *    tool_result file_delete (OK)       → refresh tree + toast 🗑️
   *    tool_result start_preview (OK)     → openAiPreview(port, root)
   *    tool_result stop_preview  (OK)     → tear the preview panel down
   *  Fully defensive — any parsing failure is swallowed (never break the UI). */
  const handleAIToolEvent = useCallback((ev: {type?: string; tool?: string; detail?: string; result?: string}) => {
    try {
      if (!ev || (ev.type !== 'tool_call' && ev.type !== 'tool_result')) return
      const tool = typeof ev.tool === 'string' ? ev.tool : ''
      if (!tool) return
      let detail: Record<string, unknown> | null = null
      try { detail = ev.detail ? JSON.parse(ev.detail) : null } catch { /* truncated */ }
      const rawDetail = typeof ev.detail === 'string' ? ev.detail : ''
      const argPath = typeof detail?.path === 'string' ? detail.path
        : typeof detail?.filePath === 'string' ? detail.filePath
        : typeof detail?.file_path === 'string' ? detail.file_path : null
      const deletedPath = typeof detail?.deleted === 'string' ? detail.deleted : null
      const pathFromDetail = argPath || deletedPath || extractJsonStringField(rawDetail, 'path') || extractJsonStringField(rawDetail, 'deleted')
      const resolveAbs = (p?: string | null): string | null => {
        if (typeof p !== 'string' || !p) return null
        if (p.startsWith('/')) return p
        return workspaceRoot ? `${workspaceRoot.replace(/\/+$/, '')}/${p}` : p
      }
      const absPath = resolveAbs(pathFromDetail)
      const fileName = pathFileName(absPath || pathFromDetail)
      if (ev.type === 'tool_call') {
        switch (tool) {
          case 'file_read': if (absPath) { void handleFileSelect(absPath); toast({ title: `📖 AI đang đọc ${fileName}` }) } break
          case 'file_edit': case 'file_multi_edit': if (absPath) { void handleFileSelect(absPath); toast({ title: `✏️ AI đang sửa ${fileName}` }) } break
          case 'shell': {
            const cmd = (typeof detail?.command === 'string' ? detail.command : null) || extractJsonStringField(rawDetail, 'command') || rawDetail
            setTerminalOutput(prev => [...prev, `$ [AI] ${String(cmd).slice(0, 120)}`])
            try { terminalViewRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }) } catch { /* ignore */ }
            toast({ title: '▶️ AI chạy lệnh', description: String(cmd).slice(0, 60) })
            break
          }
          case 'opencode': {
            const action = (typeof detail?.action === 'string' ? detail.action : null) || extractJsonStringField(rawDetail, 'action')
            if ((action === 'read' || action === 'write') && absPath) {
              void handleFileSelect(absPath)
              toast({ title: action === 'read' ? `📖 AI đang đọc ${fileName}` : `✏️ AI đang sửa ${fileName}` })
            } else if (action === 'bash') {
              const cmd = (typeof detail?.command === 'string' ? detail.command : null) || extractJsonStringField(rawDetail, 'command') || rawDetail
              setTerminalOutput(prev => [...prev, `$ [AI] ${String(cmd).slice(0, 120)}`])
              try { terminalViewRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }) } catch { /* ignore */ }
              toast({ title: '▶️ AI chạy lệnh', description: String(cmd).slice(0, 60) })
            }
            break
          }
        }
      } else if (ev.result !== 'Error') {
        switch (tool) {
          case 'file_edit': case 'file_multi_edit': {
            void loadFileTree()
            void loadPendingEdits()
            if (absPath) { void handleFileSelect(absPath, { refresh: true }); toast({ title: `✅ AI đã sửa ${fileName}` }) }
            break
          }
          case 'file_delete': { void loadFileTree(); toast({ title: `🗑️ AI đã xóa ${fileName || 'file'}` }); break }
          case 'start_preview': {
            const port = typeof detail?.port === 'number' ? detail.port : extractJsonNumberField(rawDetail, 'port') || 0
            if (port > 0) openAiPreview(port, typeof detail?.root === 'string' ? detail.root : undefined)
            break
          }
          case 'stop_preview': {
            previewEventSrcRef.current?.close(); previewEventSrcRef.current = null
            setPreviewLogs([]); setShowPreview(false); setPreviewPort(null)
            toast({ title: '⏹️ AI đã stop preview' })
            break
          }
        }
      }
    } catch (err) { console.warn('[ai-tool-event]', err) }
  }, [workspaceRoot, handleFileSelect, loadFileTree, loadPendingEdits, openAiPreview])

  // Phase 7: subscribe CodeTabContent to AI tool events dispatched by the
  // chat submit handler's workflow SSE reader.
  useEffect(() => {
    const listener = (e: Event) => {
      try { handleAIToolEvent((e as CustomEvent).detail) } catch { /* ignore */ }
    }
    window.addEventListener(AI_TOOL_EVENT_NAME, listener)
    return () => { window.removeEventListener(AI_TOOL_EVENT_NAME, listener) }
  }, [handleAIToolEvent])

  // Refresh iframe (for auto-refresh after file changes)
  const handlePreviewRefresh = useCallback(() => {
    setPreviewIframeKey(prev => prev + 1)
  }, [])

  // Retry preview detection
  const handlePreviewRetry = useCallback(async () => {
    if (!workspaceRoot) return
    setPreviewDetecting(true)
    setPreviewPort(null)
    setPreviewAutoStartAttempted(false)
    setPreviewAutoStarting(false)

    try {
      const detectRes = await authedFetch(`/api/opencode/preview/detect?root=${encodeURIComponent(workspaceRoot)}`)
      if (detectRes.ok) {
        const detectData = await detectRes.json()
        if (detectData.framework) {
          setPreviewFramework(detectData.framework)
          setPreviewFrameworkIcon(detectData.frameworkIcon || '📦')
        }
        if (detectData.devCommand) {
          setPreviewDevCommand(detectData.devCommand)
        }
        if (detectData.detectedPort) {
          setPreviewPort(detectData.detectedPort)
        } else if (detectData.devCommand) {
          // Try auto-start
          setPreviewAutoStarting(true)
          setPreviewAutoStartAttempted(true)
          try {
            const startRes = await authedFetch('/api/opencode/preview/start', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ root: workspaceRoot, script: detectData.devScript || 'dev' }),
            })
            if (startRes.ok) {
              const startData = await startRes.json()
              if (startData.status === 'started' || startData.status === 'already_running') {
                for (let i = 0; i < 15; i++) {
                  await new Promise(r => setTimeout(r, 2000))
                  const reDetectRes = await authedFetch(`/api/opencode/preview/detect?root=${encodeURIComponent(workspaceRoot)}`)
                  if (reDetectRes.ok) {
                    const reDetectData = await reDetectRes.json()
                    if (reDetectData.detectedPort) {
                      setPreviewPort(reDetectData.detectedPort)
                      break
                    }
                  }
                }
              }
            }
          } catch { /* ignore */ }
          finally { setPreviewAutoStarting(false) }
        }
      }
    } catch {
      // Fallback basic scan
      const ports = [3000, 3001, 3002, 5173, 5174, 8080, 4000, 4200, 8000, 4173]
      for (const port of ports) {
        try {
          const checkRes = await fetch(`http://127.0.0.1:${port}`, { method: 'HEAD', signal: AbortSignal.timeout(1500) })
          if (checkRes.ok) { setPreviewPort(port); break }
        } catch { continue }
      }
    } finally {
      setPreviewDetecting(false)
    }
  }, [workspaceRoot])

  const handleQuickAction = useCallback((action: string) => {
    setNewSessionPrompt(action)
  }, [])

  const handleMcpToggle = useCallback(async (direction: 'outbound' | 'inbound', toolName: string, enabled: boolean) => {
    setMcpToggling(`${direction}:${toolName}`)
    try {
      const res = await authedFetch('/api/opencode/mcp/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction, toolName, enabled }),
      })
      const data = await res.json()
      if (data.success) {
        toast({ title: enabled ? 'Đã bật tool' : 'Đã tắt tool', description: `${toolName} (${direction})` })
        loadMcpStatus()
      } else {
        toast({ title: 'Lỗi', description: data.error || 'Toggle failed', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi', description: 'Failed to toggle MCP tool', variant: 'destructive' })
    } finally {
      setMcpToggling(null)
    }
  }, [loadMcpStatus])

  const handleMcpSync = useCallback(async () => {
    setMcpSyncing(true)
    try {
      const res = await authedFetch('/api/opencode/mcp/sync', { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        toast({ title: 'MCP Bridge đã đồng bộ', description: `Outbound: ${data.sync?.outboundSynced || 0}, Inbound: ${data.sync?.inboundSynced || 0}, Skills: ${data.sync?.skillsRegistered || 0}` })
        loadMcpStatus()
      } else {
        toast({ title: 'Lỗi', description: data.error || 'Sync failed', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi', description: 'Failed to sync MCP tools', variant: 'destructive' })
    } finally {
      setMcpSyncing(false)
    }
  }, [loadMcpStatus])

  const toggleDir = useCallback((path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  // File tree rendering.
  // Declared as a function (hoisted) instead of a `useCallback` const — the body
  // recurses into itself, and referencing a `const` before its initializer
  // finishes trips the compiler's TDZ analysis ("Cannot access variable before
  // it is declared"). It is invoked directly during render, so memoizing it
  // bought nothing anyway.
  function renderFileTree(nodes: FileNode[], depth: number = 0): React.ReactNode {
    const search = fileSearch.toLowerCase()
    return nodes
      .filter(n => !search || n.name.toLowerCase().includes(search) || n.path.toLowerCase().includes(search))
      .map(node => {
        const isDir = node.type === 'directory'
        const isExpanded = expandedDirs.has(node.path)
        const isSelected = selectedFile === node.path
        const iconColor = isDir ? 'text-amber-400' : node.extension === '.ts' || node.extension === '.tsx' ? 'text-blue-400' :
          node.extension === '.json' ? 'text-yellow-400' : node.extension === '.css' ? 'text-pink-400' :
          node.extension === '.md' ? 'text-stone-400' : 'text-stone-500'

        return (
          <div key={node.path}>
            <button
              onClick={() => isDir ? toggleDir(node.path) : handleFileSelect(node.path)}
              className={`group relative w-full flex items-center gap-1.5 px-2 py-1 text-[11px] hover:bg-emerald-500/10 transition-colors rounded-sm ${
                isSelected ? 'bg-emerald-500/20 text-emerald-300' : 'text-stone-300'
              }`}
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
            >
              {isDir ? (
                isExpanded ? <ChevronDown className="h-3 w-3 text-stone-500 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 text-stone-500 flex-shrink-0" />
              ) : (
                <span className="w-3 flex-shrink-0" />
              )}
              {isDir ? (
                <FolderOpen className={`h-3.5 w-3.5 ${iconColor} flex-shrink-0`} />
              ) : (
                <FileCode className={`h-3.5 w-3.5 ${iconColor} flex-shrink-0`} />
              )}
              <span className="truncate">{node.name}</span>
              {!isDir && (
                <span className="ml-auto flex items-center flex-shrink-0">
                  {node.size !== undefined && (
                    <span className="text-[9px] text-stone-600">
                      {node.size < 1024 ? `${node.size}B` : node.size < 1024 * 1024 ? `${(node.size / 1024).toFixed(1)}K` : `${(node.size / 1024 / 1024).toFixed(1)}M`}
                    </span>
                  )}
                  <span role="button" title="Đổi tên" className="opacity-0 group-hover:opacity-100 text-stone-500 hover:text-emerald-300 px-1" onClick={(e) => { e.stopPropagation(); void handleRenameFile(node.path, node.name) }}>
                    <Pencil className="h-2.5 w-2.5" />
                  </span>
                  <span role="button" title="Xóa" className="opacity-0 group-hover:opacity-100 text-stone-500 hover:text-red-400 px-1" onClick={(e) => { e.stopPropagation(); void handleDeleteFile(node.path, node.name) }}>
                    <Trash2 className="h-2.5 w-2.5" />
                  </span>
                </span>
              )}
            </button>
            {isDir && isExpanded && node.children && renderFileTree(node.children, depth + 1)}
          </div>
        )
      })
  }

  // Session status badge
  const statusBadge = useCallback((status: string) => {
    const map: Record<string, { cls: string; icon: React.ReactNode }> = {
      active: { cls: 'bg-emerald-950/50 text-emerald-400 border-emerald-400/35', icon: <RefreshCw className="h-2.5 w-2.5 animate-spin" /> },
      paused: { cls: 'bg-amber-950/50 text-amber-400 border-amber-400/35', icon: <Pause className="h-2.5 w-2.5" /> },
      completed: { cls: 'bg-blue-950/50 text-blue-400 border-blue-400/35', icon: <CheckCircle2 className="h-2.5 w-2.5" /> },
      failed: { cls: 'bg-red-950/50 text-red-400 border-red-400/35', icon: <XCircle className="h-2.5 w-2.5" /> },
    }
    const s = map[status] || map.active
    return <Badge className={`text-[9px] border ${s.cls} flex items-center gap-1`}>{s.icon} {status}</Badge>
  }, [])

  // Uptime formatter
  const formatUptime = useCallback((ms: number) => {
    if (ms < 60000) return `${Math.floor(ms / 1000)}s`
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m`
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`
  }, [])

  // Quick actions
  const QUICK_ACTIONS = [
    { label: 'Fix Bug', icon: Bug, prompt: 'Find and fix bugs in the current file' },
    { label: 'Refactor', icon: RefreshCw, prompt: 'Refactor this code for better readability and performance' },
    { label: 'Write Tests', icon: CheckCircle2, prompt: 'Write unit tests for the current file' },
    { label: 'Document', icon: FileText, prompt: 'Add documentation and comments to this code' },
    { label: 'Code Review', icon: Eye, prompt: 'Review this code for potential issues and improvements' },
    { label: 'Optimize', icon: Zap, prompt: 'Optimize this code for better performance' },
  ]

  // Model options — NVIDIA NIM only (user directive 2026-08-28: kimi-k3 là lõi
  // CHÍNH; deepseek-v4-pro-0813 / deepseek-v4-flash / minimax-m3 là fallback
  // chain TỰ ĐỘNG phía server — selector vẫn 1 lựa chọn vì server override mọi
  // agent về kimi-k3 rồi tự chuyển lõi khi kimi cạn key)
  const MODEL_OPTIONS = [
    { value: 'moonshotai/kimi-k3', label: 'Kimi K3 (lõi chính + fallback tự động)' },
  ]

  return (
    <div className="space-y-4">

      {/* ===== Section 1: File Explorer + Code View ===== */}
      <div className="nc-wrap nc-emerald">
        <div className="nc-panel nc-md nc-border-emerald overflow-hidden">
          <div className="flex items-center gap-2 p-3 border-b border-emerald-400/35">
            <button
              className="flex items-center gap-2 hover:bg-emerald-500/10 rounded px-1 py-0.5 transition-colors cursor-pointer"
              onClick={() => {
                setFolderPickerPath(workspaceRoot || '/home/z')
                loadFolderPicker(workspaceRoot || '/home/z')
                setShowFolderPicker(true)
              }}
              title="Chọn thư mục làm việc"
            >
              <FolderTree className="h-4 w-4 text-emerald-400" />
              <span className="text-sm font-semibold text-stone-100">File Explorer</span>
            </button>
            {/* Native OS folder dialog (user request 2026-08-27) — dialog Windows/macOS/Linux thật */}
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[10px] gap-1 border-emerald-400/50 text-emerald-400 hover:bg-emerald-500/10"
              onClick={handleNativeFolderPick}
              disabled={nativeFolderLoading}
              title="Mở hộp thoại chọn thư mục của hệ điều hành (Windows Explorer / macOS Finder / Linux)"
            >
              {nativeFolderLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderOpen className="h-3 w-3" />}
              Chọn thư mục (Dialog hệ thống)
            </Button>
            <Button
              size="sm"
              variant="outline"
              className={`h-7 px-2 text-[10px] gap-1 ${showPreview ? 'border-emerald-400/50 text-emerald-300 bg-emerald-500/20' : 'border-emerald-400/50 text-emerald-400 hover:bg-emerald-500/10'}`}
              onClick={handlePreviewToggle}
              title="Smart Preview — tự nhận diện framework và khởi động dev server"
            >
              <ExternalLinkIcon className="h-3 w-3" /> Preview
            </Button>
            {workspaceRoot && (
              <Badge className="text-[8px] bg-emerald-950/50 text-emerald-400 border border-emerald-400/35 max-w-[200px] truncate" title={workspaceRoot}>
                📁 {baseNameOf(workspaceRoot) || workspaceRoot}
              </Badge>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              {workspaceRoot && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-7 p-0 border-emerald-400/50 text-emerald-400 hover:bg-emerald-500/10"
                    onClick={() => { setShowNewFileInput(true); setNewFileName('') }}
                    title="Tạo file mới"
                  >
                    <Plus className="h-3 w-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className={`h-7 w-7 p-0 border-emerald-400/50 ${showSearchPanel ? 'text-emerald-300 bg-emerald-500/20' : 'text-emerald-400 hover:bg-emerald-500/10'}`}
                    onClick={() => setShowSearchPanel(!showSearchPanel)}
                    title="Tìm kiếm trong workspace (rg)"
                  >
                    <Search className="h-3 w-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-7 p-0 border-emerald-400/50 text-emerald-400 hover:bg-emerald-500/10"
                    onClick={() => { setShowNewFolderInput(true); setNewFolderName('') }}
                    title="Tạo thư mục mới"
                  >
                    <FolderUp className="h-3 w-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-7 p-0 border-emerald-400/50 text-emerald-400 hover:bg-emerald-500/10"
                    onClick={loadFileTree}
                    disabled={treeLoading}
                  >
                    <RefreshCw className={`h-3 w-3 ${treeLoading ? 'animate-spin' : ''}`} />
                  </Button>
                </>
              )}
            </div>
          </div>

          {/* New file/folder input bars */}
          {showNewFileInput && (
            <div className="flex items-center gap-2 px-3 py-2 border-b border-emerald-500/10 bg-emerald-950/20">
              <FileCode className="h-3.5 w-3.5 text-emerald-400 flex-shrink-0" />
              <Input
                placeholder="path/to/newfile.ts"
                value={newFileName}
                onChange={e => setNewFileName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreateFile(); if (e.key === 'Escape') setShowNewFileInput(false) }}
                className="h-7 flex-1 text-[11px] bg-slate-950/50 border-emerald-400/35"
                autoFocus
              />
              <Button size="sm" className="h-7 px-2 text-[10px] bg-emerald-600 hover:bg-emerald-500 text-white" onClick={handleCreateFile}>Tạo</Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[10px] text-stone-400" onClick={() => setShowNewFileInput(false)}>Hủy</Button>
            </div>
          )}
          {showNewFolderInput && (
            <div className="flex items-center gap-2 px-3 py-2 border-b border-emerald-500/10 bg-emerald-950/20">
              <FolderOpen className="h-3.5 w-3.5 text-amber-400 flex-shrink-0" />
              <Input
                placeholder="path/to/new-folder"
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') setShowNewFolderInput(false) }}
                className="h-7 flex-1 text-[11px] bg-slate-950/50 border-emerald-400/35"
                autoFocus
              />
              <Button size="sm" className="h-7 px-2 text-[10px] bg-emerald-600 hover:bg-emerald-500 text-white" onClick={handleCreateFolder}>Tạo</Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-[10px] text-stone-400" onClick={() => setShowNewFolderInput(false)}>Hủy</Button>
            </div>
          )}

          {/* Phase 10: workspace-wide search panel (ripgrep) */}
          {showSearchPanel && (
            <div className="border-b border-emerald-500/10 bg-slate-950/95 p-2" style={{ maxHeight: '300px' }}>
              <SearchPanel
                root={workspaceRoot || undefined}
                onResultClick={(path, _line) => {
                  void handleFileSelect(path.startsWith('/') ? path : `${workspaceRoot}/${path}`)
                  setShowSearchPanel(false)
                }}
                onClose={() => setShowSearchPanel(false)}
              />
            </div>
          )}

          {/* Main content area - either File Tree + Code View OR Preview */}
          {showPreview ? (
            /* ===== Smart Preview Panel (replaces entire content area) ===== */
            <div className="flex flex-col overflow-hidden" style={{ minHeight: '200px', height: `${fileExplorerHeight}px` }}>
              {/* Preview header bar */}
              <div className="flex items-center justify-between px-3 py-1.5 bg-slate-950/90 border-b border-emerald-500/10">
                <div className="flex items-center gap-1.5">
                  <Monitor className="h-3 w-3 text-emerald-400" />
                  <span className="text-[10px] text-stone-400 font-medium">Preview</span>
                  {previewFramework && (
                    <Badge className="text-[8px] bg-violet-950/50 text-violet-300 border border-violet-400/35">
                      {previewFrameworkIcon} {previewFramework}
                    </Badge>
                  )}
                  {previewDetecting && <Loader2 className="h-3 w-3 animate-spin text-emerald-400" />}
                  {previewAutoStarting && (
                    <Badge className="text-[8px] bg-amber-950/50 text-amber-300 border border-amber-400/35 animate-pulse">
                      ⏳ Đang khởi động...
                    </Badge>
                  )}
                  {previewPort && (
                    <Badge className="text-[8px] bg-emerald-950/50 text-emerald-400 border border-emerald-400/35">
                      ✅ :{previewPort}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {previewPort && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 w-5 p-0 text-stone-500 hover:text-emerald-400"
                      onClick={() => { try { window.open(previewProxyUrl(previewPort), '_blank', 'noopener') } catch { /* ignore */ } }}
                      title="Mở preview trong tab mới (qua same-origin proxy — hoạt động cả khi xem app qua HTTPS)"
                    >
                      <ExternalLinkIcon className="h-3 w-3" />
                    </Button>
                  )}
                  {previewPort && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 w-5 p-0 text-stone-500 hover:text-emerald-400"
                      onClick={handlePreviewRefresh}
                      title="Làm mới preview"
                    >
                      <RefreshCw className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              </div>

              {/* Preview content */}
              <div className="flex-1 bg-slate-950">
                {!workspaceRoot ? (
                  /* No workspace selected */
                  <div className="flex flex-col items-center justify-center h-full text-stone-500 p-4 text-center">
                    <FolderOpen className="h-10 w-10 mb-3 opacity-30" />
                    <p className="text-[11px] font-medium text-stone-400">Chưa chọn thư mục làm việc</p>
                    <p className="text-[10px] text-stone-600 mt-1">Chọn thư mục chứa project để preview ứng dụng</p>
                  </div>
                ) : previewDetecting ? (
                  /* Detecting framework & port */
                  <div className="flex flex-col items-center justify-center h-full text-stone-500 p-4 text-center">
                    <Loader2 className="h-8 w-8 animate-spin text-emerald-400 mb-3" />
                    <p className="text-[11px] text-stone-400">
                      {previewFramework
                        ? `Đang tìm dev server ${previewFrameworkIcon} ${previewFramework}...`
                        : 'Đang phân tích project...'}
                    </p>
                    <p className="text-[10px] text-stone-600 mt-1">Quét framework, cấu hình và port</p>
                  </div>
                ) : previewAutoStarting ? (
                  /* Auto-starting dev server */
                  <div className="flex flex-col items-center justify-center h-full text-stone-500 p-4 text-center">
                    <div className="relative mb-4">
                      <PlayIcon className="h-10 w-10 text-amber-400 opacity-60" />
                      <Loader2 className="h-4 w-4 animate-spin text-amber-300 absolute -bottom-1 -right-1" />
                    </div>
                    <p className="text-[11px] text-stone-400">Đang khởi động dev server...</p>
                    {previewDevCommand && (
                      <p className="text-[10px] text-amber-400/80 font-mono mt-1.5 bg-amber-950/30 px-2 py-0.5 rounded">
                        $ {previewDevCommand}
                      </p>
                    )}
                    <p className="text-[10px] text-stone-600 mt-2">Chờ dev server sẵn sàng (tối đa 30s)</p>
                  </div>
                ) : previewPort && previewWaiting ? (
                  /* Dev server đã start nhưng chưa nhận connection — chờ (tối đa 45s) */
                  <div className="flex flex-col items-center justify-center h-full text-stone-500 p-4 text-center">
                    <Loader2 className="h-8 w-8 animate-spin text-emerald-400 mb-3" />
                    <p className="text-[11px] text-stone-400">Đang chờ dev server :{previewPort} sẵn sàng...</p>
                    {previewDevCommand && (
                      <p className="text-[10px] text-amber-400/80 font-mono mt-1.5 bg-amber-950/30 px-2 py-0.5 rounded">
                        $ {previewDevCommand}
                      </p>
                    )}
                    <p className="text-[10px] text-stone-600 mt-2">Tự làm mới khi server nhận kết nối (tối đa 45s)</p>
                  </div>
                ) : previewPort ? (
                  /* ✅ App loaded — show iframe (SAME-ORIGIN PROXY — fix 2026-09-10:
                     http://127.0.0.1:<port> chỉ chạy khi mở app trực tiếp bằng
                     HTTP localhost; qua proxy HTTPS thì 127.0.0.1 = máy user +
                     mixed-content → lỗi. Proxy chạy server-side, mọi môi trường
                     đều hiển thị được) + dev-server log tail (Phase 3) */
                  <div className="flex flex-col h-full min-h-0">
                    <iframe
                      key={previewIframeKey}
                      src={previewProxyUrl(previewPort)}
                      className="w-full flex-1 min-h-0 border-0 bg-white"
                      title="App Preview"
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                    />
                    {previewLogs.length > 0 && (
                      <pre className="m-0 max-h-[88px] overflow-auto px-2 py-1 bg-slate-950 border-t border-emerald-500/10 text-[9px] leading-relaxed font-mono text-stone-500 whitespace-pre-wrap">
                        {previewLogs.slice(-15).join('\n')}
                      </pre>
                    )}
                  </div>
                ) : (
                  /* No app found — show helpful empty state */
                  <div className="flex flex-col items-center justify-center h-full text-stone-500 p-6 text-center">
                    <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-slate-800/50 mb-3">
                      {previewFramework ? (
                        <span className="text-2xl">{previewFrameworkIcon}</span>
                      ) : (
                        <Code2 className="h-6 w-6 opacity-30" />
                      )}
                    </div>
                    {previewFramework ? (
                      <>
                        <p className="text-[11px] font-medium text-stone-400">
                          {previewFrameworkIcon} {previewFramework} — chưa chạy dev server
                        </p>
                        <p className="text-[10px] text-stone-600 mt-1.5 max-w-[300px]">
                          Preview đã nhận diện project {previewFramework} nhưng không tìm thấy dev server.
                        </p>
                        {previewAutoStartAttempted ? (
                          <p className="text-[10px] text-amber-400/70 mt-1.5">
                            ⚠️ Tự khởi động thất bại. Thử chạy thủ công trong Terminal.
                          </p>
                        ) : null}
                        {previewDevCommand && (
                          <div className="mt-2 flex items-center gap-1.5 bg-slate-800/50 px-2.5 py-1 rounded border border-stone-700/50">
                            <span className="text-[10px] text-stone-500">$</span>
                            <span className="text-[10px] text-emerald-400 font-mono">{previewDevCommand}</span>
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <p className="text-[11px] font-medium text-stone-400">Chưa có ứng dụng để preview</p>
                        <p className="text-[10px] text-stone-600 mt-1.5 max-w-[280px]">
                          Thư mục <span className="text-emerald-400 font-mono">{baseNameOf(workspaceRoot)}</span> chưa có dev server đang chạy.
                        </p>
                        <p className="text-[10px] text-stone-600 mt-1">
                          Chạy <span className="text-emerald-400 font-mono">npm run dev</span> hoặc <span className="text-emerald-400 font-mono">bun dev</span> trong Terminal, sau đó bấm Thử lại.
                        </p>
                      </>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-3 h-7 px-3 text-[10px] border-emerald-400/50 text-emerald-400 hover:bg-emerald-500/10 gap-1"
                      onClick={handlePreviewRetry}
                    >
                      <RefreshCw className="h-3 w-3" /> Thử lại
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* ===== File Tree + Code View ===== */
            <div className="flex" style={{ minHeight: '200px', height: `${fileExplorerHeight}px` }}>
              {/* File Tree */}
              <div className="w-1/3 border-r border-emerald-500/10 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                {!workspaceRoot ? (
                  <div className="flex flex-col items-center justify-center h-40 text-stone-500 p-4 text-center">
                    <FolderOpen className="h-10 w-10 mb-3 opacity-30" />
                    <p className="text-[11px] font-medium text-stone-400">Chọn thư mục để bắt đầu</p>
                    <p className="text-[10px] text-stone-600 mt-1">Bấm vào File Explorer để chọn thư mục</p>
                    <Button
                      size="sm"
                      className="mt-3 h-7 px-3 text-[10px] bg-emerald-600 hover:bg-emerald-500 text-white"
                      onClick={() => {
                        setFolderPickerPath('/home/z')
                        loadFolderPicker('/home/z')
                        setShowFolderPicker(true)
                      }}
                    >
                      <FolderOpen className="h-3 w-3 mr-1" /> Chọn thư mục
                    </Button>
                  </div>
                ) : treeLoading ? (
                  <div className="flex items-center justify-center h-32">
                    <Loader2 className="h-5 w-5 animate-spin text-emerald-400" />
                  </div>
                ) : fileTree.length > 0 ? (
                  <div className="py-1">
                    {renderFileTree(fileTree)}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center h-32 text-stone-500">
                    <FolderOpen className="h-8 w-8 mb-2" />
                    <p className="text-[11px]">Thư mục trống</p>
                  </div>
                )}
              </div>

              {/* Code View */}
              <div className={`flex-1 flex flex-col overflow-y-auto`} style={{ scrollbarWidth: 'thin' }}>
                {fileLoading ? (
                  <div className="flex items-center justify-center h-32">
                    <Loader2 className="h-5 w-5 animate-spin text-emerald-400" />
                  </div>
                ) : selectedFile && fileContent ? (
                  <>
                    <div className="sticky top-0 z-10 flex items-center justify-between px-3 py-1.5 bg-slate-950/90 border-b border-emerald-500/10">
                      <span className="text-[10px] text-stone-400 font-mono truncate max-w-[50%]">{fileContent.path}</span>
                      <div className="flex items-center gap-1.5">
                        {fileContent.isBinary ? (
                          <Badge className="text-[8px] bg-purple-950/60 text-purple-300 border border-purple-500/30">Binary</Badge>
                        ) : (
                          <Badge className="text-[8px] bg-slate-800 text-stone-400">{fileContent.language}</Badge>
                        )}
                        {fileContent.isBinary ? (
                          <Badge className="text-[8px] bg-slate-800 text-stone-400">{fileContent.size ? `${(fileContent.size / 1024 / 1024).toFixed(2)} MB` : ''}</Badge>
                        ) : (
                          <Badge className="text-[8px] bg-slate-800 text-stone-400">{fileContent.lines} dòng</Badge>
                        )}
                        {fileContent.truncated && (
                          <Badge className="text-[8px] bg-amber-950/50 text-amber-400 border border-amber-400/50">2MB đầu · read-only</Badge>
                        )}
                        {editedContent !== null && (
                          <Badge className="text-[8px] bg-amber-900/50 text-amber-400 border border-amber-400/50 animate-pulse">Đã chỉnh sửa</Badge>
                        )}
                        {!fileContent.isBinary && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className={`h-5 text-[8px] px-1.5 ${diffViewActive ? 'text-emerald-400 bg-emerald-500/20' : 'text-stone-500 hover:text-stone-300'}`}
                            onClick={() => setDiffViewActive(!diffViewActive)}
                            title="Xem Diff"
                          >
                            <FileCode className="h-3 w-3 mr-0.5" /> Diff
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-5 text-[8px] px-1.5 text-stone-500 hover:text-emerald-300"
                          onClick={() => { setShowPendingModal(true); void loadPendingEdits() }}
                          title="Xem các AI edit chờ duyệt"
                        >
                          📝 Pending{pendingEdits.length > 0 ? ` (${pendingEdits.length})` : ''}
                        </Button>
                        {editedContent !== null && (
                          <Button
                            size="sm"
                            className="h-5 text-[8px] px-2 bg-emerald-600 hover:bg-emerald-500 text-white"
                            onClick={() => void handleSaveFile(activeFileIndex)}
                            disabled={isSaving}
                          >
                            {isSaving ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <><CheckCircle2 className="h-2.5 w-2.5 mr-0.5" /> Lưu</>}
                          </Button>
                        )}
                        {editedContent !== null && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-5 text-[8px] px-1.5 text-stone-500 hover:text-red-400"
                            onClick={() => handleRevertFile(activeFileIndex)}
                            title="Hủy chỉnh sửa"
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    </div>
                    {/* Phase 9: session diff view (buffer vs original). Phase 8 Monaco multi-tab editor otherwise (locally vendored /monaco-vs, no CDN). */}
                    {diffViewActive && activeOpenFile ? (
                      <div className="flex-1 min-h-0 flex flex-col">
                        <div className="flex items-center justify-between px-3 py-1.5 bg-slate-950/90 border-b border-emerald-500/10">
                          <span className="text-[10px] font-mono text-emerald-300">Diff: {baseNameOf(activeOpenFile.path)}</span>
                          <span className="text-[9px] text-stone-500">{activeOpenFile.isDirty ? 'thay đổi chưa lưu (so với nội dung gốc)' : 'không có thay đổi trong session'}</span>
                        </div>
                        <div className="flex-1 min-h-0">
                          <DiffViewer
                            originalContent={activeOpenFile.originalContent}
                            modifiedContent={activeOpenFile.content}
                            language={detectLanguage(activeOpenFile.path)}
                          />
                        </div>
                      </div>
                    ) : (
                      <CodeEditor
                        openFiles={openFiles}
                        activeFileIndex={activeFileIndex}
                        onActiveChange={setActiveFileIndex}
                        onContentChange={handleContentChange}
                        onSave={(idx) => void handleSaveFile(idx)}
                        onClose={handleCloseFile}
                      />
                    )}
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-stone-500">
                    <FileCode className="h-10 w-10 mb-3" />
                    <p className="text-xs">Chọn file để xem/chỉnh sửa</p>
                    <p className="text-[10px] text-stone-600 mt-1">Click vào file trong cây thư mục</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Drag handle at bottom of File Explorer */}
          <div
            className="flex items-center justify-center h-3 cursor-ns-resize hover:bg-emerald-500/10 transition-colors border-t border-emerald-500/10 group"
            onMouseDown={(e) => {
              e.preventDefault()
              fileExplorerDragRef.current = { startY: e.clientY, startH: fileExplorerHeight }
              document.body.style.cursor = 'ns-resize'
              document.body.style.userSelect = 'none'
            }}
            title="Kéo để thay đổi kích thước"
          >
            <GripHorizontal className="h-3 w-4 text-stone-600 group-hover:text-emerald-400 transition-colors" />
          </div>

          {/* LSP Diagnostics Panel - only shown when NOT in Preview mode */}
          {!showPreview && diagnostics.length > 0 && (
            <div className="border-t border-emerald-500/10 p-3">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                <span className="text-[11px] font-medium text-stone-300">LSP Diagnostics ({diagnostics.length})</span>
              </div>
              <div className="space-y-1 max-h-32 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                {diagnostics.slice(0, 20).map((d, i) => (
                  <div key={i} className="flex items-start gap-2 text-[10px]">
                    {d.severity === 'error' || d.severity === 'Error' ? (
                      <XCircle className="h-3 w-3 text-red-400 flex-shrink-0 mt-0.5" />
                    ) : (
                      <AlertTriangle className="h-3 w-3 text-amber-400 flex-shrink-0 mt-0.5" />
                    )}
                    <span className="text-stone-400">
                      {d.line ? `L${d.line}` : ''}{d.column ? `:${d.column}` : ''} {d.message || d.raw || ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Folder Picker Dialog */}
      {showFolderPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[560px] max-h-[80vh] bg-slate-950 border border-emerald-400/50 rounded-xl shadow-2xl flex flex-col overflow-hidden">
            {/* Dialog header */}
            <div className="flex items-center gap-3 p-4 border-b border-emerald-400/35">
              <FolderOpen className="h-5 w-5 text-emerald-400" />
              <span className="text-sm font-semibold text-stone-100">Chọn thư mục làm việc</span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-7 w-7 p-0 text-stone-500 hover:text-red-400"
                onClick={() => setShowFolderPicker(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Path breadcrumb / input */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-emerald-500/10 bg-slate-900/50">
              <span className="text-[10px] text-stone-500 flex-shrink-0">Đường dẫn:</span>
              <Input
                value={folderPickerPath}
                onChange={e => setFolderPickerPath(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') loadFolderPicker(e.currentTarget.value) }}
                className="h-7 flex-1 text-[11px] font-mono bg-slate-950/50 border-emerald-400/35"
                placeholder="/path/to/project"
              />
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[10px] border-emerald-400/50 text-emerald-400"
                onClick={() => loadFolderPicker(folderPickerPath)}
              >
                Đi đến
              </Button>
            </div>

            {/* Quick access paths */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-emerald-500/10">
              <span className="text-[9px] text-stone-600 flex-shrink-0">Truy cập nhanh:</span>
              {['.', '..', '/tmp'].map(p => (
                <Button
                  key={p}
                  size="sm"
                  variant="outline"
                  className={`h-6 px-2 text-[9px] border-emerald-400/35 ${folderPickerPath === p ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' : 'text-stone-400 hover:text-stone-200'}`}
                  onClick={() => loadFolderPicker(p)}
                >
                  {p.split('/').pop() || '/'}
                </Button>
              ))}
            </div>

            {/* Directory listing */}
            <div className="flex-1 overflow-y-auto p-2" style={{ scrollbarWidth: 'thin' }}>
              {folderPickerLoading ? (
                <div className="flex items-center justify-center h-24">
                  <Loader2 className="h-5 w-5 animate-spin text-emerald-400" />
                </div>
              ) : folderPickerItems.length > 0 ? (
                <div className="space-y-0.5">
                  {folderPickerItems.map(item => (
                    <button
                      key={item.path}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-[11px] rounded-lg transition-colors ${
                        item.type === 'directory'
                          ? 'hover:bg-emerald-500/10 text-stone-200 cursor-pointer'
                          : 'text-stone-500 cursor-default'
                      }`}
                      onClick={() => {
                        if (item.type === 'directory') {
                          loadFolderPicker(item.path)
                        }
                      }}
                      onDoubleClick={() => {
                        if (item.type === 'directory') {
                          void handleWorkspaceSelect(item.path)
                        }
                      }}
                    >
                      {item.type === 'directory' ? (
                        <FolderOpen className="h-4 w-4 text-amber-400 flex-shrink-0" />
                      ) : (
                        <FileCode className="h-4 w-4 text-stone-600 flex-shrink-0" />
                      )}
                      <span className="truncate flex-1 text-left">{item.name}</span>
                      {item.type === 'directory' && (
                        <span className="text-[9px] text-stone-600">📂</span>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-24 text-stone-500">
                  <FolderOpen className="h-8 w-8 mb-2 opacity-30" />
                  <p className="text-[11px]">Thư mục trống hoặc không tồn tại</p>
                </div>
              )}
            </div>

            {/* Dialog footer */}
            <div className="flex items-center justify-between px-4 py-3 border-t border-emerald-400/35 bg-slate-900/30">
              <span className="text-[10px] text-stone-500 font-mono truncate max-w-[60%]" title={folderPickerPath}>
                {folderPickerPath}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 px-3 text-[11px] border-stone-600 text-stone-300"
                  onClick={() => setShowFolderPicker(false)}
                >
                  Hủy
                </Button>
                <Button
                  size="sm"
                  className="h-8 px-4 text-[11px] bg-emerald-600 hover:bg-emerald-500 text-white gap-1.5"
                  onClick={() => { void handleWorkspaceSelect(folderPickerPath) }}
                >
                  <FolderOpen className="h-3.5 w-3.5" /> Chọn thư mục này
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}


      {/* ===== Section 2: Terminal ===== */}
      <div className="nc-wrap nc-emerald">
        <div className="nc-panel nc-sm nc-border-emerald p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <TerminalIcon className="h-4 w-4 text-emerald-400" />
              <span className="text-sm font-semibold text-stone-100">Terminal</span>
              {workspaceRoot && (
                <Badge className="text-[8px] bg-emerald-950/50 text-emerald-400 border border-emerald-400/35 max-w-[180px] truncate" title={workspaceRoot}>
                  📂 {baseNameOf(workspaceRoot) || workspaceRoot}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-[9px] text-stone-500 hover:text-stone-300 gap-1"
                title="Dừng shell hiện tại — shell mới sẽ khởi động ở lệnh kế tiếp"
                onClick={handleTerminalRestart}
              >
                <RotateCcw className="h-3 w-3" />
                Khởi động lại
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-[9px] text-stone-500 hover:text-stone-300"
                onClick={() => setTerminalOutput([])}
              >
                Clear
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-[9px] text-stone-500 hover:text-stone-300"
                onClick={() => { navigator.clipboard.writeText(terminalOutput.join('\n')); toast({ title: 'Copied to clipboard' }) }}
              >
                Copy
              </Button>
            </div>
          </div>

          <div ref={terminalViewRef} className={`bg-slate-950/80 rounded-lg border border-emerald-500/10 p-3 overflow-y-auto font-mono text-[11px]`} style={{ scrollbarWidth: 'thin', height: `${terminalHeight}px` }}>
            {terminalOutput.length > 0 ? (
              terminalOutput.map((line, i) => (
                <div key={i} className={`whitespace-pre-wrap break-all ${line.startsWith('$') ? 'text-emerald-400' : line.startsWith('Error') || line.startsWith('✗') ? 'text-red-400' : line.startsWith('✓') ? 'text-emerald-300' : line.startsWith('⎿') ? 'text-stone-500 pl-3 text-[10px]' : line.startsWith('[AI') ? 'text-cyan-400/80' : line.startsWith('[local-exec]') ? 'text-stone-600 text-[9px]' : 'text-stone-400'}`}>
                  {line}
                </div>
              ))
            ) : (
              <span className="text-stone-600">Terminal sẵn sàng. Nhập lệnh bên dưới để thực thi trên máy local.</span>
            )}
          </div>

          {/* Drag handle at bottom of Terminal output area */}
          <div
            className="flex items-center justify-center h-3 cursor-ns-resize hover:bg-emerald-500/10 transition-colors rounded-b-lg border-t border-emerald-500/10 group -mt-1"
            onMouseDown={(e) => {
              e.preventDefault()
              terminalDragRef.current = { startY: e.clientY, startH: terminalHeight }
              document.body.style.cursor = 'ns-resize'
              document.body.style.userSelect = 'none'
            }}
            title="Kéo để thay đổi kích thước Terminal"
          >
            <GripHorizontal className="h-3 w-4 text-stone-600 group-hover:text-emerald-400 transition-colors" />
          </div>

          {/* Command input */}
          <div className="mt-2 flex gap-2">
            <div className="flex items-center gap-1 text-emerald-400 text-[11px] font-mono flex-shrink-0 mt-1.5">$</div>
            <Input
              placeholder="Enter command..."
              value={terminalCommand}
              onChange={e => setTerminalCommand(e.target.value)}
              className="flex-1 h-8 text-[11px] font-mono bg-slate-950/50 border-emerald-400/35"
              onKeyDown={e => { if (e.key === 'Enter') handleExecuteCommand() }}
              disabled={terminalRunning}
            />
            <Button
              size="sm"
              className="h-8 text-[10px] bg-emerald-600 hover:bg-emerald-500 text-white"
              onClick={handleExecuteCommand}
              disabled={terminalRunning || !terminalCommand.trim()}
            >
              {terminalRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <PlayIcon className="h-3 w-3" />}
            </Button>
          </div>
        </div>
      </div>

      {/* ===== Section 3: Active Sessions ===== */}
      <div className="nc-wrap nc-emerald">
        <div className="nc-panel nc-sm nc-border-emerald p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <CpuIcon className="h-4 w-4 text-emerald-400" />
              <span className="text-sm font-semibold text-stone-100">Active Sessions</span>
            </div>
            <Badge className="text-[9px] bg-emerald-950/50 text-emerald-400 border border-emerald-400/35">
              {sessions.length} sessions
            </Badge>
          </div>

          {/* New session form */}
          <div className="mb-3 p-3 bg-slate-950/50 rounded-lg border border-emerald-500/10">
            <div className="flex gap-2 mb-2">
              <Input
                placeholder="Enter prompt... e.g. 'Fix bug in auth.ts'"
                value={newSessionPrompt}
                onChange={e => setNewSessionPrompt(e.target.value)}
                className="flex-1 h-8 text-[11px] bg-slate-950/50 border-emerald-400/35"
                onKeyDown={e => { if (e.key === 'Enter') handleCreateSession() }}
              />
              <Select value={newSessionModel} onValueChange={setNewSessionModel}>
                <SelectTrigger className="w-44 h-8 text-[10px] bg-slate-950/50 border-emerald-400/35">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODEL_OPTIONS.map(m => (
                    <SelectItem key={m.value} value={m.value} className="text-[11px]">{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              size="sm"
              className="h-7 text-[10px] bg-emerald-600 hover:bg-emerald-500 text-white"
              onClick={handleCreateSession}
              disabled={creatingSession || !newSessionPrompt.trim()}
            >
              {creatingSession ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Plus className="h-3 w-3 mr-1" />}
              New Session
            </Button>
          </div>

          {/* Session list */}
          {sessionsLoading ? (
            <div className="flex items-center justify-center h-16">
              <Loader2 className="h-5 w-5 animate-spin text-emerald-400" />
            </div>
          ) : sessions.length > 0 ? (
            <div className="space-y-2 max-h-64 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
              {sessions.map(s => (
                <div key={s.sessionId} className="flex items-center gap-3 p-2.5 bg-slate-950/30 rounded-lg border border-emerald-500/10 hover:border-emerald-400/35 transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[11px] font-medium text-stone-200 truncate">{s.prompt || `Session ${s.sessionId?.substring(0, 8)}...`}</span>
                      {statusBadge(s.status)}
                    </div>
                    <div className="flex items-center gap-3 text-[9px] text-stone-500">
                      <span>Model: {s.model || '—'}</span>
                      <span>ID: {s.sessionId?.substring(0, 8)}...</span>
                      {s.filesTouched && s.filesTouched.length > 0 && <span>Files: {s.filesTouched.length}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {s.status === 'active' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 text-amber-400 hover:bg-amber-500/10"
                        onClick={() => handlePauseSession(s.sessionId)}
                        title="Pause"
                      >
                        <Pause className="h-3 w-3" />
                      </Button>
                    )}
                    {s.status === 'paused' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 text-emerald-400 hover:bg-emerald-500/10"
                        onClick={() => handleResumeSession(s.sessionId)}
                        title="Resume"
                      >
                        <Play className="h-3 w-3" />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0 text-emerald-400 hover:bg-emerald-500/10"
                      onClick={() => loadTimeline(s.sessionId)}
                      title="Xem dòng thời gian"
                    >
                      <History className="h-3 w-3" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0 text-red-400 hover:bg-red-500/10"
                      onClick={() => handleDeleteSession(s.sessionId)}
                      title="Delete"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-stone-500">
              <CpuIcon className="h-8 w-8 mb-2" />
              <p className="text-[11px]">No sessions yet</p>
              <p className="text-[10px] text-stone-600">Create a new session above to start coding</p>
            </div>
          )}
        </div>
      </div>

      {/* ===== Section 4: MCP Bridge Status ===== */}
      <div className="nc-wrap nc-emerald">
        <div className="nc-panel nc-sm nc-border-emerald p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <CableIcon className="h-4 w-4 text-emerald-400" />
              <span className="text-sm font-semibold text-stone-100">MCP Bridge</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge className={`text-[9px] border ${
                mcpStatus?.bridgeStatus === 'active' ? 'bg-emerald-950/50 text-emerald-400 border-emerald-400/35' :
                mcpStatus?.bridgeStatus === 'degraded' ? 'bg-amber-950/50 text-amber-400 border-amber-400/35' :
                'bg-red-950/50 text-red-400 border-red-400/35'
              }`}>
                {mcpStatus?.bridgeStatus || 'unknown'}
              </Badge>
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[9px] border-emerald-400/50 text-emerald-400 hover:bg-emerald-500/10"
                onClick={handleMcpSync}
                disabled={mcpSyncing}
              >
                {mcpSyncing ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                Sync
              </Button>
            </div>
          </div>

          {/* MCP Bridge Architecture Visual */}
          <div className="mb-3 p-2.5 bg-slate-950/60 rounded-lg border border-emerald-500/10">
            <div className="flex items-center justify-center gap-3 text-[10px]">
              <div className="flex items-center gap-1.5 px-2 py-1 bg-cyan-500/10 border border-cyan-400/35 rounded">
                <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
                <span className="text-cyan-300 font-medium">OpenClaw</span>
              </div>
              <div className="flex items-center gap-1 text-emerald-400">
                <ArrowRightIcon className="h-3 w-3" />
                <span className="text-[9px] text-stone-500">MCP</span>
                <ArrowRightIcon className="h-3 w-3 rotate-180" />
              </div>
              <div className="flex items-center gap-1.5 px-2 py-1 bg-violet-500/10 border border-violet-400/35 rounded">
                <span className="h-1.5 w-1.5 rounded-full bg-violet-400" />
                <span className="text-violet-300 font-medium">OpenCode</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Outbound — OpenClaw Tools → OpenCode via MCP */}
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <ArrowRightIcon className="h-3 w-3 text-cyan-400" />
                <span className="text-[10px] font-medium text-cyan-400 uppercase">Outbound (OpenClaw → OpenCode)</span>
              </div>
              <div className="space-y-1.5">
                {(mcpStatus?.outbound?.tools || [
                  { name: 'knowledge_search', enabled: true, source: 'openclaw' },
                  { name: 'knowledge_graph', enabled: true, source: 'openclaw' },
                  { name: 'knowledge_write', enabled: true, source: 'openclaw' },
                  { name: 'web_search', enabled: true, source: 'openclaw' },
                ]).map(tool => (
                  <div key={tool.name} className="flex items-center justify-between gap-2 text-[11px]">
                    <div className="flex items-center gap-2">
                      {mcpToggling === `outbound:${tool.name}` ? (
                        <Loader2 className="h-3 w-3 animate-spin text-stone-400 flex-shrink-0" />
                      ) : tool.enabled ? (
                        <CheckCircle2 className="h-3 w-3 text-emerald-400 flex-shrink-0" />
                      ) : (
                        <XCircle className="h-3 w-3 text-stone-600 flex-shrink-0" />
                      )}
                      <span className={tool.enabled ? 'text-stone-300' : 'text-stone-600'}>{tool.name}</span>
                    </div>
                    <Switch
                      checked={tool.enabled}
                      onCheckedChange={(checked) => handleMcpToggle('outbound', tool.name, checked)}
                      disabled={mcpToggling === `outbound:${tool.name}`}
                      className="scale-75 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-slate-700"
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Inbound — OpenCode Tools → OpenClaw as Skills */}
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <ArrowRightIcon className="h-3 w-3 text-violet-400 rotate-180" />
                <span className="text-[10px] font-medium text-violet-400 uppercase">Inbound (OpenCode → OpenClaw)</span>
              </div>
              <div className="space-y-1.5">
                {(mcpStatus?.inbound?.tools || [
                  { name: 'file_read', enabled: true, source: 'opencode' },
                  { name: 'file_edit', enabled: true, source: 'opencode' },
                  { name: 'bash_exec', enabled: true, source: 'opencode' },
                  { name: 'lsp_diag', enabled: true, source: 'opencode' },
                  { name: 'fetch_url', enabled: true, source: 'opencode' },
                ]).map(tool => (
                  <div key={tool.name} className="flex items-center justify-between gap-2 text-[11px]">
                    <div className="flex items-center gap-2">
                      {mcpToggling === `inbound:${tool.name}` ? (
                        <Loader2 className="h-3 w-3 animate-spin text-stone-400 flex-shrink-0" />
                      ) : tool.enabled ? (
                        <CheckCircle2 className="h-3 w-3 text-emerald-400 flex-shrink-0" />
                      ) : (
                        <XCircle className="h-3 w-3 text-stone-600 flex-shrink-0" />
                      )}
                      <span className={tool.enabled ? 'text-stone-300' : 'text-stone-600'}>{tool.name}</span>
                    </div>
                    <Switch
                      checked={tool.enabled}
                      onCheckedChange={(checked) => handleMcpToggle('inbound', tool.name, checked)}
                      disabled={mcpToggling === `inbound:${tool.name}`}
                      className="scale-75 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-slate-700"
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between">
            {mcpStatus?.lastSync && (
              <span className="text-[9px] text-stone-600">
                Last sync: {new Date(mcpStatus.lastSync).toLocaleString()}
              </span>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[9px] ml-auto border-stone-600 text-stone-400 hover:bg-stone-500/10"
              onClick={async () => {
                try {
                  const res = await authedFetch('/api/opencode/mcp/register', { method: 'POST' })
                  const data = await res.json()
                  toast({ title: 'MCP Tools đã đăng ký', description: `${data.registered || 0} mới, ${data.updated || 0} cập nhật` })
                  loadMcpStatus()
                } catch {
                  toast({ title: 'Lỗi', description: 'Failed to register tools', variant: 'destructive' })
                }
              }}
            >
              <Settings className="h-3 w-3 mr-1" /> Register Skills
            </Button>
          </div>
        </div>
      </div>

      {/* ===== Section 5: Git Integration ===== */}
      <div className="nc-wrap nc-emerald">
        <div className="nc-panel nc-sm nc-border-emerald p-4">
          <div className="flex items-center justify-between mb-3">
            <button className="flex items-center gap-2" onClick={() => setGitSectionOpen(!gitSectionOpen)}>
              <GitBranch className="h-4 w-4 text-emerald-400" />
              <span className="text-sm font-semibold text-stone-100">Tích hợp Git</span>
              <ChevronDown className={`h-3.5 w-3.5 text-stone-500 transition-transform ${gitSectionOpen ? '' : '-rotate-90'}`} />
            </button>
            <div className="flex items-center gap-2">
              {gitLoading && <Loader2 className="h-3 w-3 animate-spin text-emerald-400" />}
              <Badge className={`text-[9px] border ${gitStatus.available ? 'bg-emerald-950/50 text-emerald-400 border-emerald-400/35' : 'bg-red-950/50 text-red-400 border-red-400/35'}`}>
                {gitStatus.available ? 'Sẵn sàng' : 'Không khả dụng'}
              </Badge>
              <Button
                size="sm"
                variant="outline"
                className="h-6 w-6 p-0 border-emerald-400/50 text-emerald-400 hover:bg-emerald-500/10"
                onClick={loadGitStatus}
                disabled={gitLoading}
              >
                <RefreshCw className={`h-3 w-3 ${gitLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>

          {gitSectionOpen && (
            <>
              {gitStatus.available ? (
                <>
                  {/* Branch & Sync Status */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                    <div>
                      <span className="text-[10px] text-stone-500 uppercase">Nhánh</span>
                      <p className="text-xs text-emerald-300 font-mono flex items-center gap-1">
                        <GitBranch className="h-3 w-3" />
                        {gitStatus.branch || '—'}
                      </p>
                    </div>
                    <div>
                      <span className="text-[10px] text-stone-500 uppercase">Commit cuối</span>
                      <p className="text-xs text-stone-300 font-mono truncate" title={gitStatus.lastCommit}>
                        {gitStatus.lastCommit ? gitStatus.lastCommit.substring(0, 20) : '—'}
                      </p>
                    </div>
                    <div>
                      <span className="text-[10px] text-stone-500 uppercase">Thay đổi</span>
                      <p className="text-xs text-stone-300">{gitStatus.totalChanges} tệp</p>
                    </div>
                    <div>
                      <span className="text-[10px] text-stone-500 uppercase">Ahead</span>
                      <p className="text-xs text-emerald-300">{gitStatus.ahead} commit</p>
                    </div>
                    <div>
                      <span className="text-[10px] text-stone-500 uppercase">Behind</span>
                      <p className="text-xs text-amber-300">{gitStatus.behind} commit</p>
                    </div>
                  </div>

                  {/* File Lists */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                    <div className="p-2 bg-slate-950/50 rounded-lg border border-amber-500/10">
                      <span className="text-[9px] text-amber-400 uppercase font-medium">Đã sửa ({gitStatus.modified.length})</span>
                      <div className="mt-1 space-y-0.5 max-h-20 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                        {gitStatus.modified.length > 0 ? gitStatus.modified.map((f, i) => (
                          <div key={i} className="text-[10px] text-stone-400 font-mono truncate">{f}</div>
                        )) : <span className="text-[9px] text-stone-600">Không có</span>}
                      </div>
                    </div>
                    <div className="p-2 bg-slate-950/50 rounded-lg border border-emerald-500/10">
                      <span className="text-[9px] text-emerald-400 uppercase font-medium">Đã staged ({gitStatus.staged.length})</span>
                      <div className="mt-1 space-y-0.5 max-h-20 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                        {gitStatus.staged.length > 0 ? gitStatus.staged.map((f, i) => (
                          <div key={i} className="text-[10px] text-stone-400 font-mono truncate">{f}</div>
                        )) : <span className="text-[9px] text-stone-600">Không có</span>}
                      </div>
                    </div>
                    <div className="p-2 bg-slate-950/50 rounded-lg border border-red-500/10">
                      <span className="text-[9px] text-red-400 uppercase font-medium">Chưa theo dõi ({gitStatus.untracked.length})</span>
                      <div className="mt-1 space-y-0.5 max-h-20 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                        {gitStatus.untracked.length > 0 ? gitStatus.untracked.map((f, i) => (
                          <div key={i} className="text-[10px] text-stone-400 font-mono truncate">{f}</div>
                        )) : <span className="text-[9px] text-stone-600">Không có</span>}
                      </div>
                    </div>
                  </div>

                  {/* Action Buttons */}
                  <div className="flex items-center gap-2 mb-3">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[10px] border-emerald-400/50 text-emerald-400 hover:bg-emerald-500/10"
                      onClick={() => loadGitDiff(false)}
                      disabled={gitLoading}
                    >
                      <FileCode className="h-3 w-3 mr-1" /> Xem Diff
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[10px] border-emerald-400/50 text-emerald-400 hover:bg-emerald-500/10"
                      onClick={() => loadGitDiff(true)}
                      disabled={gitLoading}
                    >
                      <FileCode className="h-3 w-3 mr-1" /> Diff Staged
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[10px] border-stone-600 text-stone-500"
                      disabled
                    >
                      <GitCommit className="h-3 w-3 mr-1" /> Commit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[10px] border-stone-600 text-stone-500"
                      disabled
                    >
                      <RotateCcw className="h-3 w-3 mr-1" /> Revert
                    </Button>
                  </div>

                  {/* Diff Display */}
                  {gitDiff && (
                    <div className="border-t border-emerald-500/10 pt-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] font-medium text-stone-300">Unified Diff</span>
                        {gitDiffStats.filesChanged > 0 && (
                          <div className="flex items-center gap-2 text-[9px]">
                            <span className="text-emerald-400">+{gitDiffStats.additions}</span>
                            <span className="text-red-400">-{gitDiffStats.deletions}</span>
                            <span className="text-stone-500">{gitDiffStats.filesChanged} tệp</span>
                          </div>
                        )}
                      </div>
                      <div className="bg-slate-950/80 rounded-lg border border-emerald-500/10 p-3 max-h-64 overflow-y-auto font-mono text-[10px]" style={{ scrollbarWidth: 'thin' }}>
                        {gitDiff.split('\n').map((line, i) => (
                          <div key={i} className={
                            line.startsWith('+') && !line.startsWith('++') ? 'text-emerald-400 bg-emerald-500/5' :
                            line.startsWith('-') && !line.startsWith('--') ? 'text-red-400 bg-red-500/5' :
                            line.startsWith('@@') ? 'text-cyan-400' :
                            line.startsWith('diff') || line.startsWith('index') ? 'text-stone-500 font-medium' :
                            'text-stone-400'
                          }>
                            {line}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex flex-col items-center justify-center py-6 text-stone-500">
                  <GitBranch className="h-8 w-8 mb-2" />
                  <p className="text-[11px]">Git không khả dụng</p>
                  <p className="text-[10px] text-stone-600">Server đang offline hoặc chưa cấu hình Git</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ===== Section 6: Session Timeline ===== */}
      <div className="nc-wrap nc-emerald">
        <div className="nc-panel nc-sm nc-border-emerald p-4">
          <div className="flex items-center justify-between mb-3">
            <button className="flex items-center gap-2" onClick={() => setTimelineSectionOpen(!timelineSectionOpen)}>
              <History className="h-4 w-4 text-emerald-400" />
              <span className="text-sm font-semibold text-stone-100">Dòng thời gian Session</span>
              <ChevronDown className={`h-3.5 w-3.5 text-stone-500 transition-transform ${timelineSectionOpen ? '' : '-rotate-90'}`} />
            </button>
            <div className="flex items-center gap-2">
              {timelineLoading && <Loader2 className="h-3 w-3 animate-spin text-emerald-400" />}
              {selectedTimelineSession && (
                <Badge className="text-[9px] bg-emerald-950/50 text-emerald-400 border border-emerald-400/35">
                  {selectedTimelineSession.substring(0, 8)}...
                </Badge>
              )}
            </div>
          </div>

          {timelineSectionOpen && (
            <>
              {!selectedTimelineSession ? (
                <div className="flex flex-col items-center justify-center py-6 text-stone-500">
                  <History className="h-8 w-8 mb-2" />
                  <p className="text-[11px]">Chưa chọn session</p>
                  <p className="text-[10px] text-stone-600">Nhấn vào nút ⏱ trong danh sách Session để xem dòng thời gian</p>
                </div>
              ) : timelineLoading ? (
                <div className="flex items-center justify-center h-16">
                  <Loader2 className="h-5 w-5 animate-spin text-emerald-400" />
                </div>
              ) : timelineData.timeline.length > 0 ? (
                <div className="relative pl-6 max-h-80 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                  {/* Vertical timeline line */}
                  <div className="absolute left-3 top-0 bottom-0 w-px bg-emerald-500/20" />
                  {timelineData.timeline.map((event, i) => {
                    const eventIcon: Record<string, string> = {
                      start: '🚀', file_read: '📁', tool_call: '🔧',
                      complete: '✅', error: '❌', paused: '⏸️',
                    }
                    const eventColor: Record<string, string> = {
                      start: 'text-emerald-400 bg-emerald-500/20',
                      file_read: 'text-blue-400 bg-blue-500/20',
                      tool_call: 'text-amber-400 bg-amber-500/20',
                      complete: 'text-green-400 bg-green-500/20',
                      error: 'text-red-400 bg-red-500/20',
                      paused: 'text-stone-400 bg-stone-500/20',
                    }
                    const color = eventColor[event.event] || eventColor.start
                    return (
                      <div key={i} className="relative mb-3 last:mb-0">
                        {/* Timeline dot */}
                        <div className={`absolute -left-6 top-0.5 h-5 w-5 rounded-full flex items-center justify-center text-[10px] ${color}`}>
                          {eventIcon[event.event] || '📋'}
                        </div>
                        <div className="ml-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] font-medium text-stone-200">{event.label}</span>
                            <span className="text-[9px] text-stone-600">{new Date(event.timestamp).toLocaleTimeString()}</span>
                          </div>
                          {event.detail && (
                            <p className="text-[10px] text-stone-500 mt-0.5">{event.detail}</p>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-6 text-stone-500">
                  <Clock className="h-8 w-8 mb-2" />
                  <p className="text-[11px]">Không có sự kiện</p>
                  <p className="text-[10px] text-stone-600">Session này chưa có hoạt động nào</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ===== Section 7: Knowledge Context Panel ===== */}
      <div className="nc-wrap nc-emerald">
        <div className="nc-panel nc-sm nc-border-emerald p-4">
          <div className="flex items-center justify-between mb-3">
            <button className="flex items-center gap-2" onClick={() => setKbSectionOpen(!kbSectionOpen)}>
              <Brain className="h-4 w-4 text-emerald-400" />
              <span className="text-sm font-semibold text-stone-100">Ngữ cảnh Kiến thức</span>
              <ChevronDown className={`h-3.5 w-3.5 text-stone-500 transition-transform ${kbSectionOpen ? '' : '-rotate-90'}`} />
            </button>
            <div className="flex items-center gap-2">
              {kbContextLoading && <Loader2 className="h-3 w-3 animate-spin text-emerald-400" />}
              <Button
                size="sm"
                variant="outline"
                className="h-6 w-6 p-0 border-emerald-400/50 text-emerald-400 hover:bg-emerald-500/10"
                onClick={() => loadKbContext()}
                disabled={kbContextLoading}
              >
                <RefreshCw className={`h-3 w-3 ${kbContextLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>

          {kbSectionOpen && (
            <>
              {/* Enrichment Score */}
              <div className="mb-3 p-2.5 bg-slate-950/50 rounded-lg border border-emerald-500/10">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] text-stone-400">Điểm làm phong phú</span>
                  <span className="text-[11px] font-medium text-emerald-300">{kbContext.enrichmentScore}%</span>
                </div>
                <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-emerald-500 to-cyan-400 rounded-full transition-all"
                    style={{ width: `${kbContext.enrichmentScore}%` }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                {/* Entities */}
                <div className="p-2.5 bg-slate-950/50 rounded-lg border border-emerald-500/10">
                  <span className="text-[9px] text-emerald-400 uppercase font-medium">Thực thể ({kbContext.entities.length})</span>
                  <div className="mt-1 space-y-1 max-h-24 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                    {kbContext.entities.length > 0 ? kbContext.entities.map((e, i) => (
                      <div key={i} className="text-[10px]">
                        <span className="text-stone-200 font-medium">{e.name}</span>
                        <span className="text-stone-600 ml-1">({e.type})</span>
                        {e.description && <p className="text-stone-500 truncate">{e.description}</p>}
                      </div>
                    )) : <span className="text-[9px] text-stone-600">Không có thực thể</span>}
                  </div>
                </div>

                {/* Documents */}
                <div className="p-2.5 bg-slate-950/50 rounded-lg border border-emerald-500/10">
                  <span className="text-[9px] text-cyan-400 uppercase font-medium">Tài liệu ({kbContext.documents.length})</span>
                  <div className="mt-1 space-y-1 max-h-24 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                    {kbContext.documents.length > 0 ? kbContext.documents.map((d, i) => (
                      <div key={i} className="text-[10px] flex items-center justify-between">
                        <span className="text-stone-300 truncate">{d.source}</span>
                        <Badge className="text-[8px] bg-cyan-950/50 text-cyan-400 border border-cyan-400/35 ml-1">{(d.score * 100).toFixed(0)}%</Badge>
                      </div>
                    )) : <span className="text-[9px] text-stone-600">Không có tài liệu</span>}
                  </div>
                </div>

                {/* Corrections */}
                <div className="p-2.5 bg-slate-950/50 rounded-lg border border-amber-500/10">
                  <span className="text-[9px] text-amber-400 uppercase font-medium">Sửa đổi ({kbContext.corrections.length})</span>
                  <div className="mt-1 space-y-1 max-h-24 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                    {kbContext.corrections.length > 0 ? kbContext.corrections.map((c, i) => (
                      <div key={i} className="text-[10px]">
                        <span className="text-stone-300 truncate">{c.content}</span>
                        <span className="text-stone-600 ml-1">{new Date(c.createdAt).toLocaleDateString()}</span>
                      </div>
                    )) : <span className="text-[9px] text-stone-600">Không có sửa đổi</span>}
                  </div>
                </div>

                {/* Insights */}
                <div className="p-2.5 bg-slate-950/50 rounded-lg border border-violet-500/10">
                  <span className="text-[9px] text-violet-400 uppercase font-medium">Insights ({kbContext.insights.length})</span>
                  <div className="mt-1 space-y-1 max-h-24 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                    {kbContext.insights.length > 0 ? kbContext.insights.map((ins, i) => (
                      <div key={i} className="text-[10px]">
                        <Badge className="text-[8px] bg-violet-950/50 text-violet-400 border border-violet-400/35 mr-1">{ins.type}</Badge>
                        <span className="text-stone-300">{ins.content}</span>
                      </div>
                    )) : <span className="text-[9px] text-stone-600">Không có insight</span>}
                  </div>
                </div>
              </div>

              {/* Custom Query */}
              <div className="flex gap-2">
                <Input
                  placeholder="Nhập truy vấn để thử làm phong phú..."
                  value={kbContextQuery}
                  onChange={e => setKbContextQuery(e.target.value)}
                  className="flex-1 h-8 text-[11px] bg-slate-950/50 border-emerald-400/35"
                  onKeyDown={e => { if (e.key === 'Enter' && kbContextQuery.trim()) { loadKbContext(kbContextQuery) } }}
                />
                <Button
                  size="sm"
                  className="h-8 text-[10px] bg-emerald-600 hover:bg-emerald-500 text-white"
                  onClick={() => loadKbContext(kbContextQuery)}
                  disabled={kbContextLoading || !kbContextQuery.trim()}
                >
                  <Lightbulb className="h-3 w-3 mr-1" /> Thử
                </Button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Phase 9: PendingEdit review modal (portal dialog) */}
      {showPendingModal && (
        <PendingEditModal
          edits={pendingEdits}
          onRefresh={() => { void loadPendingEdits() }}
          onClose={() => setShowPendingModal(false)}
        />
      )}
    </div>
  )
}

