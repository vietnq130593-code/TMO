'use client'

// ========================================================================
// memory-tab — Tab Memory (Smolab)
// PERF-SPLIT 2026-09-03: trích xuất nguyên vẹn từ src/app/page.tsx (không đổi logic)
// ========================================================================

import { useState, useCallback, useEffect } from 'react'
import { Loader2, RefreshCw, Brain, Zap, ChevronLeft, ChevronRight, Trash2, X, AlertCircle, Flame, Archive, Snowflake, Thermometer } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast as sonnerToast } from 'sonner'


// ==================== MEMORY TAB CONTENT ====================

export interface MemoryRow {
  id: string
  tier: 'hot' | 'warm' | 'cold'
  sessionId?: string | null
  content: string
  context?: string | null
  importance: number
  accessCount?: number
  lastAccessedAt?: string | null
  source?: string
  tags?: string | null
  domain?: string
  isActive?: boolean
  category?: string
  role?: string
  expiresAt?: string | null
  createdAt: string
  updatedAt?: string
}


export interface ArchiveRow {
  id: string
  originalIds: string
  summaryContent: string
  domain: string
  importance: number
  sourceCount: number
  qdrantPointId: string | null
  embeddingModel: string | null
  expiresAt: string | null
  createdAt: string
}


export interface TierStats {
  tiers: { hot: number; warm: number; coldInactive: number; coldArchive: number }
  domains: { user: number; work: number; meta: number }
  pending: { decayed: number; expiredArchives: number }
}


// USER REQUEST 2026-08-28 (Memory tab persistence): lựa chọn agent trong tab
// Memory phải được GIỮ NGUYÊN khi user chuyển tab khác / module khác rồi quay
// lại — MemoryTabContent unmount khi rời tab nên state mất; persist qua
// localStorage (cùng pattern với smolab-chat-context-v1).
export const MEMORY_TAB_AGENT_KEY = 'smolab-memory-selected-agent-v1'

export const MEMORY_TAB_TIER_KEY = 'smolab-memory-active-tier-v1'


