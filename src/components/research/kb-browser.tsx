'use client'

/**
 * KbBrowser — P8 UI (Task S7-P8) — KB tab content
 * ==============================================================
 * Spec:
 *  - TB-13 §2.2 — KB query (GET action=stats|query) + POST seed/add/retire/curate/snapshot.
 *  - TB-05 §5 + DR-C6 — KB 3 layers: SQLite canonical + snapshot .md + Live read-only.
 *  - TB-08 §4 + DECISION-RECORD v1.3 — Curate kép 3 mốc (phase 1→2→3).
 *  - TB-12 §3.2 TC-05 — KB cold-start seed idempotent.
 *
 * Behavior:
 *  - GET /api/research/kb?action=stats → header stats card.
 *  - GET /api/research/kb?action=query&category=X&search=Y&limit=50 → list entries.
 *  - POST action=seed (TC-05 idempotent), action=snapshot (export .md files).
 *  - Per entry: action=curate (1→2 or 2→3), action=retire (Input reason).
 *
 * Fail-open: API error → Alert. KHÔNG crash.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  AlertTriangle,
  BookMarked,
  ChevronDown,
  Database,
  Filter,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  TrendingUp,
} from 'lucide-react'

// ==================== Types (mirror API contract) ====================

interface KBStats {
  total: number
  active: number
  retired: number
  byCategory: Record<string, number>
  byPhase: Record<string, number>
  snapshotGeneratedAt: string | null
}

interface KBEntry {
  id: string
  category: string
  title: string
  content: string
  sourceMission: string | null
  phase: number
  snapshotMdPath: string | null
  retiredAt: string | null
  createdAt: string
  updatedAt: string
}

interface KBStatsResponse {
  status: string
  stats: KBStats
}

interface KBQueryResponse {
  status: string
  entries: KBEntry[]
  total: number
  limit: number
  offset: number
  filter: { category: string | null; phase: number | null; search: string | null; includeRetired: boolean }
}

interface KBActionResult {
  status: 'ok' | 'error'
  seeded?: number
  categories?: string[]
  message?: string
  id?: string
  entry?: KBEntry
  files?: string[]
  indexMd?: string
  generatedAt?: string
  fileCount?: number
  error?: string
}

// ==================== Helpers ====================

const CATEGORY_COLORS: Record<string, string> = {
  lesson: 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10',
  'anti-pattern': 'border-red-500/40 text-red-300 bg-red-500/10',
  baseline: 'border-cyan-500/40 text-cyan-300 bg-cyan-500/10',
  pattern: 'border-violet-500/40 text-violet-300 bg-violet-500/10',
  calibration: 'border-amber-500/40 text-amber-300 bg-amber-500/10',
}

function categoryBadgeClass(category: string): string {
  return CATEGORY_COLORS[category] ?? 'border-stone-700 text-stone-300 bg-stone-800/50'
}

function phaseBadgeClass(phase: number): string {
  if (phase === 1) return 'border-stone-600 text-stone-300 bg-stone-800/40'
  if (phase === 2) return 'border-amber-500/40 text-amber-300 bg-amber-500/10'
  if (phase === 3) return 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10'
  return 'border-stone-700 text-stone-300 bg-stone-800/50'
}

const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All categories' },
  { value: 'lesson', label: 'lesson' },
  { value: 'anti-pattern', label: 'anti-pattern' },
  { value: 'baseline', label: 'baseline' },
  { value: 'pattern', label: 'pattern' },
  { value: 'calibration', label: 'calibration' },
]

// ==================== Component ====================

export function KbBrowser() {
  // --- Stats state ---
  const [stats, setStats] = useState<KBStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)

  // --- Query state ---
  const [entries, setEntries] = useState<KBEntry[]>([])
  const [total, setTotal] = useState(0)
  const [queryLoading, setQueryLoading] = useState(true)
  const [queryError, setQueryError] = useState<string | null>(null)
  const [filterCategory, setFilterCategory] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [includeRetired, setIncludeRetired] = useState(false)

  // --- Action loading ---
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [snapshotResult, setSnapshotResult] = useState<KBActionResult | null>(null)

  // --- Per-entry retire state ---
  const [retireId, setRetireId] = useState<string | null>(null)
  const [retireReason, setRetireReason] = useState('')

  // -------------------- Fetch stats --------------------
  const fetchStats = useCallback(async () => {
    setStatsLoading(true)
    try {
      const res = await fetch('/api/research/kb?action=stats')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as KBStatsResponse
      setStats(data.stats)
    } catch {
      setStats(null)
    } finally {
      setStatsLoading(false)
    }
  }, [])

  // -------------------- Fetch entries --------------------
  const fetchEntries = useCallback(async () => {
    setQueryLoading(true)
    setQueryError(null)
    try {
      const params = new URLSearchParams()
      params.set('action', 'query')
      params.set('limit', '50')
      if (filterCategory !== 'all') params.set('category', filterCategory)
      if (search.trim()) params.set('search', search.trim())
      if (includeRetired) params.set('includeRetired', 'true')
      const res = await fetch(`/api/research/kb?${params.toString()}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as KBQueryResponse
      setEntries(data.entries)
      setTotal(data.total)
    } catch (err) {
      setQueryError(err instanceof Error ? err.message : String(err))
      setEntries([])
    } finally {
      setQueryLoading(false)
    }
  }, [filterCategory, search, includeRetired])

  useEffect(() => {
    queueMicrotask(() => void fetchStats())
  }, [fetchStats])

  useEffect(() => {
    queueMicrotask(() => void fetchEntries())
  }, [fetchEntries])

  // -------------------- Actions --------------------
  async function handleSeed() {
    setActionLoading('seed')
    try {
      const res = await fetch('/api/research/kb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'seed' }),
      })
      const json = (await res.json()) as KBActionResult
      if (!res.ok || json.status === 'error') {
        throw new Error(json.error || `HTTP ${res.status}`)
      }
      toast.success(json.message || `Seed OK — ${json.seeded ?? 0} entries`)
      void fetchStats()
      void fetchEntries()
    } catch (err) {
      toast.error(`Seed failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setActionLoading(null)
    }
  }

  async function handleSnapshot() {
    setActionLoading('snapshot')
    setSnapshotResult(null)
    try {
      const res = await fetch('/api/research/kb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'snapshot' }),
      })
      const json = (await res.json()) as KBActionResult
      if (!res.ok || json.status === 'error') {
        throw new Error(json.error || `HTTP ${res.status}`)
      }
      setSnapshotResult(json)
      toast.success(`Snapshot OK — ${json.fileCount ?? 0} files generated`)
      void fetchStats()
    } catch (err) {
      toast.error(`Snapshot failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setActionLoading(null)
    }
  }

  async function handleCurate(entry: KBEntry, toPhase: 2 | 3) {
    const fromPhase = entry.phase as 1 | 2
    if (fromPhase >= toPhase) {
      toast.error(`Curate chỉ tăng phase (1→2→3) — entry hiện tại phase ${entry.phase}`)
      return
    }
    setActionLoading(`curate-${entry.id}`)
    try {
      const res = await fetch('/api/research/kb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'curate',
          id: entry.id,
          fromPhase,
          toPhase,
          curator: 'HAN',
          reason: `UI curate ${fromPhase}→${toPhase}`,
        }),
      })
      const json = (await res.json()) as KBActionResult
      if (!res.ok || json.status === 'error') {
        throw new Error(json.error || `HTTP ${res.status}`)
      }
      toast.success(`Curated ${entry.title.slice(0, 30)}… phase ${fromPhase}→${toPhase}`)
      void fetchEntries()
      void fetchStats()
    } catch (err) {
      toast.error(`Curate failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setActionLoading(null)
    }
  }

  async function handleRetire(entry: KBEntry) {
    if (!retireReason.trim()) {
      toast.error('Retire reason BẮT BUỘC')
      return
    }
    setActionLoading(`retire-${entry.id}`)
    try {
      const res = await fetch('/api/research/kb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'retire',
          id: entry.id,
          reason: retireReason.trim(),
        }),
      })
      const json = (await res.json()) as KBActionResult
      if (!res.ok || json.status === 'error') {
        throw new Error(json.error || `HTTP ${res.status}`)
      }
      toast.success(`Retired: ${entry.title.slice(0, 30)}…`)
      setRetireId(null)
      setRetireReason('')
      void fetchEntries()
      void fetchStats()
    } catch (err) {
      toast.error(`Retire failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setActionLoading(null)
    }
  }

  // -------------------- Render --------------------
  const categoryCounts = useMemo(() => {
    if (!stats) return null
    return Object.entries(stats.byCategory).sort((a, b) => b[1] - a[1])
  }, [stats])

  return (
    <div className="space-y-4">
      {/* Stats header */}
      <Card className="bg-stone-950/70 border-stone-800 text-stone-200">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <BookMarked className="h-4 w-4 text-amber-400" />
              Knowledge Base
              {stats && (
                <Badge variant="outline" className="text-[10px] border-stone-700 text-stone-400">
                  {stats.total} total · {stats.active} active · {stats.retired} retired
                </Badge>
              )}
            </CardTitle>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleSeed()}
                disabled={actionLoading === 'seed'}
                className="h-7 px-2 text-[11px] border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10"
                title="TC-05: cold-start idempotent seed"
              >
                {actionLoading === 'seed' ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <Sparkles className="h-3 w-3 mr-1" />
                )}
                Seed KB
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleSnapshot()}
                disabled={actionLoading === 'snapshot'}
                className="h-7 px-2 text-[11px] border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10"
                title="Export KB snapshot .md files"
              >
                {actionLoading === 'snapshot' ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <Database className="h-3 w-3 mr-1" />
                )}
                Export Snapshot
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void fetchStats()
                  void fetchEntries()
                }}
                className="h-7 px-2 text-[11px] text-stone-400 hover:text-stone-200"
              >
                <RefreshCw className="h-3 w-3" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {statsLoading ? (
            <Skeleton className="h-20 w-full bg-stone-900/60" />
          ) : stats ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-[10px]">
                <div className="rounded-md border border-stone-800 bg-stone-900/40 px-2 py-1.5">
                  <div className="text-stone-500 uppercase">Total</div>
                  <div className="text-stone-200 font-medium text-sm tabular-nums">{stats.total}</div>
                </div>
                <div className="rounded-md border border-stone-800 bg-stone-900/40 px-2 py-1.5">
                  <div className="text-stone-500 uppercase">Active</div>
                  <div className="text-emerald-300 font-medium text-sm tabular-nums">{stats.active}</div>
                </div>
                <div className="rounded-md border border-stone-800 bg-stone-900/40 px-2 py-1.5">
                  <div className="text-stone-500 uppercase">Retired</div>
                  <div className="text-stone-400 font-medium text-sm tabular-nums">{stats.retired}</div>
                </div>
                <div className="rounded-md border border-stone-800 bg-stone-900/40 px-2 py-1.5">
                  <div className="text-stone-500 uppercase">Phase 1</div>
                  <div className="text-stone-300 font-medium text-sm tabular-nums">{stats.byPhase['1'] ?? 0}</div>
                </div>
                <div className="rounded-md border border-stone-800 bg-stone-900/40 px-2 py-1.5">
                  <div className="text-stone-500 uppercase">Phase 2</div>
                  <div className="text-amber-300 font-medium text-sm tabular-nums">{stats.byPhase['2'] ?? 0}</div>
                </div>
              </div>
              {categoryCounts && categoryCounts.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[10px] text-stone-500 uppercase">By category:</span>
                  {categoryCounts.map(([cat, count]) => (
                    <Badge key={cat} variant="outline" className={`text-[10px] h-5 ${categoryBadgeClass(cat)}`}>
                      {cat} · {count}
                    </Badge>
                  ))}
                </div>
              )}
              {stats.snapshotGeneratedAt && (
                <div className="text-[10px] text-stone-500">
                  Last snapshot: {stats.snapshotGeneratedAt.slice(0, 19).replace('T', ' ')}
                </div>
              )}
            </div>
          ) : (
            <Alert variant="destructive" className="bg-red-950/40 border-red-500/40">
              <AlertDescription className="text-xs">Stats fetch failed</AlertDescription>
            </Alert>
          )}

          {snapshotResult && (
            <Alert className="mt-2 bg-cyan-950/40 border-cyan-500/40">
              <Database className="h-3.5 w-3.5 text-cyan-300" />
              <AlertTitle className="text-xs text-cyan-200">Snapshot exported</AlertTitle>
              <AlertDescription className="text-[11px] text-stone-300">
                Generated at {snapshotResult.generatedAt?.slice(0, 19).replace('T', ' ')} ·{' '}
                {snapshotResult.fileCount ?? 0} files:
                <ul className="mt-1 list-disc list-inside space-y-0.5 font-mono text-[10px]">
                  {snapshotResult.files?.slice(0, 8).map((f, i) => (
                    <li key={i} className="text-stone-400">{f}</li>
                  ))}
                  {(snapshotResult.files?.length ?? 0) > 8 && (
                    <li className="text-stone-500 italic">
                      … +{(snapshotResult.files?.length ?? 0) - 8} more
                    </li>
                  )}
                </ul>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Query filter + entries */}
      <Card className="bg-stone-950/70 border-stone-800 text-stone-200">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-sm font-semibold">
              KB Entries{' '}
              <Badge variant="outline" className="ml-1 text-[10px] border-stone-700 text-stone-400">
                {total}
              </Badge>
            </CardTitle>
            <button
              onClick={() => void fetchEntries()}
              className="text-[11px] text-stone-400 hover:text-stone-200 inline-flex items-center gap-1"
            >
              <RefreshCw className={`h-3 w-3 ${queryLoading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            <div className="flex items-center gap-1 text-[10px] text-stone-400">
              <Filter className="h-3 w-3" /> Filter:
            </div>
            <Select value={filterCategory} onValueChange={setFilterCategory}>
              <SelectTrigger className="bg-stone-900 border-stone-700 text-stone-300 text-xs h-7 w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label className="flex items-center gap-1 text-[11px] text-stone-400 cursor-pointer">
              <input
                type="checkbox"
                checked={includeRetired}
                onChange={(e) => setIncludeRetired(e.target.checked)}
                className="h-3 w-3 accent-violet-500"
              />
              Include retired
            </label>
            <div className="relative flex-1 min-w-[120px]">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-stone-500" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search title/content…"
                className="bg-stone-900 border-stone-700 text-stone-300 placeholder:text-stone-500 text-xs h-7 pl-7"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {queryLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full bg-stone-900/60" />
              ))}
            </div>
          ) : queryError ? (
            <Alert variant="destructive" className="bg-red-950/40 border-red-500/40">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Fetch failed</AlertTitle>
              <AlertDescription className="text-xs">{queryError}</AlertDescription>
            </Alert>
          ) : entries.length === 0 ? (
            <div className="text-xs text-stone-500 italic py-8 text-center">
              Không có KB entries. Click "Seed KB" để khởi tạo cold-start (TC-05).
            </div>
          ) : (
            <ScrollArea className="max-h-[600px]">
              <div className="space-y-1.5 pr-2">
                {entries.map((entry) => {
                  const isRetired = !!entry.retiredAt
                  const expanded = retireId === entry.id
                  return (
                    <Collapsible key={entry.id}>
                      <CollapsibleTrigger asChild>
                        <button className="w-full text-left rounded-md border border-stone-800 bg-stone-900/40 hover:bg-stone-900/70 hover:border-stone-700 transition-colors p-2.5 group">
                          <div className="flex items-center justify-between gap-2 mb-0.5">
                            <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                              <Badge variant="outline" className={`text-[9px] h-4 ${categoryBadgeClass(entry.category)}`}>
                                {entry.category}
                              </Badge>
                              <Badge variant="outline" className={`text-[9px] h-4 ${phaseBadgeClass(entry.phase)}`}>
                                P{entry.phase}
                              </Badge>
                              {isRetired && (
                                <Badge variant="outline" className="text-[9px] h-4 border-stone-600 text-stone-400 bg-stone-800/50">
                                  RETIRED
                                </Badge>
                              )}
                              {entry.phase < 3 && !isRetired && (
                                <Badge variant="outline" className="text-[9px] h-4 border-amber-500/30 text-amber-300/80 bg-amber-500/5">
                                  can curate
                                </Badge>
                              )}
                            </div>
                            <ChevronDown className="h-3 w-3 text-stone-500 group-data-[state=open]:rotate-180 transition-transform flex-shrink-0" />
                          </div>
                          <div className={`text-xs font-medium ${isRetired ? 'text-stone-500 line-through' : 'text-stone-200'}`}>
                            {entry.title}
                          </div>
                          <div className="text-[10px] text-stone-500 mt-0.5 line-clamp-1">
                            {entry.content.split('\n')[0]}
                          </div>
                        </button>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div className="rounded-md border border-stone-800 bg-stone-900/20 p-3 mt-1 space-y-2">
                          <div>
                            <div className="text-[10px] text-stone-500 uppercase mb-0.5">Content</div>
                            <pre className="text-[11px] text-stone-300 whitespace-pre-wrap break-words font-mono bg-stone-950/60 p-2 rounded border border-stone-800">
                              {entry.content}
                            </pre>
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-[10px] text-stone-500">
                            <div>Source: <code className="text-stone-400">{entry.sourceMission ?? '—'}</code></div>
                            <div>Phase: {entry.phase}</div>
                            <div>Created: {entry.createdAt.slice(0, 19).replace('T', ' ')}</div>
                            {entry.retiredAt && (
                              <div className="text-stone-400">Retired: {entry.retiredAt.slice(0, 19).replace('T', ' ')}</div>
                            )}
                            {entry.snapshotMdPath && (
                              <div className="col-span-2 truncate" title={entry.snapshotMdPath}>
                                Snapshot: <code className="text-stone-400">{entry.snapshotMdPath}</code>
                              </div>
                            )}
                          </div>

                          {!isRetired && (
                            <>
                              <Separator className="bg-stone-800" />
                              <div className="flex flex-wrap items-center gap-1.5">
                                <div className="text-[10px] text-stone-500 uppercase">Actions:</div>
                                {entry.phase === 1 && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={actionLoading === `curate-${entry.id}`}
                                    onClick={() => void handleCurate(entry, 2)}
                                    className="h-6 px-2 text-[10px] border-amber-500/40 text-amber-300 hover:bg-amber-500/10"
                                  >
                                    {actionLoading === `curate-${entry.id}` ? (
                                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                    ) : (
                                      <TrendingUp className="h-3 w-3 mr-1" />
                                    )}
                                    Promote 1→2
                                  </Button>
                                )}
                                {entry.phase === 2 && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={actionLoading === `curate-${entry.id}`}
                                    onClick={() => void handleCurate(entry, 3)}
                                    className="h-6 px-2 text-[10px] border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10"
                                  >
                                    {actionLoading === `curate-${entry.id}` ? (
                                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                    ) : (
                                      <TrendingUp className="h-3 w-3 mr-1" />
                                    )}
                                    Promote 2→3
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    setRetireId(expanded ? null : entry.id)
                                    setRetireReason('')
                                  }}
                                  className="h-6 px-2 text-[10px] border-red-500/40 text-red-300 hover:bg-red-500/10"
                                >
                                  <Trash2 className="h-3 w-3 mr-1" />
                                  Retire
                                </Button>
                              </div>

                              {expanded && (
                                <div className="space-y-1.5 rounded border border-red-500/30 bg-red-950/20 p-2">
                                  <Label className="text-[10px] text-stone-400">
                                    Retire reason <span className="text-red-400">*</span>
                                  </Label>
                                  <Textarea
                                    value={retireReason}
                                    onChange={(e) => setRetireReason(e.target.value)}
                                    placeholder="VD: Outdated — superseded by entry X"
                                    className="bg-stone-900 border-stone-700 text-stone-200 placeholder:text-stone-500 text-xs min-h-[40px] resize-y"
                                  />
                                  <div className="flex gap-1.5">
                                    <Button
                                      size="sm"
                                      variant="destructive"
                                      disabled={
                                        actionLoading === `retire-${entry.id}` ||
                                        !retireReason.trim()
                                      }
                                      onClick={() => void handleRetire(entry)}
                                      className="h-7 text-[11px]"
                                    >
                                      {actionLoading === `retire-${entry.id}` ? (
                                        <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                      ) : (
                                        <Trash2 className="h-3 w-3 mr-1" />
                                      )}
                                      Confirm Retire
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => {
                                        setRetireId(null)
                                        setRetireReason('')
                                      }}
                                      className="h-7 text-[11px] text-stone-400"
                                    >
                                      Cancel
                                    </Button>
                                  </div>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  )
                })}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export { KbBrowser as default }
