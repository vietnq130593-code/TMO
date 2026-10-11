'use client'

// ========================================================================
// neural-architecture-section — Tab "Kiến trúc Neural" (module Database)
// (2026-10-11) — hiển thị TOÀN BỘ kiến trúc "mạng thần kinh" của TMO:
// 6 lớp (Đầu vào → Xử lý → Lưu trữ → Học → Quyết định → Đầu ra), 23 node,
// 37 cạnh dòng chảy dữ liệu (data/reward/feedback/read — có hạt chạy động),
// thuật toán + hàm số từng node (file:line) và Ô NHẬP TINH CHỈNH runtime
// thật cho 13 hyperparameter (STORE > ENV > DEFAULT qua /api/neural-architecture).
//
// Tự poll 15s (fail-open giữ dữ liệu cũ); health (qdrant/neo4j/r2) nhận
// qua prop từ parent (page.tsx poll 10s sẵn).
// ========================================================================

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import {
  Network, RefreshCw, RotateCcw, Loader2, Settings2, ArrowRight,
  TriangleAlert, Wrench, Database, Zap, ZoomIn, ZoomOut, Maximize2,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { toast } from 'sonner'
import type { HealthResponse } from '@/components/app-shared'
import type { NeuralGraph, TuningStateEntry } from '@/lib/learning/neural-types'
import {
  NEURAL_GEO, NEURAL_FONTS, NEURAL_ZOOM,
  computeNeuralLayout, edgeVisual, edgeIsActive,
  clampNeuralZoom, neuralSvgWidth, neuralZoomLabel, zoomStepFrom,
  type NeuralZoom,
} from '@/lib/learning/neural-layout'

// ==================== API CONTRACT ====================

interface NeuralApiResponse {
  graph: NeuralGraph
  tuning: TuningStateEntry[]
  live: Record<string, Array<{ label: string; value: string }>>
  qTop: Array<{ action: string; q: number; visits: number }>
  salRecent: Array<{
    id: string; fromStrategy: string; toStrategy: string; reason: string
    confidence: number | null; successful: boolean | null; createdAt: string
  }>
  generatedAt: string
}

const POLL_NEURAL_MS = 15_000

// ==================== MÀU NHẤN (accent theo lớp) ====================
// P1 (2026-10-11): hình học (NEURAL_GEO) + cỡ chữ (NEURAL_FONTS) + style cạnh
// (NEURAL_EDGE_KINDS/edgeVisual) + thu phóng (NEURAL_ZOOM) tách sang
// neural-layout.ts (module thuần — pin test r82).

const ACCENTS: Record<string, { stroke: string; bright: string; text: string; badge: string }> = {
  cyan:    { stroke: 'rgba(34,211,238,0.45)',  bright: 'rgba(34,211,238,0.95)',  text: 'text-cyan-400',    badge: 'bg-cyan-950/60 text-cyan-400 border-cyan-500/40' },
  teal:    { stroke: 'rgba(45,212,191,0.45)',  bright: 'rgba(45,212,191,0.95)',  text: 'text-teal-400',    badge: 'bg-teal-950/60 text-teal-400 border-teal-500/40' },
  amber:   { stroke: 'rgba(251,191,36,0.45)',  bright: 'rgba(251,191,36,0.95)',  text: 'text-amber-400',   badge: 'bg-amber-950/60 text-amber-400 border-amber-500/40' },
  violet:  { stroke: 'rgba(167,139,250,0.45)', bright: 'rgba(167,139,250,0.95)', text: 'text-violet-400',  badge: 'bg-violet-950/60 text-violet-400 border-violet-500/40' },
  fuchsia: { stroke: 'rgba(232,121,249,0.45)', bright: 'rgba(232,121,249,0.95)', text: 'text-fuchsia-400', badge: 'bg-fuchsia-950/60 text-fuchsia-400 border-fuchsia-500/40' },
  emerald: { stroke: 'rgba(52,211,153,0.45)',  bright: 'rgba(52,211,153,0.95)',  text: 'text-emerald-400', badge: 'bg-emerald-950/60 text-emerald-400 border-emerald-500/40' },
}

// ==================== HELPERS ====================

const viNum = (n: number): string => n.toLocaleString('vi-VN')

const SOURCE_BADGE: Record<string, { label: string; cls: string }> = {
  store:   { label: 'đã đặt', cls: 'bg-emerald-950/70 text-emerald-400 border-emerald-500/45' },
  env:     { label: 'env',    cls: 'bg-cyan-950/70 text-cyan-400 border-cyan-500/45' },
  default: { label: 'mặc định', cls: 'bg-slate-950/70 text-stone-400 border-stone-600/50' },
}

/** Bổ sung số liệu sống cho node storage từ /api/health (client merge). */
function healthLiveFor(health: HealthResponse | null, nodeId: string): Array<{ label: string; value: string }> {
  if (!health?.services) return []
  try {
    switch (nodeId) {
      case 'qdrant': {
        const q = health.services.qdrant as { connected?: boolean; documentsCollection?: { pointCount?: number }; chunksCollection?: { pointCount?: number; dimActual?: number } } | undefined
        if (!q?.connected) return [{ label: 'Trạng thái', value: 'MẤT KẾT NỐI' }]
        const out: Array<{ label: string; value: string }> = []
        if (q.documentsCollection) out.push({ label: 'Điểm documents', value: viNum(q.documentsCollection.pointCount ?? 0) })
        if (q.chunksCollection) out.push({ label: `Điểm chunks (${q.chunksCollection.dimActual ?? '?'}d)`, value: viNum(q.chunksCollection.pointCount ?? 0) })
        return out
      }
      case 'neo4j': {
        const n = health.services.neo4j as { connected?: boolean; nodeCount?: number; relationshipCount?: number } | undefined
        if (!n?.connected) return [{ label: 'Trạng thái', value: 'MẤT KẾT NỐI' }]
        return [
          { label: 'Nodes', value: viNum(n.nodeCount ?? 0) },
          { label: 'Relationships', value: viNum(n.relationshipCount ?? 0) },
        ]
      }
      case 'r2': {
        const r = health.services.r2 as { configured?: boolean; connected?: boolean; objectCount?: number } | undefined
        if (!r?.configured || !r?.connected) return [{ label: 'Trạng thái', value: r?.configured ? 'MẤT KẾT NỐI' : 'CHƯA CẤU HÌNH' }]
        return [{ label: 'Objects', value: viNum(r.objectCount ?? 0) }]
      }
      default:
        return []
    }
  } catch {
    return []
  }
}

// ==================== MAIN SECTION ====================

export function NeuralArchitectureSection({ health }: { health?: HealthResponse | null }) {
  const [data, setData] = useState<NeuralApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>('q-table')
  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set())
  const inspectorRef = useRef<HTMLDivElement | null>(null)
  // FB-P1-R1-03: cần đo tỉ lệ render thật của chế độ fit (renderedWidth /
  // viewBoxWidth) để nút ± bước từ tỉ lệ HIỆN TẠI — "Thu nhỏ" thu nhỏ thật.
  const svgRef = useRef<SVGSVGElement | null>(null)
  // P1-1: thu phóng đồ thị ('fit' | 0.6..1.6) — mặc định 1 (= 100%: cỡ chữ
  // thiết kế 1:1, đọc được ngay; mobile lần đầu vào mặc định 'fit').
  const [zoom, setZoom] = useState<NeuralZoom>(1)
  const [zoomRestored, setZoomRestored] = useState(false)
  // P1-3: node đang nhận focus bàn phím — vẽ ring đứt nét thay cho outline
  // (focus:outline-none trên <g> SVG không có chỉ báo mặc định tin được).
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null)

  // Không setState đồng bộ ở đầu hàm (react-hooks/set-state-in-effect):
  // mọi setState đều nằm SAU await — an toàn gọi từ effect. Cờ loading bật
  // bởi event handler (nút Làm mới), không bật trong hàm.
  // hasDataRef thay dep [data] → fetchData ỔN ĐỊNH (effect không re-run
  // mỗi lần data đổi — chống vòng lặp fetch vô hạn).
  const hasDataRef = useRef(false)
  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/neural-architecture')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as NeuralApiResponse
      setData(json)
      hasDataRef.current = true
      setError(null)
    } catch (err) {
      console.error('[NeuralArch] fetch error:', err)
      if (!hasDataRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  // Mount + poll nền 15s giữ số liệu sống (fail-open giữ dữ liệu cũ).
  // (queueMicrotask: defer để không gọi setState đồng bộ trong body effect —
  // cùng pattern auto-learn-section)
  useEffect(() => {
    queueMicrotask(() => {
      fetchData()
    })
    const t = setInterval(() => {
      fetchData()
    }, POLL_NEURAL_MS)
    return () => clearInterval(t)
  }, [fetchData])

  // P1-1: restore zoom 1 lần SAU mount (localStorage > mobile-fit > 100%)
  // rồi mới bật persist — tránh ghi đè lựa chọn user bằng mặc định khởi tạo.
  // (queueMicrotask: defer để không gọi setState đồng bộ trong body effect —
  // cùng pattern fetch phía trên)
  useEffect(() => {
    queueMicrotask(() => {
      try {
        const saved = localStorage.getItem('graphrag-neural-zoom')
        if (saved === 'fit') setZoom('fit')
        else if (saved !== null) {
          const n = Number.parseFloat(saved)
          if (Number.isFinite(n)) setZoom(clampNeuralZoom(n))
        } else if (window.innerWidth < 1024) {
          setZoom('fit') // mobile: mở đầu bằng tổng quan, chạm node để xem chi tiết
        }
      } catch { /* private mode — giữ mặc định */ }
      setZoomRestored(true)
    })
  }, [])
  useEffect(() => {
    if (!zoomRestored) return
    try { localStorage.setItem('graphrag-neural-zoom', zoom === 'fit' ? 'fit' : String(zoom)) } catch { /* bỏ qua */ }
  }, [zoom, zoomRestored])

  const zoomBy = useCallback((delta: number) => {
    // FB-P1-R1-03: từ 'fit' neo theo tỉ lệ render thật (vd 1180/1732 ≈ 0.68)
    // thay vì neo 1 — tránh "Thu nhỏ 10%" lại PHÓNG TO trên card hẹp
    // (0.9 × 1732 = 1559px > 1180px fit). Svg chưa render → fallback 1.
    let fitScale: number | null = null
    const el = svgRef.current
    if (el) {
      const w = el.getBoundingClientRect().width
      const vbW = el.viewBox?.baseVal.width ?? 0
      if (w > 0 && vbW > 0) fitScale = w / vbW
    }
    setZoom(prev => zoomStepFrom(prev, fitScale, delta))
  }, [])

  // ==================== TUNING ACTIONS ====================

  const withSaving = useCallback(async (key: string, fn: () => Promise<Response>) => {
    setSavingKeys(prev => new Set(prev).add(key))
    try {
      const res = await fn()
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error('Tinh chỉnh thất bại', { description: json.error ?? `HTTP ${res.status}` })
        return false
      }
      if (json.tuning) setData(prev => (prev ? { ...prev, tuning: json.tuning } : prev))
      return true
    } catch (err) {
      toast.error('Tinh chỉnh thất bại', { description: err instanceof Error ? err.message : String(err) })
      return false
    } finally {
      setSavingKeys(prev => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }, [])

  const handleSet = useCallback((key: string, value: string | number) =>
    withSaving(key, () => fetch('/api/neural-architecture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set', key, value }),
    })), [withSaving])

  const handleReset = useCallback((key: string) =>
    withSaving(key, () => fetch('/api/neural-architecture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reset', key }),
    })), [withSaving])

  // ==================== DERIVED ====================

  const graph = data?.graph ?? null
  const tuning = data?.tuning ?? []
  const tuningByNode = useMemo(() => {
    const m = new Map<string, TuningStateEntry[]>()
    for (const t of tuning) {
      const list = m.get(t.nodeId) ?? []
      list.push(t)
      m.set(t.nodeId, list)
    }
    return m
  }, [tuning])
  const tuningByKey = useMemo(() => new Map(tuning.map(t => [t.key, t])), [tuning])
  const paramsChanged = tuning.filter(t => t.source === 'store').length

  // Auto-layout (đời từ inline sang module thuần neural-layout — pin test r82)
  const layout = useMemo(() => (graph ? computeNeuralLayout(graph) : null), [graph])

  const selectedNode = layout?.nodeById.get(selectedNodeId ?? '') ?? null
  const selectedLive = useMemo(() => {
    if (!selectedNodeId) return []
    const fromApi = data?.live?.[selectedNodeId] ?? []
    return [...fromApi, ...healthLiveFor(health ?? null, selectedNodeId)]
  }, [selectedNodeId, data, health])

  const selectNode = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId)
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      // Mobile: cuộn tới inspector ngay dưới đồ thị
      requestAnimationFrame(() => inspectorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
    }
  }, [])

  // ==================== RENDER ====================

  return (
    <div className="space-y-4" role="region" aria-label="Kiến trúc Neural">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="p-1.5 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600">
          <Network className="h-4 w-4 text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold tracking-tight text-stone-100 flex flex-wrap items-center gap-2">
            🧬 Kiến trúc Neural — toàn bộ mạng học của TMO
            {data && (
              <Badge variant="outline" className="text-[9px] h-4 px-1.5 bg-emerald-950/60 text-emerald-400 border-emerald-500/40">
                ● sống · {new Date(data.generatedAt).toLocaleTimeString('vi-VN')}
              </Badge>
            )}
          </h3>
          <p className="text-[11px] text-stone-400">
            6 lớp × {graph?.nodes.length ?? '…'} nút × {graph?.edges.length ?? '…'} dòng chảy · {tuning.length} tham số tinh chỉnh runtime
            {paramsChanged > 0 && <span className="text-amber-400"> · {paramsChanged} đã bị chỉnh</span>}
          </p>
        </div>
        <Button
          variant="outline" size="sm"
          className="h-7 text-[11px] border-emerald-500/40 text-emerald-300 hover:bg-emerald-950/40 hover:text-emerald-200"
          onClick={() => { setLoading(true); void fetchData() }} disabled={loading}
        >
          {loading ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />} Làm mới
        </Button>
      </div>

      {error && !data && (
        <Card className="border-rose-500/40 bg-rose-950/20">
          <CardContent className="p-4 text-xs text-rose-300">
            Không tải được kiến trúc: {error} — thử Làm mới (đường /api/neural-architecture fail-open nhưng có thể DB đang bận).
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_390px]">
        {/* ── ĐỒ THỊ LỚP (SVG) ── */}
        <div className="nc-wrap nc-cyan">
          <Card className="nc-panel nc-md nc-border-cyan">
            <CardContent className="p-3 sm:p-4">
              {loading && !layout ? (
                <div className="flex items-center justify-center py-24" aria-busy="true">
                  <Loader2 className="h-6 w-6 animate-spin text-cyan-400" />
                </div>
              ) : layout ? (
                <>
                  {/* Thanh thu phóng (P1-1): 100% = cỡ chữ thiết kế 1:1 (đọc được
                      ngay); Fit = ôm vừa khung (tổng quan nhanh, chữ nhỏ). */}
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2" role="group" aria-label="Thu phóng đồ thị">
                    <p className="text-[10px] text-stone-500" aria-live="polite">
                      {zoom === 'fit'
                        ? 'Vừa khung — tổng quan nhanh (chữ nhỏ; chọn 100% để đọc chi tiết)'
                        : `${neuralZoomLabel(zoom)} — cỡ chữ thiết kế; kéo ngang để xem hết 6 lớp`}
                    </p>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline" size="sm"
                        className="h-6 w-6 p-0 border-slate-700 text-stone-300"
                        aria-label="Thu nhỏ 10%"
                        disabled={zoom !== 'fit' && zoom <= NEURAL_ZOOM.MIN}
                        onClick={() => zoomBy(-NEURAL_ZOOM.STEP)}
                      >
                        <ZoomOut className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="outline" size="sm"
                        className={`h-6 px-2 text-[10px] tabular-nums border-slate-700 ${zoom === 1 ? 'text-emerald-300 border-emerald-500/60' : 'text-stone-300'}`}
                        aria-pressed={zoom === 1}
                        onClick={() => setZoom(1)}
                      >
                        100%
                      </Button>
                      <Button
                        variant="outline" size="sm"
                        className="h-6 w-6 p-0 border-slate-700 text-stone-300"
                        aria-label="Phóng to 10%"
                        disabled={zoom !== 'fit' && zoom >= NEURAL_ZOOM.MAX}
                        onClick={() => zoomBy(NEURAL_ZOOM.STEP)}
                      >
                        <ZoomIn className="h-3 w-3" />
                      </Button>
                      <Button
                        variant={zoom === 'fit' ? 'default' : 'outline'}
                        size="sm"
                        className={`h-6 px-2 text-[10px] ${zoom === 'fit' ? 'bg-emerald-600/80 hover:bg-emerald-600 text-white' : 'border-slate-700 text-stone-300'}`}
                        aria-pressed={zoom === 'fit'}
                        onClick={() => setZoom('fit')}
                      >
                        <Maximize2 className="h-3 w-3 mr-1" /> Vừa khung
                      </Button>
                    </div>
                  </div>
                  <div className="overflow-x-auto pb-2">
                    <svg
                      ref={svgRef}
                      viewBox={`0 0 ${layout.width} ${layout.height}`}
                      style={zoom === 'fit'
                        ? { minWidth: NEURAL_ZOOM.FIT_FLOOR_PX, width: '100%', height: 'auto' }
                        : { width: neuralSvgWidth(layout.width, zoom), height: 'auto' }}
                      role="img"
                      aria-label="Sơ đồ kiến trúc 6 lớp của hệ thống TMO — chọn một nút để xem chi tiết và tinh chỉnh"
                    >
                      <defs>
                        <marker id="na-arrow-cyan" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                          <path d="M 0 0 L 8 4 L 0 8 z" fill="rgba(34,211,238,0.85)" />
                        </marker>
                        <marker id="na-arrow-amber" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                          <path d="M 0 0 L 8 4 L 0 8 z" fill="rgba(251,191,36,0.9)" />
                        </marker>
                        <marker id="na-arrow-fuchsia" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                          <path d="M 0 0 L 8 4 L 0 8 z" fill="rgba(232,121,249,0.85)" />
                        </marker>
                        <marker id="na-arrow-stone" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                          <path d="M 0 0 L 8 4 L 0 8 z" fill="rgba(168,162,158,0.6)" />
                        </marker>
                      </defs>

                      {/* Tiêu đề lớp */}
                      {graph!.layers.map(layer => {
                        const acc = ACCENTS[layer.accent] ?? ACCENTS.cyan
                        const x = NEURAL_GEO.PAD + (layer.index - 1) * (NEURAL_GEO.LAYER_W + NEURAL_GEO.LAYER_GAP)
                        return (
                          <g key={layer.id}>
                            <text x={x} y={NEURAL_GEO.PAD + 6} fontSize={NEURAL_FONTS.layerTitle} fontWeight="700" className={acc.text} style={{ fontFamily: 'inherit' }}>
                              LỚP {layer.index} · {layer.title.toUpperCase()}
                            </text>
                            <text x={x} y={NEURAL_GEO.PAD + 19} fontSize={NEURAL_FONTS.layerSub} className="fill-stone-500" style={{ fontFamily: 'inherit' }}>
                              {layer.subtitle}
                            </text>
                          </g>
                        )
                      })}

                      {/* Cạnh (dưới node) */}
                      {layout.edges.map(e => {
                        // P1-2: cạnh nối với node đang chọn → sáng + dày + hạt
                        // to; còn lại mờ NEURAL_EDGE_DIM_OPACITY để dòng chảy
                        // của node đang xem nổi bật hẳn (opacity trên <g> kéo
                        // theo cả marker arrowhead).
                        const active = edgeIsActive(e, selectedNodeId)
                        const k = edgeVisual(e.kind, active)
                        return (
                          <g key={e.id} opacity={k.opacity}>
                            <title>{`${e.label} (${e.kind})`}</title>
                            <path
                              d={e.d} fill="none"
                              stroke={k.stroke} strokeWidth={k.strokeWidth}
                              strokeDasharray={k.dash}
                              className={k.className}
                              markerEnd={`url(#${k.marker})`}
                            />
                            {k.dot && (
                              <circle r={k.dotRadius} fill={k.dot}>
                                <animateMotion dur="3s" repeatCount="indefinite" path={e.d} />
                              </circle>
                            )}
                          </g>
                        )
                      })}

                      {/* Node */}
                      {layout.nodes.map(node => {
                        const layer = graph!.layers.find(l => l.id === node.layer)
                        const acc = ACCENTS[layer?.accent ?? 'cyan'] ?? ACCENTS.cyan
                        const isSel = node.id === selectedNodeId
                        // P1-3: focus ring riêng (đứt nét amber) — ẩn khi đã chọn
                        // (selection ring màu accent đã hiện sẵn)
                        const isFocused = node.id === focusedNodeId && !isSel
                        const params = tuningByNode.get(node.id) ?? []
                        const live = [...(data?.live?.[node.id] ?? []), ...healthLiveFor(health ?? null, node.id)]
                        const liveText = live[0] ? `${live[0].label}: ${live[0].value}` : ''
                        return (
                          <g
                            key={node.id}
                            transform={`translate(${node.x}, ${node.y})`}
                            onClick={() => selectNode(node.id)}
                            onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectNode(node.id) } }}
                            onFocus={() => setFocusedNodeId(node.id)}
                            onBlur={() => setFocusedNodeId(prev => (prev === node.id ? null : prev))}
                            tabIndex={0}
                            role="button"
                            aria-label={`${node.title} — ${node.subtitle}${params.length > 0 ? `, ${params.length} tham số tinh chỉnh` : ''}`}
                            className="cursor-pointer transition-opacity hover:opacity-85 focus:outline-none"
                          >
                            <title>{`${node.title} — ${node.subtitle}`}</title>
                            {isFocused && (
                              <rect x="-4" y="-4" width={NEURAL_GEO.NODE_W + 8} height={NEURAL_GEO.NODE_H + 8} rx="12"
                                fill="none" stroke="rgba(251,191,36,0.9)" strokeWidth="1.5" strokeDasharray="5 4" />
                            )}
                            {isSel && (
                              <rect x="-3" y="-3" width={NEURAL_GEO.NODE_W + 6} height={NEURAL_GEO.NODE_H + 6} rx="12"
                                fill="none" stroke={acc.bright} strokeOpacity="0.25" strokeWidth="6" />
                            )}
                            <rect
                              width={NEURAL_GEO.NODE_W} height={NEURAL_GEO.NODE_H} rx="10"
                              fill="rgba(2,6,23,0.92)"
                              stroke={isSel ? acc.bright : acc.stroke}
                              strokeWidth={isSel ? 2 : 1.2}
                            />
                            <text x="10" y="26" fontSize={NEURAL_FONTS.title} fontWeight="600" className="fill-stone-100" style={{ fontFamily: 'inherit' }}>
                              {node.title.length > 25 ? `${node.title.slice(0, 24)}…` : node.title}
                            </text>
                            <text x="10" y="42" fontSize={NEURAL_FONTS.subtitle} className="fill-stone-400" style={{ fontFamily: 'inherit' }}>
                              {node.subtitle.length > 40 ? `${node.subtitle.slice(0, 39)}…` : node.subtitle}
                            </text>
                            <text x="10" y="66" fontSize={NEURAL_FONTS.live} className={acc.text} style={{ fontFamily: 'inherit' }}>
                              {liveText.length > 38 ? `${liveText.slice(0, 37)}…` : liveText}
                            </text>
                            {params.length > 0 && (
                              <text x={NEURAL_GEO.NODE_W - 10} y="66" fontSize={NEURAL_FONTS.gear} textAnchor="end" className="fill-amber-400" style={{ fontFamily: 'inherit' }}>
                                ⚙ {params.length}
                              </text>
                            )}
                          </g>
                        )
                      })}
                    </svg>
                  </div>

                  {/* Chú giải dòng chảy */}
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[9px] text-stone-400">
                    <span className="flex items-center gap-1.5">
                      <svg width="26" height="6"><line x1="0" y1="3" x2="26" y2="3" stroke="rgba(34,211,238,0.8)" strokeWidth="1.6" strokeDasharray="6 4" className="na-edge-data" /></svg>
                      dòng dữ liệu
                    </span>
                    <span className="flex items-center gap-1.5">
                      <svg width="26" height="6"><line x1="0" y1="3" x2="26" y2="3" stroke="rgba(251,191,36,0.9)" strokeWidth="1.8" strokeDasharray="3 4" className="na-edge-reward" /></svg>
                      phần thưởng học (W1/W2)
                    </span>
                    <span className="flex items-center gap-1.5">
                      <svg width="26" height="6"><line x1="0" y1="3" x2="26" y2="3" stroke="rgba(232,121,249,0.8)" strokeWidth="1.4" strokeDasharray="7 5" /></svg>
                      điều tiết ngược
                    </span>
                    <span className="flex items-center gap-1.5">
                      <svg width="26" height="6"><line x1="0" y1="3" x2="26" y2="3" stroke="rgba(168,162,158,0.5)" strokeWidth="1" strokeDasharray="2 4" /></svg>
                      truy vấn đọc
                    </span>
                    <span className="text-amber-400">⚙ = có ô nhập tinh chỉnh</span>
                    <span>cạnh sáng = dòng chảy qua nút đang chọn</span>
                  </div>
                </>
              ) : null}
            </CardContent>
          </Card>
        </div>

        {/* ── INSPECTOR ── */}
        <div ref={inspectorRef} className="nc-wrap nc-emerald">
          <Card className="nc-panel nc-md nc-border-emerald h-full">
            <CardContent className="p-4 space-y-3">
              {selectedNode ? (
                <>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="text-sm font-semibold text-stone-100">{selectedNode.title}</h4>
                      <Badge variant="outline" className={`text-[9px] h-4 px-1.5 ${ACCENTS[graph!.layers.find(l => l.id === selectedNode.layer)?.accent ?? 'cyan']?.badge ?? ''}`}>
                        Lớp {graph!.layers.find(l => l.id === selectedNode.layer)?.index} · {graph!.layers.find(l => l.id === selectedNode.layer)?.title}
                      </Badge>
                    </div>
                    <p className="text-[10px] text-stone-500 font-mono">{selectedNode.subtitle}</p>
                  </div>

                  <p className="text-[11px] leading-relaxed text-stone-300">{selectedNode.description}</p>

                  {selectedNode.algorithm && (
                    <div className="rounded-md border border-cyan-500/30 bg-slate-950/70 p-2">
                      <p className="text-[9px] uppercase tracking-wide text-cyan-500 mb-1">Thuật toán</p>
                      <p className="font-mono text-[10px] text-cyan-300 leading-relaxed break-words">{selectedNode.algorithm}</p>
                      {selectedNode.algorithmNote && (
                        <p className="text-[9px] text-stone-500 italic mt-1">{selectedNode.algorithmNote}</p>
                      )}
                    </div>
                  )}

                  {selectedNode.functions.length > 0 && (
                    <div>
                      <p className="text-[9px] uppercase tracking-wide text-stone-500 mb-1.5 flex items-center gap-1"><Wrench className="h-2.5 w-2.5" /> Hàm số</p>
                      <div className="flex flex-wrap gap-1.5">
                        {selectedNode.functions.map(fn => (
                          <span key={`${fn.name}-${fn.file}-${fn.line ?? ''}`}
                            className="font-mono text-[9px] rounded border border-slate-700/60 bg-slate-950/60 px-1.5 py-0.5 text-stone-300">
                            {fn.name} <span className="text-stone-500">{fn.file.split('/').slice(-1)[0]}{fn.line ? `:${fn.line}` : ''}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {selectedLive.length > 0 && (
                    <div>
                      <p className="text-[9px] uppercase tracking-wide text-stone-500 mb-1.5 flex items-center gap-1"><Database className="h-2.5 w-2.5" /> Số liệu trực tiếp</p>
                      <div className="grid grid-cols-2 gap-1.5">
                        {selectedLive.map(lv => (
                          <div key={lv.label} className="rounded border border-slate-700/50 bg-slate-950/50 px-2 py-1">
                            <p className="text-[8px] text-stone-500 truncate">{lv.label}</p>
                            <p className="text-[11px] text-stone-100 font-medium truncate" title={lv.value}>{lv.value}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {(tuningByNode.get(selectedNode.id) ?? []).length > 0 ? (
                    <div className="space-y-3 pt-1 border-t border-slate-800">
                      <p className="text-[9px] uppercase tracking-wide text-amber-500 flex items-center gap-1 pt-2">
                        <Settings2 className="h-2.5 w-2.5" /> Tinh chỉnh vận hành ({(tuningByNode.get(selectedNode.id) ?? []).length})
                      </p>
                      {(tuningByNode.get(selectedNode.id) ?? []).map(entry => (
                        <TuningControl
                          key={entry.key}
                          entry={entry}
                          nodeTitle={selectedNode.title}
                          saving={savingKeys.has(entry.key)}
                          onSet={handleSet}
                          onReset={handleReset}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="text-[10px] text-stone-600 italic pt-2 border-t border-slate-800">
                      Node này không có tham số runtime (giá trị cố định theo spec — xem mô tả thuật toán).
                    </p>
                  )}
                </>
              ) : (
                <div className="py-10 text-center space-y-2">
                  <Network className="h-8 w-8 text-stone-600 mx-auto" />
                  <p className="text-xs text-stone-400">Chọn một nút trên sơ đồ để xem thuật toán, hàm số và ô tinh chỉnh.</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ── BẢNG TINH CHỈNH TOÀN BỘ ── */}
      <div className="nc-wrap nc-violet">
        <Card className="nc-panel nc-md nc-border-violet">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Zap className="h-3.5 w-3.5 text-violet-400" />
              <h4 className="text-xs font-semibold text-stone-100">Bảng điều khiển tham số — toàn bộ mạng</h4>
              <span className="text-[9px] text-stone-500">chuỗi hiệu lực: STORE › ENV › DEFAULT · áp dụng tức thì (không restart)</span>
            </div>
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="text-stone-500 border-b border-slate-800">
                    <th className="text-left py-1.5 pr-2 font-medium">Tham số</th>
                    <th className="text-left py-1.5 pr-2 font-medium">Nút</th>
                    <th className="text-left py-1.5 pr-2 font-medium">Hiệu lực</th>
                    <th className="text-left py-1.5 pr-2 font-medium">Mặc định</th>
                    <th className="text-left py-1.5 font-medium">Hành động</th>
                  </tr>
                </thead>
                <tbody>
                  {tuning.length === 0 && (
                    <tr><td colSpan={5} className="py-4 text-center text-stone-600">Đang tải…</td></tr>
                  )}
                  {tuning.map(t => {
                    const node = graph?.nodes.find(n => n.id === t.nodeId)
                    const src = SOURCE_BADGE[t.source] ?? SOURCE_BADGE.default
                    return (
                      <tr key={t.key} className="border-b border-slate-900/80 hover:bg-slate-950/40">
                        <td className="py-1.5 pr-2">
                          <p className="text-stone-200 font-medium">{t.label}</p>
                          <p className="font-mono text-[8px] text-stone-600">{t.key}</p>
                        </td>
                        <td className="py-1.5 pr-2">
                          <button
                            className="text-cyan-400 hover:text-cyan-300 hover:underline text-left"
                            onClick={() => selectNode(t.nodeId)}
                          >
                            {node?.title ?? t.nodeId}
                          </button>
                        </td>
                        <td className="py-1.5 pr-2">
                          <span className="inline-flex items-center gap-1.5">
                            <span className="text-stone-100 font-mono">
                              {String(t.effectiveValue)}{t.unit ? ` ${t.unit}` : ''}
                            </span>
                            <Badge variant="outline" className={`text-[8px] h-3.5 px-1 ${src.cls}`}>{src.label}</Badge>
                          </span>
                        </td>
                        <td className="py-1.5 pr-2 text-stone-500 font-mono">
                          {String(t.default)}{t.unit ? ` ${t.unit}` : ''}
                        </td>
                        <td className="py-1.5">
                          <span className="inline-flex items-center gap-1">
                            <button
                              className="text-stone-400 hover:text-stone-200"
                              title="Xem & tinh chỉnh tại nút"
                              aria-label={`Mở tinh chỉnh ${t.label}`}
                              onClick={() => selectNode(t.nodeId)}
                            >
                              <ArrowRight className="h-3 w-3" />
                            </button>
                            {t.storeValue !== null && (
                              <button
                                className="text-stone-500 hover:text-amber-400 disabled:opacity-40"
                                title="Trả về mặc định (bỏ override)"
                                aria-label={`Reset ${t.label}`}
                                disabled={savingKeys.has(t.key)}
                                onClick={() => void handleReset(t.key)}
                              >
                                <RotateCcw className="h-3 w-3" />
                              </button>
                            )}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── HỒ SƠ HỌC GẦN ĐÂY (Q + SAL) ── */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="nc-wrap nc-amber">
          <Card className="nc-panel nc-md nc-border-amber">
            <CardContent className="p-4">
              <p className="text-[9px] uppercase tracking-wide text-amber-500 mb-2">Bảng Q — top model đã học (mode-agent-tier-1)</p>
              {(data?.qTop?.length ?? 0) === 0 ? (
                <p className="text-[10px] text-stone-500 italic">Chưa có Q-entry nào (Q học sau mỗi run goal-loop / workflow).</p>
              ) : (
                <div className="space-y-1.5">
                  {data!.qTop.map((q, i) => (
                    <div key={q.action} className="flex items-center gap-2 text-[10px]">
                      <span className="w-4 text-stone-600 tabular-nums">#{i + 1}</span>
                      <span className="font-mono text-stone-200 truncate flex-1" title={q.action}>{q.action}</span>
                      <div className="w-20 h-1.5 rounded-full bg-slate-900 overflow-hidden" aria-hidden="true">
                        <div
                          className={`h-full rounded-full ${q.q >= 0 ? 'bg-emerald-500/80' : 'bg-rose-500/80'}`}
                          style={{ width: `${Math.min(100, Math.abs(q.q) * 100)}%` }}
                        />
                      </div>
                      <span className={`tabular-nums font-mono w-12 text-right ${q.q >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>Q={q.q.toFixed(2)}</span>
                      <span className="text-stone-500 tabular-nums w-14 text-right">{q.visits} lần</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
        <div className="nc-wrap nc-rose">
          <Card className="nc-panel nc-md nc-border-rose">
            <CardContent className="p-4">
              <p className="text-[9px] uppercase tracking-wide text-rose-400 mb-2">Strategy Adaptation Log — gần nhất</p>
              {(data?.salRecent?.length ?? 0) === 0 ? (
                <p className="text-[10px] text-stone-500 italic">Chưa có SAL nào (phát sinh khi workflow gặp failure-pattern và đổi chiến lược).</p>
              ) : (
                <div className="space-y-1.5 max-h-44 overflow-y-auto">
                  {data!.salRecent.map(sal => (
                    <div key={sal.id} className="text-[10px] flex items-center gap-2">
                      <span className="font-mono text-stone-400">{sal.fromStrategy}</span>
                      <ArrowRight className="h-2.5 w-2.5 text-stone-600" />
                      <span className="font-mono text-stone-200">{sal.toStrategy}</span>
                      {sal.successful === null
                        ? <Badge variant="outline" className="text-[8px] h-3.5 px-1 bg-slate-950/70 text-stone-400 border-stone-600/50">chưa chốt</Badge>
                        : sal.successful
                          ? <Badge variant="outline" className="text-[8px] h-3.5 px-1 bg-emerald-950/70 text-emerald-400 border-emerald-500/45">thành công</Badge>
                          : <Badge variant="outline" className="text-[8px] h-3.5 px-1 bg-rose-950/70 text-rose-400 border-rose-500/45">thất bại</Badge>}
                      <span className="text-stone-600 ml-auto shrink-0">{new Date(sal.createdAt).toLocaleString('vi-VN')}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

// ==================== TUNING CONTROL (một tham số) ====================

function TuningControl({
  entry, nodeTitle, saving, onSet, onReset,
}: {
  entry: TuningStateEntry
  nodeTitle: string
  saving: boolean
  onSet: (key: string, value: string | number) => Promise<boolean>
  onReset: (key: string) => Promise<boolean>
}) {
  const isNumber = entry.type === 'number'
  const [localNum, setLocalNum] = useState<number>(Number(entry.effectiveValue))
  const [localRaw, setLocalRaw] = useState<string>(String(entry.effectiveValue))
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pendingValue, setPendingValue] = useState<string | null>(null)

  // Đồng bộ local state khi server đổi giá trị hiệu lực (poll/save) —
  // pattern "adjust state during render" của React (không useEffect —
  // tránh cascading render; chạy 1 lần duy nhất tới khi hội tụ).
  const [lastEffective, setLastEffective] = useState<string | number>(entry.effectiveValue)
  if (entry.effectiveValue !== lastEffective) {
    setLastEffective(entry.effectiveValue)
    setLocalNum(Number(entry.effectiveValue))
    setLocalRaw(String(entry.effectiveValue))
  }

  const src = SOURCE_BADGE[entry.source] ?? SOURCE_BADGE.default

  const commit = useCallback(async (value: string | number) => {
    // Spec có cảnh báo (điểm dừng #5) → xác nhận trước khi áp giá trị mới
    if (entry.warning && String(value) !== String(entry.effectiveValue)) {
      setPendingValue(String(value))
      setConfirmOpen(true)
      return
    }
    const ok = await onSet(entry.key, value)
    if (ok) toast.success(`Đã cập nhật ${entry.label}`, { description: `${nodeTitle} · hiệu lực tức thì` })
  }, [entry.key, entry.label, entry.effectiveValue, entry.warning, nodeTitle, onSet])

  return (
    <div className="rounded-md border border-slate-800 bg-slate-950/50 p-2.5 space-y-2">
      {/* Header: label + source badge */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-medium text-stone-200">{entry.label}</span>
        <Badge variant="outline" className={`text-[8px] h-3.5 px-1 ${src.cls}`}>{src.label}</Badge>
        <span className="text-[8px] text-stone-600 font-mono truncate">{entry.key}</span>
        <span className="ml-auto flex items-center gap-1">
          {saving && <Loader2 className="h-3 w-3 animate-spin text-emerald-400" />}
          {entry.storeValue !== null && (
            <button
              className="text-stone-500 hover:text-amber-400 disabled:opacity-40"
              title="Trả về mặc định (bỏ override)"
              aria-label={`Reset ${entry.label}`}
              disabled={saving}
              onClick={async () => {
                const ok = await onReset(entry.key)
                if (ok) toast.success(`Đã trả ${entry.label} về mặc định`)
              }}
            >
              <RotateCcw className="h-3 w-3" />
            </button>
          )}
        </span>
      </div>

      <p className="text-[9px] text-stone-500 leading-relaxed">{entry.description}</p>

      {isNumber ? (
        <div className="space-y-1.5">
          <Slider
            min={entry.min ?? 0}
            max={entry.max ?? 1}
            step={entry.step ?? 0.01}
            value={[Number.isFinite(localNum) ? localNum : Number(entry.default)]}
            onValueChange={v => { setLocalNum(v[0]); setLocalRaw(String(v[0])) }}
            onValueCommit={v => void commit(v[0])}
            disabled={saving}
            aria-label={`${entry.label} — thanh trượt`}
            className="[&_[data-slot=slider-range]]:bg-emerald-500/70"
          />
          <div className="flex items-center gap-2">
            <Input
              type="number"
              inputMode="decimal"
              className="h-6 text-[10px] font-mono w-24 bg-slate-950/70 border-slate-700"
              value={localRaw}
              min={entry.min}
              max={entry.max}
              step={entry.step}
              disabled={saving}
              aria-label={`${entry.label} — ô nhập số`}
              onChange={e => setLocalRaw(e.target.value)}
              onBlur={() => {
                const n = parseFloat(localRaw)
                if (Number.isFinite(n) && n !== Number(entry.effectiveValue)) void commit(n)
                else setLocalRaw(String(entry.effectiveValue))
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.currentTarget.blur() }
              }}
            />
            {entry.unit && <span className="text-[9px] text-stone-500">{entry.unit}</span>}
            <span className="text-[8px] text-stone-600 ml-auto">
              [{entry.min ?? '−∞'} … {entry.max ?? '∞'}] · mặc định {String(entry.default)}
            </span>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {(entry.enumValues ?? []).map(v => {
            const active = String(entry.effectiveValue) === v
            return (
              <Button
                key={v}
                type="button"
                variant="outline"
                size="sm"
                disabled={saving}
                aria-pressed={active}
                className={`h-6 px-2.5 text-[10px] font-mono rounded-md border transition-colors ${
                  active
                    ? 'bg-emerald-600/25 border-emerald-500/60 text-emerald-200'
                    : 'bg-slate-950/60 border-slate-700 text-stone-400 hover:text-stone-200 hover:border-slate-500'
                }`}
                onClick={() => { if (!active) void commit(v) }}
              >
                {v}
              </Button>
            )
          })}
          <span className="text-[8px] text-stone-600 ml-auto">mặc định {String(entry.default)}</span>
        </div>
      )}

      <p className="text-[8px] text-stone-600 font-mono truncate" title={entry.appliesTo}>
        ⟶ áp dụng: {entry.appliesTo}
      </p>

      {/* Cảnh báo hiệu lực (vd policy=softmax đang bật) */}
      {entry.warning && String(entry.effectiveValue) !== String(entry.default) && (
        <p className="text-[9px] text-amber-400 flex items-start gap-1.5 leading-relaxed">
          <TriangleAlert className="h-3 w-3 shrink-0 mt-0.5" /> {entry.warning}
        </p>
      )}

      {/* Xác nhận cho spec có cảnh báo (điểm dừng #5) */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm flex items-center gap-2">
              <TriangleAlert className="h-4 w-4 text-amber-400" /> Xác nhận đổi {entry.label}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs leading-relaxed">
              {entry.warning}
              <br /><br />
              Giá trị sẽ áp: <span className="font-mono text-amber-300">{pendingValue}</span> (hiện tại:{' '}
              <span className="font-mono">{String(entry.effectiveValue)}</span>). Hiệu lực tức thì trên mọi call tiếp theo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-8 text-xs" onClick={() => { setConfirmOpen(false); setPendingValue(null) }}>Giữ nguyên</AlertDialogCancel>
            <AlertDialogAction
              className="h-8 text-xs bg-amber-600 hover:bg-amber-500 text-white"
              onClick={async () => {
                setConfirmOpen(false)
                if (pendingValue !== null) {
                  const ok = await onSet(entry.key, pendingValue)
                  if (ok) toast.success(`Đã cập nhật ${entry.label}`, { description: `${nodeTitle} · hiệu lực tức thì` })
                }
                setPendingValue(null)
              }}
            >
              Áp dụng {pendingValue}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
