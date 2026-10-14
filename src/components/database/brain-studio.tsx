'use client'

/**
 * BRAIN-UX §9.5 (UX-4) — BRAIN STUDIO (CONTROLLED)
 * ============================================================================
 *
 * BRAIN-TAB-3PHAN (18-b) — rewrite "thanh ngang phần trên" (SECTION 1 của
 * layout 3 phần tab BRAIN) theo chỉ thị user 2026-10-12: "Phần trên cùng là
 * nút chọn Brain cũng như thông tin liên quan brain, Có thể thêm lớp cũng như
 * chỉnh số nơ ron mỗi lớp". Studio bỏ dropdown + editor DỌC dài chiếm cột
 * trái, nay gọn thành 4 khối ngang:
 *  (1) Segmented 3 nút chọn não (grid-cols-1 sm:grid-cols-3): dot lifecycle
 *      + tên hiệu amber + badge NGỦ/THỨC TỈNH/ACTIVE + chuỗi mẫu signals
 *      ngắn current/min — bấm trực tiếp (aria-pressed), không còn listbox.
 *  (2) Dòng thông tin não đang chọn: lifecycle · in: inputMode · inputDim ·
 *      role · models summary (★v{version} · inputMode / chưa train).
 *      Badge phase + flag=giá trị runtime giữ ở brain-tab (18-c) — studio
 *      KHÔNG nhân bản (props contract giữ nguyên, không thêm prop mới).
 *  (3) Editor kiến trúc NGANG (cờ UI_BRAIN_EDIT): hàng chip lớp
 *      Input 🔒 → [Ẩn: stepper −/N/+ (1–256) · dropdown 8 activation (softmax
 *      chỉ output đa lớp — audit B1) · α/β activation (18-d: leakyRelu α 0.01
 *      / elu α 1.0 / swish β 1.0 — trùng engine resolveAlpha/resolveBeta) ·
 *      🗑] → Output 🔒 · nút Thêm lớp ẩn (0–6, ≥3 cảnh báo overfit kèm n mẫu).
 *      Bộ đếm tham số realtime (công thức trùng mlp.validateSpec): cảnh báo
 *      > 100K, chặn lưu > 250K (§9.1-3).
 *  (4) Versions nén 1-2 dòng flex-wrap (brain.models slice 3 — giữ nguyên
 *      dữ liệu 3 thẻ cũ, chỉ đổi layout wrapper).
 *
 *  Nháp: Lưu nháp (parent PUT /api/brain/spec-draft — validate single-
 *  source spec-schema, client + server cùng rule) · Phục hồi spec chuẩn
 *  (về default chuẩn pipeline) · So sánh với bản active (diff).
 *
 * UX-4: state draft NÂNG LÊN PARENT (NeuralArchitectureSection) — studio trở
 * thành CONTROLLED component (draft/onDraftChange/onDraftSave/savingDraft/
 * draftDirty/saveErrors qua props) để Training Console (tab phải) và Brain
 * Stage (giữa) cùng đọc MỘT bản nháp duy nhất — không còn 2 nguồn sự thật.
 * (18-b giữ nguyên props contract — 18-c render <BrainStudio> cùng props.)
 *
 * Draft ≠ runtime (§9.1-1): không có gì ở đây chạm BrainModel.active.
 * Cờ UI_BRAIN_EDIT off → chỉ xem (editor ẩn, y hệt trước UX-1).
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Trash2, Plus, Save, RotateCcw, GitCompareArrows } from 'lucide-react'
import type { BrainKey, BrainStatusEntry } from '@/lib/brain/registry'
import {
  ACTIVATION_MENU,
  BRAIN_DRAFT_RULES,
  DRAFT_LIMITS,
  defaultDraftFor,
  diffDraftAgainst,
  normalizeLossWeights,
  validateBrainDraft,
  type BrainDraftSpec,
  type DraftCompareTarget,
} from '@/lib/brain/spec-schema'

const viNum = (n: number): string => n.toLocaleString('vi-VN')

const LIFECYCLE_BADGE: Record<string, { label: string; cls: string; dot: string }> = {
  dormant: { label: 'NGỦ', cls: 'bg-slate-950/70 text-stone-400 border-stone-600/50', dot: 'bg-stone-500' },
  awake: { label: 'THỨC TỈNH', cls: 'bg-amber-950/70 text-amber-400 border-amber-500/45', dot: 'bg-amber-400' },
  active: { label: 'ACTIVE', cls: 'bg-emerald-950/70 text-emerald-400 border-emerald-500/45', dot: 'bg-emerald-400' },
}

/**
 * Default α/β hiển thị trong chip lớp ẩn (18-b UI cho field 18-d) — ĐÚNG engine
 * defaults (activations.ts resolveAlpha/resolveBeta): leakyRelu α 0.01 · elu α
 * 1.0 · swish β 1.0. Draft KHÔNG lưu key khi user chưa chỉnh; đổi activation
 * sang loại khác thì GIỮ nguyên activationParams cũ (normalize DROP lúc lưu,
 * không dọn tại chỗ — input α/β tự ẩn theo activation đang chọn).
 */
