'use client'

/**
 * BRAIN-UX §9.4 (UX-3) — BRAIN STAGE: đường dây ánh sáng trên sân khấu giữa
 * ============================================================================
 *
 * Đồ thị MLP của não ĐANG CHỌN với:
 *  - Cạnh bezier gradient "sáng dần theo chiều đi" + nét đứt CHẠY theo hướng
 *    lan truyền (tiến / ngược — ngược chỉ bật khi có |gradient| thật) —
 *    lệch pha từng cạnh, không nhấp nháy đồng loạt.
 *  - Bấm được: nhãn cột lớp → editor lớp đó (UX-1); nơ-ron → inspector bias +
 *    |w| trung bình vào/ra (từ trọng số THẬT /api/brain/weights); cạnh →
 *    inspector |w| của đúng cặp nơ-ron.
 *  - Hiệu năng/a11y (§9.4): LOD ≤ 300 cạnh + ≤ 8 nơ-ron/cột hiển thị;
 *    IntersectionObserver dừng animation ngoài viewport; prefers-reduced-
 *    motion → bản tĩnh có mũi tên; touch target ≥ 44px (hit radius viewBox).
 *  - Trạng thái thật chi phối trực quan (§9.4): ACTIVE = hào quang "thở";
 *    NGỦ = ánh sáng rất yếu, tĩnh — ánh sáng mang thông tin.
 *
 * Toán hình học tách thuần tại src/lib/brain/stage-geometry.ts (test r90).
 * Thu thập trọng số READ-ONLY — KHÔNG đụng pipeline/runtime gì.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BrainStatusEntry } from '@/lib/brain/registry'
import type { BrainDraftSpec } from '@/lib/brain/spec-schema'
import {
  buildStageLayout,
  bezierControls,
  bezierTangentDeg,
  edgePhaseSec,
  hitEdge,
  isAnimated,
  lodEdges,
  strokeWidthForGrad,
  STAGE_LIMITS,
  type StageColumn,
  type StageEdge,
} from '@/lib/brain/stage-geometry'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia(REDUCED_MOTION_QUERY)
    const onChange = () => setReduced(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/** 1 MLP đã serialize từ BrainModel.weightsJson (envelope numpy — audit A6). */
interface MlpSerializedLike {
  spec: { layers: Array<{ units: number; activation: string }> }
  tensors: Array<{
    kind: 'W' | 'b'
    layer: number
    envelope: { shape: number[]; data: number[] }
  }>
}

interface WeightsResponse {
  brain: string
  head: string | null
  version: number
  active: boolean
  trainedAt: string
  spec: { layers: Array<{ units: number; activation: string }> } | MlpSerializedLike['spec']
  mlp: MlpSerializedLike
  gradAbsMean: number[] | null
}

export type SurrogateHead = 'success' | 'tokens' | 'durationMs'

interface InspectorState {
  kind: 'neuron' | 'edge'
  col: number
  row: number
  /** edge: hàng nơ-ron bên phải */
  toRow?: number
}

