'use client'

import Editor, { loader, type OnMount } from '@monaco-editor/react'
import { useEffect, useRef } from 'react'
import { Binary, AlertTriangle } from 'lucide-react'

// Phase 8 — Monaco is served LOCALLY from /monaco-vs (vendored copy of
// node_modules/monaco-editor/min/vs). Must run at module top-level, before
// any <Editor> mounts, so the wrapper never falls back to the jsdelivr CDN.
//
loader.config({ paths: { vs: '/monaco-vs' } })

export interface OpenFile {
  path: string
  content: string
  originalContent: string
  isDirty: boolean
  /** Optional metadata from GET /api/opencode/files/read (drives the tab header badges) */
  language?: string
  lines?: number
  size?: number
  /** FIX 2026-08-29: binary file (VD .exe/.png/.db) — render placeholder, không mở Monaco */
  isBinary?: boolean
  /** xxd-style hex preview (512 byte đầu) — chỉ có khi isBinary */
  hexPreview?: string
  /** FIX 2026-08-29: text file >2MB — nội dung bị cắt, tab PHẢI read-only */
  truncated?: boolean
  /** Tổng kích thước gốc (bytes) khi truncated */
  totalSize?: number
}

export interface CodeEditorProps {
  openFiles: OpenFile[]
  activeFileIndex: number
  onActiveChange: (idx: number) => void
  onContentChange: (idx: number, content: string) => void
  onSave: (idx: number) => void
  onClose: (idx: number) => void
}

/** Cross-platform basename — Windows path dùng backslash (VD "E:\APP\x.ts") */
export function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

function humanSize(bytes?: number): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return ''
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/** Map file extension → Monaco language id */
export function detectLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', jsonc: 'json',
    md: 'markdown', mdx: 'markdown',
    css: 'css', scss: 'scss', less: 'less',
    html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
    py: 'python', go: 'go', rs: 'rust', java: 'java',
    c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cs: 'csharp',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
    sql: 'sql', php: 'php', rb: 'ruby', swift: 'swift',
    kt: 'kotlin', dart: 'dart',
  }
  return map[ext || ''] || 'plaintext'
}

