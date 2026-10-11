'use client'

// ========================================================================
// neural-architecture-section — Tab "Kiến trúc Neural" (module Database)
// (2026-10-11) — hiển thị TOÀN BỘ kiến trúc "mạng thần kinh" của TMO:
// 6 lớp (Đầu vào → Xử lý → Lưu trữ → Học → Quyết định → Đầu ra), 23 node,
// 37 cạnh dòng chảy dữ liệu (data/reward/feedback/read — có hạt chạy động),
// thuật toán + hàm số từng node (file:line) và Ô NHẬP TINH CHỈNH runtime
// thật cho 14 hyperparameter (STORE > ENV > DEFAULT qua /api/neural-architecture).
//
// P3 (2026-10-11, chỉ thị user):
//   B1. PAN — bấm giữ chuột + kéo nền đồ thị để di chuyển nội dung (vùng
//       cuộn ngang vốn đã có, thêm drag-pan cho chuột; touch giữ cuộn native).
//   B2. Cỡ chữ +1px toàn bộ ô/bảng (NEURAL_FONTS + mọi text-[Npx] trong tab)
//       — "phần chữ trong nhiều ô và bảng quá bé".
//   B3. ARIA — svg role="img" → role="group" (con node là role="button" tương
//       tác — role=img biến con thành presentational, mâu thuẫn đã backlog từ P1).
//
// Tự poll 15s (fail-open giữ dữ liệu cũ); health (qdrant/neo4j/r2) nhận
// qua prop từ parent (page.tsx poll 10s sẵn).
// ========================================================================

import { useState, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import {
  Network, RefreshCw, RotateCcw, Loader2, Settings2, ArrowRight,
  TriangleAlert, Wrench, Database, Zap, ZoomIn, ZoomOut, Maximize2, History, BrainCircuit, Tags,
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
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'
import { toast } from 'sonner'
import type { HealthResponse } from '@/components/app-shared'
import type { NeuralGraph, TuningStateEntry, TuningChangeLogEntry } from '@/lib/learning/neural-types'
import { TUNING_CHANGE_LOG_CAP } from '@/lib/learning/neural-types'
import {
  NEURAL_GEO, NEURAL_FONTS, NEURAL_ZOOM,
  computeNeuralLayout, edgeVisual, edgeIsActive, edgeDotVisible,
  NEURAL_DESKTOP_BREAKPOINT,
  clampNeuralZoom, neuralSvgWidth, neuralZoomLabel, zoomStepFrom,
  type NeuralZoom, type PlacedNode,
} from '@/lib/learning/neural-layout'
// BRAIN-P1 phần UI (áp dụng sớm 2026-10-12 — BLUEPRINT-BRAIN §4.1 v0.2):
// registry single-source cho panel "Não vận hành"; API + UI cùng import.
import {
  BRAIN_REGISTRY,
  BRAIN_TRAINABLE_KEYS,
  computeLabelTotal,
  type BrainApiResponse, type BrainStatusEntry, type BrainLifecycle, type BrainKey,
} from '@/lib/brain/registry'

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
  /** P2-M2: audit mọi set/reset (mới → cũ, tối đa 10 dòng) */
  changeLog?: TuningChangeLogEntry[]
  generatedAt: string
}

const POLL_NEURAL_MS = 15_000

// ==================== MEDIA QUERY HOOKS (P2) ====================

/** Đăng ký theo dõi một media query — trả hàm dọn (unsubscribe). */
function subscribeMediaQuery(query: string, onChange: () => void): () => void {
  const mq = window.matchMedia(query)
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

/**
 * P2-M1: SMIL <animateMotion> KHÔNG tuân media query CSS
 * prefers-reduced-motion (chỉ keyframe CSS bị tắt ở globals.css) → component
 * phải gate hạt chạy bằng JS. useSyncExternalStore: theo dõi đổi cấu hình
 * lúc runtime (user bật/tắt giảm chuyển động không cần reload).
 * (FB-P2-R1-03: subscribe hoisted module-scope — closure mới mỗi render sẽ
 * khiến React unsubscribe+resubscribe媒 query mỗi lần poll setData 15s.)
 */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const subscribeReducedMotion = (onChange: () => void): (() => void) =>
  subscribeMediaQuery(REDUCED_MOTION_QUERY, onChange)

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
  )
}

const DESKTOP_MEDIA_QUERY = `(min-width: ${NEURAL_DESKTOP_BREAKPOINT}px)`
const subscribeDesktop = (onChange: () => void): (() => void) =>
  subscribeMediaQuery(DESKTOP_MEDIA_QUERY, onChange)

/**
 * P2-M3: viewport ≥ lg (1024px) = desktop (inspector cột phải); hẹp hơn =
 * mobile (bottom-sheet). Server snapshot = desktop — khớp render mặc định
 * của cột `hidden lg:block` (tránh nhảy layout khi hydrate).
 */