const ALPHA_DEFAULT = { leakyRelu: 0.01, elu: 1.0 } as const
const BETA_DEFAULT = 1.0

export function BrainStudio({
  brains,
  selectedKey,
  onSelect,
  editorOn,
  draft,
  onDraftChange,
  onDraftSave,
  savingDraft,
  draftDirty,
  saveErrors,
  focusLayerSignal,
}: {
  brains: BrainStatusEntry[]
  selectedKey: BrainKey
  onSelect: (key: BrainKey) => void
  /** Cờ ui_brain_edit — on: editor hiện; off: chỉ xem */
  editorOn: boolean
  /** Bản nháp làm việc (parent owning — UX-4 controlled) */
  draft: BrainDraftSpec
  /** Mọi chỉnh sửa draft bắn về parent (cùng 1 nguồn sự thật) */
  onDraftChange: (d: BrainDraftSpec) => void
  /** Parent PUT /api/brain/spec-draft — dùng cho nút Lưu nháp */
  onDraftSave: () => void
  /** Parent đang PUT (disable nút Lưu nháp) */
  savingDraft: boolean
  /** Có chỉnh chưa lưu (chỉ báo "• chưa lưu") */
  draftDirty: boolean
  /** Lỗi server khi PUT (hiện cùng lỗi validation cục bộ) */
  saveErrors: string[]
  /** Stage bấm lớp → editor nháy tới chip đó */
  focusLayerSignal?: { brain: BrainKey; layer: number; nonce: number } | null
}) {
  const [diffOpen, setDiffOpen] = useState(false)
  const [diffTarget, setDiffTarget] = useState<DraftCompareTarget | null>(null)
  const [flashRow, setFlashRow] = useState<number | null>(null)
  const rowRefs = useRef<Array<HTMLDivElement | null>>([])

  const brain = brains.find(b => b.key === selectedKey) ?? brains[0]
  const rule = BRAIN_DRAFT_RULES[selectedKey]

  // ── Stage bấm lớp → nháy chip editor (scroll tới + highlight 1.6s) ──
  // (queueMicrotask defer: không gọi setState đồng bộ trong body effect —
  // react-hooks/set-state-in-effect, cùng pattern neural-architecture-section)
  useEffect(() => {
    if (!focusLayerSignal || focusLayerSignal.brain !== selectedKey) return
    queueMicrotask(() => setFlashRow(focusLayerSignal.layer))
    const el = rowRefs.current[focusLayerSignal.layer]
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    const t = setTimeout(() => setFlashRow(null), 1600)
    return () => clearTimeout(t)
  }, [focusLayerSignal, selectedKey])

  // UX-4 controlled: mọi chỉnh sửa bắn thẳng về parent (draft = props)
  const setDraft = onDraftChange

  // ── Validation realtime (single-source spec-schema) ──
  const inputUnits = brain?.inputDim ?? rule?.inputUnits ?? null
  // FB-BRAIN-UX-R1-02: truyền outputDim (từ bản active — vd |A| policy) làm
  // outputUnitsOverride → bộ đếm tham số gồm ĐÚNG số unit output thay vì
  // hardcode 1; chưa train → null → rule.outputUnits (policy null → 1 tạm + note).
  const outputUnits = brain?.outputDim ?? null
  const validation = useMemo(
    () => validateBrainDraft({ ...draft, brain: selectedKey }, inputUnits, outputUnits),
    [draft, selectedKey, inputUnits, outputUnits],
  )

  const restoreDefault = useCallback(() => {
    onDraftChange(defaultDraftFor(selectedKey))
  }, [onDraftChange, selectedKey])

  // ── So sánh với bản active (kéo spec active theo yêu cầu) ──
  // FB-BRAIN-UX-R1-05: tính tham số HAI BÊN — draft từ validation.params
  // (single-source spec-schema), active từ layers fetch được qua cùng công thức
  // Σ(unitsₗ×unitsₗ₋₁ + unitsₗ) — bộ đếm cục bộ 5 dòng, không import thêm gì.
  const countParams = (unitsList: number[]): number | null => {
    if (unitsList.length < 2) return null
    let total = 0
    for (let i = 1; i < unitsList.length; i++) total += unitsList[i] * unitsList[i - 1] + unitsList[i]
    return total
  }
  const openDiff = useCallback(async () => {
    try {
      const res = await fetch(`/api/brain/weights?brain=${selectedKey}`)
      if (res.ok) {
        const json = (await res.json()) as {
          version: number; spec: { layers: Array<{ units: number; activation: string }> }; mlp: { spec: { layers: Array<{ units: number; activation: string }> } }
        }
        const layers = json.spec?.layers ?? json.mlp?.spec?.layers ?? []
        const activeModel = brain?.models.find(m => m.active)
        setDiffTarget({
          source: 'active',
          layersText: layers.map(l => `${l.units}·${l.activation}`).join(' → '),
          params: countParams(layers.map(l => l.units)),
          nSamples: activeModel?.meta.nSamples ?? null,
          cvScore: activeModel?.meta.cvScore ?? null,
        })
      } else {
        // chưa có bản active → diff với planned registry (chưa train → '—')
        setDiffTarget({
          source: 'planned',
          layersText: (brain?.planned.layers ?? []).map(l => `${l.unitsLabel ?? l.units}·${l.activation || 'in'}`).join(' → '),
          params: null,
          nSamples: null,
          cvScore: null,
        })
      }
    } catch {
      setDiffTarget(null)
    }
    setDiffOpen(true)
  }, [selectedKey, brain])

  if (!brain || !rule) return null
  const lc = LIFECYCLE_BADGE[brain.lifecycle] ?? LIFECYCLE_BADGE.dormant
  const activeModel = brain.models.find(m => m.active)
  const normWeights = normalizeLossWeights(draft.lossPerHead.map(h => h.weight))
  const dirty = draftDirty
  const hiddenCount = draft.hidden.length
  // Lỗi hiển thị = validation cục bộ (realtime) + lỗi server từ lần PUT cuối
  const errorsLocal = validation.ok ? [] : validation.errors
  const shownErrors = [...errorsLocal, ...saveErrors]

  return (
    <div className="space-y-2.5" role="group" aria-label="Brain Studio — chọn não + editor kiến trúc">
      {/* ── Khối 1 · Segmented 3 nút chọn não (18-b — thay dropdown UX-1) ── */}
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3" role="group" aria-label="Chọn bộ não">
        {brains.map(b => {
          const blc = LIFECYCLE_BADGE[b.lifecycle] ?? LIFECYCLE_BADGE.dormant
          const sel = b.key === selectedKey
          return (
            <button
              key={b.key}
              onClick={() => onSelect(b.key)}
              aria-pressed={sel}
              className={`flex min-h-[44px] w-full flex-col items-start gap-1 rounded-lg border px-2.5 py-2 text-left transition-colors ${sel ? 'border-amber-500/70 bg-amber-500/10' : 'border-stone-700/70 bg-slate-950/60 hover:border-amber-500/40'}`}
            >
              {/* dòng 1: dot lifecycle + tên hiệu */}
              <span className="flex w-full min-w-0 items-center gap-1.5">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${blc.dot}`} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-stone-100">
                  {b.title} <span className="text-amber-400">&quot;{b.name}&quot;</span>
                </span>
              </span>
              {/* dòng 2: badge lifecycle + mẫu signals ngắn current/min */}
              <span className="flex w-full min-w-0 items-center gap-1.5">
                <Badge variant="outline" className={`h-4 shrink-0 px-1.5 text-[8.5px] ${blc.cls}`}>{blc.label}</Badge>
                <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-stone-500">
                  {b.signals.map(s => `${s.current === null ? '—' : viNum(s.current)}/${s.min}`).join(' · ')}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {/* ── Khối 2 · Dòng thông tin não đang chọn (phase/flag runtime ở brain-tab 18-c — không nhân bản) ── */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className={`h-3.5 px-1 text-[9px] ${lc.cls}`} role="status">
          <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${lc.dot}`} aria-hidden="true" />
          {lc.label}
        </Badge>
        <Badge variant="outline" className="h-3.5 bg-slate-950/70 px-1 font-mono text-[9px] text-stone-400 border-stone-600/50">in: {brain.defaultInputMode}</Badge>
        <Badge
          variant="outline"
          className="h-3.5 bg-slate-950/70 px-1 font-mono text-[9px] text-stone-400 border-stone-600/50"
          title={brain.inputDim == null
            ? 'Số chiều đầu vào chưa đo (động — đo lúc train)'
            : brain.inputDimExact
              ? 'Số chiều đầu vào đo chính xác'
              : 'Ước tính từ DB — có thể lệch filter usable lúc train'}
        >
          inputDim: {brain.inputDim ?? 'động'}
        </Badge>
        <span className="max-w-[240px] truncate text-[9.5px] text-stone-500" title={brain.role}>{brain.role}</span>
        <span className="font-mono text-[9.5px] text-stone-400" title={activeModel ? `Bản active v${activeModel.version}` : 'Chưa có bản active'}>
          {activeModel ? `★v${activeModel.version} · ${activeModel.inputMode}` : 'chưa train'}
        </span>
      </div>

      {/* ── Khối 3 · Editor kiến trúc NGANG (cờ UI_BRAIN_EDIT) ── */}
      {editorOn ? (
        <div className="space-y-2 rounded-xl border border-stone-700/60 bg-slate-950/50 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[11px] font-semibold text-stone-200">Editor kiến trúc — bản nháp</p>
            <span className="rounded bg-slate-900 px-1.5 py-0.5 font-mono text-[9px] text-stone-500">BrainSpecDraft · không chạm bản active (§9.1-1)</span>
            {dirty && <span className="text-[9.5px] text-amber-400">• chưa lưu</span>}
          </div>

          {/* Hàng chip lớp ngang: Input 🔒 → các lớp ẩn (chip dọc nhỏ) → Output 🔒 → + Thêm lớp ẩn */}
          <div className="flex flex-wrap items-stretch gap-1.5">
            {/* Lớp input — khóa (§9.1-2) */}
            <div
              className="flex min-w-[86px] flex-col justify-center gap-0.5 rounded-lg border border-slate-800 bg-slate-950/60 px-2 py-1.5"
              title="Lớp đầu vào KHÓA theo inputMode (§9.1-2) — tránh chỉnh làm vỡ contract dữ liệu"
            >
              <span className="text-[9px] uppercase tracking-wide text-stone-500">Input 🔒</span>
              <span className="font-mono text-[11px] text-stone-300">
                {inputUnits ?? 'D động'}{inputUnits == null && <span className="text-stone-600"> (đo lúc train)</span>}
              </span>
              <span className="font-mono text-[9px] text-stone-600">linear (bỏ qua)</span>
            </div>

            {draft.hidden.map((h, i) => {
              // 18-d: default hiển thị α/β = engine defaults (resolveAlpha/resolveBeta)
              const showAlpha = h.activation === 'leakyRelu' || h.activation === 'elu'
              const showBeta = h.activation === 'swish'
              const alphaDefault = h.activation === 'elu' ? ALPHA_DEFAULT.elu : ALPHA_DEFAULT.leakyRelu
              return (
                <Fragment key={`hidden-${i}`}>
                  <span className="shrink-0 self-center text-stone-600" aria-hidden="true">→</span>
                  <div
                    ref={el => { rowRefs.current[i] = el }}
                    className={`flex flex-col gap-1 rounded-lg border px-2 py-1.5 transition-colors ${flashRow === i ? 'border-amber-400/80 bg-amber-500/10' : 'border-slate-800 bg-slate-950/60'}`}
                  >
                    {/* dòng 1: nhãn + 🗑 góc chip */}
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[9px] uppercase tracking-wide text-stone-500">Ẩn {i + 1}</span>
                      <button
                        aria-label={`Xóa lớp ẩn ${i + 1}`}
                        onClick={() => setDraft({ ...draft, hidden: draft.hidden.filter((_, j) => j !== i) })}
                        disabled={draft.hidden.length <= 0}
                        className="min-h-[44px] md:min-h-[32px] w-8 min-w-[44px] md:min-w-8 rounded border border-stone-700 text-stone-400 hover:text-rose-400 disabled:opacity-30"
                        title="Xóa lớp ẩn này"
                      ><Trash2 className="mx-auto h-3 w-3" /></button>
                    </div>
                    {/* dòng 2: stepper −/N/+ (bước nhảy giữ logic UX-1) */}
                    <div className="flex items-center gap-1">
                      <button
                        aria-label={`Bớt nơ-ron lớp ẩn ${i + 1}`}
                        onClick={() => setDraft({ ...draft, hidden: draft.hidden.map((l, j) => j === i ? { ...l, units: Math.max(DRAFT_LIMITS.unitsMin, l.units - (l.units > 16 ? 8 : l.units > 4 ? 4 : 1)) } : l) })}
                        className="min-h-[44px] md:min-h-[32px] w-8 min-w-[44px] md:min-w-8 rounded border border-stone-700 text-stone-300 hover:text-amber-300"
                      >−</button>
                      <input
                        type="number" min={DRAFT_LIMITS.unitsMin} max={DRAFT_LIMITS.unitsMax} value={h.units}
                        onChange={e => {
                          const v = Number.parseInt(e.target.value, 10)
                          if (Number.isFinite(v)) setDraft({ ...draft, hidden: draft.hidden.map((l, j) => j === i ? { ...l, units: v } : l) })
                        }}
                        aria-label={`Số nơ-ron lớp ẩn ${i + 1}`}
                        className="h-8 w-14 rounded border border-stone-700 bg-slate-900 px-1.5 text-center font-mono text-[11px] text-stone-100"
                      />
                      <button
                        aria-label={`Thêm nơ-ron lớp ẩn ${i + 1}`}
                        onClick={() => setDraft({ ...draft, hidden: draft.hidden.map((l, j) => j === i ? { ...l, units: Math.min(DRAFT_LIMITS.unitsMax, l.units + (l.units >= 16 ? 8 : l.units >= 4 ? 4 : 1)) } : l) })}
                        className="min-h-[44px] md:min-h-[32px] w-8 min-w-[44px] md:min-w-8 rounded border border-stone-700 text-stone-300 hover:text-amber-300"
                      >+</button>
                    </div>
                    {/* dòng 3: dropdown activation (bỏ softmax — audit B1) */}
                    <select
                      value={h.activation}
                      onChange={e => setDraft({ ...draft, hidden: draft.hidden.map((l, j) => j === i ? { ...l, activation: e.target.value as typeof l.activation } : l) })}
                      aria-label={`Activation lớp ẩn ${i + 1}`}
                      className="h-8 min-w-[104px] rounded border border-stone-700 bg-slate-900 px-1.5 font-mono text-[10.5px] text-stone-100"
                    >
                      {ACTIVATION_MENU.filter(m => m.name !== 'softmax').map(m => (
                        <option key={m.name} value={m.name} title={`${m.formula} · đạo hàm ${m.derivative} · init ${m.init} — ${m.note}`}>{m.name}</option>
                      ))}
                    </select>
                    {/* dòng 4 (18-d): α (leakyRelu/elu) / β (swish) — activation khác ẩn đi */}
                    {showAlpha && (
                      <label className="flex items-center gap-1">
                        <span className="text-[9px] text-stone-500">α</span>
                        <input
                          type="number" min={DRAFT_LIMITS.alphaMin} max={DRAFT_LIMITS.alphaMax} step={0.01}
                          value={h.activationParams?.alpha ?? alphaDefault}
                          placeholder={String(alphaDefault)}
                          onChange={e => {
                            const v = Number.parseFloat(e.target.value)
                            if (Number.isFinite(v) && v > 0) setDraft({ ...draft, hidden: draft.hidden.map((l, j) => j === i ? { ...l, activationParams: { ...l.activationParams, alpha: v } } : l) })
                          }}
                          aria-label={`α lớp ẩn ${i + 1}`}
                          title="Hệ số α (dốc âm) — mặc định 0.01 (leakyRelu) / 1.0 (elu)"
                          className="h-8 w-16 rounded border border-stone-700 bg-slate-900 px-1.5 text-center font-mono text-[10.5px] text-stone-100"
                        />
                      </label>
                    )}
                    {showBeta && (
                      <label className="flex items-center gap-1">
                        <span className="text-[9px] text-stone-500">β</span>
                        <input
                          type="number" min={DRAFT_LIMITS.betaMin} max={DRAFT_LIMITS.betaMax} step={0.05}
                          value={h.activationParams?.beta ?? BETA_DEFAULT}
                          placeholder={String(BETA_DEFAULT)}
                          onChange={e => {
                            const v = Number.parseFloat(e.target.value)
                            if (Number.isFinite(v) && v > 0) setDraft({ ...draft, hidden: draft.hidden.map((l, j) => j === i ? { ...l, activationParams: { ...l.activationParams, beta: v } } : l) })
                          }}
                          aria-label={`β lớp ẩn ${i + 1}`}
                          title="Hệ số β (co giãn σ(βx)) — mặc định 1.0 (swish)"
                          className="h-8 w-16 rounded border border-stone-700 bg-slate-900 px-1.5 text-center font-mono text-[10.5px] text-stone-100"
                        />
                      </label>
                    )}
                  </div>
                </Fragment>
              )
            })}

            <span className="shrink-0 self-center text-stone-600" aria-hidden="true">→</span>
            {/* Lớp output — khóa (§9.1-2) */}
            <div
              className="flex max-w-[170px] flex-col justify-center gap-0.5 rounded-lg border border-slate-800 bg-slate-950/60 px-2 py-1.5"
              title="Lớp đầu ra KHÓA theo hợp đồng pipeline (§9.1-2)"
            >
              <span className="text-[9px] uppercase tracking-wide text-stone-500">Output 🔒</span>
              <span className="font-mono text-[10px] leading-tight text-stone-300">{rule.outputLabel}</span>
            </div>

            {/* + Thêm lớp ẩn — cuối hàng */}
            <button
              onClick={() => { if (hiddenCount < DRAFT_LIMITS.hiddenLayersMax) setDraft({ ...draft, hidden: [...draft.hidden, { units: 16, activation: 'tanh' }] }) }}
              disabled={hiddenCount >= DRAFT_LIMITS.hiddenLayersMax}
              className="flex min-h-[44px] md:min-h-[32px] items-center gap-1 self-center rounded border border-dashed border-stone-700 px-2 text-[10px] text-stone-300 hover:border-amber-500/50 hover:text-amber-300 disabled:opacity-40"
              title={hiddenCount >= DRAFT_LIMITS.hiddenLayersMax ? `Tối đa ${DRAFT_LIMITS.hiddenLayersMax} lớp ẩn (§9.2)` : 'Thêm lớp ẩn (mặc định 16·tanh)'}
            ><Plus className="h-3 w-3" /> Thêm lớp ẩn ({hiddenCount}/{DRAFT_LIMITS.hiddenLayersMax})</button>
          </div>

          {/* Cảnh báo overfit ≥3 lớp ẩn kèm số mẫu */}
          {hiddenCount >= 3 && (
            <p className="text-[9.5px] text-amber-500/90" title="Mạng sâu với ít mẫu dễ khớp quá mức (overfit)">
              ⚠ {hiddenCount} lớp ẩn — cảnh báo overfit khi chỉ có {(brain.signals[0]?.current ?? 0).toLocaleString('vi-VN')} mẫu
            </p>
          )}

          {/* Bộ đếm tham số realtime + nút nháp — 1 hàng ngang (18-b) */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {/* Bộ đếm tham số realtime (single-source validation.params — FB-BRAIN-UX-R1-02:
                bỏ bản sao công thức tại chỗ, dùng thẳng spec-schema) */}
            <div className="flex flex-wrap items-center gap-2 text-[10px]">
              <span className="text-stone-500">Tham số:</span>
              <span className={`font-mono tabular-nums ${validation.ok && validation.params.warn ? 'text-amber-400' : 'text-stone-200'}`}>
                {validation.ok && validation.params.includesInput ? viNum(validation.params.total ?? 0) : '— (D động)'}
              </span>
              {validation.ok && validation.params.warn && (
                <span className="text-amber-500/90">⚠ &gt; {viNum(DRAFT_LIMITS.paramsWarn)} — overfit dễ với {brain.signals[0]?.current ?? '?'} mẫu</span>
              )}
              {validation.ok && !validation.params.includesInput && validation.params.note && (
                <span className="text-stone-600">{validation.params.note}</span>
              )}
              {validation.ok && !validation.params.includesInput && !validation.params.note && (
                <span className="text-stone-600">kém lớp input — trần 250K chặn thật tại validateSpec lúc train</span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                size="sm" variant="outline" onClick={onDraftSave}
                disabled={savingDraft || !validation.ok}
                className="min-h-[44px] md:min-h-[32px] border-amber-500/50 px-2 text-[10px] text-amber-300 hover:text-amber-200"
                title={validation.ok ? 'R7: lưu cấu hình + TỰ ĐỘNG train & ÁP DỤNG NGAY vào runtime thật (bản active mới + cờ bật)' : 'Sửa lỗi validation trước khi lưu'}
              ><Save className="mr-1 h-3 w-3" /> {savingDraft ? 'Đang lưu & áp dụng…' : 'Lưu & áp dụng'}</Button>
              <Button
                size="sm" variant="outline" onClick={restoreDefault}
                className="min-h-[44px] md:min-h-[32px] border-stone-700 px-2 text-[10px] text-stone-300"
                title="Về spec chuẩn của pipeline (defaultDraftFor — không đổi hành vi)"
              ><RotateCcw className="mr-1 h-3 w-3" /> Phục hồi spec chuẩn</Button>
              <Button
                size="sm" variant="outline" onClick={() => void openDiff()}
                className="min-h-[44px] md:min-h-[32px] border-stone-700 px-2 text-[10px] text-stone-300"
                title="Diff kiến trúc nháp vs bản active (hoặc planned khi chưa train)"
              ><GitCompareArrows className="mr-1 h-3 w-3" /> So sánh với bản active</Button>
            </div>
          </div>

          {/* Lỗi validation (cục bộ realtime) + lỗi server lần PUT cuối */}
          {shownErrors.length > 0 && (
            <ul className="space-y-0.5 rounded-lg border border-rose-500/40 bg-rose-950/20 p-2 text-[10px] text-rose-300" role="alert">
              {shownErrors.map((e, i) => <li key={i}>• {e}</li>)}
            </ul>
          )}

          {/* Diff */}
          {diffOpen && diffTarget && (
            <div className="overflow-hidden rounded-lg border border-stone-700/70">
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="border-b border-slate-800 text-stone-500">
                    <th className="p-1.5 text-left font-medium">Trường</th>
                    <th className="p-1.5 text-left font-medium">Nháp</th>
                    <th className="p-1.5 text-left font-medium">{diffTarget.source === 'active' ? 'Bản active' : 'Planned (chưa train)'}</th>
                  </tr>
                </thead>
                <tbody>
                  {/* FB-BRAIN-UX-R2-01: chỉ truyền tổng tham số khi validateBrainDraft biết chiều input
                      (includesInput) — khi chưa biết, truyền null → hàng 'Tham số' hiện '—' trung thực,
                      nhất quán với bộ đếm realtime cùng panel ('— (D động)') đúng docstring diffDraftAgainst. */}
                  {diffDraftAgainst(draft, diffTarget, validation.ok && validation.params.includesInput ? validation.params.total : null).map(r => (
                    <tr key={r.label} className={`border-b border-slate-900/70 ${r.diff ? 'bg-amber-500/5' : ''}`}>
                      <td className="p-1.5 text-stone-400">{r.label}</td>
                      <td className={`p-1.5 font-mono ${r.diff ? 'text-amber-300' : 'text-stone-200'}`}>{r.draft}</td>
                      <td className="p-1.5 font-mono text-stone-300">{r.active}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="p-1.5 text-[9px] text-stone-600">
                Nháp KHÔNG tự lên runtime — lên bản active chỉ qua train (nút Huấn luyện ở Training Console) → thắng đối chứng CV → thăng cấp version+1 (bất biến A1).
              </p>
            </div>
          )}

          {/* Trọng số loss từng đầu (rút gọn — chỉnh chi tiết ở Training Console UX-2) */}
          {rule.editableWeights && (
            <p className="text-[9.5px] text-stone-500">
              λ từng đầu ra (chỉnh ở Training Console): {draft.lossPerHead.map((h, i) => `${h.type} ${(normWeights[i] * 100).toFixed(0)}%`).join(' · ')} — Σλ=1 tự động.
            </p>
          )}
        </div>
      ) : (
        <p className="rounded-lg border border-slate-800/80 bg-slate-950/40 px-2.5 py-1.5 text-[9.5px] text-stone-500">
          Editor kiến trúc đang TẮT (cờ UI_BRAIN_EDIT — tab Tham số runtime). Bật để chỉnh lớp ẩn/nơ-ron/activation và lưu nháp.
        </p>
      )}

      {/* ── Khối 4 · Phiên bản đã train (nén 1-2 dòng — giữ dữ liệu 3 thẻ cũ) ── */}
      {brain.models.length > 0 ? (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
          {brain.models.slice(0, 3).map(m => (
            <span key={m.id} className="truncate text-[9.5px] text-stone-400" title={`v${m.version} · ${m.inputMode}`}>
              {m.active ? '★' : '·'} v{m.version} · {m.inputMode}
              {m.meta.cvScore !== undefined ? ` · ${m.meta.metric ?? 'CV'} ${m.meta.cvScore.toFixed(3)}` : ''}
              {m.meta.nSamples !== undefined ? ` · ${viNum(m.meta.nSamples)} mẫu` : ''}
              {m.meta.draftUsed ? ' · từ nháp UX-2' : ''}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-[9.5px] italic text-stone-600">Chưa có phiên bản nào được huấn luyện — ngủ an toàn, không đổi hành vi runtime.</p>
      )}
    </div>
  )
}
