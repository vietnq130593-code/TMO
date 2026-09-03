'use client'

// ========================================================================
// learning-tab — Tab Learning (Smolab) — recharts
// PERF-SPLIT 2026-09-03: trích xuất nguyên vẹn từ src/app/page.tsx (không đổi logic)
// ========================================================================

import React, { useState, useRef, useEffect } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, AreaChart, Area } from 'recharts'
import { Network, Cpu, CheckCircle2, XCircle, Loader2, RefreshCw, Brain, Zap, ArrowRight, Activity, AlertTriangle, Play, Shield, Clock, MessageSquare, Trash2, Layers, GitBranch, Sparkles, MessageCircle, Lightbulb, Target, TrendingUp, ThumbsUp, ThumbsDown, Settings, BookMarked, Download, Upload as UploadIcon, FileJson, GraduationCap, RotateCcw, FileDown, FileUp, FlaskConical, ShieldAlert, Swords, CloudDownload, CircleHelp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { format } from 'date-fns'
import { toast } from '@/hooks/use-toast'


// ==================== LEARNING TAB CONTENT ====================

// Phase 4 SMOLAB Proposal 11' — Eval harness types (Evaluation Results card)
export interface EvalRunSummary {
  id: string
  status: string
  caseCount: number
  processedCount: number
  avgRecallAt5?: number
  avgFaithfulness?: number
  // Task 4 (2026-08-25): coverage split — "did the system attempt an answer"
  // vs faithfulness's "was the attempted answer correct".
  avgCoverage?: number
  avgCondFaithfulness?: number
  answeredCount?: number
  refusalCount?: number
  avgF1?: number
  avgLatencyMs?: number
  hallucinationCount?: number
  errorMessage?: string | null
  startedAt: string
  completedAt?: string | null
}


export interface EvalCaseResult {
  id: string
  question: string
  category: string
  recallAt5: number
  faithfulnessMedian: number
  faithfulnessScores: number[]
  extractionF1: number
  hallucinationDetected: boolean
  retrievedChunks: number
  rawConfidence: number
  latencyMs: number
}


export interface EvalResultsPayload {
  run: EvalRunSummary | null
  results: EvalCaseResult[]
}


// RED TEAM ENGINE (Blueprint 2026-08-25) — adversarial self-testing types.
export interface RedTeamRunSummary {
  id: string
  status: string
  caseCount: number
  processedCount: number
  breachCount: number
  defendedCount: number
  breachesByVector: string // JSON string
  avgLatencyMs: number
  errorMessage?: string | null
  startedAt: string
  completedAt?: string | null
}


export interface RedTeamCaseResult {
  id: string
  question: string
  attackVector: string
  breached: boolean
  attackVerdict: { score?: number; reasoning?: string; failureMode?: string; verdict?: string }
  defenseVerdict: { score?: number; reasoning?: string }
  retrievedChunks: number
  latencyMs: number
}


export interface RedTeamResultsPayload {
  run: RedTeamRunSummary | null
  results: RedTeamCaseResult[]
}


export interface RedTeamCasesPayload {
  counts: { total: number; active: number; retired: number }
}


/** RED TEAM — short display labels for the 6 attack vectors (blueprint §3.1). */
export const REDTEAM_VECTOR_LABELS: Record<string, string> = {
  hallucination_boundary: 'Ranh giới',
  knowledge_poison: 'Đầu độc',
  ambiguity_trap: 'Mơ hồ',
  injection_probe: 'Injection',
  domain_confusion: 'Lẫn domain',
  failure_mutation: 'Đột biến',
}


export function LearningTabContent() {
  // Timeline data
  const [timeline, setTimeline] = useState<{
    events: Array<{
      id: string
      type: string
      content: string
      timestamp: string
      metadata: Record<string, unknown>
    }>
    total: number
    typeCounts: Record<string, number>
  } | null>(null)
  const [timelineFilter, setTimelineFilter] = useState<string>('all')
  const [timelineLoading, setTimelineLoading] = useState(false)

  // Learning stats
  const [stats, setStats] = useState<{
    totalInsights: number
    totalCorrections: number
    totalPreferences: number
    totalStandingOrders: number
    totalFeedbackPositive: number
    totalFeedbackNegative: number
    accuracyRate: number
    appliedCorrections: number
    pendingCorrections: number
    insightsByDay: Array<{ date: string; count: number }>
    correctionsByDay: Array<{ date: string; count: number }>
    insightTypeDistribution: Array<{ type: string; count: number }>
    insightSourceDistribution: Array<{ source: string; count: number }>
    standingOrders: Array<{ id: string; order: string; priority: number }>
    recentInsights: Array<Record<string, unknown>>
    recentCorrections: Array<Record<string, unknown>>
  } | null>(null)

  // Manual teaching form
  const [teachType, setTeachType] = useState<'insight' | 'correction' | 'preference' | 'order'>('insight')
  const [teachContent, setTeachContent] = useState('')
  const [teachRelatedEntity, setTeachRelatedEntity] = useState('')
  const [teachWrongAnswer, setTeachWrongAnswer] = useState('')
  const [teachReason, setTeachReason] = useState('')
  const [teachSubmitting, setTeachSubmitting] = useState(false)

  // Feedback history
  const [feedbackHistory, setFeedbackHistory] = useState<Array<{
    id: string
    type: string
    content: string
    timestamp: string
    metadata: Record<string, unknown>
  }>>([])
  const [feedbackFilter, setFeedbackFilter] = useState<'all' | 'positive' | 'negative'>('all')

  // Export/Import
  const [exportFormat, setExportFormat] = useState<'json' | 'markdown'>('json')
  const [importMode, setImportMode] = useState<'skip' | 'overwrite' | 'merge'>('skip')
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Knowledge graph mini-view
  const [agentEntities, setAgentEntities] = useState<Array<{ id: string; entityName: string; entityType: string; description: string | null }>>([])

  // Standing orders management
  const [orders, setOrders] = useState<Array<{ id: string; order: string; priority: number; enabled: boolean }>>([])
  const [newOrder, setNewOrder] = useState('')
  const [newOrderPriority, setNewOrderPriority] = useState(0)

  // Phase 2 SMOLAB Proposal 6 — Writeback Audit (PendingWriteback saga tracker)
  const [writebackAudit, setWritebackAudit] = useState<{
    counts: { pending: number; partial: number; failed: number; completed: number; needs_review: number; rejected: number; total: number }
    recent: Array<{
      batchId: string
      documentId: string
      status: string
      failedStep: string | null
      attempts: number
      createdAt: string
      updatedAt: string
    }>
  } | null>(null)
  const [reconciling, setReconciling] = useState(false)

  // USER REQUEST 2026-08-27 — Gray-zone review (tri thức chờ phê duyệt) + cloud sync
  const [reviewItems, setReviewItems] = useState<Array<{
    batchId: string
    query: string
    agentName?: string
    createdAt: string
    entities: Array<{ name: string; type: string; description: string; confidence: number }>
    relationships: Array<{ source: string; target: string; type: string; description: string; confidence: number }>
  }>>([])
  const [reviewActionLoading, setReviewActionLoading] = useState<string | null>(null)
  const [cloudSyncLoading, setCloudSyncLoading] = useState(false)

  // Phase 2 SMOLAB Proposal 8 — Layer 9 Adaptation Intelligence (ExecutionMetrics
  // + FailurePattern + StrategyAdaptationLog + ML quality placeholders).
  const [layer9Metrics, setLayer9Metrics] = useState<{
    aggregated: {
      totalRuns: number
      totalCompletedSteps: number
      totalFailedSteps: number
      totalTokensUsed: number
      overallSuccessRate: number
      overallTokenEfficiency: number
    }
    byRoutingMode: Record<string, { count: number; avgSuccess: number; avgTokens: number; avgTime: number }>
    successRateTrend: Array<{ runId: string; successRate: number; timestamp: string }>
    recentPatterns: Array<{
      id: string
      sessionId: string
      type: string
      count: number
      nextStrategy: string
      resolved: boolean
      createdAt: string
    }>
    recentAdaptations: Array<{
      id: string
      sessionId: string
      fromStrategy: string
      toStrategy: string
      reason: string
      confidence: number
      successful: boolean | null
      createdAt: string
    }>
    mlQuality: {
      embeddingCacheHitRate: number | null
      pseudoHashVectorCount: number
      autoLearnVerificationRate: number | null
    }
  } | null>(null)

  // Phase 4 SMOLAB Proposal 11' — Eval harness (latest run status + results)
  const [evalLatestRun, setEvalLatestRun] = useState<EvalRunSummary | null>(null)
  const [evalData, setEvalData] = useState<EvalResultsPayload | null>(null)
  const [evalStarting, setEvalStarting] = useState(false)
  // Bump to force an immediate re-poll (e.g. right after starting a run).
  const [evalRefresh, setEvalRefresh] = useState(0)

  // RED TEAM ENGINE — adversarial self-testing state (mirrors eval card).
  const [redteamLatestRun, setRedteamLatestRun] = useState<RedTeamRunSummary | null>(null)
  const [redteamData, setRedteamData] = useState<RedTeamResultsPayload | null>(null)
  const [redteamCounts, setRedteamCounts] = useState<RedTeamCasesPayload['counts'] | null>(null)
  const [redteamAttacking, setRedteamAttacking] = useState(false)
  const [redteamForging, setRedteamForging] = useState(false)
  const [redteamRefresh, setRedteamRefresh] = useState(0)

  // Fetch data on mount
  useEffect(() => {
    const fetchData = async () => {
      setTimelineLoading(true)
      try {
        const [timelineRes, statsRes] = await Promise.all([
          fetch(`/api/openclaw/learning/timeline${timelineFilter !== 'all' ? `?type=${timelineFilter}` : ''}`),
          fetch('/api/openclaw/learning/stats'),
        ])

        if (timelineRes.ok) {
          const data = await timelineRes.json()
          setTimeline(data)
          // Extract feedback events
          setFeedbackHistory(data.events?.filter((e: { type: string }) => e.type === 'feedback') || [])
        }

        if (statsRes.ok) {
          const data = await statsRes.json()
          setStats(data)
          setOrders(data.standingOrders || [])
        }
      } catch (err) {
        console.error('[Learning] Fetch error:', err)
      }
      setTimelineLoading(false)
    }

    fetchData()
    const interval = setInterval(fetchData, 30000)
    return () => clearInterval(interval)
  }, [timelineFilter])

  // Fetch agent-created entities for graph mini-view
  useEffect(() => {
    const fetchEntities = async () => {
      try {
        const res = await fetch('/api/openclaw/knowledge/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'sql', query: "SELECT id, entityName, entityType, description FROM LocalEntity WHERE source = 'agent' LIMIT 30" }),
        })
        if (res.ok) {
          const data = await res.json()
          setAgentEntities(data.records?.map((r: Record<string, unknown>) => ({
            id: String(r.id || ''),
            entityName: String(r.entityName || ''),
            entityType: String(r.entityType || ''),
            description: r.description ? String(r.description) : null,
          })) || [])
        }
      } catch {}
    }
    fetchEntities()
  }, [])

  // Phase 2 SMOLAB Proposal 6 — Fetch writeback audit (60s auto-refresh)
  useEffect(() => {
    let cancelled = false
    const fetchWritebackAudit = async () => {
      try {
        const res = await fetch('/api/storage/reconcile-writebacks')
        if (res.ok && !cancelled) {
          const data = await res.json()
          if (!cancelled) setWritebackAudit(data)
        }
      } catch (err) {
        console.warn('[Writeback Audit] fetch failed:', err)
      }
    }
    fetchWritebackAudit()
    const interval = setInterval(fetchWritebackAudit, 60000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  // USER REQUEST 2026-08-27 — Fetch gray-zone review items (tri thức chờ phê duyệt).
  // Items có confidence 0.3-0.5: Agent không chắc → hỏi user trước khi ghi vào KB.
  useEffect(() => {
    let cancelled = false
    const fetchReviewItems = async () => {
      try {
        const res = await fetch('/api/storage/writeback-review?limit=20')
        if (res.ok) {
          const data = await res.json()
          if (!cancelled && data.ok) setReviewItems(Array.isArray(data.items) ? data.items : [])
        }
      } catch (err) {
        console.warn('[Review Items] fetch failed:', err)
      }
    }
    fetchReviewItems()
    const interval = setInterval(fetchReviewItems, 30000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  // USER REQUEST 2026-08-27 — Phê duyệt / từ chối tri thức vùng xám
  const handleReviewAction = async (batchId: string, action: 'approve' | 'reject') => {
    setReviewActionLoading(batchId)
    try {
      const res = await fetch('/api/storage/writeback-review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId, action }),
      })
      const data = await res.json()
      if (data.ok) {
        toast({
          title: action === 'approve' ? '✅ Đã ghi vào Knowledge Base' : '🗑️ Đã bỏ tri thức này',
          description: action === 'approve'
            ? `Đã ghi ${data.entitiesWritten ?? 0} entities + ${data.relationshipsWritten ?? 0} relationships`
            : 'Tri thức bị từ chối sẽ không được lưu vào KB',
          duration: 4000,
        })
        // Refresh lists
        setReviewItems(prev => prev.filter(r => r.batchId !== batchId))
        try {
          const auditRes = await fetch('/api/storage/reconcile-writebacks')
          if (auditRes.ok) setWritebackAudit(await auditRes.json())
        } catch { /* best-effort */ }
      } else {
        toast({ title: 'Lỗi xử lý', description: data.error || 'Không xác định', variant: 'destructive' })
      }
    } catch (err) {
      console.error('[Review] Action failed:', err)
      toast({ title: 'Lỗi kết nối', variant: 'destructive' })
    }
    setReviewActionLoading(null)
  }

  // USER REQUEST 2026-08-27 — Đồng bộ Memory/Knowledge từ Supabase Cloud về local
  // (chat ở sandbox → memory push lên cloud → máy local pull về bằng nút này)
  const handleCloudPull = async () => {
    setCloudSyncLoading(true)
    try {
      const res = await fetch('/api/storage/supabase-sync?action=pull', { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        toast({
          title: '☁️ Đã đồng bộ từ Cloud',
          description: `Pull ${data.totalPulled ?? 0} records từ Supabase (push ${data.totalPushed ?? 0})`,
          duration: 4000,
        })
      } else {
        toast({ title: 'Đồng bộ Cloud thất bại', description: data.error || 'Supabase chưa cấu hình?', variant: 'destructive' })
      }
    } catch (err) {
      console.error('[CloudSync] Pull failed:', err)
      toast({ title: 'Lỗi kết nối Supabase', variant: 'destructive' })
    }
    setCloudSyncLoading(false)
  }

  // Phase 2 SMOLAB Proposal 8 — Fetch Layer 9 metrics (30s auto-refresh)
  useEffect(() => {
    let cancelled = false
    const fetchLayer9 = async () => {
      try {
        const res = await fetch('/api/openclaw/learning/layer9-metrics')
        if (res.ok && !cancelled) {
          const data = await res.json()
          if (!cancelled) setLayer9Metrics(data)
        }
      } catch (err) {
        console.warn('[Layer9 Metrics] fetch failed:', err)
      }
    }
    fetchLayer9()
    const interval = setInterval(fetchLayer9, 30000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  // Phase 4 SMOLAB Proposal 11' — Fetch eval run status + results.
  // Polls every 10s while a run is in progress, every 60s otherwise.
  // /api/eval/run (no param) → latest 10 runs (live status source).
  // /api/eval/results (no param) → latest COMPLETED run + per-case results.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      let running = false
      try {
        const [runsRes, resultsRes] = await Promise.all([
          fetch('/api/eval/run'),
          fetch('/api/eval/results'),
        ])
        if (runsRes.ok && !cancelled) {
          const data = (await runsRes.json()) as { runs?: EvalRunSummary[] }
          const latest = Array.isArray(data.runs) && data.runs.length > 0 ? data.runs[0] : null
          if (!cancelled) setEvalLatestRun(latest)
          running = latest?.status === 'running'
        }
        if (resultsRes.ok && !cancelled) {
          const data = (await resultsRes.json()) as EvalResultsPayload
          if (!cancelled) setEvalData(data)
        }
      } catch (err) {
        console.warn('[Eval Results] fetch failed:', err)
      }
      if (cancelled) return
      // 10s cadence while a run is in progress, 60s otherwise.
      timer = setTimeout(poll, running ? 10_000 : 60_000)
    }

    poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [evalRefresh])

  // RED TEAM ENGINE — Fetch attack run status + results + weapon counts.
  // Same polling pattern as the eval card: 10s while a wave is running,
  // 60s otherwise. /api/redteam/run (no param) → latest 10 runs (live
  // status). /api/redteam/results (no param) → latest COMPLETED wave.
  // /api/redteam/cases → weapon inventory counts (active/retired).
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      let running = false
      try {
        const [runsRes, resultsRes, casesRes] = await Promise.all([
          fetch('/api/redteam/run'),
          fetch('/api/redteam/results'),
          fetch('/api/redteam/cases'),
        ])
        if (runsRes.ok && !cancelled) {
          const data = (await runsRes.json()) as { runs?: RedTeamRunSummary[] }
          const latest = Array.isArray(data.runs) && data.runs.length > 0 ? data.runs[0] : null
          if (!cancelled) setRedteamLatestRun(latest)
          running = latest?.status === 'running'
        }
        if (resultsRes.ok && !cancelled) {
          const data = (await resultsRes.json()) as RedTeamResultsPayload
          if (!cancelled) setRedteamData(data)
        }
        if (casesRes.ok && !cancelled) {
          const data = (await casesRes.json()) as RedTeamCasesPayload
          if (!cancelled) setRedteamCounts(data.counts)
        }
      } catch (err) {
        console.warn('[RedTeam] fetch failed:', err)
      }
      if (cancelled) return
      // 10s cadence while a wave is in progress, 60s otherwise.
      timer = setTimeout(poll, running ? 10_000 : 60_000)
    }

    poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [redteamRefresh])

  // Phase 4 SMOLAB Proposal 11' — Start a background eval run (10 cases).
  // POST /api/eval/run returns immediately (fire-and-forget runner); the
  // poll effect above picks up the running status + refreshes every 10s.
  const handleRunEval = async () => {
    setEvalStarting(true)
    try {
      const res = await fetch('/api/eval/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseLimit: 10 }),
      })
      const data = (await res.json()) as { runId?: string; caseCount?: number; error?: string }
      if (res.ok && data.runId) {
        toast({
          title: 'Eval started',
          description: `Run ${data.runId.slice(0, 8)} — ${data.caseCount ?? 10} cases × 4 LLM calls (chạy nền)`,
        })
        // Force an immediate re-poll so the running badge shows up right away.
        setEvalRefresh((n) => n + 1)
      } else {
        toast({ title: 'Eval start failed', description: data.error || 'Unknown error', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi kết nối eval', variant: 'destructive' })
    }
    setEvalStarting(false)
  }

  // RED TEAM ENGINE — Launch an attack wave (15 cases, fire-and-forget).
  // POST /api/redteam/run returns immediately; the poll effect above picks up
  // the running status. Each case = retrieval + answer + 2 judges (~60-90s).
  const handleRedTeamAttack = async () => {
    setRedteamAttacking(true)
    try {
      const res = await fetch('/api/redteam/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caseLimit: 15 }),
      })
      const data = (await res.json()) as { runId?: string; caseCount?: number; error?: string }
      if (res.ok && data.runId) {
        toast({
          title: 'Đợt tấn công đã triển khai',
          description: `Run ${data.runId.slice(0, 8)} — ${data.caseCount ?? 15} vũ khí × 4 LLM calls (chạy nền, mỗi case ~60-90s)`,
        })
        setRedteamRefresh((n) => n + 1)
      } else {
        toast({ title: 'Triển khai tấn công thất bại', description: data.error || 'Unknown error', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi kết nối Red Team', variant: 'destructive' })
    }
    setRedteamAttacking(false)
  }

  // RED TEAM ENGINE — Forge new weapons (generate adversarial cases).
  // POST /api/redteam/generate-cases is synchronous (~10-60s: 1 generator
  // call per vector + 1 quality-gate call per candidate).
  const handleRedTeamForge = async () => {
    setRedteamForging(true)
    try {
      const res = await fetch('/api/redteam/generate-cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = (await res.json()) as { inserted?: number; skipped?: number; error?: string }
      if (res.ok) {
        toast({
          title: 'Đã rèn vũ khí mới',
          description: `Sinh ${data.inserted ?? 0} case adversarial (${data.skipped ?? 0} bị loại/trùng)`,
        })
        setRedteamRefresh((n) => n + 1)
      } else {
        toast({ title: 'Sinh vũ khí thất bại', description: data.error || 'Unknown error', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi kết nối generator', variant: 'destructive' })
    }
    setRedteamForging(false)
  }

  // Reconcile now — POST endpoint that re-attempts pending/partial/failed batches
  const handleReconcileWritebacks = async () => {
    setReconciling(true)
    try {
      const res = await fetch('/api/storage/reconcile-writebacks?limit=20', { method: 'POST' })
      const data = await res.json()
      if (res.ok && data.ok) {
        toast({
          title: 'Reconcile hoàn tất',
          description: `Đã xử lý ${data.processed} batch (OK: ${data.completed}, thất bại: ${data.stillFailed})`,
        })
        // Refresh audit immediately
        const auditRes = await fetch('/api/storage/reconcile-writebacks')
        if (auditRes.ok) setWritebackAudit(await auditRes.json())
      } else {
        toast({ title: 'Reconcile lỗi', description: data.error || 'Thất bại', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi kết nối reconcile', variant: 'destructive' })
    }
    setReconciling(false)
  }

  // Teach agent
  const handleTeach = async () => {
    if (!teachContent.trim()) return
    if (teachType === 'correction' && !teachWrongAnswer.trim()) return

    setTeachSubmitting(true)
    try {
      const body: Record<string, unknown> = {
        type: teachType,
        content: teachContent.trim(),
        relatedEntity: teachRelatedEntity.trim() || undefined,
      }

      if (teachType === 'correction') {
        body.metadata = {
          wrongAnswer: teachWrongAnswer.trim(),
          reason: teachReason.trim() || undefined,
        }
      } else if (teachType === 'preference') {
        body.metadata = {
          preferenceKey: teachContent.trim().split(':')[0].trim(),
          preferenceValue: teachContent.trim(),
          source: 'manual',
        }
      } else if (teachType === 'order') {
        body.metadata = {
          priority: newOrderPriority,
          enabled: true,
        }
      } else if (teachType === 'insight') {
        body.metadata = {
          insightType: 'factual',
          confidence: 0.9,
          source: 'manual',
        }
      }

      const res = await fetch('/api/openclaw/learning/teach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (res.ok) {
        toast({ title: 'Đã dạy Agent thành công', description: `Loại: ${teachType}` })
        setTeachContent('')
        setTeachRelatedEntity('')
        setTeachWrongAnswer('')
        setTeachReason('')
        // Refresh data
        const [timelineRes, statsRes] = await Promise.all([
          fetch(`/api/openclaw/learning/timeline${timelineFilter !== 'all' ? `?type=${timelineFilter}` : ''}`),
          fetch('/api/openclaw/learning/stats'),
        ])
        if (timelineRes.ok) { const data = await timelineRes.json(); setTimeline(data) }
        if (statsRes.ok) { const data = await statsRes.json(); setStats(data); setOrders(data.standingOrders || []) }
      } else {
        const data = await res.json()
        toast({ title: 'Lỗi', description: data.error || 'Không thể dạy Agent', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi kết nối', variant: 'destructive' })
    }
    setTeachSubmitting(false)
  }

  // Export
  const handleExport = async () => {
    try {
      const res = await fetch(`/api/openclaw/learning/export?format=${exportFormat}`)
      if (res.ok) {
        if (exportFormat === 'markdown') {
          const text = await res.text()
          const blob = new Blob([text], { type: 'text/markdown' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = 'agent-memory.md'
          a.click()
          URL.revokeObjectURL(url)
        } else {
          const data = await res.json()
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = 'agent-memory.json'
          a.click()
          URL.revokeObjectURL(url)
        }
        toast({ title: 'Xuất thành công', description: `Đã xuất bộ nhớ Agent (${exportFormat})` })
      }
    } catch {
      toast({ title: 'Lỗi xuất dữ liệu', variant: 'destructive' })
    }
  }

  // Import
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setImporting(true)
    try {
      const formData = new FormData()
      formData.append('file', file)

      const res = await fetch(`/api/openclaw/learning/import?mode=${importMode}`, {
        method: 'POST',
        body: formData,
      })

      if (res.ok) {
        const data = await res.json()
        toast({ title: 'Nhập thành công', description: `Insights: ${data.stats?.insights?.imported || 0} | Corrections: ${data.stats?.corrections?.imported || 0} | Preferences: ${data.stats?.preferences?.imported || 0}` })
        // Refresh
        const [timelineRes, statsRes] = await Promise.all([
          fetch(`/api/openclaw/learning/timeline${timelineFilter !== 'all' ? `?type=${timelineFilter}` : ''}`),
          fetch('/api/openclaw/learning/stats'),
        ])
        if (timelineRes.ok) { const d = await timelineRes.json(); setTimeline(d) }
        if (statsRes.ok) { const d = await statsRes.json(); setStats(d); setOrders(d.standingOrders || []) }
      } else {
        toast({ title: 'Lỗi nhập dữ liệu', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi kết nối', variant: 'destructive' })
    }
    setImporting(false)
    // Reset file input
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // Format timestamp
  const formatTime = (ts: string) => {
    try {
      const d = new Date(ts)
      return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
    } catch { return ts }
  }

  const formatDate = (ts: string) => {
    try {
      const d = new Date(ts)
      return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit' })
    } catch { return ts }
  }

  // Timeline event type colors and icons
  const typeConfig: Record<string, { color: string; bg: string; border: string; icon: React.ReactNode; label: string }> = {
    insight: { color: 'text-amber-400', bg: 'bg-amber-950/30', border: 'border-amber-400/35', icon: <Lightbulb className="h-3.5 w-3.5" />, label: 'Insight' },
    correction: { color: 'text-red-400', bg: 'bg-red-950/30', border: 'border-red-400/35', icon: <RotateCcw className="h-3.5 w-3.5" />, label: 'Correction' },
    preference: { color: 'text-violet-400', bg: 'bg-violet-950/30', border: 'border-violet-400/35', icon: <Settings className="h-3.5 w-3.5" />, label: 'Preference' },
    feedback: { color: 'text-cyan-400', bg: 'bg-cyan-950/30', border: 'border-cyan-400/35', icon: <ThumbsUp className="h-3.5 w-3.5" />, label: 'Feedback' },
    pattern: { color: 'text-emerald-400', bg: 'bg-emerald-950/30', border: 'border-emerald-400/35', icon: <Target className="h-3.5 w-3.5" />, label: 'Pattern' },
    order: { color: 'text-blue-400', bg: 'bg-blue-950/30', border: 'border-blue-400/35', icon: <BookMarked className="h-3.5 w-3.5" />, label: 'Standing Order' },
  }

  const getTypeConfig = (type: string) => typeConfig[type] || typeConfig.pattern

  // Filtered feedback
  const filteredFeedback = feedbackFilter === 'all'
    ? feedbackHistory
    : feedbackHistory.filter(e => {
        const fbType = (e.metadata?.feedbackType as string) || (e.metadata?.type as string) || ''
        return fbType === feedbackFilter
      })

  // RED TEAM — derived display values (latest COMPLETED wave).
  const rtRun = redteamData?.run ?? null
  const rtBreaches = rtRun?.breachCount ?? 0
  const rtDefended = rtRun?.defendedCount ?? 0
  const rtDecided = rtBreaches + rtDefended
  const rtWinRate = rtDecided > 0 ? rtDefended / rtDecided : null
  let rtBreachesByVector: Record<string, number> = {}
  try {
    rtBreachesByVector = rtRun ? (JSON.parse(rtRun.breachesByVector || '{}') as Record<string, number>) : {}
  } catch {
    rtBreachesByVector = {}
  }
  const rtVectorMax = Math.max(1, ...Object.values(rtBreachesByVector))
  const rtRecentBreaches = (redteamData?.results ?? []).filter((r) => r.breached).slice(-5).reverse()

  return (
    <div className="space-y-4">

      {/* ===== 1. LEARNING STATS ===== */}
      <div className="nc-wrap nc-amber">
        <div className="nc-panel nc-sm nc-border-amber p-4">
          <div className="flex items-center gap-2 mb-3">
            <GraduationCap className="h-4 w-4 text-amber-400" />
            <span className="text-sm font-semibold text-stone-100">Thống kê Học tập</span>
            <div className="ml-auto">
              {/* USER REQUEST 2026-08-27 — pull Memory/KB từ Supabase Cloud về máy local */}
              <Button
                variant="ghost"
                size="sm"
                disabled={cloudSyncLoading}
                onClick={handleCloudPull}
                className="h-6 px-2 text-[10px] bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25 hover:text-cyan-200 border border-cyan-500/25"
                title="Pull toàn bộ Memory / Chat / Knowledge từ Supabase Cloud về máy này (chat ở sandbox cũng được load về)"
              >
                {cloudSyncLoading ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <CloudDownload className="h-3 w-3 mr-1" />}
                Đồng bộ từ Cloud
              </Button>
            </div>
          </div>

          {/* Stat cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <div className="p-2.5 bg-slate-950/50 border border-amber-500/15 rounded-lg text-center">
              <Lightbulb className="h-4 w-4 mx-auto text-amber-400 mb-1" />
              <p className="text-lg font-bold text-stone-100 tabular-nums">{stats?.totalInsights ?? '—'}</p>
              <p className="text-[9px] text-stone-400 uppercase">Insights</p>
            </div>
            <div className="p-2.5 bg-slate-950/50 border border-amber-500/15 rounded-lg text-center">
              <RotateCcw className="h-4 w-4 mx-auto text-red-400 mb-1" />
              <p className="text-lg font-bold text-stone-100 tabular-nums">{stats?.totalCorrections ?? '—'}</p>
              <p className="text-[9px] text-stone-400 uppercase">Corrections</p>
            </div>
            <div className="p-2.5 bg-slate-950/50 border border-amber-500/15 rounded-lg text-center">
              <ThumbsUp className="h-4 w-4 mx-auto text-emerald-400 mb-1" />
              <p className="text-lg font-bold text-stone-100 tabular-nums">{stats?.accuracyRate !== undefined ? `${Math.round(stats.accuracyRate * 100)}%` : '—'}</p>
              <p className="text-[9px] text-stone-400 uppercase">Độ chính xác</p>
            </div>
            <div className="p-2.5 bg-slate-950/50 border border-amber-500/15 rounded-lg text-center">
              <BookMarked className="h-4 w-4 mx-auto text-violet-400 mb-1" />
              <p className="text-lg font-bold text-stone-100 tabular-nums">{stats?.totalStandingOrders ?? '—'}</p>
              <p className="text-[9px] text-stone-400 uppercase">Standing Orders</p>
            </div>
          </div>

          {/* Feedback counts */}
          <div className="flex items-center gap-3 mb-4">
            <span className="flex items-center gap-1.5 text-[10px] text-emerald-400">
              <ThumbsUp className="h-3 w-3" /> {stats?.totalFeedbackPositive ?? 0} tích cực
            </span>
            <span className="flex items-center gap-1.5 text-[10px] text-red-400">
              <ThumbsDown className="h-3 w-3" /> {stats?.totalFeedbackNegative ?? 0} cần cải thiện
            </span>
            <span className="flex items-center gap-1.5 text-[10px] text-stone-400">
              <CheckCircle2 className="h-3 w-3" /> {stats?.appliedCorrections ?? 0} đã áp dụng
            </span>
            <span className="flex items-center gap-1.5 text-[10px] text-stone-400">
              <Clock className="h-3 w-3" /> {stats?.pendingCorrections ?? 0} chờ xử lý
            </span>
          </div>

          {/* Charts row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Insights by day */}
            <div className="p-2.5 bg-slate-950/50 border border-amber-500/10 rounded-lg">
              <span className="text-[10px] text-stone-400 uppercase mb-2 block">Insights / ngày (30 ngày)</span>
              <div className="h-32">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={stats?.insightsByDay || []}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(245,158,11,0.1)" />
                    <XAxis dataKey="date" tick={{ fontSize: 8, fill: '#78716c' }} tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis tick={{ fontSize: 8, fill: '#78716c' }} allowDecimals={false} />
                    <RechartsTooltip contentStyle={{ background: '#1c1917', border: '1px solid rgba(245,158,11,0.3)', fontSize: 10 }} />
                    <Area type="monotone" dataKey="count" stroke="#f59e0b" fill="rgba(245,158,11,0.15)" strokeWidth={1.5} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Corrections by day */}
            <div className="p-2.5 bg-slate-950/50 border border-amber-500/10 rounded-lg">
              <span className="text-[10px] text-stone-400 uppercase mb-2 block">Corrections / ngày (30 ngày)</span>
              <div className="h-32">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats?.correctionsByDay || []}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(239,68,68,0.1)" />
                    <XAxis dataKey="date" tick={{ fontSize: 8, fill: '#78716c' }} tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis tick={{ fontSize: 8, fill: '#78716c' }} allowDecimals={false} />
                    <RechartsTooltip contentStyle={{ background: '#1c1917', border: '1px solid rgba(239,68,68,0.3)', fontSize: 10 }} />
                    <Bar dataKey="count" fill="rgba(239,68,68,0.6)" radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {/* Insight type distribution */}
          {(stats?.insightTypeDistribution?.length ?? 0) > 0 && (
            <div className="mt-3 p-2.5 bg-slate-950/50 border border-amber-500/10 rounded-lg">
              <span className="text-[10px] text-stone-400 uppercase mb-2 block">Phân loại Insight</span>
              <div className="flex flex-wrap gap-2">
                {stats?.insightTypeDistribution.map(t => (
                  <div key={t.type} className="flex items-center gap-1.5 px-2 py-1 bg-amber-950/30 border border-amber-500/15 rounded-lg">
                    <span className="text-[10px] text-amber-300 font-mono">{t.type}</span>
                    <Badge className="text-[9px] h-4 px-1.5 bg-amber-900/40 text-amber-400 border-amber-400/35">{t.count}</Badge>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ===== 1a-2. KIẾN THỨC CHỜ PHÊ DUYỆT (USER REQUEST 2026-08-27) ===== */}
      <div className="nc-wrap nc-violet">
        <div className="nc-panel nc-sm nc-border-violet p-4">
          <div className="flex items-center gap-2 mb-3">
            <CircleHelp className="h-4 w-4 text-violet-400" />
            <span className="text-sm font-semibold text-stone-100">Kiến thức chờ phê duyệt</span>
            <Badge className="text-[9px] h-4 px-1.5 bg-violet-950/50 text-violet-400 border-violet-400/35">
              {reviewItems.length} batch
            </Badge>
          </div>
          <p className="text-[10px] text-stone-400 mb-3 leading-relaxed">
            Agent <span className="text-violet-300 font-medium">không chắc chắn</span> về những tri thức dưới đây (confidence 0.3–0.5) nên xếp hàng chờ bạn quyết định.
            Tri thức đủ tin cậy (confidence &gt; 0.5) đã được <span className="text-emerald-300 font-medium">tự động ghi</span> vào Knowledge Base theo mặc định.
          </p>

          {reviewItems.length === 0 ? (
            <div className="text-[10px] text-stone-500 italic text-center py-3 border border-dashed border-violet-500/20 rounded-lg">
              Không có tri thức nào chờ phê duyệt — Agent tự tin về các kiến thức đã học gần đây.
            </div>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto pr-1" style={{ scrollbarWidth: 'thin' }}>
              {reviewItems.map(item => (
                <div key={item.batchId} className="p-2.5 bg-slate-950/50 border border-violet-500/20 rounded-lg">
                  <div className="flex items-center gap-2 mb-1.5">
                    <MessageSquare className="h-3 w-3 text-violet-400 flex-shrink-0" />
                    <span className="text-[10px] text-stone-300 truncate flex-1" title={item.query}>
                      "{item.query.length > 80 ? item.query.slice(0, 80) + '…' : item.query}"
                    </span>
                    {item.agentName && (
                      <Badge className="text-[8px] h-3.5 px-1 bg-violet-950/50 text-violet-400 border-violet-400/30">{item.agentName}</Badge>
                    )}
                    <span className="text-[8px] text-stone-500 flex-shrink-0">{formatTime(item.createdAt)}</span>
                  </div>

                  {/* Entities */}
                  {item.entities.length > 0 && (
                    <div className="mb-1.5">
                      <span className="text-[8px] text-stone-500 uppercase">Entities ({item.entities.length})</span>
                      <div className="flex flex-wrap gap-1 mt-0.5">
                        {item.entities.map((e, i) => (
                          <Badge key={i} className="text-[8px] h-3.5 px-1 bg-slate-900/60 text-stone-300 border-slate-700 max-w-full" title={`${e.type}: ${e.description} (conf ${e.confidence.toFixed(2)})`}>
                            {e.name} <span className="text-violet-400">{(e.confidence * 100).toFixed(0)}%</span>
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Relationships */}
                  {item.relationships.length > 0 && (
                    <div className="mb-2">
                      <span className="text-[8px] text-stone-500 uppercase">Relationships ({item.relationships.length})</span>
                      <div className="flex flex-wrap gap-1 mt-0.5">
                        {item.relationships.map((r, i) => (
                          <Badge key={i} className="text-[8px] h-3.5 px-1 bg-slate-900/60 text-stone-300 border-slate-700 max-w-full" title={`${r.description} (conf ${r.confidence.toFixed(2)})`}>
                            {r.source} → {r.target} <span className="text-violet-400">{(r.confidence * 100).toFixed(0)}%</span>
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      disabled={reviewActionLoading === item.batchId}
                      onClick={() => handleReviewAction(item.batchId, 'approve')}
                      className="h-6 px-2.5 text-[10px] bg-emerald-600 hover:bg-emerald-500 text-white gap-1"
                    >
                      {reviewActionLoading === item.batchId ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                      Phê duyệt → ghi vào KB
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={reviewActionLoading === item.batchId}
                      onClick={() => handleReviewAction(item.batchId, 'reject')}
                      className="h-6 px-2.5 text-[10px] border-red-400/40 text-red-400 hover:bg-red-500/10 hover:text-red-300 gap-1"
                    >
                      <XCircle className="h-3 w-3" />
                      Từ chối
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ===== 1b. WRITEBACK AUDIT (Phase 2 SMOLAB Proposal 6) ===== */}
      <div className="nc-wrap nc-amber">
        <div className="nc-panel nc-sm nc-border-amber p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-amber-400" />
              <span className="text-sm font-semibold text-stone-100">Writeback Audit</span>
              <Badge className="text-[9px] h-4 px-1.5 bg-amber-950/50 text-amber-400 border-amber-400/35">
                {writebackAudit?.counts?.total ?? 0} batch
              </Badge>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={reconciling}
              onClick={handleReconcileWritebacks}
              className="h-6 px-2 text-[10px] bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 hover:text-amber-200 border border-amber-500/25"
            >
              {reconciling ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
              Reconcile now
            </Button>
          </div>

          {/* 6 stat tiles: pending / needs_review / partial / failed / rejected / completed */}
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-3">
            <div className="p-2 bg-slate-950/50 border border-amber-500/15 rounded-lg text-center">
              <Clock className="h-3.5 w-3.5 mx-auto text-amber-400 mb-0.5" />
              <p className="text-base font-bold text-stone-100 tabular-nums">{writebackAudit?.counts?.pending ?? '—'}</p>
              <p className="text-[9px] text-stone-400 uppercase">Pending</p>
            </div>
            <div className="p-2 bg-slate-950/50 border border-violet-500/25 rounded-lg text-center">
              <CircleHelp className="h-3.5 w-3.5 mx-auto text-violet-400 mb-0.5" />
              <p className="text-base font-bold text-stone-100 tabular-nums">{writebackAudit?.counts?.needs_review ?? '—'}</p>
              <p className="text-[9px] text-stone-400 uppercase">Chờ duyệt</p>
            </div>
            <div className="p-2 bg-slate-950/50 border border-amber-500/15 rounded-lg text-center">
              <AlertTriangle className="h-3.5 w-3.5 mx-auto text-orange-400 mb-0.5" />
              <p className="text-base font-bold text-stone-100 tabular-nums">{writebackAudit?.counts?.partial ?? '—'}</p>
              <p className="text-[9px] text-stone-400 uppercase">Partial</p>
            </div>
            <div className="p-2 bg-slate-950/50 border border-amber-500/15 rounded-lg text-center">
              <XCircle className="h-3.5 w-3.5 mx-auto text-red-400 mb-0.5" />
              <p className="text-base font-bold text-stone-100 tabular-nums">{writebackAudit?.counts?.failed ?? '—'}</p>
              <p className="text-[9px] text-stone-400 uppercase">Failed</p>
            </div>
            <div className="p-2 bg-slate-950/50 border border-amber-500/15 rounded-lg text-center">
              <Trash2 className="h-3.5 w-3.5 mx-auto text-stone-500 mb-0.5" />
              <p className="text-base font-bold text-stone-100 tabular-nums">{writebackAudit?.counts?.rejected ?? 0}</p>
              <p className="text-[9px] text-stone-400 uppercase">Rejected</p>
            </div>
            <div className="p-2 bg-slate-950/50 border border-amber-500/15 rounded-lg text-center">
              <CheckCircle2 className="h-3.5 w-3.5 mx-auto text-emerald-400 mb-0.5" />
              <p className="text-base font-bold text-stone-100 tabular-nums">{writebackAudit?.counts?.completed ?? '—'}</p>
              <p className="text-[9px] text-stone-400 uppercase">Completed</p>
            </div>
          </div>

          {/* Recent batches (last 5) */}
          {(writebackAudit?.recent?.length ?? 0) > 0 && (
            <div className="p-2 bg-slate-950/50 border border-amber-500/10 rounded-lg">
              <span className="text-[10px] text-stone-400 uppercase mb-1.5 block">Recent batches</span>
              <div className="space-y-1 max-h-40 overflow-y-auto pr-1" style={{ scrollbarWidth: 'thin' }}>
                {writebackAudit?.recent.slice(0, 5).map(b => {
                  const statusColor =
                    b.status === 'completed' ? 'text-emerald-400 bg-emerald-950/30 border-emerald-400/30'
                    : b.status === 'failed' ? 'text-red-400 bg-red-950/30 border-red-400/30'
                    : b.status === 'partial' ? 'text-orange-400 bg-orange-950/30 border-orange-400/30'
                    : b.status === 'needs_review' ? 'text-violet-400 bg-violet-950/30 border-violet-400/30'
                    : b.status === 'rejected' ? 'text-stone-500 bg-stone-950/30 border-stone-700/30'
                    : 'text-amber-400 bg-amber-950/30 border-amber-400/30'
                  return (
                    <div key={b.batchId} className={`flex items-center gap-2 p-1.5 border rounded-md ${statusColor}`}>
                      <span className="text-[9px] font-mono text-stone-400 truncate flex-1">
                        {b.batchId.slice(0, 8)}
                      </span>
                      <span className="text-[9px] uppercase font-semibold">{b.status}</span>
                      {b.failedStep && (
                        <span className="text-[8px] text-red-400/80" title={b.failedStep}>
                          {b.failedStep}
                        </span>
                      )}
                      <Badge className="text-[8px] h-3.5 px-1 bg-slate-900/60 text-stone-300 border-slate-700">
                        ×{b.attempts}
                      </Badge>
                      <span className="text-[8px] text-stone-500">{formatTime(b.createdAt)}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
          {(writebackAudit?.recent?.length ?? 0) === 0 && (
            <div className="text-[10px] text-stone-500 italic text-center py-2">
              Chưa có writeback batch nào — chat với agent để kích hoạt auto-learn writeback.
            </div>
          )}
        </div>
      </div>

      {/* ===== 1c. LAYER 9 — ADAPTATION INTELLIGENCE (Phase 2 SMOLAB Proposal 8) ===== */}
      <div className="nc-wrap nc-emerald">
        <div className="nc-panel nc-sm nc-border-emerald p-4">
          {/* Header row */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Brain className="h-4 w-4 text-emerald-400" />
              <span className="text-sm font-semibold text-stone-100">Layer 9 — Adaptation Intelligence</span>
              <Badge className="text-[9px] h-4 px-1.5 bg-emerald-950/50 text-emerald-400 border-emerald-400/35">
                {layer9Metrics?.aggregated?.totalRuns ?? 0} runs
              </Badge>
            </div>
          </div>

          {/* 4 stat tiles: Total Runs / Success Rate / Token Efficiency / Tokens Used */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
            <div className="p-2 bg-slate-950/50 border border-emerald-500/15 rounded-lg text-center">
              <Activity className="h-3.5 w-3.5 mx-auto text-emerald-400 mb-0.5" />
              <p className="text-base font-bold text-stone-100 tabular-nums">{layer9Metrics?.aggregated?.totalRuns ?? 0}</p>
              <p className="text-[9px] text-stone-400 uppercase">Total Runs</p>
            </div>
            <div className="p-2 bg-slate-950/50 border border-emerald-500/15 rounded-lg text-center">
              <CheckCircle2 className="h-3.5 w-3.5 mx-auto text-emerald-400 mb-0.5" />
              <p className="text-base font-bold text-stone-100 tabular-nums">
                {((layer9Metrics?.aggregated?.overallSuccessRate ?? 0) * 100).toFixed(1)}%
              </p>
              <p className="text-[9px] text-stone-400 uppercase">Success Rate</p>
            </div>
            <div className="p-2 bg-slate-950/50 border border-cyan-500/15 rounded-lg text-center">
              <Zap className="h-3.5 w-3.5 mx-auto text-cyan-400 mb-0.5" />
              <p className="text-base font-bold text-stone-100 tabular-nums">
                {(layer9Metrics?.aggregated?.overallTokenEfficiency ?? 0).toFixed(2)}
              </p>
              <p className="text-[9px] text-stone-400 uppercase">Token Efficiency</p>
            </div>
            <div className="p-2 bg-slate-950/50 border border-cyan-500/15 rounded-lg text-center">
              <Cpu className="h-3.5 w-3.5 mx-auto text-cyan-400 mb-0.5" />
              <p className="text-base font-bold text-stone-100 tabular-nums">
                {(layer9Metrics?.aggregated?.totalTokensUsed ?? 0).toLocaleString()}
              </p>
              <p className="text-[9px] text-stone-400 uppercase">Tokens Used</p>
            </div>
          </div>

          {/* Success Rate Trend — inline SVG sparkline (no external dep) */}
          <div className="p-2 bg-slate-950/50 border border-emerald-500/10 rounded-lg mb-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] text-stone-400 uppercase flex items-center gap-1">
                <TrendingUp className="h-3 w-3 text-emerald-400" /> Success Rate Trend (last 10 runs)
              </span>
              <span className="text-[9px] text-emerald-400/70 font-mono">
                {layer9Metrics?.successRateTrend?.length ?? 0}/10
              </span>
            </div>
            {(layer9Metrics?.successRateTrend?.length ?? 0) >= 2 ? (
              <svg viewBox="0 0 100 30" className="w-full h-8" preserveAspectRatio="none">
                <polyline
                  fill="none"
                  stroke="rgb(52 211 153)"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                  points={
                    layer9Metrics!.successRateTrend
                      .map((p, i) => {
                        const n = layer9Metrics!.successRateTrend.length
                        const x = n > 1 ? (i / (n - 1)) * 100 : 0
                        const y = 30 - (p.successRate * 30)
                        return `${x.toFixed(2)},${y.toFixed(2)}`
                      })
                      .join(' ')
                  }
                />
              </svg>
            ) : (
              <div className="text-[10px] text-stone-500 italic text-center py-2">
                Not enough data yet — needs at least 2 workflow runs.
              </div>
            )}
          </div>

          {/* 2-column grid: Recent Failure Patterns + Recent Adaptations */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
            {/* Recent Failure Patterns */}
            <div className="p-2 bg-slate-950/50 border border-emerald-500/10 rounded-lg">
              <span className="text-[10px] text-stone-400 uppercase mb-1.5 block">Recent Failure Patterns</span>
              {(layer9Metrics?.recentPatterns?.length ?? 0) > 0 ? (
                <div className="space-y-1 max-h-40 overflow-y-auto pr-1" style={{ scrollbarWidth: 'thin' }}>
                  {layer9Metrics?.recentPatterns.slice(0, 5).map(p => (
                    <div key={p.id} className="flex items-center gap-1.5 p-1.5 border rounded-md border-orange-400/25 bg-orange-950/20">
                      <Badge className="text-[8px] h-3.5 px-1 bg-orange-950/60 text-orange-400 border-orange-400/40 truncate max-w-[80px]">
                        {p.type}
                      </Badge>
                      <span className="text-[9px] text-stone-300">×{p.count}</span>
                      <span className="text-[8px] text-cyan-400/80 truncate flex-1" title={p.nextStrategy}>
                        → {p.nextStrategy}
                      </span>
                      {p.resolved && <CheckCircle2 className="h-2.5 w-2.5 text-emerald-400 flex-shrink-0" />}
                      <span className="text-[8px] text-stone-500">
                        {p.createdAt ? formatTime(p.createdAt) : '—'}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[10px] text-stone-500 italic text-center py-2">
                  No failure patterns detected — workflows healthy.
                </div>
              )}
            </div>

            {/* Recent Adaptations */}
            <div className="p-2 bg-slate-950/50 border border-cyan-500/10 rounded-lg">
              <span className="text-[10px] text-stone-400 uppercase mb-1.5 block">Recent Adaptations</span>
              {(layer9Metrics?.recentAdaptations?.length ?? 0) > 0 ? (
                <div className="space-y-1 max-h-40 overflow-y-auto pr-1" style={{ scrollbarWidth: 'thin' }}>
                  {layer9Metrics?.recentAdaptations.slice(0, 5).map(a => (
                    <div key={a.id} className="flex items-center gap-1.5 p-1.5 border rounded-md border-cyan-400/25 bg-cyan-950/20">
                      <span className="text-[8px] font-mono text-stone-300 truncate max-w-[60px]" title={a.fromStrategy}>
                        {a.fromStrategy}
                      </span>
                      <ArrowRight className="h-2.5 w-2.5 text-cyan-400 flex-shrink-0" />
                      <span className="text-[8px] font-mono text-emerald-400 truncate max-w-[60px]" title={a.toStrategy}>
                        {a.toStrategy}
                      </span>
                      <span className="text-[8px] text-stone-400 truncate flex-1" title={a.reason}>
                        {a.reason}
                      </span>
                      <Badge className="text-[8px] h-3.5 px-1 bg-cyan-950/60 text-cyan-300 border-cyan-400/40">
                        {(a.confidence * 100).toFixed(0)}%
                      </Badge>
                      <span className="text-[8px] text-stone-500">{formatTime(a.createdAt)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[10px] text-stone-500 italic text-center py-2">
                  No adaptations triggered.
                </div>
              )}
            </div>
          </div>

          {/* ML Quality subpanel (Phase 4 will populate TBDs) */}
          <div className="p-2 bg-slate-950/50 border border-emerald-500/10 rounded-lg">
            <span className="text-[10px] text-stone-400 uppercase mb-1.5 block">ML Quality</span>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="flex items-center gap-1.5 text-[10px]">
                <CheckCircle2 className="h-3 w-3 text-emerald-400 flex-shrink-0" />
                <span className="text-stone-300">Pseudo-hash vectors:</span>
                <span className="font-mono text-emerald-400 font-semibold">
                  {layer9Metrics?.mlQuality?.pseudoHashVectorCount ?? 0}
                </span>
                <span className="text-emerald-400">✓</span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px]">
                <Activity className="h-3 w-3 text-stone-500 flex-shrink-0" />
                <span className="text-stone-300">Embedding cache hit:</span>
                <span className="font-mono text-stone-400 italic">
                  {layer9Metrics?.mlQuality?.embeddingCacheHitRate == null
                    ? 'TBD'
                    : `${((layer9Metrics.mlQuality.embeddingCacheHitRate as number) * 100).toFixed(0)}%`}
                  <span className="text-stone-500 ml-1">(Phase 4)</span>
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px]">
                <Activity className="h-3 w-3 text-stone-500 flex-shrink-0" />
                <span className="text-stone-300">Auto-learn verified:</span>
                <span className="font-mono text-stone-400 italic">
                  {layer9Metrics?.mlQuality?.autoLearnVerificationRate == null
                    ? 'TBD'
                    : `${((layer9Metrics.mlQuality.autoLearnVerificationRate as number) * 100).toFixed(0)}%`}
                  <span className="text-stone-500 ml-1">(Phase 4)</span>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ===== 1d. EVALUATION RESULTS (Phase 4 SMOLAB Proposal 11' — eval harness) ===== */}
      <div className="nc-wrap nc-cyan">
        <div className="nc-panel nc-sm nc-border-cyan p-4">
          {/* Header row: icon + title + latest run status badge + Run Eval button */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <FlaskConical className="h-4 w-4 text-cyan-400" />
              <span className="text-sm font-semibold text-stone-100">Evaluation Results</span>
              {evalLatestRun && (
                <Badge
                  className={
                    evalLatestRun.status === 'completed'
                      ? 'text-[9px] h-4 px-1.5 bg-emerald-950/50 text-emerald-400 border-emerald-400/35'
                      : evalLatestRun.status === 'failed'
                        ? 'text-[9px] h-4 px-1.5 bg-red-950/50 text-red-400 border-red-400/35'
                        : 'text-[9px] h-4 px-1.5 bg-amber-950/50 text-amber-400 border-amber-400/35'
                  }
                >
                  {evalLatestRun.status}
                </Badge>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={evalStarting || evalLatestRun?.status === 'running'}
              onClick={handleRunEval}
              className="h-6 px-2 text-[10px] bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25 hover:text-cyan-200 border border-cyan-500/25"
            >
              {evalStarting || evalLatestRun?.status === 'running' ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Play className="h-3 w-3 mr-1" />
              )}
              Run Eval
            </Button>
          </div>

          {/* Live progress line while a run is in progress */}
          {evalLatestRun?.status === 'running' && (
            <div className="p-2 bg-slate-950/50 border border-cyan-500/15 rounded-lg mb-3 flex items-center gap-2">
              <Loader2 className="h-3 w-3 text-cyan-400 animate-spin flex-shrink-0" />
              <span className="text-[10px] text-stone-300 truncate">
                Running — {evalLatestRun.processedCount}/{evalLatestRun.caseCount} cases processed
                {evalData?.run ? ` (đang hiển thị kết quả run hoàn thành trước đó)` : ''}
              </span>
            </div>
          )}

          {/* Failed-run banner */}
          {evalLatestRun?.status === 'failed' && (
            <div className="p-2 bg-red-950/20 border border-red-400/25 rounded-lg mb-3 flex items-center gap-2">
              <AlertTriangle className="h-3 w-3 text-red-400 flex-shrink-0" />
              <span className="text-[10px] text-red-300 truncate" title={evalLatestRun.errorMessage ?? ''}>
                Run failed: {evalLatestRun.errorMessage || 'unknown error'}
              </span>
            </div>
          )}

          {/* Latest completed run: 6 stat tiles + meta + per-case list */}
          {evalData?.run ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2 mb-2">
                {/* Task 4: Coverage — fraction of cases the system attempted to
                    answer (negative cases count refusing as correct "answering"). */}
                <div className="p-2 bg-slate-950/50 border border-cyan-500/15 rounded-lg text-center">
                  <Layers className="h-3.5 w-3.5 mx-auto text-cyan-400 mb-0.5" />
                  <p className="text-base font-bold text-stone-100 tabular-nums">
                    {((evalData.run.avgCoverage ?? 0) * 100).toFixed(0)}%
                  </p>
                  <p className="text-[9px] text-stone-400 uppercase">Coverage</p>
                </div>
                <div className="p-2 bg-slate-950/50 border border-cyan-500/15 rounded-lg text-center">
                  <Target className="h-3.5 w-3.5 mx-auto text-cyan-400 mb-0.5" />
                  <p className="text-base font-bold text-stone-100 tabular-nums">
                    {((evalData.run.avgRecallAt5 ?? 0) * 100).toFixed(1)}%
                  </p>
                  <p className="text-[9px] text-stone-400 uppercase">Recall@5</p>
                </div>
                {/* Task 4: conditional faithfulness — among ANSWERED cases only
                    (the honest "was the attempted answer right" number). */}
                <div className="p-2 bg-slate-950/50 border border-cyan-500/15 rounded-lg text-center">
                  <CheckCircle2 className="h-3.5 w-3.5 mx-auto text-cyan-400 mb-0.5" />
                  <p className="text-base font-bold text-stone-100 tabular-nums">
                    {(evalData.run.avgCondFaithfulness ?? 0) > 0
                      ? `${((evalData.run.avgCondFaithfulness ?? 0) * 100).toFixed(1)}%`
                      : '—'}
                  </p>
                  <p className="text-[9px] text-stone-400 uppercase" title="Faithfulness among answered cases only (avg across all cases in parentheses)">
                    Faith·ans ({((evalData.run.avgFaithfulness ?? 0) * 100).toFixed(0)}%)
                  </p>
                </div>
                <div className="p-2 bg-slate-950/50 border border-cyan-500/15 rounded-lg text-center">
                  <GitBranch className="h-3.5 w-3.5 mx-auto text-cyan-400 mb-0.5" />
                  <p className="text-base font-bold text-stone-100 tabular-nums">
                    {((evalData.run.avgF1 ?? 0) * 100).toFixed(1)}%
                  </p>
                  <p className="text-[9px] text-stone-400 uppercase">Entity F1</p>
                </div>
                <div className="p-2 bg-slate-950/50 border border-cyan-500/15 rounded-lg text-center">
                  <AlertTriangle className={`h-3.5 w-3.5 mx-auto mb-0.5 ${(evalData.run.hallucinationCount ?? 0) > 0 ? 'text-red-400' : 'text-emerald-400'}`} />
                  <p className={`text-base font-bold tabular-nums ${(evalData.run.hallucinationCount ?? 0) > 0 ? 'text-red-400' : 'text-stone-100'}`}>
                    {evalData.run.hallucinationCount ?? 0}
                  </p>
                  <p className="text-[9px] text-stone-400 uppercase">Hallucinations</p>
                </div>
                <div className="p-2 bg-slate-950/50 border border-cyan-500/15 rounded-lg text-center">
                  <Clock className="h-3.5 w-3.5 mx-auto text-cyan-400 mb-0.5" />
                  <p className="text-base font-bold text-stone-100 tabular-nums">
                    {((evalData.run.avgLatencyMs ?? 0) / 1000).toFixed(1)}s
                  </p>
                  <p className="text-[9px] text-stone-400 uppercase">Avg Latency</p>
                </div>
              </div>

              {/* Task 4: answered/refused split line */}
              <div className="flex items-center gap-3 mb-2 text-[9px] text-stone-500 flex-wrap">
                <span className="text-emerald-400">{evalData.run.answeredCount ?? 0} answered</span>
                <span className="text-stone-500">·</span>
                <span className="text-amber-400">{evalData.run.refusalCount ?? 0} refused (correct for out-of-domain)</span>
              </div>

              {/* Run meta line */}
              <div className="flex items-center gap-3 mb-2 text-[9px] text-stone-500 flex-wrap">
                <span>Run {evalData.run.id.slice(0, 8)}</span>
                <span>Started: {formatDate(evalData.run.startedAt)} {formatTime(evalData.run.startedAt)}</span>
                {evalData.run.completedAt && <span>Completed: {formatTime(evalData.run.completedAt)}</span>}
                <span>
                  {evalData.run.processedCount}/{evalData.run.caseCount} cases
                </span>
                <span>{evalData.results.length} results</span>
              </div>

              {/* Last 5 per-case results */}
              {evalData.results.length > 0 && (
                <div className="p-2 bg-slate-950/50 border border-cyan-500/10 rounded-lg">
                  <span className="text-[10px] text-stone-400 uppercase mb-1.5 block">Recent cases (last 5)</span>
                  <div className="space-y-1 max-h-40 overflow-y-auto pr-1" style={{ scrollbarWidth: 'thin' }}>
                    {evalData.results.slice(-5).reverse().map((r) => (
                      <div key={r.id} className="flex items-center gap-1.5 p-1.5 border rounded-md border-cyan-400/20 bg-cyan-950/10">
                        <span className="text-[9px] text-stone-300 truncate flex-1" title={r.question}>
                          {r.question}
                        </span>
                        <Badge className="text-[8px] h-3.5 px-1 bg-slate-900/60 text-stone-400 border-slate-700 truncate max-w-[70px]">
                          {r.category}
                        </Badge>
                        <span
                          className="text-[9px] text-cyan-400 font-mono flex-shrink-0"
                          title={`judges: ${r.faithfulnessScores?.join(', ') ?? '—'}`}
                        >
                          F:{r.faithfulnessMedian.toFixed(2)}
                        </span>
                        <span className="text-[9px] text-emerald-400 font-mono flex-shrink-0">
                          R:{(r.recallAt5 * 100).toFixed(0)}%
                        </span>
                        {r.hallucinationDetected && (
                          <AlertTriangle className="h-2.5 w-2.5 text-red-400 flex-shrink-0" />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : evalLatestRun?.status !== 'running' ? (
            <div className="text-[10px] text-stone-500 italic text-center py-2">
              No eval runs yet — click Run Eval to start (uses ~10 cases × 4 LLM calls).
            </div>
          ) : null}
        </div>
      </div>

      {/* ===== 1e. RED TEAM SECURITY (Blueprint 2026-08-25 — adversarial self-testing) ===== */}
      <div className="nc-wrap nc-rose">
        <div className="nc-panel nc-sm nc-border-rose p-4">
          {/* Header row: icon + title + latest wave status badge + action buttons */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-rose-400" />
              <span className="text-sm font-semibold text-stone-100">Red Team Security</span>
              {redteamLatestRun && (
                <Badge
                  className={
                    redteamLatestRun.status === 'completed'
                      ? 'text-[9px] h-4 px-1.5 bg-emerald-950/50 text-emerald-400 border-emerald-400/35'
                      : redteamLatestRun.status === 'failed'
                        ? 'text-[9px] h-4 px-1.5 bg-red-950/50 text-red-400 border-red-400/35'
                        : 'text-[9px] h-4 px-1.5 bg-amber-950/50 text-amber-400 border-amber-400/35'
                  }
                >
                  {redteamLatestRun.status}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={redteamAttacking || redteamLatestRun?.status === 'running'}
                onClick={handleRedTeamAttack}
                className="h-6 px-2 text-[10px] bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 hover:text-rose-200 border border-rose-500/25"
              >
                {redteamAttacking || redteamLatestRun?.status === 'running' ? (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <Swords className="h-3 w-3 mr-1" />
                )}
                Triển khai tấn công
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={redteamForging}
                onClick={handleRedTeamForge}
                className="h-6 px-2 text-[10px] bg-rose-500/10 text-stone-300 hover:bg-rose-500/20 hover:text-rose-200 border border-rose-500/20"
              >
                {redteamForging ? (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <Sparkles className="h-3 w-3 mr-1" />
                )}
                Sinh vũ khí
              </Button>
            </div>
          </div>

          {/* Live progress line while a wave is in progress */}
          {redteamLatestRun?.status === 'running' && (
            <div className="p-2 bg-slate-950/50 border border-rose-500/15 rounded-lg mb-3 flex items-center gap-2">
              <Loader2 className="h-3 w-3 text-rose-400 animate-spin flex-shrink-0" />
              <span className="text-[10px] text-stone-300 truncate">
                Đang tấn công — {redteamLatestRun.processedCount}/{redteamLatestRun.caseCount} vũ khí đã bắn
                {rtRun ? ' (đang hiển thị kết quả đợt hoàn thành trước đó)' : ''}
              </span>
            </div>
          )}

          {/* Failed-run banner */}
          {redteamLatestRun?.status === 'failed' && (
            <div className="p-2 bg-red-950/20 border border-red-400/25 rounded-lg mb-3 flex items-center gap-2">
              <AlertTriangle className="h-3 w-3 text-red-400 flex-shrink-0" />
              <span className="text-[10px] text-red-300 truncate" title={redteamLatestRun.errorMessage ?? ''}>
                Đợt tấn công lỗi: {redteamLatestRun.errorMessage || 'unknown error'}
              </span>
            </div>
          )}

          {/* Latest completed wave: 5 stat tiles + vector bars + breach list */}
          {rtRun ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2 mb-2">
                <div className="p-2 bg-slate-950/50 border border-rose-500/15 rounded-lg text-center">
                  <AlertTriangle className="h-3.5 w-3.5 mx-auto text-rose-400 mb-0.5" />
                  <p className="text-base font-bold text-stone-100 tabular-nums">{rtBreaches}</p>
                  <p className="text-[9px] text-stone-400 uppercase" title="Số lần tấn công thắng hệ thống — bằng chứng đội an ninh đang làm việc">Breaches</p>
                </div>
                <div className="p-2 bg-slate-950/50 border border-rose-500/15 rounded-lg text-center">
                  <Shield className="h-3.5 w-3.5 mx-auto text-emerald-400 mb-0.5" />
                  <p className="text-base font-bold text-stone-100 tabular-nums">{rtDefended}</p>
                  <p className="text-[9px] text-stone-400 uppercase">Defended</p>
                </div>
                <div className="p-2 bg-slate-950/50 border border-rose-500/15 rounded-lg text-center">
                  <Target className="h-3.5 w-3.5 mx-auto text-emerald-400 mb-0.5" />
                  <p className="text-base font-bold text-stone-100 tabular-nums">
                    {rtWinRate != null ? `${(rtWinRate * 100).toFixed(0)}%` : '—'}
                  </p>
                  <p className="text-[9px] text-stone-400 uppercase">Win-rate</p>
                </div>
                <div className="p-2 bg-slate-950/50 border border-rose-500/15 rounded-lg text-center">
                  <Swords className="h-3.5 w-3.5 mx-auto text-rose-400 mb-0.5" />
                  <p className="text-base font-bold text-stone-100 tabular-nums">{redteamCounts?.active ?? '—'}</p>
                  <p className="text-[9px] text-stone-400 uppercase">Active Weapons</p>
                </div>
                <div className="p-2 bg-slate-950/50 border border-rose-500/15 rounded-lg text-center">
                  <CheckCircle2 className="h-3.5 w-3.5 mx-auto text-stone-400 mb-0.5" />
                  <p className="text-base font-bold text-stone-100 tabular-nums">{redteamCounts?.retired ?? '—'}</p>
                  <p className="text-[9px] text-stone-400 uppercase" title="Vũ khí bị phòng thủ hóa giải ≥5 lần liên tiếp — thành regression test">Retired</p>
                </div>
              </div>

              {/* Copy principle: breach = information (security exercise working), NOT system failure. */}
              <div className="flex items-center gap-3 mb-2 text-[9px] text-stone-500 flex-wrap">
                <span>Run {rtRun.id.slice(0, 8)}</span>
                <span>{rtRun.processedCount}/{rtRun.caseCount} cases</span>
                <span className="text-stone-400">
                  Breach = phát hiện của hoạt động an ninh (điều tốt) — hệ thống đang được chủ động săn lỗi trước khi gặp user
                </span>
              </div>

              {/* breachesByVector mini-bars (pure divs — no chart lib) */}
              {Object.keys(rtBreachesByVector).length > 0 && (
                <div className="p-2 bg-slate-950/50 border border-rose-500/10 rounded-lg mb-2">
                  <span className="text-[10px] text-stone-400 uppercase mb-1.5 block">Breaches theo vector tấn công</span>
                  <div className="space-y-1">
                    {Object.entries(rtBreachesByVector)
                      .sort((a, b) => b[1] - a[1])
                      .map(([vector, count]) => (
                        <div key={vector} className="flex items-center gap-2">
                          <span className="text-[9px] text-stone-400 w-20 truncate flex-shrink-0" title={vector}>
                            {REDTEAM_VECTOR_LABELS[vector] ?? vector}
                          </span>
                          <div className="flex-1 h-2.5 bg-slate-900/70 rounded-sm overflow-hidden">
                            <div
                              className="h-full bg-rose-500/60 rounded-sm"
                              style={{ width: `${Math.max(6, (count / rtVectorMax) * 100)}%` }}
                            />
                          </div>
                          <span className="text-[9px] text-rose-400 font-mono w-4 text-right flex-shrink-0">{count}</span>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {/* Last 5 breaches: vector badge + failureMode + question */}
              {rtRecentBreaches.length > 0 && (
                <div className="p-2 bg-slate-950/50 border border-rose-500/10 rounded-lg">
                  <span className="text-[10px] text-stone-400 uppercase mb-1.5 block">Breaches mới nhất (5)</span>
                  <div className="space-y-1 max-h-40 overflow-y-auto pr-1" style={{ scrollbarWidth: 'thin' }}>
                    {rtRecentBreaches.map((r) => (
                      <div key={r.id} className="flex items-center gap-1.5 p-1.5 border rounded-md border-rose-400/20 bg-rose-950/10">
                        <span className="text-[9px] text-stone-300 truncate flex-1" title={r.question}>
                          {r.question}
                        </span>
                        <Badge className="text-[8px] h-3.5 px-1 bg-rose-950/50 text-rose-300 border-rose-400/35 truncate max-w-[64px]">
                          {REDTEAM_VECTOR_LABELS[r.attackVector] ?? r.attackVector}
                        </Badge>
                        <span
                          className="text-[8px] text-amber-400 font-mono flex-shrink-0 truncate max-w-[80px]"
                          title={r.attackVerdict?.reasoning ?? ''}
                        >
                          {r.attackVerdict?.failureMode ?? '—'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : redteamLatestRun?.status !== 'running' ? (
            <div className="text-[10px] text-stone-500 italic text-center py-2">
              Chưa có đợt tấn công nào — Red Team săn failure modes trước khi chúng gặp user.
            </div>
          ) : null}
        </div>
      </div>

      {/* ===== 2. MEMORY TIMELINE ===== */}
      <div className="nc-wrap nc-amber">
        <div className="nc-panel nc-sm nc-border-amber p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-amber-400" />
              <span className="text-sm font-semibold text-stone-100">Memory Timeline</span>
              <Badge className="text-[9px] h-4 px-1.5 bg-amber-950/50 text-amber-400 border-amber-400/35">{timeline?.total ?? 0}</Badge>
            </div>
            <div className="flex items-center gap-1">
              {['all', 'insight', 'correction', 'preference', 'feedback', 'pattern'].map(filter => (
                <Button
                  key={filter}
                  variant="ghost"
                  size="sm"
                  className={`h-6 px-2 text-[9px] ${timelineFilter === filter ? 'bg-amber-500/20 text-amber-400' : 'text-stone-400 hover:text-stone-200'}`}
                  onClick={() => setTimelineFilter(filter)}
                >
                  {filter === 'all' ? 'Tất cả' : getTypeConfig(filter).label}
                </Button>
              ))}
            </div>
          </div>

          {timelineLoading && !timeline ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 text-amber-400 animate-spin" />
            </div>
          ) : (timeline?.events?.length ?? 0) > 0 ? (
            <div className="max-h-80 overflow-y-auto space-y-1.5 pr-1" style={{ scrollbarWidth: 'thin' }}>
              {timeline?.events.map(event => {
                const cfg = getTypeConfig(event.type)
                return (
                  <div key={event.id} className={`flex items-start gap-2.5 p-2 ${cfg.bg} border ${cfg.border} rounded-lg`}>
                    <div className={`shrink-0 mt-0.5 ${cfg.color}`}>{cfg.icon}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <Badge className={`text-[8px] h-3.5 px-1 ${cfg.bg} ${cfg.color} border ${cfg.border}`}>{cfg.label}</Badge>
                        <span className="text-[9px] text-stone-500">{formatDate(event.timestamp)} {formatTime(event.timestamp)}</span>
                      </div>
                      <p className="text-[11px] text-stone-300 leading-relaxed line-clamp-2">{event.content}</p>
                      {/* Show extra metadata for feedback */}
                      {event.type === 'feedback' && Boolean(event.metadata?.feedbackType || event.metadata?.type) && (
                        <span className="inline-flex items-center gap-1 mt-0.5">
                          {((event.metadata?.feedbackType || event.metadata?.type) === 'positive') ? (
                            <ThumbsUp className="h-2.5 w-2.5 text-emerald-400" />
                          ) : (
                            <ThumbsDown className="h-2.5 w-2.5 text-red-400" />
                          )}
                        </span>
                      )}
                      {/* Show applied status for corrections */}
                      {event.type === 'correction' && (
                        <span className="text-[9px] text-stone-500 ml-2">
                          {event.metadata?.applied ? '✓ Đã áp dụng' : '⏳ Chờ xử lý'}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <BookMarked className="h-8 w-8 text-amber-500/30 mb-2" />
              <p className="text-xs text-stone-500">Chưa có sự kiện học tập nào</p>
              <p className="text-[10px] text-stone-600">Chat với Agent hoặc dạy Agent để bắt đầu</p>
            </div>
          )}
        </div>
      </div>

      {/* ===== 3. MANUAL TEACHING ===== */}
      <div className="nc-wrap nc-amber">
        <div className="nc-panel nc-sm nc-border-amber p-4">
          <div className="flex items-center gap-2 mb-3">
            <GraduationCap className="h-4 w-4 text-amber-400" />
            <span className="text-sm font-semibold text-stone-100">Dạy Agent</span>
          </div>

          <div className="space-y-3">
            {/* Type selector */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-stone-400 w-16 shrink-0">Loại:</span>
              <div className="flex gap-1">
                {(['insight', 'correction', 'preference', 'order'] as const).map(t => {
                  const cfg = getTypeConfig(t)
                  return (
                    <Button
                      key={t}
                      variant="ghost"
                      size="sm"
                      className={`h-7 px-2.5 text-[10px] ${teachType === t ? `${cfg.bg} ${cfg.color} border ${cfg.border}` : 'text-stone-400 hover:text-stone-200'}`}
                      onClick={() => setTeachType(t)}
                    >
                      {cfg.icon} <span className="ml-1">{cfg.label}</span>
                    </Button>
                  )
                })}
              </div>
            </div>

            {/* Wrong answer (for correction only) */}
            {teachType === 'correction' && (
              <div className="flex items-start gap-2">
                <span className="text-[10px] text-stone-400 w-16 shrink-0 pt-2">Sai:</span>
                <Textarea
                  value={teachWrongAnswer}
                  onChange={e => setTeachWrongAnswer(e.target.value)}
                  placeholder="Câu trả lời sai của Agent..."
                  className="text-xs bg-slate-950/60 border-amber-400/40 text-stone-200 placeholder:text-stone-500 focus:border-amber-500/50 min-h-[60px] resize-none"
                />
              </div>
            )}

            {/* Content */}
            <div className="flex items-start gap-2">
              <span className="text-[10px] text-stone-400 w-16 shrink-0 pt-2">
                {teachType === 'correction' ? 'Đúng:' : teachType === 'order' ? 'Lệnh:' : 'Nội dung:'}
              </span>
              <Textarea
                value={teachContent}
                onChange={e => setTeachContent(e.target.value)}
                placeholder={
                  teachType === 'insight' ? 'VD: QuickSort có độ phức tạp O(n log n) trung bình'
                  : teachType === 'correction' ? 'VD: QuickSort có độ phức tạp O(n log n) trung bình, không phải O(n²)'
                  : teachType === 'preference' ? 'VD: response_style: ngắn gọn'
                  : 'VD: Luôn tìm kiếm Knowledge Base trước khi trả lời'
                }
                className="text-xs bg-slate-950/60 border-amber-400/40 text-stone-200 placeholder:text-stone-500 focus:border-amber-500/50 min-h-[60px] resize-none"
              />
            </div>

            {/* Reason (for correction) */}
            {teachType === 'correction' && (
              <div className="flex items-start gap-2">
                <span className="text-[10px] text-stone-400 w-16 shrink-0 pt-2">Lý do:</span>
                <Input
                  value={teachReason}
                  onChange={e => setTeachReason(e.target.value)}
                  placeholder="Tại sao Agent sai? (tùy chọn)"
                  className="h-8 text-xs bg-slate-950/60 border-amber-400/40 text-stone-200 placeholder:text-stone-500 focus:border-amber-500/50"
                />
              </div>
            )}

            {/* Related entity (for insight/correction) */}
            {(teachType === 'insight' || teachType === 'correction') && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-stone-400 w-16 shrink-0">Entity:</span>
                <Input
                  value={teachRelatedEntity}
                  onChange={e => setTeachRelatedEntity(e.target.value)}
                  placeholder="Entity liên quan (tùy chọn)"
                  className="h-8 text-xs bg-slate-950/60 border-amber-400/40 text-stone-200 placeholder:text-stone-500 focus:border-amber-500/50"
                />
              </div>
            )}

            {/* Submit button */}
            <div className="flex items-center justify-end">
              <Button
                onClick={handleTeach}
                disabled={teachSubmitting || !teachContent.trim() || (teachType === 'correction' && !teachWrongAnswer.trim())}
                className="chamfer-sm h-8 px-4 bg-gradient-to-r from-amber-500 to-yellow-600 hover:from-amber-600 hover:to-yellow-700 text-white border-0 text-xs"
              >
                {teachSubmitting ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Đang gửi...</> : <><GraduationCap className="mr-1.5 h-3.5 w-3.5" /> Dạy Agent</>}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* ===== 4. FEEDBACK HISTORY ===== */}
      <div className="nc-wrap nc-amber">
        <div className="nc-panel nc-sm nc-border-amber p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <MessageCircle className="h-4 w-4 text-amber-400" />
              <span className="text-sm font-semibold text-stone-100">Lịch sử Feedback</span>
              <Badge className="text-[9px] h-4 px-1.5 bg-amber-950/50 text-amber-400 border-amber-400/35">{feedbackHistory.length}</Badge>
            </div>
            <div className="flex items-center gap-1">
              {(['all', 'positive', 'negative'] as const).map(f => (
                <Button
                  key={f}
                  variant="ghost"
                  size="sm"
                  className={`h-6 px-2 text-[9px] ${feedbackFilter === f ? 'bg-amber-500/20 text-amber-400' : 'text-stone-400 hover:text-stone-200'}`}
                  onClick={() => setFeedbackFilter(f)}
                >
                  {f === 'all' ? 'Tất cả' : f === 'positive' ? '👍' : '👎'}
                </Button>
              ))}
            </div>
          </div>

          {filteredFeedback.length > 0 ? (
            <div className="max-h-64 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
              <table className="w-full text-[10px]">
                <thead className="sticky top-0 bg-slate-950/80">
                  <tr>
                    <th className="px-2 py-1.5 text-left text-stone-400 font-medium border-b border-amber-500/10">Thời gian</th>
                    <th className="px-2 py-1.5 text-left text-stone-400 font-medium border-b border-amber-500/10">Feedback</th>
                    <th className="px-2 py-1.5 text-left text-stone-400 font-medium border-b border-amber-500/10">Nội dung</th>
                    <th className="px-2 py-1.5 text-left text-stone-400 font-medium border-b border-amber-500/10">Correction</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredFeedback.map(event => {
                    const meta = event.metadata || {}
                    const isPositive = (meta.feedbackType || meta.type) === 'positive'
                    return (
                      <tr key={event.id} className="hover:bg-slate-950/30">
                        <td className="px-2 py-1.5 text-stone-400 border-b border-amber-500/5 whitespace-nowrap">{formatTime(event.timestamp)}</td>
                        <td className="px-2 py-1.5 border-b border-amber-500/5">
                          {isPositive ? <ThumbsUp className="h-3 w-3 text-emerald-400" /> : <ThumbsDown className="h-3 w-3 text-red-400" />}
                        </td>
                        <td className="px-2 py-1.5 text-stone-300 border-b border-amber-500/5 max-w-[200px] truncate">{String(meta.userContent || event.content).substring(0, 60)}</td>
                        <td className="px-2 py-1.5 text-stone-400 border-b border-amber-500/5 max-w-[150px] truncate">{meta.correction ? String(meta.correction).substring(0, 40) : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-6">
              <p className="text-[10px] text-stone-500">Chưa có feedback nào</p>
            </div>
          )}
        </div>
      </div>

      {/* ===== 5. KNOWLEDGE GRAPH MINI-VIEW ===== */}
      <div className="nc-wrap nc-amber">
        <div className="nc-panel nc-sm nc-border-amber p-4">
          <div className="flex items-center gap-2 mb-3">
            <Network className="h-4 w-4 text-amber-400" />
            <span className="text-sm font-semibold text-stone-100">Agent Knowledge Graph</span>
            <Badge className="text-[9px] h-4 px-1.5 bg-amber-950/50 text-amber-400 border-amber-400/35">{agentEntities.length} entities</Badge>
          </div>

          {agentEntities.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-48 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
              {agentEntities.map(entity => (
                <div key={entity.id} className="p-2 bg-slate-950/50 border border-amber-500/10 rounded-lg">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-cyan-400" />
                    <span className="text-[10px] font-medium text-stone-200 truncate">{entity.entityName}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Badge className="text-[8px] h-3 px-1 bg-cyan-950/30 text-cyan-400 border-cyan-400/35">{entity.entityType}</Badge>
                  </div>
                  {entity.description && (
                    <p className="text-[9px] text-stone-500 mt-0.5 line-clamp-1">{entity.description}</p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-4">
              <Network className="h-6 w-6 text-amber-500/20 mx-auto mb-1" />
              <p className="text-[10px] text-stone-500">Agent chưa tạo entity nào</p>
              <p className="text-[9px] text-stone-600">Sử dụng knowledge_write tool để Agent tạo entity</p>
            </div>
          )}
        </div>
      </div>

      {/* ===== 6. STANDING ORDERS ===== */}
      <div className="nc-wrap nc-amber">
        <div className="nc-panel nc-sm nc-border-amber p-4">
          <div className="flex items-center gap-2 mb-3">
            <BookMarked className="h-4 w-4 text-amber-400" />
            <span className="text-sm font-semibold text-stone-100">Standing Orders</span>
            <Badge className="text-[9px] h-4 px-1.5 bg-amber-950/50 text-amber-400 border-amber-400/35">{orders.length}</Badge>
          </div>

          {orders.length > 0 ? (
            <div className="space-y-1.5 mb-3 max-h-40 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
              {orders.map((order, idx) => (
                <div key={order.id} className="flex items-start gap-2 p-2 bg-slate-950/50 border border-amber-500/10 rounded-lg">
                  <span className="text-[10px] text-stone-500 shrink-0">{idx + 1}.</span>
                  <span className="text-[11px] text-stone-300 flex-1">{order.order}</span>
                  <Badge className="text-[8px] h-3.5 px-1 bg-blue-950/30 text-blue-400 border-blue-400/35">P{order.priority}</Badge>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[10px] text-stone-500 mb-3">Chưa có standing order nào</p>
          )}

          {/* Add new order inline */}
          <div className="flex items-center gap-2">
            <Input
              value={newOrder}
              onChange={e => setNewOrder(e.target.value)}
              placeholder="Thêm standing order mới..."
              className="h-7 text-xs bg-slate-950/60 border-amber-400/40 text-stone-200 placeholder:text-stone-500 focus:border-amber-500/50 flex-1"
              onKeyDown={e => {
                if (e.key === 'Enter' && newOrder.trim()) {
                  // Directly teach - don't set teachContent/teachType (pollutes form state)
                  const orderText = newOrder.trim()
                  fetch('/api/openclaw/learning/teach', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: 'order', content: orderText, metadata: { priority: newOrderPriority, enabled: true } }),
                  }).then(async res => {
                    if (res.ok) {
                      toast({ title: 'Đã thêm Standing Order' })
                      setNewOrder('')
                      const statsRes = await fetch('/api/openclaw/learning/stats')
                      if (statsRes.ok) { const d = await statsRes.json(); setStats(d); setOrders(d.standingOrders || []) }
                    }
                  })
                }
              }}
            />
            <Input
              type="number"
              value={newOrderPriority}
              onChange={e => setNewOrderPriority(parseInt(e.target.value) || 0)}
              className="h-7 w-14 text-xs bg-slate-950/60 border-amber-400/40 text-stone-200 text-center"
              min={0}
              max={10}
            />
          </div>
        </div>
      </div>

      {/* ===== 7. EXPORT / IMPORT ===== */}
      <div className="nc-wrap nc-amber">
        <div className="nc-panel nc-sm nc-border-amber p-4">
          <div className="flex items-center gap-2 mb-3">
            <FileJson className="h-4 w-4 text-amber-400" />
            <span className="text-sm font-semibold text-stone-100">Xuất / Nhập Bộ nhớ</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Export */}
            <div className="p-3 bg-slate-950/50 border border-amber-500/10 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <FileDown className="h-3.5 w-3.5 text-amber-400" />
                <span className="text-xs text-stone-200">Xuất bộ nhớ</span>
              </div>
              <div className="flex items-center gap-2 mb-2">
                <Select value={exportFormat} onValueChange={(v: 'json' | 'markdown') => setExportFormat(v)}>
                  <SelectTrigger className="h-7 text-xs w-[110px] rounded-lg border-amber-400/35 bg-slate-950/60 text-stone-200">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-950/80 border-amber-400/35">
                    <SelectItem value="json" className="text-stone-200 focus:text-white focus:bg-stone-800/80">JSON</SelectItem>
                    <SelectItem value="markdown" className="text-stone-200 focus:text-white focus:bg-stone-800/80">Markdown</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={handleExport}
                className="chamfer-sm h-7 px-3 bg-gradient-to-r from-amber-500/80 to-yellow-600/80 hover:from-amber-600/80 hover:to-yellow-700/80 text-white border-0 text-[10px]"
              >
                <Download className="mr-1 h-3 w-3" /> Xuất {exportFormat.toUpperCase()}
              </Button>
            </div>

            {/* Import */}
            <div className="p-3 bg-slate-950/50 border border-amber-500/10 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <FileUp className="h-3.5 w-3.5 text-amber-400" />
                <span className="text-xs text-stone-200">Nhập bộ nhớ</span>
              </div>
              <div className="flex items-center gap-2 mb-2">
                <Select value={importMode} onValueChange={(v: 'skip' | 'overwrite' | 'merge') => setImportMode(v)}>
                  <SelectTrigger className="h-7 text-xs w-[110px] rounded-lg border-amber-400/35 bg-slate-950/60 text-stone-200">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-950/80 border-amber-400/35">
                    <SelectItem value="skip" className="text-stone-200 focus:text-white focus:bg-stone-800/80">Bỏ qua trùng</SelectItem>
                    <SelectItem value="overwrite" className="text-stone-200 focus:text-white focus:bg-stone-800/80">Ghi đè</SelectItem>
                    <SelectItem value="merge" className="text-stone-200 focus:text-white focus:bg-stone-800/80">Ghép nối</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={importing}
                  className="chamfer-sm h-7 px-3 bg-gradient-to-r from-violet-500/80 to-purple-600/80 hover:from-violet-600/80 hover:to-purple-700/80 text-white border-0 text-[10px]"
                >
                  {importing ? <><Loader2 className="mr-1 h-3 w-3 animate-spin" /> Đang nhập...</> : <><UploadIcon className="mr-1 h-3 w-3" /> Chọn file JSON</>}
                </Button>
                <input ref={fileInputRef} type="file" accept=".json" onChange={handleImport} className="hidden" />
              </div>
            </div>
          </div>
        </div>
      </div>

    </div>
  )
}

