'use client'

import { DiffEditor, loader } from '@monaco-editor/react'

// Local vendored Monaco — same module-level loader config as CodeEditor (no CDN)
loader.config({ paths: { vs: '/monaco-vs' } })

export interface DiffViewerProps {
  originalContent: string
  modifiedContent: string
  language?: string
  height?: string
}

/**
 * Read-only side-by-side Monaco diff viewer (Phase 9).
 * Used both for session diffs (editor buffer vs original) and for
 * PendingEdit before/after review.
 */
export function DiffViewer({
  originalContent,
  modifiedContent,
  language,
  height = '100%',
}: DiffViewerProps) {
  return (
    <DiffEditor
      height={height}
      language={language}
      original={originalContent}
      modified={modifiedContent}
      theme="vs-dark"
      loading={
        <div className="flex items-center justify-center h-full bg-slate-950">
          <span className="text-[10px] font-mono text-stone-500">Đang tải diff…</span>
        </div>
      }
      options={{
        readOnly: true,
        renderSideBySide: true,
        minimap: { enabled: false },
        automaticLayout: true,
        fontSize: 13,
        scrollBeyondLastLine: false,
        renderOverviewRuler: false,
        diffWordWrap: 'off',
        ignoreTrimWhitespace: false,
      }}
    />
  )
}
