'use client'

import Editor, { loader, type OnMount } from '@monaco-editor/react'
import { useEffect, useRef } from 'react'

// Phase 8 — Monaco is served LOCALLY from /monaco-vs (vendored copy of
// node_modules/monaco-editor/min/vs). Must run at module top-level, before
// any <Editor> mounts, so the wrapper never falls back to the jsdelivr CDN.
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
}

export interface CodeEditorProps {
  openFiles: OpenFile[]
  activeFileIndex: number
  onActiveChange: (idx: number) => void
  onContentChange: (idx: number, content: string) => void
  onSave: (idx: number) => void
  onClose: (idx: number) => void
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
            <span className="truncate max-w-[160px]">{f.path.split('/').pop()}</span>
            {f.isDirty && (
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" aria-label="unsaved changes" />
            )}
            <span
              role="button"
              aria-label={`Close ${f.path.split('/').pop()}`}
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
            minimap: { enabled: true },
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
    </div>
  )
}