export function BrainStage({
  brain,
  draft,
  editorOn,
  fxOn,
  onEditLayer,
}: {
  brain: BrainStatusEntry
  /** Bản nháp hiện tại (preview kiến trúc khi editor bật) */
  draft: BrainDraftSpec | null
  /** Cờ ui_brain_edit — on: sân khấu preview DRAFT; off: hiển thị active/planned */
  editorOn: boolean
  /** Cờ ui_synapse_fx — on: bezier + animation + inspector; off: đường thẳng tĩnh (y hệt trước UX-3) */
  fxOn: boolean
  /** Bấm nhãn cột lớp ẩn → editor UX-1 nhảy tới lớp đó */
  onEditLayer?: (layerIdx: number) => void
}) {
  const reducedMotion = usePrefersReducedMotion()
  const animated = isAnimated(fxOn, reducedMotion)
  const [backMode, setBackMode] = useState(false)
  const [head, setHead] = useState<SurrogateHead>('success')
  const [inspector, setInspector] = useState<InspectorState | null>(null)
  const [inView, setInView] = useState(true)
  const [weights, setWeights] = useState<WeightsResponse | null>(null)
  const [weightsError, setWeightsError] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  // ── Kéo trọng số bản active (READ-ONLY, fail-open planned/draft) ──
  const fetchWeights = useCallback(async () => {
    try {
      const q = brain.key === 'surrogate' ? `?brain=${brain.key}&head=${head}` : `?brain=${brain.key}`
      const res = await fetch(`/api/brain/weights${q}`)
      if (!res.ok) {
        setWeights(null)
        setWeightsError(res.status === 404 ? 'chưa có bản active' : `HTTP ${res.status}`)
        return
      }
      setWeights((await res.json()) as WeightsResponse)
      setWeightsError(null)
    } catch {
      setWeights(null)
      setWeightsError('lỗi mạng — hiển thị spec kế hoạch')
    }
  }, [brain.key, head])
  // (queueMicrotask defer: không gọi setState đồng bộ trong body effect —
  // react-hooks/set-state-in-effect, cùng pattern neural-architecture-section)
  useEffect(() => { queueMicrotask(() => { void fetchWeights() }) }, [fetchWeights])

  // ── IntersectionObserver: ngoài viewport → dừng animation (§9.4) ──
  useEffect(() => {
    const el = wrapRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(entries => {
      setInView(entries.some(e => e.isIntersecting))
    }, { threshold: 0.05 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // ── Cột hiển thị: DRAFT (editor on) > active spec > planned registry ──
  const { columns, activeLayers } = useMemo(() => {
    const inLabel = brain.inputDim !== null && brain.inputDim !== undefined
      ? `${brain.inputDim}${brain.inputDimExact === false ? ' (≈)' : ''}`
      : (brain.planned.layers[0]?.unitsLabel ?? '?')
    const outLayer = brain.planned.layers[brain.planned.layers.length - 1]
    const outLabel = outLayer?.unitsLabel ?? `×${outLayer?.units ?? 1}`
    const outAct = outLayer?.activation || 'sigmoid/linear ×3'

    if (editorOn && draft) {
      const cols: StageColumn[] = [
        { units: brain.inputDim ?? 8, display: 0, label: inLabel, activation: 'input', locked: true },
        ...draft.hidden.map(h => ({ units: h.units, display: 0, label: `×${h.units}`, activation: h.activation, locked: false })),
        { units: brain.key === 'policy' ? 3 : 1, display: 0, label: outLabel, activation: outAct, locked: true },
      ]
      return { columns: cols, activeLayers: null }
    }
    if (weights?.spec?.layers?.length) {
      const layers = weights.spec.layers
      const cols: StageColumn[] = layers.map((l, i) => ({
        units: l.units,
        display: 0,
        label: i === 0 ? inLabel : i === layers.length - 1 ? outLabel : `×${l.units}`,
        activation: i === 0 ? 'input' : l.activation,
        locked: i === 0 || i === layers.length - 1,
      }))
      return { columns: cols, activeLayers: layers }
    }
    // planned registry (đúng BrainArchDiagram cũ — fail-open)
    const cols: StageColumn[] = brain.planned.layers.map((l, i) => ({
      units: l.units === 0 ? (i === 0 ? (brain.inputDim ?? 8) : 3) : l.units,
      display: 0,
      label: l.unitsLabel ?? (l.units === 0 ? (i === 0 ? inLabel : outLabel) : `×${l.units}`),
      activation: l.activation || 'input',
      locked: true,
    }))
    return { columns: cols, activeLayers: null }
  }, [brain, draft, editorOn, weights])

  // ── Layout + cạnh (LOD) ──
  const layout = useMemo(() => buildStageLayout(columns.map(c => ({
    ...c,
    display: Math.min(c.units, STAGE_LIMITS.maxDisplayNeurons),
  }))), [columns])

  const edgesAll = useMemo(() => {
    const byColRow = new Map<string, { x: number; y: number; realIndex: number | null }>()
    for (const n of layout.neurons) byColRow.set(`${n.col}:${n.row}`, { x: n.x, y: n.y, realIndex: n.realIndex })
    const list: StageEdge[] = []
    let id = 0
    for (let c = 0; c < columns.length - 1; c++) {
      for (let r1 = 0; r1 < Math.min(columns[c].units, STAGE_LIMITS.maxDisplayNeurons); r1++) {
        for (let r2 = 0; r2 < Math.min(columns[c + 1].units, STAGE_LIMITS.maxDisplayNeurons); r2++) {
          const a = byColRow.get(`${c}:${r1}`)
          const b = byColRow.get(`${c + 1}:${r2}`)
          if (!a || !b) continue
          const R = 6.5 // bán kính nơ-ron — cạnh né lõi (tiền lệ BrainArchDiagram)
          const { cx1, cy1, cx2, cy2 } = bezierControls(a.x + R, a.y, b.x - R, b.y)
          list.push({
            id: id++, fromCol: c, toCol: c + 1, fromRow: r1, toRow: r2,
            x1: a.x + R, y1: a.y, x2: b.x - R, y2: b.y, cx1, cy1, cx2, cy2,
          })
        }
      }
    }
    return list
  }, [columns, layout.neurons])

  const edges = useMemo(() => lodEdges(edgesAll), [edgesAll])

  // ── |gradient| từng lớp (chế độ ngược — dữ liệu thật, có mới bật được) ──
  const gradByCol = useMemo(() => {
    if (!weights?.gradAbsMean || !Array.isArray(weights.gradAbsMean)) return null
    // gradAbsMean[i] (0-based) = |gradient| TB của LỚP TRỌNG SỐ nối cột i → cột i+1
    // (tensor W(i+1)); cạnh từ cột fromCol đọc g[fromCol] — mapping ĐÚNG theo
    // cột TRÁI của cạnh (FB-BRAIN-UX-R1-09a: trước đây comment ghi sai i+1→i+2)
    const g = weights.gradAbsMean
    return (col: number): number | null => (col < g.length ? g[col] : null)
  }, [weights])
  const hasBackData = gradByCol !== null && weights?.gradAbsMean?.some(v => v > 0) === true

  // ── Inspector: tra bias/|w| từ tensor thật ──
  const inspect = useMemo(() => {
    if (!inspector || !weights?.mlp?.tensors) return null
    const tensors = weights.mlp.tensors
    const W = (layer: number): { data: number[]; rows: number; cols: number } | null => {
      const t = tensors.find(x => x.kind === 'W' && x.layer === layer)
      if (!t) return null
      const rows = t.envelope.shape[0] ?? 0
      const cols = t.envelope.shape[1] ?? 0
      return { data: t.envelope.data, rows, cols }
    }
    const B = (layer: number): number[] | null => {
      const t = tensors.find(x => x.kind === 'b' && x.layer === layer)
      return t ? t.envelope.data : null
    }
    const neuronReal = (col: number, row: number): number | null => {
      const n = layout.neurons.find(x => x.col === col && x.row === row)
      return n?.realIndex ?? null
    }
    if (inspector.kind === 'neuron') {
      const col = inspector.col
      const real = neuronReal(col, inspector.row)
      const units = columns[col]?.units ?? 0
      if (real === null) return { kind: 'neuron' as const, col, row: inspector.row, real, note: units > STAGE_LIMITS.maxDisplayNeurons ? 'nơ-ron đại diện (đã nén ×N)' : null }
      // Convention serialize mlp.ts (tensor layer 1..L−1): W(l) nối cột l−1 →
      // cột l, với W(l)[j][i] = trọng số từ unit i (cột l−1) sang unit j (cột l);
      // b(l) = bias CỘT l. Nơ-ron (col, real) thuộc cột col nên đọc:
      //  - bias       = b(col) — chỉ cột ≥ 1 có bias (cột input 0 không có)
      //  - |w| vào TB = mean |W(col)[real][i]| theo i (hàng real của W(col)) — col ≥ 1
      //  - |w| ra TB  = mean |W(col+1)[j][real]| theo j (cột real của W(col+1)) — không phải cột cuối
      // (FB-BRAIN-UX-R1-01: trước đây đọc B(col+1)/W(col+1)/W(col+2) — lệch hẳn
      // sang nơ-ron cột kế cùng unit index, sai cột một bậc.)
      const biasArr = col >= 1 ? B(col) : null
      const bias = biasArr && real < biasArr.length ? biasArr[real] : null
      const wIn = col >= 1 ? W(col) : null
      let absWIn: number | null = null
      if (wIn && wIn.cols > 0 && real < wIn.rows) {
        let s = 0
        for (let i = 0; i < wIn.cols; i++) s += Math.abs(wIn.data[real * wIn.cols + i] ?? 0)
        absWIn = s / wIn.cols
      }
      const isLastCol = col >= columns.length - 1
      const wOut = !isLastCol ? W(col + 1) : null
      let absWOut: number | null = null
      if (wOut && wOut.cols > 0 && real < wOut.cols) {
        let s = 0
        for (let j = 0; j < wOut.rows; j++) s += Math.abs(wOut.data[j * wOut.cols + real] ?? 0)
        absWOut = s / wOut.rows
      }
      return { kind: 'neuron' as const, col, row: inspector.row, real, bias, absWIn, absWOut, note: units > STAGE_LIMITS.maxDisplayNeurons ? 'nơ-ron đại diện (đã nén ×N)' : null }
    }
    // edge — ĐÚNG convention: W(fromCol+1)[toReal][fromReal] = từ unit
    // fromReal (cột fromCol) sang unit toReal (cột fromCol+1) — giữ nguyên.
    const fromReal = neuronReal(inspector.col, inspector.row)
    const toReal = neuronReal(inspector.col + 1, inspector.toRow ?? 0)
    const w = W(inspector.col + 1)
    let weight: number | null = null
    if (w && fromReal !== null && toReal !== null && fromReal < w.cols && toReal < w.rows) {
      weight = w.data[toReal * w.cols + fromReal] ?? null
    }
    return { kind: 'edge' as const, col: inspector.col, fromRow: inspector.row, toRow: inspector.toRow ?? 0, fromReal, toReal, weight }
  }, [inspector, weights, layout.neurons, columns])

  // ── Bấm SVG → hit-test cạnh / nơ-ron ──
  const onSvgClick = useCallback((ev: React.MouseEvent<SVGSVGElement>) => {
    const svg = ev.currentTarget
    const pt = svg.createSVGPoint()
    pt.x = ev.clientX
    pt.y = ev.clientY
    const loc = pt.matrixTransform(svg.getScreenCTM()?.inverse() ?? svg.getCTM()?.inverse())
    if (!loc) return
    // nơ-ron trước (bán kính 6.5 + đệm)
    const neuron = layout.neurons.find(n => Math.hypot(n.x - loc.x, n.y - loc.y) <= 9)
    if (neuron) {
      setInspector({ kind: 'neuron', col: neuron.col, row: neuron.row })
      return
    }
    const edge = hitEdge(loc.x, loc.y, edges)
    if (edge) {
      setInspector({ kind: 'edge', col: edge.fromCol, row: edge.fromRow, toRow: edge.toRow })
      return
    }
    setInspector(null)
  }, [edges, layout.neurons])

  const lifecycleCls = brain.lifecycle === 'active' ? 'bs-glow-active' : 'bs-glow-dormant'
  const accent = brain.lifecycle === 'active' ? 'rgba(251,191,36,0.85)' : 'rgba(251,191,36,0.38)'
  const ariaLayers = columns.map(c => `${c.label} ${c.activation}`).join(' → ')

  return (
    <div ref={wrapRef} className="relative" role="group" aria-label={`Sân khấu não ${brain.title}`}>
      {/* Thanh công cụ sân khấu */}
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        {brain.key === 'surrogate' && weights && (
          <div className="flex overflow-hidden rounded-md border border-stone-700/70" role="tablist" aria-label="Chọn đầu ra surrogate">
            {(['success', 'tokens', 'durationMs'] as const).map(h => (
              <button
                key={h}
                role="tab"
                aria-selected={head === h}
                onClick={() => { setHead(h); setInspector(null) }}
                className={`min-h-[44px] md:min-h-[28px] px-2 text-[10px] ${head === h ? 'bg-amber-500/20 text-amber-300' : 'text-stone-400 hover:text-stone-200'}`}
              >
                {h === 'success' ? 'success' : h === 'tokens' ? 'tokens' : 'duration'}
              </button>
            ))}
          </div>
        )}
        {fxOn && (
          <button
            onClick={() => setBackMode(b => !b)}
            disabled={!hasBackData}
            title={hasBackData
              ? backMode ? 'Đang xem lan truyền NGƯỢC (tông hổ phách, độ dày theo |gradient| thật từ train) — bấm về TIẾN' : 'Xem lan truyền NGƯỢC — đảo chiều + độ dày theo |gradient| trung bình từng lớp (dữ liệu thật từ train)'
              : 'Chưa có dữ liệu |gradient| (train lần đầu để bật — không trang trí suông)'}
            className={`min-h-[44px] md:min-h-[28px] rounded-md border px-2 text-[10px] ${backMode && hasBackData ? 'border-amber-500/60 bg-amber-500/15 text-amber-300' : 'border-stone-700/70 text-stone-400 hover:text-stone-200'} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {backMode && hasBackData ? '↺ Ngược (|grad| thật)' : '→ Tiến'}
          </button>
        )}
        <span className="ml-auto text-[9.5px] text-stone-500">
          {weights
            ? `bản v${weights.version}${weights.active ? ' ★active' : ''} · ${new Date(weights.trainedAt).toLocaleDateString('vi-VN')}`
            : weightsError ?? 'đang tải…'}
        </span>
      </div>

      <div
        className={`overflow-hidden rounded-xl border ${fxOn ? 'border-stone-700/60' : 'border-slate-800/80'} bg-slate-950/60 ${fxOn ? lifecycleCls : ''}`}
      >
        <svg
          viewBox={`0 0 340 ${Math.max(layout.height, 96)}`}
          className={`h-auto w-full ${fxOn ? 'cursor-pointer' : ''}`}
          role="img"
          aria-label={`Kiến trúc ${brain.title}: ${ariaLayers} — loss ${brain.planned.loss}`}
          onClick={fxOn ? onSvgClick : undefined}
        >
          <defs>
            <linearGradient id="bs-fwd" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor={fxOn ? 'rgba(251,191,36,0.10)' : 'rgba(168,162,158,0.22)'} />
              <stop offset="1" stopColor={fxOn ? accent : 'rgba(168,162,158,0.34)'} />
            </linearGradient>
            <linearGradient id="bs-bwd" x1="1" y1="0" x2="0" y2="0">
              <stop offset="0" stopColor="rgba(251,146,60,0.10)" />
              <stop offset="1" stopColor="rgba(251,146,60,0.75)" />
            </linearGradient>
            <marker id="bs-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M0,1 L7,4 L0,7 z" fill={backMode && hasBackData ? 'rgba(251,146,60,0.85)' : accent} />
            </marker>
          </defs>

          {/* Cạnh: bezier gradient + nét đứt chạy (động) hoặc thẳng tĩnh có mũi tên (off) */}
          {edges.map(e => {
            const gradVal = backMode && hasBackData && gradByCol ? gradByCol(e.fromCol) : null
            const strokeW = backMode && hasBackData
              ? strokeWidthForGrad(gradVal, weights?.gradAbsMean ?? [])
              : 0.9
            if (!fxOn) {
              return (
                <line
                  key={e.id}
                  x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
                  stroke="rgba(168,162,158,0.22)" strokeWidth="0.8"
                  markerEnd="url(#bs-arrow)"
                />
              )
            }
            const path = `M ${e.x1} ${e.y1} C ${e.cx1} ${e.cy1}, ${e.cx2} ${e.cy2}, ${e.x2} ${e.y2}`
            const isSel = inspector?.kind === 'edge'
              && inspector.col === e.fromCol && inspector.row === e.fromRow && inspector.toRow === e.toRow
            return (
              <path
                key={e.id}
                d={path}
                fill="none"
                stroke={backMode && hasBackData ? 'url(#bs-bwd)' : 'url(#bs-fwd)'}
                strokeWidth={isSel ? Math.max(strokeW * 1.9, 2.2) : strokeW}
                strokeDasharray={animated && inView ? '5 4.5' : undefined}
                markerEnd={backMode && hasBackData ? 'url(#bs-arrow)' : animated && inView ? undefined : 'url(#bs-arrow)'}
                className={animated && inView ? (backMode && hasBackData ? 'bs-flow bs-flow-bwd' : 'bs-flow') : undefined}
                style={animated && inView ? { animationDelay: `${edgePhaseSec(e.id)}s` } : undefined}
                opacity={isSel ? 1 : 0.9}
              />
            )
          })}

          {/* Nơ-ron */}
          {layout.neurons.map(n => {
            const isSel = inspector?.kind === 'neuron' && inspector.col === n.col && inspector.row === n.row
            return (
              <circle
                key={`n-${n.col}-${n.row}`}
                cx={n.x} cy={n.y} r={isSel ? 7.4 : 6.5}
                fill="rgba(2,6,23,0.95)"
                stroke={isSel ? 'rgba(251,191,36,0.95)' : accent}
                strokeWidth={isSel ? 1.8 : 1.1}
                className={fxOn ? 'transition-all' : undefined}
              />
            )
          })}

          {/* Nhãn cột: bấm được khi editor bật (cột ẩn) */}
          {columns.map((c, ci) => {
            const x = layout.colX[ci] ?? 0
            const yBase = Math.max(layout.height - 18, 72)
            const isHiddenEditable = editorOn && !c.locked
            return (
              <g key={`l-${ci}`}>
                {isHiddenEditable ? (
                  <text
                    x={x} y={yBase - 10} textAnchor="middle"
                    fontSize={8} className="cursor-pointer fill-amber-400 underline decoration-dotted"
                    style={{ fontFamily: 'inherit' }}
                    role="button"
                    onClick={ev => { ev.stopPropagation(); onEditLayer?.(ci - 1) }}
                  >
                    {c.label} ✎
                  </text>
                ) : (
                  <text x={x} y={yBase - 10} textAnchor="middle" fontSize={8} className="fill-stone-300" style={{ fontFamily: 'inherit' }}>
                    {c.label}
                  </text>
                )}
                <text x={x} y={yBase} textAnchor="middle" fontSize={7} className="fill-stone-500" style={{ fontFamily: 'inherit' }}>
                  {c.activation}
                </text>
                {c.locked && (
                  <title>{`Lớp ${ci === 0 ? 'đầu vào' : 'đầu ra'} KHÓA theo hợp đồng pipeline (§9.1-2)`}</title>
                )}
              </g>
            )
          })}
        </svg>
      </div>

      {/* Inspector nơ-ron/cạnh */}
      {fxOn && inspector && inspect && (
        <div className="mt-1.5 rounded-lg border border-stone-700/60 bg-slate-950/80 p-2 text-[10.5px] text-stone-300" role="status">
          {inspect.kind === 'neuron' ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span className="font-semibold text-amber-400">
                Nơ-ron cột {inspect.col + 1} · hàng {inspect.row + 1}{inspect.real !== null ? ` (unit #${inspect.real + 1})` : ''}
              </span>
              <span>activation: <span className="font-mono">{columns[inspect.col]?.activation || '—'}</span></span>
              {weights ? (
                <>
                  <span>bias: <span className="font-mono">{inspect.bias !== null && inspect.bias !== undefined ? inspect.bias.toFixed(4) : '—'}</span></span>
                  <span>|w| vào TB: <span className="font-mono">{inspect.absWIn !== null && inspect.absWIn !== undefined ? inspect.absWIn.toFixed(4) : '—'}</span></span>
                  <span>|w| ra TB: <span className="font-mono">{inspect.absWOut !== null && inspect.absWOut !== undefined ? inspect.absWOut.toFixed(4) : '—'}</span></span>
                </>
              ) : (
                <span className="italic text-stone-500">chưa train — không có bias/|w| (không trang trí suông)</span>
              )}
              {inspect.note && <span className="italic text-stone-500">({inspect.note})</span>}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span className="font-semibold text-amber-400">
                Cạnh {inspect.col + 1}→{inspect.col + 2} · hàng {inspect.fromRow + 1}→{(inspect.toRow ?? 0) + 1}
              </span>
              {weights ? (
                <span>|w|: <span className="font-mono">{inspect.weight !== null && inspect.weight !== undefined ? Math.abs(inspect.weight).toFixed(4) : '—'}</span></span>
              ) : (
                <span className="italic text-stone-500">chưa train — không có trọng số</span>
              )}
              {editorOn && !columns[inspect.col]?.locked && (
                <button
                  className="min-h-[44px] md:min-h-[28px] rounded border border-stone-700 px-1.5 text-[9.5px] text-stone-300 hover:text-amber-300"
                  onClick={() => onEditLayer?.(inspect.col - 1)}
                >
                  Sửa 2 lớp hai đầu
                </button>
              )}
            </div>
          )}
          <button
            className="ml-2 min-h-[44px] md:min-h-[28px] text-[9.5px] text-stone-500 hover:text-stone-300"
            onClick={() => setInspector(null)}
            aria-label="Đóng inspector"
          >
            ✕ đóng
          </button>
        </div>
      )}
      {!fxOn && (
        <p className="mt-1 text-[9px] text-stone-600">
          Hiệu ứng synapse đang TẮT (cờ UI_SYNAPSE_FX — bảng tinh chỉnh): đường thẳng tĩnh như trước. Bật để thấy hướng lan truyền + bấm sửa nơ-ron/cạnh.
        </p>
      )}
      {fxOn && !hasBackData && (
        <p className="mt-0.5 text-[9px] text-stone-600">
          Chế độ lan truyền ngược cần |gradient| thật từ lần train đầu (không trang trí suông — §9.4).
        </p>
      )}
    </div>
  )
}
