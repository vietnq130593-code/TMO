'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Loader2, Search as SearchIcon, X } from 'lucide-react'

export interface SearchPanelProps {
  onResultClick: (path: string, line: number) => void
  root?: string
  onClose: () => void
}

interface SearchHit {
  path: string
  line: number
  text: string
}

/**
 * Phase 10 — workspace-wide search panel (ripgrep-backed).
 * Type a keyword → POST /api/opencode/search → clickable path:line results.
 */
export function SearchPanel({ onResultClick, root, onClose }: SearchPanelProps) {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [results, setResults] = useState<SearchHit[]>([])

  const runSearch = async () => {
    if (!query.trim() || loading) return
    setLoading(true)
    setSearched(true)
    try {
      const res = await fetch('/api/opencode/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim(), root }),
      })
      const data = await res.json().catch(() => ({ results: [] }))
      setResults(Array.isArray(data.results) ? data.results : [])
    } catch {
      setResults([])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 w-full" data-testid="search-panel">
      <div className="flex items-center gap-1.5">
        <SearchIcon className="h-3 w-3 text-emerald-400 flex-shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); if (e.key === 'Escape') onClose() }}
          placeholder="Từ khóa tìm trong workspace..."
          autoFocus
          className="flex-1 min-w-0 h-6 px-2 text-[10px] font-mono bg-slate-950/70 border border-emerald-400/25 rounded-sm text-stone-200 placeholder:text-stone-600 focus:outline-none focus:border-emerald-400/60"
        />
        <Button
          size="sm"
          className="h-6 px-2 text-[9px] bg-emerald-600 hover:bg-emerald-500 text-white flex-shrink-0"
          disabled={!query.trim() || loading}
          onClick={() => void runSearch()}
        >
          {loading ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : 'Tìm'}
        </Button>
        <button
          className="text-stone-500 hover:text-red-400 flex-shrink-0 px-0.5"
          onClick={onClose}
          title="Đóng tìm kiếm"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      <div className="max-h-[220px] overflow-y-auto flex flex-col gap-0.5" style={{ scrollbarWidth: 'thin' }}>
        {!searched && !loading && (
          <p className="text-[9px] text-stone-600 px-1 py-1">Nhập từ khóa để tìm trong workspace</p>
        )}
        {searched && !loading && results.length === 0 && (
          <p className="text-[9px] text-stone-600 px-1 py-1">Không tìm thấy kết quả</p>
        )}
        {results.map((hit, i) => (
          <button
            key={`${hit.path}:${hit.line}:${i}`}
            className="text-left px-1.5 py-1 rounded-sm hover:bg-emerald-500/10 transition-colors group"
            onClick={() => onResultClick(hit.path, hit.line)}
            title={`${hit.path}:${hit.line}`}
          >
            <span className="block font-mono text-[9px] text-stone-500 group-hover:text-emerald-400 truncate">
              {hit.path.replace(/^\/home\/z\//, '~/')}:{hit.line}
            </span>
            <span className="block text-[10px] text-stone-300 truncate">{hit.text}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