export function CodeEditor({
  openFiles,
  activeFileIndex,
  onActiveChange,
  onContentChange,
  onSave,
  onClose,
}: CodeEditorProps) {
  // Refs so the closures captured at mount time (Ctrl+S command + onChange)
  // always see the CURRENT active index / save callback — <Editor> only
  // remounts when the active PATH changes, not when activeFileIndex shifts.
  const activeIndexRef = useRef(activeFileIndex)
  const onSaveRef = useRef(onSave)
  useEffect(() => {
    activeIndexRef.current = activeFileIndex
    onSaveRef.current = onSave
  })

  const handleMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current(activeIndexRef.current)
    })
  }

  if (openFiles.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-stone-500 text-xs">
        No file open
      </div>
    )
  }

  // Guard against transient out-of-range index (e.g. close-tab re-render)
  const activeFile = openFiles[Math.min(Math.max(activeFileIndex, 0), openFiles.length - 1)]

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Tab bar */}
      <div
        className="flex flex-shrink-0 border-b border-emerald-500/10 bg-slate-950/90 overflow-x-auto"
        style={{ scrollbarWidth: 'thin' }}
      >
        {openFiles.map((f, idx) => (
          <button
            key={f.path}
            role="tab"
            aria-selected={idx === activeFileIndex}
            title={f.path}
            onClick={() => onActiveChange(idx)}
            className={`group flex items-center gap-1.5 h-7 px-2.5 text-[10px] font-mono whitespace-nowrap border-r border-emerald-500/10 transition-colors ${
              idx === activeFileIndex
                ? 'bg-slate-800/70 text-emerald-300 shadow-[inset_0_-2px_0_0_rgb(52,211,153)]'
                : 'text-stone-400 hover:text-stone-200 hover:bg-slate-800/40'
            }`}
          >
            {/* FIX 2026-08-29 (Windows): split('/') sai với path backslash — tab hiển thị
                NGUYÊN đường dẫn "E:\APP\TMO-main\file.ts" thay vì tên file. baseName xử lý cả 2. */}
            <span className="truncate max-w-[160px]">{baseName(f.path)}</span>
            {f.isBinary && (
              <span className="text-[8px] px-1 rounded bg-purple-950/60 text-purple-300 border border-purple-500/30 flex-shrink-0" title="File nhị phân">BIN</span>
            )}
            {f.truncated && (
              <span className="text-[8px] px-1 rounded bg-amber-950/60 text-amber-300 border border-amber-500/30 flex-shrink-0" title="Chỉ hiển thị phần đầu (read-only)">✂</span>
            )}
            {f.isDirty && (
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" aria-label="unsaved changes" />
            )}
            <span
              role="button"
              aria-label={`Close ${baseName(f.path)}`}
              className="tab-close ml-0.5 px-0.5 text-stone-600 hover:text-red-400 rounded leading-none"
              onClick={(e) => {
                e.stopPropagation()
                onClose(idx)
              }}
            >
              ×
            </span>
          </button>
        ))}
      </div>

      {/* FIX 2026-08-29 — binary file: placeholder kiểu VSCode thay vì editor trống/lỗi */}
      {activeFile.isBinary ? (
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center bg-slate-950/40 p-4 overflow-hidden">
          <div className="flex flex-col items-center max-w-full">
            <Binary className="h-10 w-10 mb-3 text-purple-300" />
            <p className="text-xs text-stone-200 font-medium text-center">
              File nhị phân — không hiển thị được trong editor
            </p>
            <p className="text-[10px] text-stone-500 mt-1 text-center font-mono break-all">
              {baseName(activeFile.path)} · {humanSize(activeFile.size)}
            </p>
            <p className="text-[10px] text-stone-600 mt-2 text-center max-w-md">
              File chứa dữ liệu nhị phân (executable / image / database...). Dùng shell tool
              (<span className="font-mono text-stone-400">file</span>,{' '}
              <span className="font-mono text-stone-400">strings</span>,{' '}
              <span className="font-mono text-stone-400">xxd</span>) để xử lý qua terminal.
            </p>
            {activeFile.hexPreview && (
              <pre
                className="mt-4 w-full max-w-2xl max-h-64 overflow-auto rounded-md border border-purple-500/20 bg-slate-950/80 p-3 text-[10px] leading-relaxed font-mono text-stone-400"
                style={{ scrollbarWidth: 'thin' }}
                aria-label="Hex preview 512 byte đầu"
              >
                {activeFile.hexPreview}
              </pre>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* FIX 2026-08-29 — file text >2MB: banner cảnh báo + editor read-only
              (ghi đè content bị cắt lên disk sẽ MẤT dữ liệu phần còn lại) */}
          {activeFile.truncated && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-950/40 border-b border-amber-500/20 text-amber-300 flex-shrink-0">
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="text-[10px]">
                File lớn ({humanSize(activeFile.totalSize)}) — hiển thị 2 MB đầu,{' '}
                <span className="font-semibold">read-only</span> để tránh ghi đè mất phần còn lại
              </span>
            </div>
          )}
          {/* Monaco editor */}
          <div className="flex-1 min-h-0">
            <Editor
              key={activeFile.path}
              height="100%"
              theme="vs-dark"
              language={detectLanguage(activeFile.path)}
              value={activeFile.content}
              onMount={handleMount}
              onChange={(value) => onContentChange(activeIndexRef.current, value ?? '')}
              loading={<div className="flex h-full items-center justify-center text-stone-500 text-xs">Đang tải editor...</div>}
              options={{
                minimap: { enabled: !activeFile.truncated },
                readOnly: !!activeFile.truncated,
                fontSize: 13,
                lineNumbers: 'on',
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                automaticLayout: true,
                tabSize: 2,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                renderWhitespace: 'selection',
              }}
            />
          </div>
        </>
      )}
    </div>
  )
}