function useIsDesktopViewport(): boolean {
  return useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_MEDIA_QUERY).matches,
    () => true,
  )
}

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
  // P2-M3: bottom-sheet inspector trên mobile — mở khi user chạm node;
  // đóng bằng nút X / chạm nền / Esc (chọn node khác mở lại). Desktop không
  // dùng sheet (inspector cột phải hiển thị thường trực).
  const [sheetOpen, setSheetOpen] = useState(false)
  // P2-M1: tắt hạt animateMotion khi user bật giảm chuyển động (SMIL không
  // tuân media query CSS); P2-M3: chọn layout inspector theo viewport.
  const reducedMotion = usePrefersReducedMotion()
  const isDesktop = useIsDesktopViewport()
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

  // ==================== P3-B1: PAN (giữ chuột + kéo) ====================
  // Vùng đồ thị vốn cuộn ngang được (overflow-x-auto) nhưng chỉ bằng thanh
  // cuộn / touch — chuột không có affordance kéo. Thiết kế:
  //   - pointerdown (chuột/pen, không phải touch) trên vùng cuộn → ghi điểm
  //     xuất phát; window-listener pointermove kéo scrollLeft theo delta
  //     (không dùng setPointerCapture — capture đổi đích click, dễ nuốt
  //     click chọn node; window listener kéo được cả khi ra ngoài khung).
  //   - Kéo >3px = "đã pan" → nuốt click ngay sau đó (setTimeout 0 dọn cờ
  //     sau khi click nổ) — phân biệt kéo vs chọn node.
  //   - Không tràn ngang → không khởi pan (kéo vô nghĩa, tránh nuốt selection).
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const justPannedRef = useRef(false)
  const [panning, setPanning] = useState(false)
  // FB-P3-R1-02: chỉ hiện affordance kéo (cursor-grab + chú giải) khi vùng
  // cuộn THẬT SỰ tràn ngang — fit trên card rộng / zoom thấp không tràn thì
  // kéo vô tác dụng, đừng cho cursor nói dối. Đo lại khi: layout đổi (svg
  // width), zoom đổi, container đổi (viewport) — ResizeObserver theo dõi
  // cả container lẫn <svg> con (width svg đổi theo zoom).
  const [canPan, setCanPan] = useState(false)
  // FB-P3-R1-01: dọn pan đang sống khi component unmount giữa lúc kéo.
  const panTeardownRef = useRef<(() => void) | null>(null)
  const onPanPointerDown = useCallback((ev: React.PointerEvent<HTMLDivElement>) => {
    if (ev.pointerType === 'touch' || ev.button !== 0) return // touch: cuộn native
    const el = scrollRef.current
    if (!el || el.scrollWidth <= el.clientWidth + 1) return
    const startX = ev.clientX
    const startScrollLeft = el.scrollLeft
    let moved = false
    const onMove = (mv: PointerEvent) => {
      // FB-P3-R1-01: chuột đã nhả mà pointerup không bao giờ tới (cửa sổ mất
      // focus giữa lúc kéo — Alt+Tab, dialog OS) → buttons=0: tự dọn ngay,
      // không để đồ thị bám theo chuột không bấm giữ.
      if (mv.buttons === 0) { onUp(); return }
      const dx = mv.clientX - startX
      // FB-P3-R1-03a: chỉ bật trạng thái panning khi VƯỢT ngưỡng 3px —
      // nhấn giữ chưa kéo chưa là "đang kéo" (cursor grabbing).
      if (!moved && Math.abs(dx) > 3) { moved = true; setPanning(true) }
      el.scrollLeft = startScrollLeft - dx
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', onUp)
      panTeardownRef.current = null
      setPanning(false)
      if (moved) {
        justPannedRef.current = true
        setTimeout(() => { justPannedRef.current = false }, 0)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    // FB-P3-R1-01: cửa sổ mất focus giữa lúc kéo → chốt pan (pointerup
    // có thể không bao giờ tới trong tab nền).
    window.addEventListener('blur', onUp)
    panTeardownRef.current = onUp
  }, [])
  // FB-P3-R1-01: unmount giữa lúc kéo (đổi tab app) → dọn listener sống.
  useEffect(() => () => { panTeardownRef.current?.() }, [])

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

  // BRAIN-P1 UI (2026-10-12): trạng thái 3 brain cho panel "Não vận hành"
  // — fail-open tuyệt đối: lỗi fetch giữ dữ liệu cũ, chưa từng load thành
  // công thì UI vẫn render được từ registry tĩnh (đếm hiển thị "—").
  const [brainData, setBrainData] = useState<BrainApiResponse | null>(null)
  const [brainError, setBrainError] = useState<string | null>(null)
  const hasBrainDataRef = useRef(false)
  const fetchBrainData = useCallback(async () => {
    try {
      const res = await fetch('/api/brain')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as BrainApiResponse
      setBrainData(json)
      hasBrainDataRef.current = true
      setBrainError(null)
    } catch (err) {
      console.error('[Brain] fetch error:', err)
      if (!hasBrainDataRef.current) setBrainError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  // Mount + poll nền 15s giữ số liệu sống (fail-open giữ dữ liệu cũ).
  // (queueMicrotask: defer để không gọi setState đồng bộ trong body effect —
  // cùng pattern auto-learn-section)
  // P2-M4: poll chỉ chạy khi tab ĐANG HIỆN — ẩn thì dừng hẳn interval
  // (không fetch vô nghĩa vào tab nền); hiện lại → fetch ngay một lần rồi
  // tiếp tục nhịp 15s. Tab load ngầm (visibilityState=hidden ngay từ đầu)
  // → lần fetch đầu hoãn tới khi user mở tab.
  // BRAIN-P1 UI: cùng nhịp poll này cũng kéo /api/brain (panel Não vận hành).
  // BRAIN-P2: train xong (nút Huấn luyện lại) cũng fetchBrainData tươi.
  const [trainingBrains, setTrainingBrains] = useState<Set<string>>(new Set())
  const trainBrain = useCallback(async (key: BrainKey) => {
    setTrainingBrains(prev => new Set(prev).add(key))
    try {
      const res = await fetch('/api/brain/train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brain: key }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        error?: string; version?: number; active?: boolean
        cvBrier?: number; brierV2?: number; sampleSize?: number; improved?: boolean
      }
      if (!res.ok) {
        toast.error('Huấn luyện Brain không chạy', { description: json.error ?? `HTTP ${res.status}` })
        return
      }
      const verdict = json.active
        ? `v${json.version} ACTIVE — thắng CV (cờ CALIBRATION_V3 mới có tác dụng khi bật)`
        : `v${json.version} không thắng CV — giữ nguyên chuỗi V2/V1 (bản vết audit đã ghi)`
      toast.success(
        `Brain-A "V3" huấn luyện xong · ${(json.cvBrier ?? Number.NaN).toFixed(4)} vs V2 ${(json.brierV2 ?? Number.NaN).toFixed(4)}`,
        { description: `${verdict} · ${json.sampleSize ?? '?'} mẫu` },
      )
      void fetchBrainData() // kéo trạng thái mới ngay không chờ nhịp 15s
    } catch (err) {
      toast.error('Huấn luyện Brain thất bại', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setTrainingBrains(prev => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }, [fetchBrainData])
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null
    const start = () => {
      if (timer === null) timer = setInterval(() => { void fetchData(); void fetchBrainData() }, POLL_NEURAL_MS)
    }
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
    if (document.visibilityState !== 'hidden') {
      queueMicrotask(() => {
        void fetchData()
        void fetchBrainData()
      })
      start()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        stop()
      } else {
        void fetchData()
        void fetchBrainData()
        start()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [fetchData, fetchBrainData])

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
        } else if (window.innerWidth < NEURAL_DESKTOP_BREAKPOINT) {
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
      if (json.tuning) setData(prev => (prev ? { ...prev, tuning: json.tuning, changeLog: json.changeLog ?? prev.changeLog } : prev))
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

  // FB-P3-R1-02: đo canPan SAU layout (dep layout?.width — phải nằm dưới
  // useMemo layout để không TDZ). ResizeObserver theo dõi cả container
  // (viewport đổi) lẫn <svg> con (width đổi theo zoom) → cursor-grab và
  // chú giải kéo chỉ hiện khi thật sự tràn ngang.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => { setCanPan(el.scrollWidth > el.clientWidth + 1) }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    const svg = el.firstElementChild
    if (svg) ro.observe(svg)
    return () => ro.disconnect()
  }, [layout?.width, zoom])

  const selectedNode = layout?.nodeById.get(selectedNodeId ?? '') ?? null
  const selectedLive = useMemo(() => {
    if (!selectedNodeId) return []
    const fromApi = data?.live?.[selectedNodeId] ?? []
    return [...fromApi, ...healthLiveFor(health ?? null, selectedNodeId)]
  }, [selectedNodeId, data, health])

  // BRAIN-P1 UI: danh sách brain để render — dữ liệu thật nếu đã load,
  // còn chưa load/lỗi thì fallback registry tĩnh (đếm null → hiển thị "—",
  // fail-open không để panel trắng). useMemo chống tạo lại mỗi nhịp poll.
  const brainEntries = useMemo<BrainStatusEntry[]>(() => {
    if (brainData) return brainData.brains
    return BRAIN_REGISTRY.map(spec => ({
      ...spec,
      lifecycle: 'dormant' as const,
      signals: spec.signals.map(s => ({ ...s, current: null, ok: false })),
      models: [],
      trainable: BRAIN_TRAINABLE_KEYS.includes(spec.key),
    }))
  }, [brainData])

  // UX-1 áp dụng sớm (chỉ thị user 2026-10-12 — blueprint §9.2 v0.4): tổng
  // số NHÃN VẬN HÀNH TÍCH LŨY — "nguyên liệu dạy não" (EvalResult +
  // AgentRunRecord + QEntry + ArbiterVerdict). Logic thuần tách xuống
  // registry.computeLabelTotal (pin được bằng test r84): cộng theo NGUỒN
  // (khóa signal duy nhất — không đếm trùng khi nhiều brain cùng đọc 1
  // bảng); null (đếm lỗi) bị bỏ; MỌI nguồn null → ẩn badge (không phải
  // "0 nhãn" — FB-BRAIN-P1-R1-12).
  const labelTotal = useMemo<number | null>(() => computeLabelTotal(brainData?.brains), [brainData])

  // P2-M3: mobile (viewport < lg) → chọn node mở bottom-sheet inspector
  // (thay cuộn xuống inspector dưới đồ thị — below-the-fold); desktop giữ
  // inspector cột phải hiển thị thường trực, không cuộn.
  // P3-B1: vừa pan xong (giữ+kéo >3px) → nuốt click này, không chọn node.
  const selectNode = useCallback((nodeId: string) => {
    if (justPannedRef.current) return
    setSelectedNodeId(nodeId)
    if (!isDesktop) setSheetOpen(true)
  }, [isDesktop])

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
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 bg-emerald-950/60 text-emerald-400 border-emerald-500/40">
                ● sống · {new Date(data.generatedAt).toLocaleTimeString('vi-VN')}
              </Badge>
            )}
          </h3>
          <p className="text-[12px] text-stone-400">
            6 lớp × {graph?.nodes.length ?? '…'} nút × {graph?.edges.length ?? '…'} dòng chảy · {tuning.length} tham số tinh chỉnh runtime
            {paramsChanged > 0 && <span className="text-amber-400"> · {paramsChanged} đã bị chỉnh</span>}
          </p>
        </div>
        <Button
          variant="outline" size="sm"
          className="h-7 text-[12px] border-emerald-500/40 text-emerald-300 hover:bg-emerald-950/40 hover:text-emerald-200"
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
                    <p className="text-[11px] text-stone-500" aria-live="polite">
                      {zoom === 'fit'
                        ? 'Vừa khung — tổng quan nhanh (chữ nhỏ; chọn 100% để đọc chi tiết)'
                        : `${neuralZoomLabel(zoom)} — cỡ chữ thiết kế${canPan ? ' · giữ chuột + kéo để di chuyển / cuộn ngang xem hết 6 lớp' : ''}`}
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
                        className={`h-6 px-2 text-[11px] tabular-nums border-slate-700 ${zoom === 1 ? 'text-emerald-300 border-emerald-500/60' : 'text-stone-300'}`}
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
                        className={`h-6 px-2 text-[11px] ${zoom === 'fit' ? 'bg-emerald-600/80 hover:bg-emerald-600 text-white' : 'border-slate-700 text-stone-300'}`}
                        aria-pressed={zoom === 'fit'}
                        onClick={() => setZoom('fit')}
                      >
                        <Maximize2 className="h-3 w-3 mr-1" /> Vừa khung
                      </Button>
                    </div>
                  </div>
                  {/* P3-B1: vùng cuộn ngang + drag-pan chuột (tabIndex cho
                      cuộn bằng bàn phím; select-none chống bôi đen chữ SVG
                      khi kéo; cursor grab/grabbing theo trạng thái panning). */}
                  <div
                    ref={scrollRef}
                    onPointerDown={onPanPointerDown}
                    tabIndex={0}
                    role="region"
                    aria-label="Vùng đồ thị kiến trúc — giữ chuột và kéo để di chuyển; phím mũi tên trái/phải để cuộn"
                    className={`overflow-x-auto pb-2 select-none${canPan ? ' cursor-grab' : ''}${panning ? ' cursor-grabbing [&_*]:cursor-grabbing!' : ''}`}
                  >
                    <svg
                      ref={svgRef}
                      viewBox={`0 0 ${layout.width} ${layout.height}`}
                      style={zoom === 'fit'
                        ? { minWidth: NEURAL_ZOOM.FIT_FLOOR_PX, width: '100%', height: 'auto' }
                        : { width: neuralSvgWidth(layout.width, zoom), height: 'auto' }}
                      role="group"
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
                            {edgeDotVisible(k.dot, reducedMotion) && (
                              <circle r={k.dotRadius} fill={k.dot!}>
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
                              {node.subtitle.length > 36 ? `${node.subtitle.slice(0, 35)}…` : node.subtitle}
                            </text>
                            <text x="10" y="66" fontSize={NEURAL_FONTS.live} className={acc.text} style={{ fontFamily: 'inherit' }}>
                              {liveText.length > 33 ? `${liveText.slice(0, 32)}…` : liveText}
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
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10px] text-stone-400">
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
                    {canPan && <span>✋ giữ + kéo nền = di chuyển sơ đồ</span>}
                  </div>
                </>
              ) : null}
            </CardContent>
          </Card>
        </div>

        {/* ── INSPECTOR (desktop — cột phải; mobile dùng bottom-sheet P2-M3).
            FB-P2-R1-04: render điều kiện theo isDesktop — mobile không mount
            bản ẩn (trước-fix sheet mở vẫn render NodeInspectorContent 2 lần
            vì cột chỉ ẩn bằng CSS `hidden lg:block`). Hydrate an toàn: server
            snapshot = desktop (true) → SSR/hydrate đầu render cột, client
            snapshot thật hiệu chỉnh ngay sau đó mà KHÔNG mismatch. ── */}
        {isDesktop && (
          <div className="nc-wrap nc-emerald hidden lg:block">
            <Card className="nc-panel nc-md nc-border-emerald h-full">
              <CardContent className="p-4 space-y-3">
                <NodeInspectorContent
                  selectedNode={selectedNode}
                  graph={graph}
                  selectedLive={selectedLive}
                  tuningEntries={selectedNode ? (tuningByNode.get(selectedNode.id) ?? []) : []}
                  savingKeys={savingKeys}
                  onSet={handleSet}
                  onReset={handleReset}
                />
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      {/* ── INSPECTOR MOBILE (P2-M3: bottom-sheet — chạm node mở panel trượt
          lên thay cuộn xuống inspector dưới đồ thị below-the-fold; đóng bằng
          nút X / chạm nền / Esc; chọn node khác mở lại) ── */}
      <Sheet open={sheetOpen && !isDesktop} onOpenChange={setSheetOpen}>
        <SheetContent
          side="bottom"
          aria-label="Chi tiết nút đang chọn"
          className="top-auto mx-auto flex h-auto max-h-[85dvh] w-full max-w-2xl flex-col rounded-t-xl border-emerald-500/30 bg-slate-950/95 p-0"
        >
          <div className="mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full bg-stone-700" aria-hidden="true" />
          <SheetHeader className="px-4 pb-0 pt-2 text-left">
            <SheetTitle className="text-sm font-semibold text-stone-100">
              {selectedNode ? selectedNode.title : 'Chi tiết nút'}
            </SheetTitle>
            <SheetDescription className="sr-only">
              Thuật toán, hàm số và ô tinh chỉnh runtime của nút đang chọn trên sơ đồ
            </SheetDescription>
          </SheetHeader>
          <div className="dialog-scrollbar min-h-0 flex-1 overscroll-contain overflow-y-auto px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-2">
            <NodeInspectorContent
              selectedNode={selectedNode}
              graph={graph}
              selectedLive={selectedLive}
              tuningEntries={selectedNode ? (tuningByNode.get(selectedNode.id) ?? []) : []}
              savingKeys={savingKeys}
              onSet={handleSet}
              onReset={handleReset}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* ── PANEL "NÃO VẬN HÀNH" (BRAIN-P1 phần UI — áp dụng sớm 2026-10-12
          theo chỉ thị P/S user; blueprint §4.1 v0.2. 3 bộ não MLP-CPU nhỏ:
          hiện trạng thái thức tỉnh theo số liệu THẬT từ DB — chưa train,
          không đổi hành vi runtime nào — nút huấn luyện tắt chờ duyệt
          nền toán §4.1.) ── */}
      <div className="nc-wrap nc-amber">
        <Card className="nc-panel nc-md nc-border-amber">
          <CardContent className="p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <BrainCircuit className="h-3.5 w-3.5 shrink-0 text-amber-400" />
              <h4 className="text-xs font-semibold text-stone-100">Não vận hành — MLP-CPU (BRAIN)</h4>
              <span className="text-[10px] text-stone-500">
                3 bộ não nhỏ tự huấn luyện khi đủ mẫu · ngủ an toàn khi thiếu · BLUEPRINT-BRAIN-P1-P5 v0.6
              </span>
              {brainData && (
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                  {labelTotal !== null && (
                    <Badge
                      variant="outline"
                      className="h-3.5 px-1 bg-slate-950/60 text-[9px] text-stone-300 border-stone-600/50"
                      title="Tổng nhãn vận hành tích lũy — nguyên liệu dạy não (EvalResult + AgentRunRecord + QEntry + ArbiterVerdict, cộng theo nguồn không trùng — blueprint §2/§9.2)"
                    >
                      <Tags className="mr-0.5 h-2.5 w-2.5" aria-hidden="true" />
                      {viNum(labelTotal)} nhãn
                    </Badge>
                  )}
                  <Badge variant="outline" className="text-[9px] h-3.5 px-1 bg-amber-950/60 text-amber-400 border-amber-500/40">
                    ● sống · {new Date(brainData.generatedAt).toLocaleTimeString('vi-VN')}
                  </Badge>
                </div>
              )}
            </div>
            {brainError && !brainData && (
              <p className="mb-2 text-[11px] text-amber-500/90">
                Không tải được số liệu mẫu ({brainError}) — hiển thị spec kế hoạch, thử Làm mới ở trên (fail-open).
              </p>
            )}
            <div className="grid gap-3 md:grid-cols-3">
              {brainEntries.map(spec => (
                <BrainCard
                  key={spec.key}
                  spec={spec}
                  trainingImplemented={brainData?.trainingImplemented ?? false}
                  onTrain={trainBrain}
                  training={trainingBrains.has(spec.key)}
                  flagValue={
                    spec.flagTuningKey !== undefined
                      ? String(tuningByKey.get(spec.flagTuningKey)?.effectiveValue ?? 'off')
                      : undefined
                  }
                />
              ))}
            </div>
            <p className="mt-2.5 text-[9.5px] leading-relaxed text-stone-500">
              ⚠ Brain-A "V3" đã có pipeline train (BRAIN-P2): nút Huấn luyện chỉ ghi bản mới — bản active chỉ
              xuất hiện khi thắng V2 qua 5-fold CV Brier (ngặt, V2 train lại từng fold). Runtime chỉ đổi khi cờ
              CALIBRATION_V3 bật (STORE › ENV › DEFAULT=off — bảng tinh chỉnh phía dưới). Brain-B/C chờ P3/P4.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── BẢNG TINH CHỈNH TOÀN BỘ ── */}
      <div className="nc-wrap nc-violet">
        <Card className="nc-panel nc-md nc-border-violet">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Zap className="h-3.5 w-3.5 text-violet-400" />
              <h4 className="text-xs font-semibold text-stone-100">Bảng điều khiển tham số — toàn bộ mạng</h4>
              <span className="text-[10px] text-stone-500">chuỗi hiệu lực: STORE › ENV › DEFAULT · áp dụng tức thì (không restart)</span>
            </div>
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-[11px]">
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
                          <p className="font-mono text-[9px] text-stone-600">{t.key}</p>
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
                            <Badge variant="outline" className={`text-[9px] h-3.5 px-1 ${src.cls}`}>{src.label}</Badge>
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

      {/* ── NHẬT KÝ TINH CHỈNH (P2-M2 — audit mọi set/reset) ── */}
      <div className="nc-wrap nc-teal">
        <Card className="nc-panel nc-md nc-border-teal">
          <CardContent className="p-4">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <History className="h-3.5 w-3.5 text-teal-400" />
              <h4 className="text-xs font-semibold text-stone-100">Nhật ký tinh chỉnh runtime</h4>
              <span className="text-[10px] text-stone-500">mọi đặt / trả-mặc-định được ghi audit · giữ tối đa {TUNING_CHANGE_LOG_CAP} dòng mới nhất</span>
            </div>
            {(data?.changeLog?.length ?? 0) === 0 ? (
              <p className="text-[11px] text-stone-500 italic">Chưa có thay đổi nào được ghi (phát sinh khi đặt hoặc trả mặc định một tham số).</p>
            ) : (
              <div className="dialog-scrollbar max-h-44 space-y-1.5 overflow-y-auto">
                {data!.changeLog!.map(c => {
                  const label = tuningByKey.get(c.key)?.label ?? c.key
                  return (
                    <div
                      key={c.id}
                      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]"
                      title={`${c.key} · store: ${c.fromStoreValue ?? '—'} → ${c.toStoreValue ?? '—'}`}
                    >
                      <span className="shrink-0 tabular-nums text-stone-600">{new Date(c.createdAt).toLocaleString('vi-VN')}</span>
                      <span className="font-mono text-stone-300">{label}</span>
                      {c.action === 'set'
                        ? <Badge variant="outline" className="h-3.5 px-1 border-amber-500/45 bg-amber-950/70 text-[9px] text-amber-400">đặt</Badge>
                        : <Badge variant="outline" className="h-3.5 px-1 border-stone-600/50 bg-slate-950/70 text-[9px] text-stone-400">về mặc định</Badge>}
                      <span className="font-mono text-stone-500">{c.fromEffectiveValue}</span>
                      <ArrowRight className="h-2.5 w-2.5 shrink-0 text-stone-600" />
                      <span className="font-mono font-medium text-stone-100">{c.toEffectiveValue}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── HỒ SƠ HỌC GẦN ĐÂY (Q + SAL) ── */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="nc-wrap nc-amber">
          <Card className="nc-panel nc-md nc-border-amber">
            <CardContent className="p-4">
              <p className="text-[10px] uppercase tracking-wide text-amber-500 mb-2">Bảng Q — top model đã học (mode-agent-tier-1)</p>
              {(data?.qTop?.length ?? 0) === 0 ? (
                <p className="text-[11px] text-stone-500 italic">Chưa có Q-entry nào (Q học sau mỗi run goal-loop / workflow).</p>
              ) : (
                <div className="space-y-1.5">
                  {data!.qTop.map((q, i) => (
                    <div key={q.action} className="flex items-center gap-2 text-[11px]">
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
              <p className="text-[10px] uppercase tracking-wide text-rose-400 mb-2">Strategy Adaptation Log — gần nhất</p>
              {(data?.salRecent?.length ?? 0) === 0 ? (
                <p className="text-[11px] text-stone-500 italic">Chưa có SAL nào (phát sinh khi workflow gặp failure-pattern và đổi chiến lược).</p>
              ) : (
                <div className="space-y-1.5 max-h-44 overflow-y-auto">
                  {data!.salRecent.map(sal => (
                    <div key={sal.id} className="text-[11px] flex items-center gap-2">
                      <span className="font-mono text-stone-400">{sal.fromStrategy}</span>
                      <ArrowRight className="h-2.5 w-2.5 text-stone-600" />
                      <span className="font-mono text-stone-200">{sal.toStrategy}</span>
                      {sal.successful === null
                        ? <Badge variant="outline" className="text-[9px] h-3.5 px-1 bg-slate-950/70 text-stone-400 border-stone-600/50">chưa chốt</Badge>
                        : sal.successful
                          ? <Badge variant="outline" className="text-[9px] h-3.5 px-1 bg-emerald-950/70 text-emerald-400 border-emerald-500/45">thành công</Badge>
                          : <Badge variant="outline" className="text-[9px] h-3.5 px-1 bg-rose-950/70 text-rose-400 border-rose-500/45">thất bại</Badge>}
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

// ==================== NODE INSPECTOR (nội dung dùng chung — P2-M3) ====================
// Render ở 2 nơi: cột phải desktop (lg+) và bottom-sheet mobile — cùng một
// nguồn JSX nên không lệch nội dung giữa hai chế độ.

function NodeInspectorContent({
  selectedNode, graph, selectedLive, tuningEntries, savingKeys, onSet, onReset,
}: {
  selectedNode: PlacedNode | null
  graph: NeuralGraph | null
  selectedLive: Array<{ label: string; value: string }>
  tuningEntries: TuningStateEntry[]
  savingKeys: Set<string>
  onSet: (key: string, value: string | number) => Promise<boolean>
  onReset: (key: string) => Promise<boolean>
}) {
  if (!selectedNode || !graph) {
    return (
      <div className="py-10 text-center space-y-2">
        <Network className="h-8 w-8 text-stone-600 mx-auto" />
        <p className="text-xs text-stone-400">Chọn một nút trên sơ đồ để xem thuật toán, hàm số và ô tinh chỉnh.</p>
      </div>
    )
  }
  const layer = graph.layers.find(l => l.id === selectedNode.layer)
  const acc = ACCENTS[layer?.accent ?? 'cyan'] ?? ACCENTS.cyan
  return (
    <>
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <h4 className="text-sm font-semibold text-stone-100">{selectedNode.title}</h4>
          <Badge variant="outline" className={`text-[10px] h-4 px-1.5 ${acc.badge}`}>
            Lớp {layer?.index} · {layer?.title}
          </Badge>
        </div>
        <p className="text-[11px] text-stone-500 font-mono">{selectedNode.subtitle}</p>
      </div>

      <p className="text-[12px] leading-relaxed text-stone-300">{selectedNode.description}</p>

      {selectedNode.algorithm && (
        <div className="rounded-md border border-cyan-500/30 bg-slate-950/70 p-2">
          <p className="text-[10px] uppercase tracking-wide text-cyan-500 mb-1">Thuật toán</p>
          <p className="font-mono text-[11px] text-cyan-300 leading-relaxed break-words">{selectedNode.algorithm}</p>
          {selectedNode.algorithmNote && (
            <p className="text-[10px] text-stone-500 italic mt-1">{selectedNode.algorithmNote}</p>
          )}
        </div>
      )}

      {selectedNode.functions.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-stone-500 mb-1.5 flex items-center gap-1"><Wrench className="h-2.5 w-2.5" /> Hàm số</p>
          <div className="flex flex-wrap gap-1.5">
            {selectedNode.functions.map(fn => (
              <span key={`${fn.name}-${fn.file}-${fn.line ?? ''}`}
                className="font-mono text-[10px] rounded border border-slate-700/60 bg-slate-950/60 px-1.5 py-0.5 text-stone-300">
                {fn.name} <span className="text-stone-500">{fn.file.split('/').slice(-1)[0]}{fn.line ? `:${fn.line}` : ''}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {selectedLive.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide text-stone-500 mb-1.5 flex items-center gap-1"><Database className="h-2.5 w-2.5" /> Số liệu trực tiếp</p>
          <div className="grid grid-cols-2 gap-1.5">
            {selectedLive.map(lv => (
              <div key={lv.label} className="rounded border border-slate-700/50 bg-slate-950/50 px-2 py-1">
                <p className="text-[9px] text-stone-500 truncate">{lv.label}</p>
                <p className="text-[12px] text-stone-100 font-medium truncate" title={lv.value}>{lv.value}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {tuningEntries.length > 0 ? (
        <div className="space-y-3 pt-1 border-t border-slate-800">
          <p className="text-[10px] uppercase tracking-wide text-amber-500 flex items-center gap-1 pt-2">
            <Settings2 className="h-2.5 w-2.5" /> Tinh chỉnh vận hành ({tuningEntries.length})
          </p>
          {tuningEntries.map(entry => (
            <TuningControl
              key={entry.key}
              entry={entry}
              nodeTitle={selectedNode.title}
              saving={savingKeys.has(entry.key)}
              onSet={onSet}
              onReset={onReset}
            />
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-stone-600 italic pt-2 border-t border-slate-800">
          Node này không có tham số runtime (giá trị cố định theo spec — xem mô tả thuật toán).
        </p>
      )}
    </>
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
        <span className="text-[12px] font-medium text-stone-200">{entry.label}</span>
        <Badge variant="outline" className={`text-[9px] h-3.5 px-1 ${src.cls}`}>{src.label}</Badge>
        <span className="text-[9px] text-stone-600 font-mono truncate">{entry.key}</span>
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

      <p className="text-[10px] text-stone-500 leading-relaxed">{entry.description}</p>

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
              className="h-6 text-[11px] font-mono w-24 bg-slate-950/70 border-slate-700"
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
            {entry.unit && <span className="text-[10px] text-stone-500">{entry.unit}</span>}
            <span className="text-[9px] text-stone-600 ml-auto">
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
                className={`h-6 px-2.5 text-[11px] font-mono rounded-md border transition-colors ${
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
          <span className="text-[9px] text-stone-600 ml-auto">mặc định {String(entry.default)}</span>
        </div>
      )}

      <p className="text-[9px] text-stone-600 font-mono truncate" title={entry.appliesTo}>
        ⟶ áp dụng: {entry.appliesTo}
      </p>

      {/* Cảnh báo hiệu lực (vd policy=softmax đang bật) */}
      {entry.warning && String(entry.effectiveValue) !== String(entry.default) && (
        <p className="text-[10px] text-amber-400 flex items-start gap-1.5 leading-relaxed">
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

// ==================== BRAIN CARD (panel "Não vận hành" — BRAIN-P1 UI) ====================
// (2026-10-12, áp dụng sớm theo chỉ thị P/S user — BLUEPRINT-BRAIN §4.1 v0.2)
// Mỗi thẻ = 1 brain: đồ thị lớp MLP theo spec khởi điểm + trạng thái thức
// tỉnh theo số liệu ĐẾM THẬT từ /api/brain + các phiên bản đã train (nếu
// có) + nút huấn luyện (tắt — nền toán P1 chờ duyệt). Không state riêng —
// nhận dữ liệu qua props, mọi fallback xử lý ở panel cha.

const BRAIN_LIFECYCLE_BADGE: Record<BrainLifecycle, { label: string; cls: string; dot: string }> = {
  dormant: { label: 'NGỦ', cls: 'bg-slate-950/70 text-stone-400 border-stone-600/50', dot: 'bg-stone-500' },
  awake:   { label: 'THỨC TỈNH', cls: 'bg-amber-950/70 text-amber-400 border-amber-500/45', dot: 'bg-amber-400' },
  active:  { label: 'ACTIVE', cls: 'bg-emerald-950/70 text-emerald-400 border-emerald-500/45', dot: 'bg-emerald-400' },
}

/** Vẽ nhẹ đồ thị lớp MLP khởi điểm (input → hidden → output + nhãn). */
function BrainArchDiagram({ spec }: { spec: BrainStatusEntry }) {
  const layers = spec.planned.layers
  // Cột x: đều nhau trong viewBox 300 — đồ thị brain nhỏ, không cần pan/zoom
  // (hạ tầng pan/zoom P3 dành cho đồ thị 6 lớp lớn phía trên).
  const R = 6.5
  const cols = layers.map((l, i) => ({
    x: 42 + i * 108, // 42 · 150 · 258
    count: l.units === 0 ? 1 : Math.min(Math.max(l.units, 1), 4),
    label: l.unitsLabel ?? `×${l.units}`,
    sub: l.activation || 'input',
  }))
  const yFor = (colIdx: number, i: number) => 30 + (i - (cols[colIdx].count - 1) / 2) * 16
  // Cạnh: nối đủ từng cặp vòng tròn giữa 2 cột liền kề (đủ nhẹ để đọc dòng chảy)
  const edges: Array<{ x1: number; y1: number; x2: number; y2: number }> = []
  for (let ci = 0; ci < cols.length - 1; ci++) {
    for (let i = 0; i < cols[ci].count; i++) {
      for (let j = 0; j < cols[ci + 1].count; j++) {
        edges.push({ x1: cols[ci].x + R, y1: yFor(ci, i), x2: cols[ci + 1].x - R, y2: yFor(ci + 1, j) })
      }
    }
  }
  const ariaLayers = layers.map(l => `${l.unitsLabel ?? l.units} ${l.activation || 'in'}`).join(' → ')
  return (
    <svg
      viewBox="0 0 300 92" className="h-auto w-full" role="img"
      aria-label={`Kiến trúc khởi điểm ${spec.title}: ${ariaLayers} — loss ${spec.planned.loss}`}
    >
      {edges.map((e, i) => (
        <line key={`e-${i}`} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke="rgba(168,162,158,0.22)" strokeWidth="0.8" />
      ))}
      {cols.map((c, ci) =>
        Array.from({ length: c.count }).map((_, i) => (
          <circle
            key={`n-${ci}-${i}`} cx={c.x} cy={yFor(ci, i)} r={R}
            fill="rgba(2,6,23,0.95)" stroke="rgba(251,191,36,0.55)" strokeWidth="1.1"
          />
        )),
      )}
      {cols.map((c, ci) => (
        <g key={`l-${ci}`}>
          <text x={c.x} y="72" textAnchor="middle" fontSize={NEURAL_FONTS.subtitle} className="fill-stone-300" style={{ fontFamily: 'inherit' }}>
            {c.label}
          </text>
          <text x={c.x} y="82" textAnchor="middle" fontSize={NEURAL_FONTS.gear} className="fill-stone-500" style={{ fontFamily: 'inherit' }}>
            {c.sub}
          </text>
        </g>
      ))}
      <text x="150" y="90.5" textAnchor="middle" fontSize={NEURAL_FONTS.gear} className="fill-amber-500/80" style={{ fontFamily: 'inherit' }}>
        loss: {spec.planned.loss}
      </text>
    </svg>
  )
}

/** Thẻ 1 brain trong panel "Não vận hành" (BRAIN-P2: nút train sống cho brain có pipeline). */
function BrainCard({
  spec, trainingImplemented, onTrain, training, flagValue,
}: {
  spec: BrainStatusEntry
  trainingImplemented: boolean
  /** BRAIN-P2 — gọi POST /api/brain/train (chỉ brain trainable mới có) */
  onTrain?: (key: BrainKey) => void
  training?: boolean
  /** Giá trị hiệu lực thật của cờ (từ tuning state) — undefined = chưa có cờ */
  flagValue?: string
}) {
  const lc = BRAIN_LIFECYCLE_BADGE[spec.lifecycle]
  // Lý do nút huấn luyện bị tắt (hiển thị trong title — không để nút chết không giải thích)
  const missing = spec.signals
    .filter(s => !s.ok)
    .map(s => `${s.current === null ? '—' : s.current}/${s.min}`)
    .join(', ')
  // BRAIN-P2 — nút chỉ sống cho brain có pipeline (trainable) VÀ đủ mẫu
  const canTrain = Boolean(onTrain) && spec.trainable && trainingImplemented && spec.lifecycle !== 'dormant'
  const retrainTitle = !spec.trainable
    ? `Chờ pipeline phase ${spec.phase} (nền toán BRAIN-P1 đã có — chưa có job train cho brain này)`
    : !trainingImplemented
      ? `Chờ hạ tầng train bật (BRAIN_TRAINING_IMPLEMENTED)${missing ? ` · chưa đủ mẫu: ${missing}` : ''}`
      : spec.lifecycle === 'dormant'
        ? `Chưa đủ mẫu thức tỉnh (${missing}) — ngủ an toàn`
        : 'Chạy huấn luyện batch (offline, fail-open) — bản active chỉ xuất hiện khi thắng V2 qua 5-fold CV Brier (ngặt)'
  return (
    <div className="space-y-2.5 rounded-xl border border-slate-800/80 bg-slate-950/50 p-3" role="group" aria-label={spec.title}>
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-[12px] font-semibold text-stone-100">
          {spec.title} <span className="text-amber-400">&quot;{spec.name}&quot;</span>
        </p>
        <Badge variant="outline" className={`h-4 px-1.5 text-[9px] ${lc.cls}`} role="status" aria-label={`Trạng thái ${lc.label}`}>
          <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${lc.dot}`} aria-hidden="true" />
          {lc.label}
        </Badge>
      </div>
      <p className="text-[11px] leading-snug text-stone-400">{spec.role}</p>
      <BrainArchDiagram spec={spec} />
      <div className="space-y-1.5">
        <p className="text-[10px] uppercase tracking-wide text-stone-500">Thức tỉnh khi đủ mẫu</p>
        {spec.signals.map(sig => {
          const pct = sig.current === null ? 0 : Math.min(100, Math.round((sig.current / sig.min) * 100))
          return (
            <div
              key={sig.key} className="flex items-center gap-2 text-[11px]"
              title={`${sig.label} — bảng ${sig.table} · ngưỡng ${sig.min} (${sig.source})`}
            >
              <span className="min-w-0 flex-1 truncate text-stone-300">{sig.label}</span>
              <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-slate-900" aria-hidden="true">
                <div className={`h-full rounded-full ${sig.ok ? 'bg-emerald-500/80' : 'bg-amber-500/70'}`} style={{ width: `${pct}%` }} />
              </div>
              <span className="w-16 shrink-0 text-right font-mono tabular-nums text-stone-200">
                {sig.current === null ? '—' : viNum(sig.current)}/{sig.min}
              </span>
            </div>
          )
        })}
      </div>
      {spec.models.length > 0 ? (
        <div className="space-y-1">
          {spec.models.slice(0, 2).map(m => (
            <p
              key={m.id} className="truncate text-[10px] text-stone-400"
              title={`v${m.version} · ${m.inputMode}${m.meta.brierBaseline !== undefined ? ` · Brier V2 đối chứng ${m.meta.brierBaseline.toFixed(3)}` : ''}`}
            >
              {m.active ? '★' : '·'} v{m.version} · {m.inputMode}
              {m.meta.cvScore !== undefined
                ? ` · ${m.meta.metric ?? 'CV'} ${m.meta.cvScore.toFixed(3)}${
                    m.meta.ciLow !== undefined && m.meta.ciHigh !== undefined
                      ? ` [${m.meta.ciLow.toFixed(3)}–${m.meta.ciHigh.toFixed(3)}]`
                      : ''
                  }`
                : ''}
              {m.meta.brierBaseline !== undefined && m.meta.improved !== undefined
                ? ` · ${m.meta.improved ? 'thắng' : 'thua'} V2 (${m.meta.brierBaseline.toFixed(3)})`
                : ''}
              {m.meta.nSamples !== undefined ? ` · ${viNum(m.meta.nSamples)} mẫu` : ''}
            </p>
          ))}
        </div>
      ) : (
        <p className="text-[10px] italic text-stone-600">Chưa có phiên bản nào được huấn luyện — ngủ an toàn, không đổi hành vi runtime.</p>
      )}
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        <Badge variant="outline" className="h-3.5 px-1 bg-slate-950/70 font-mono text-[9px] text-stone-500 border-stone-600/50">{spec.phase}</Badge>
        <Badge
          variant="outline"
          className={`h-3.5 px-1 bg-slate-950/70 font-mono text-[9px] border-stone-600/50 ${flagValue === 'on' ? 'text-emerald-400' : 'text-stone-500'}`}
          title={flagValue !== undefined ? 'Giá trị hiệu lực thật (STORE › ENV › DEFAULT) — đổi ở bảng tinh chỉnh phía dưới' : 'Cờ phase chưa có trong tuning store (mặc định OFF)'}
        >
          {spec.flag}={flagValue ?? 'off'}
        </Badge>
        <Badge variant="outline" className="h-3.5 px-1 bg-slate-950/70 font-mono text-[9px] text-stone-400 border-stone-600/50">in: {spec.defaultInputMode}</Badge>
        <Button
          variant="outline" size="sm"
          disabled={!canTrain || training}
          onClick={() => onTrain?.(spec.key)}
          className="ml-auto h-6 px-2 text-[10px] border-stone-700 text-stone-300"
          title={retrainTitle}
        >
          {training ? 'Đang huấn luyện…' : 'Huấn luyện lại'}
        </Button>
      </div>
    </div>
  )
}