export function MemoryTabContent() {
  // Agent selector
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string>('')
  const [agentsLoading, setAgentsLoading] = useState(true)

  // Tier stats
  const [tierStats, setTierStats] = useState<TierStats | null>(null)
  const [tierStatsLoading, setTierStatsLoading] = useState(false)

  // Active sub-tab
  const [activeTier, setActiveTier] = useState<'hot' | 'warm' | 'cold' | 'archive'>('warm')

  // Memory list
  const [memories, setMemories] = useState<{ hot: MemoryRow[]; warm: MemoryRow[]; cold: MemoryRow[] }>({ hot: [], warm: [], cold: [] })
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memoryPage, setMemoryPage] = useState(1)
  const [memoryTotals, setMemoryTotals] = useState({ hot: 0, warm: 0, cold: 0 })

  // Archive list (separate endpoint)
  const [archives, setArchives] = useState<ArchiveRow[]>([])
  const [archiveLoading, setArchiveLoading] = useState(false)
  const [archiveTotal, setArchiveTotal] = useState(0)

  // Search
  const [searchQuery, setSearchQuery] = useState('')

  // Action in progress
  const [actionLoading, setActionLoading] = useState(false)
  // Track which memory is being acted on (delete/promote/archive)
  const [actingId, setActingId] = useState<string | null>(null)

  // ---------- Load agent list + restore trạng thái đã lưu ----------
  // (Restore tier nằm trong async IIFE — setState sau await không bị
  //  "set-state-in-effect" lint và tránh hydration mismatch localStorage)
  useEffect(() => {
    (async () => {
      // Restore active tier sub-tab (localStorage phải đọc sau mount)
      try {
        const savedTier = localStorage.getItem(MEMORY_TAB_TIER_KEY)
        if (savedTier === 'hot' || savedTier === 'warm' || savedTier === 'cold' || savedTier === 'archive') {
          setActiveTier(savedTier)
        }
      } catch { /* non-fatal */ }

      setAgentsLoading(true)
      try {
        const res = await fetch('/api/agents')
        const data = await res.json()
        const list = (data.agents || data || []).map((a: { id: string; name: string }) => ({ id: a.id, name: a.name }))
        list.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))
        setAgents(list)
        // Restore agent đã chọn từ lần trước (user quay lại tab Memory) —
        // chỉ dùng khi agent vẫn còn tồn tại; nếu không thì về mặc định đầu danh sách
        const savedAgentId = (() => { try { return localStorage.getItem(MEMORY_TAB_AGENT_KEY) } catch { return null } })()
        if (savedAgentId && list.some(a => a.id === savedAgentId)) {
          setSelectedAgentId(savedAgentId)
        } else if (list.length > 0 && !selectedAgentId) {
          setSelectedAgentId(list[0].id)
        }
      } catch (e) {
        console.error('Failed to load agents:', e)
      } finally {
        setAgentsLoading(false)
      }
    })()
  }, [])

  // ---------- Load tier stats when agent changes ----------
  const fetchTierStats = useCallback(async () => {
    if (!selectedAgentId) return
    setTierStatsLoading(true)
    try {
      const res = await fetch(`/api/memory/tiers?agentId=${encodeURIComponent(selectedAgentId)}`)
      if (res.ok) setTierStats(await res.json())
    } catch (e) {
      console.error('Failed to load tier stats:', e)
    } finally {
      setTierStatsLoading(false)
    }
  }, [selectedAgentId])

  useEffect(() => {
    // (queueMicrotask: defer để không gọi setState đồng bộ trong body effect)
    queueMicrotask(() => { fetchTierStats() })
  }, [fetchTierStats])

  // ---------- Load memory list when agent or page changes ----------
  const fetchMemories = useCallback(async () => {
    if (!selectedAgentId) return
    setMemoryLoading(true)
    try {
      const params = new URLSearchParams({
        agentId: selectedAgentId,
        page: String(memoryPage),
        pageSize: '25',
      })
      if (searchQuery.trim()) params.set('search', searchQuery.trim())
      const res = await fetch(`/api/memory/list?${params.toString()}`)
      const data = await res.json()
      setMemories({
        hot: data.hot?.memories || [],
        warm: data.warm?.memories || [],
        cold: data.cold?.memories || [],
      })
      setMemoryTotals({
        hot: data.hot?.total || 0,
        warm: data.warm?.total || 0,
        cold: data.cold?.total || 0,
      })
    } catch (e) {
      console.error('Failed to load memories:', e)
    } finally {
      setMemoryLoading(false)
    }
  }, [selectedAgentId, memoryPage, searchQuery])

  useEffect(() => {
    // (queueMicrotask: defer để không gọi setState đồng bộ trong body effect)
    queueMicrotask(() => { fetchMemories() })
  }, [fetchMemories])

  // ---------- Load archive list ----------
  const fetchArchives = useCallback(async () => {
    if (!selectedAgentId) return
    setArchiveLoading(true)
    try {
      const params = new URLSearchParams({ agentId: selectedAgentId, pageSize: '25' })
      const res = await fetch(`/api/memory/archive?${params.toString()}`)
      const data = await res.json()
      setArchives(data.archives || [])
      setArchiveTotal(data.total || 0)
    } catch (e) {
      console.error('Failed to load archives:', e)
    } finally {
      setArchiveLoading(false)
    }
  }, [selectedAgentId])

  useEffect(() => {
    // (queueMicrotask: defer để không gọi setState đồng bộ trong body effect)
    if (activeTier === 'archive') queueMicrotask(() => { fetchArchives() })
  }, [activeTier, fetchArchives])

  // ---------- Actions ----------
  const handleRunTransition = useCallback(async (action: 'promote' | 'archive' | 'cleanup' | 'all') => {
    if (!selectedAgentId) return
    const labelMap: Record<string, string> = {
      promote: 'Promote HOT → WARM',
      archive: 'Archive WARM → COLD',
      cleanup: 'Cleanup expired COLD',
      all: 'Run all transitions',
    }
    if (!window.confirm(`Chạy "${labelMap[action]}" cho agent này?`)) return
    setActionLoading(true)
    try {
      const res = await fetch('/api/memory/tiers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: selectedAgentId, action }),
      })
      const data = await res.json()
      if (res.ok) {
        sonnerToast.success('Hoàn tất', {
          description: `promoted=${data.promoted ?? 0} archived=${data.archived ?? 0} cleaned=${data.cleaned ?? 0}`,
          duration: 4000,
        })
        fetchTierStats()
        fetchMemories()
        if (activeTier === 'archive') fetchArchives()
      } else {
        sonnerToast.error('Lỗi', { description: data.error || 'Thất bại', duration: 4000 })
      }
    } catch (e) {
      sonnerToast.error('Lỗi mạng', { description: e instanceof Error ? e.message : 'unknown', duration: 4000 })
    } finally {
      setActionLoading(false)
    }
  }, [selectedAgentId, activeTier, fetchTierStats, fetchMemories, fetchArchives])

  // FIX 2026-09-10: POST /api/memory/decay trước đây không có caller nào (endpoint
  // chết) — decay chỉ chạy tự động mỗi ~20 tin nhắn. Nút này cho phép chủ động chạy
  // decay ngay cho TẤT CẢ agent (importance giảm theo ngày không truy cập,
  // < 0.1 → deactivate + tier transition).
  const handleRunDecay = useCallback(async () => {
    if (!window.confirm('Chạy memory decay ngay cho TẤT CẢ agent? (importance giảm theo ngày không truy cập; < 0.1 → deactivate)')) return
    setActionLoading(true)
    try {
      const res = await fetch('/api/memory/decay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}), // no agentId → decay ALL agents
      })
      const data = await res.json()
      if (res.ok) {
        sonnerToast.success('Decay hoàn tất', {
          description: `agents=${data.agentsProcessed ?? 0}, decayed=${data.totals?.decayed ?? 0}, deactivated=${data.totals?.deactivated ?? 0}`,
          duration: 4000,
        })
        fetchTierStats()
        fetchMemories()
      } else {
        sonnerToast.error('Lỗi', { description: data.error || 'Thất bại', duration: 4000 })
      }
    } catch (e) {
      sonnerToast.error('Lỗi mạng', { description: e instanceof Error ? e.message : 'unknown', duration: 4000 })
    } finally {
      setActionLoading(false)
    }
  }, [fetchTierStats, fetchMemories])

  const handleDeleteMemory = useCallback(async (id: string) => {
    if (!window.confirm('Xóa memory này? Không thể hoàn tác.')) return
    setActingId(id)
    try {
      const res = await fetch(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (res.ok) {
        sonnerToast.success('Đã xóa memory', { duration: 2500 })
        fetchTierStats()
        fetchMemories()
      } else {
        const err = await res.json().catch(() => ({}))
        sonnerToast.error('Lỗi xóa', { description: err.error || 'thất bại', duration: 4000 })
      }
    } finally {
      setActingId(null)
    }
  }, [fetchTierStats, fetchMemories])

  const handleMoveMemory = useCallback(async (id: string, action: 'promote' | 'archive') => {
    setActingId(id)
    try {
      const res = await fetch(`/api/memory/${encodeURIComponent(id)}?action=${action}`, { method: 'PATCH' })
      if (res.ok) {
        const data = await res.json()
        sonnerToast.success(action === 'promote' ? 'Đã promote → WARM' : 'Đã archive → COLD', {
          description: `tier=${data.tier}, isActive=${data.isActive}`,
          duration: 3000,
        })
        fetchTierStats()
        fetchMemories()
      } else {
        const err = await res.json().catch(() => ({}))
        sonnerToast.error('Lỗi', { description: err.error || 'thất bại', duration: 4000 })
      }
    } finally {
      setActingId(null)
    }
  }, [fetchTierStats, fetchMemories])

  // ---------- Render helpers ----------
  const importanceColor = (imp: number) => {
    if (imp >= 0.7) return 'text-emerald-400'
    if (imp >= 0.4) return 'text-amber-400'
    return 'text-rose-400'
  }
  const importanceLabel = (imp: number) => {
    if (imp >= 0.7) return 'Cao'
    if (imp >= 0.4) return 'TB'
    return 'Thấp'
  }

  const domainBadge = (domain?: string) => {
    if (!domain) return null
    const map: Record<string, string> = {
      user: 'bg-pink-500/15 text-pink-300 border-pink-500/30',
      work: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
      meta: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
      session: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
    }
    return <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 ${map[domain] || map.session}`}>{domain}</Badge>
  }

  const categoryBadge = (cat?: string) => {
    if (!cat) return null
    const map: Record<string, string> = {
      insight: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
      fact: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
      preference: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
      correction: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
      procedure: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
      user_info: 'bg-pink-500/15 text-pink-300 border-pink-500/30',
      session: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
    }
    return <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 ${map[cat] || map.session}`}>{cat}</Badge>
  }

  const tierConfig = {
    hot: { icon: Flame, label: 'HOT', desc: 'Working Memory — phiên hiện tại, TTL ngắn', color: 'orange' },
    warm: { icon: Thermometer, label: 'WARM', desc: 'AgentMemory active — truy xuất thường xuyên', color: 'amber' },
    cold: { icon: Snowflake, label: 'COLD', desc: 'Đã decay — đợi archive hoặc xóa', color: 'sky' },
    archive: { icon: Archive, label: 'ARCHIVE', desc: 'Tóm tắt LLM từ nhiều memory đã gộp', color: 'violet' },
  } as const

  const renderMemoryRow = (m: MemoryRow) => (
    <div key={m.id} className="group p-3 rounded-lg border border-slate-700/40 bg-slate-900/40 hover:border-slate-600/60 hover:bg-slate-900/60 transition-colors">
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          {categoryBadge(m.category)}
          {domainBadge(m.domain)}
          {m.role && <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 bg-slate-500/15 text-slate-300 border-slate-500/30">{m.role}</Badge>}
          {m.isActive === false && <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 bg-slate-600/30 text-slate-400 border-slate-600/40">inactive</Badge>}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 ${importanceColor(m.importance)} bg-slate-900/40 border-slate-700/50`}>
            {importanceLabel(m.importance)} · {m.importance.toFixed(2)}
          </Badge>
          {m.accessCount !== undefined && m.accessCount > 0 && (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 bg-slate-900/40 border-slate-700/50 text-slate-400">
              ×{m.accessCount}
            </Badge>
          )}
        </div>
      </div>
      <p className="text-[12px] text-slate-200 leading-relaxed line-clamp-3 mb-1.5">{m.content}</p>
      {m.context && (
        <p className="text-[10px] text-slate-500 italic line-clamp-1 mb-1.5">↳ {m.context}</p>
      )}
      <div className="flex items-center justify-between gap-2">
        <div className="text-[9px] text-slate-500 flex items-center gap-2 min-w-0">
          <span>{new Date(m.createdAt).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' })}</span>
          {m.lastAccessedAt && <span>· last: {new Date(m.lastAccessedAt).toLocaleDateString('vi-VN')}</span>}
          {m.expiresAt && <span className="text-amber-500/70">· TTL {new Date(m.expiresAt).toLocaleDateString('vi-VN')}</span>}
        </div>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
          {m.tier === 'cold' && (
            <Button
              size="sm" variant="ghost" disabled={actingId === m.id}
              onClick={() => handleMoveMemory(m.id, 'promote')}
              className="h-6 px-1.5 text-[10px] text-emerald-400 hover:text-emerald-300 hover:bg-emerald-900/30"
              title="Promote → WARM"
            >
              {actingId === m.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Thermometer className="h-3 w-3 mr-0.5" /> Warm</>}
            </Button>
          )}
          {m.tier === 'warm' && (
            <Button
              size="sm" variant="ghost" disabled={actingId === m.id}
              onClick={() => handleMoveMemory(m.id, 'archive')}
              className="h-6 px-1.5 text-[10px] text-sky-400 hover:text-sky-300 hover:bg-sky-900/30"
              title="Archive → COLD"
            >
              {actingId === m.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <><Snowflake className="h-3 w-3 mr-0.5" /> Cold</>}
            </Button>
          )}
          <Button
            size="sm" variant="ghost" disabled={actingId === m.id}
            onClick={() => handleDeleteMemory(m.id)}
            className="h-6 px-1.5 text-[10px] text-rose-400 hover:text-rose-300 hover:bg-rose-900/30"
            title="Xóa memory"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </div>
  )

  const renderArchiveRow = (a: ArchiveRow) => {
    let originalIds: string[] = []
    try { originalIds = JSON.parse(a.originalIds) } catch { /* ignore */ }
    return (
      <div key={a.id} className="p-3 rounded-lg border border-violet-700/30 bg-violet-950/15 hover:border-violet-600/50 transition-colors">
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            {domainBadge(a.domain)}
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 bg-violet-500/15 text-violet-300 border-violet-500/30">
              <Archive className="h-2.5 w-2.5 mr-0.5" />archive
            </Badge>
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 bg-slate-500/15 text-slate-300 border-slate-500/30">
              {a.sourceCount} nguồn
            </Badge>
          </div>
          <span className="text-[10px] text-slate-500">{new Date(a.createdAt).toLocaleDateString('vi-VN')}</span>
        </div>
        <p className="text-[12px] text-slate-200 leading-relaxed mb-2">{a.summaryContent}</p>
        <div className="flex items-center justify-between text-[9px] text-slate-500">
          <span>importance {a.importance.toFixed(2)}</span>
          {a.expiresAt && <span className="text-rose-500/60">hết hạn {new Date(a.expiresAt).toLocaleDateString('vi-VN')}</span>}
        </div>
      </div>
    )
  }

  // ---------- Tier dashboard cards ----------
  const tierCards = [
    { key: 'hot' as const, label: 'HOT', icon: Flame, count: tierStats?.tiers.hot ?? 0, total: memoryTotals.hot, color: 'orange', desc: 'Working Memory' },
    { key: 'warm' as const, label: 'WARM', icon: Thermometer, count: tierStats?.tiers.warm ?? 0, total: memoryTotals.warm, color: 'amber', desc: 'Active Long-term' },
    { key: 'cold' as const, label: 'COLD', icon: Snowflake, count: (tierStats?.tiers.coldInactive ?? 0), total: memoryTotals.cold, color: 'sky', desc: 'Decayed' },
    { key: 'archive' as const, label: 'ARCHIVE', icon: Archive, count: tierStats?.tiers.coldArchive ?? 0, total: archiveTotal, color: 'violet', desc: 'LLM Summary' },
  ]

  const colorMap: Record<string, string> = {
    orange: 'border-orange-500/40 bg-orange-950/15 text-orange-300',
    amber: 'border-amber-500/40 bg-amber-950/15 text-amber-300',
    sky: 'border-sky-500/40 bg-sky-950/15 text-sky-300',
    violet: 'border-violet-500/40 bg-violet-950/15 text-violet-300',
  }

  const activeMemories = activeTier === 'archive' ? archives : (memories[activeTier] || [])
  const activeTotal = activeTier === 'archive' ? archiveTotal : memoryTotals[activeTier]
  const activeLoading = activeTier === 'archive' ? archiveLoading : memoryLoading

  return (
    <div className="space-y-4">
      {/* Header: Agent selector + actions */}
      <Card className="bg-slate-900/40 border-slate-700/40">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Brain className="h-4 w-4 text-rose-400" />
                Memory System — 3 Tier Architecture
              </CardTitle>
              <CardDescription className="text-[11px] mt-0.5">
                HOT (WorkingMemory) → WARM (AgentMemory active) → COLD (decayed) → ARCHIVE (LLM tóm tắt)
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Select
                value={selectedAgentId}
                onValueChange={(v) => {
                  setSelectedAgentId(v)
                  setMemoryPage(1) // đổi agent → về trang 1 của danh sách memory mới
                  try { localStorage.setItem(MEMORY_TAB_AGENT_KEY, v) } catch { /* non-fatal */ }
                }}
                disabled={agentsLoading}
              >
                <SelectTrigger className="w-[180px] h-8 text-xs">
                  <SelectValue placeholder={agentsLoading ? 'Đang tải...' : 'Chọn agent'} />
                </SelectTrigger>
                <SelectContent>
                  {agents.map(a => (
                    <SelectItem key={a.id} value={a.id} className="text-xs">{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm" variant="outline" disabled={!selectedAgentId || actionLoading}
                onClick={() => handleRunTransition('all')}
                className="h-8 text-[11px] border-rose-500/40 bg-rose-950/20 text-rose-200 hover:bg-rose-900/40"
              >
                {actionLoading ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                Run Transitions
              </Button>
              <Button
                size="sm" variant="outline" disabled={actionLoading}
                onClick={handleRunDecay}
                className="h-8 text-[11px] border-amber-500/40 bg-amber-950/20 text-amber-200 hover:bg-amber-900/40"
                title="Chạy memory decay ngay cho tất cả agent — importance giảm theo ngày không truy cập"
              >
                {actionLoading ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Zap className="h-3 w-3 mr-1" />}
                Decay Now
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {/* Tier dashboard */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {tierCards.map(card => {
              const Icon = card.icon
              const isActive = activeTier === card.key
              return (
                <button
                  key={card.key}
                  onClick={() => {
                    setActiveTier(card.key)
                    setMemoryPage(1)
                    try { localStorage.setItem(MEMORY_TAB_TIER_KEY, card.key) } catch { /* non-fatal */ }
                  }}
                  className={`text-left p-3 rounded-lg border transition-all ${colorMap[card.color]} ${isActive ? 'ring-2 ring-offset-2 ring-offset-slate-900 ring-current' : 'opacity-80 hover:opacity-100'}`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <Icon className="h-4 w-4" />
                    <span className="text-2xl font-bold tabular-nums">{card.count}</span>
                  </div>
                  <div className="text-[10px] font-semibold tracking-wide">{card.label}</div>
                  <div className="text-[9px] opacity-70 mt-0.5">{card.desc}</div>
                </button>
              )
            })}
          </div>
          {tierStats && (tierStats.pending.decayed > 0 || tierStats.pending.expiredArchives > 0) && (
            <div className="mt-2 flex items-center gap-2 text-[10px] text-amber-400">
              <AlertCircle className="h-3 w-3" />
              <span>
                {tierStats.pending.decayed > 0 && `${tierStats.pending.decayed} memory chờ archive · `}
                {tierStats.pending.expiredArchives > 0 && `${tierStats.pending.expiredArchives} archive hết hạn chờ xóa`}
                {' · bấm "Run Transitions" để xử lý'}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Sub-tab content + search */}
      <Card className="bg-slate-900/40 border-slate-700/40">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-sm flex items-center gap-2">
              {(() => {
                const cfg = tierConfig[activeTier]
                const Icon = cfg.icon
                return <Icon className="h-4 w-4 text-rose-400" />
              })()}
              {tierConfig[activeTier].label} — {tierConfig[activeTier].desc}
            </CardTitle>
            <div className="flex items-center gap-2">
              {activeTier !== 'archive' && (
                <Input
                  placeholder="Tìm memory..."
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setMemoryPage(1) }}
                  className="h-7 w-48 text-xs"
                />
              )}
              <Badge variant="outline" className="text-[10px] bg-slate-900/40 border-slate-700/50">
                {activeTotal} total
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {activeLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-slate-500" />
            </div>
          ) : !selectedAgentId ? (
            <div className="text-center py-12 text-slate-500 text-xs">
              Chọn một agent để xem memory
            </div>
          ) : activeMemories.length === 0 ? (
            <div className="text-center py-12 text-slate-500 text-xs">
              <Archive className="h-8 w-8 mx-auto mb-2 opacity-30" />
              Không có memory nào ở tier {activeTier.toUpperCase()}
              {activeTier === 'hot' && <span className="block mt-1 opacity-70">HOT memory được tạo khi chat — kết thúc session sẽ tự promote → WARM</span>}
              {activeTier === 'archive' && <span className="block mt-1 opacity-70">Archive được tạo khi WARM memory decay dưới 0.1 importance</span>}
            </div>
          ) : (
            <ScrollArea className="h-[480px] pr-2">
              <div className="space-y-2">
                {activeTier === 'archive'
                  ? archives.map(renderArchiveRow)
                  : (memories[activeTier] || []).map(renderMemoryRow)}
              </div>
            </ScrollArea>
          )}

          {/* Pagination */}
          {(activeTier === 'hot' || activeTier === 'warm' || activeTier === 'cold') && activeTotal > 25 && (
            <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-800">
              <Button
                size="sm" variant="ghost" disabled={memoryPage === 1 || memoryLoading}
                onClick={() => setMemoryPage(p => Math.max(1, p - 1))}
                className="h-7 text-xs"
              >
                <ChevronLeft className="h-3 w-3 mr-1" /> Trước
              </Button>
              <span className="text-[10px] text-slate-400">Trang {memoryPage} / {Math.ceil(activeTotal / 25)}</span>
              <Button
                size="sm" variant="ghost" disabled={memoryPage * 25 >= activeTotal || memoryLoading}
                onClick={() => setMemoryPage(p => p + 1)}
                className="h-7 text-xs"
              >
                Sau <ChevronRight className="h-3 w-3 ml-1" />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

