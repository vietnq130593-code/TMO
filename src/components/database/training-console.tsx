'use client'

/**
 * BRAIN-UX §9.3 (UX-2) — TRAINING CONSOLE
 * ============================================================================
 *
 *  - Nhóm A — siêu tham số khối train (ghi vào draft UX-1): optimizer · lr
 *    (thang log 1e-4→1) · epochs 50–5000 · batch 8–256 · L2 0–0.1 ·
 *    patience 10–200 · hold-out 10–30% · grad-clip 1–10 · seed.
 *  - Nhóm B — trọng số loss TỪNG ĐẦU RA (Brain-B 3 đầu): λ ∈ [0,1], chuẩn
 *    hoá Σλ=1 tự động (hiển thị %); mỗi đầu hồi quy chọn loss {Huber, MSE};
 *    formula hiển thị THẬT: mỗi head 1 MLP riêng → scale λᵢ×3 áp gradient
 *    head đó (chia đều = 1.0 = đúng hành vi trước UX-2; Adam ~ trung hoà —
 *    GHI CHÚ trung thực, tác dụng rõ với SGD).
 *  - Nhóm C — composite reward w₁w₂w₃ (override qua tuning-store
 *    STORE›ENV›DEFAULT=1/3 + audit; LOG-ONLY — không đổi quyết định).
 *  - Nút "Huấn luyện": POST /api/brain/train (useDraft khi có nháp) — batch
 *    ngoài request path (A7); hiển thị quỹ đạo epoch loss train/hold-out SAU
 *    khi xong (MLP nhỏ ~giây — stream realtime từng epoch over-engineering,
 *    ghi nhận blueprint v0.10) + kết quả CV + CI + thắng/thua đối chứng.
 */

import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Play, Save } from 'lucide-react'
import type { BrainKey, BrainStatusEntry } from '@/lib/brain/registry'
import {
  DRAFT_LIMITS,
  normalizeLossWeights,
  validateBrainDraft,
  type BrainDraftSpec,
} from '@/lib/brain/spec-schema'

const viNum = (n: number): string => n.toLocaleString('vi-VN')

/** Kết quả train hiển thị console (từ POST /api/brain/train). */
export interface TrainOutcomeUi {
  brain: BrainKey
  useDraft: boolean
  version: number
  active: boolean
  cvText: string
  baselineText: string
  history: Array<{ epoch: number; trainLoss: number; valLoss: number | null }>
  improved: boolean
}

export function TrainingConsole({
  brain,
  draft,
  onDraftChange,
  onDraftSave,
  draftDirty,
  hasSavedDraft,
  editorOn,
  onTrain,
  training,
  outcome,
  rewardWeights,
  rewardSource,
  onSetRewardWeight,
  onResetRewardWeight,
  savingRewardKey,
}: {
  brain: BrainStatusEntry
  draft: BrainDraftSpec
  onDraftChange: (d: BrainDraftSpec) => void
  onDraftSave: () => void
  draftDirty: boolean
  /** FB-BRAIN-UX-R1-03 — có bản nháp ĐÃ LƯU ở server (savedDrafts[key] != null) */
  hasSavedDraft: boolean
  editorOn: boolean
  onTrain: (key: BrainKey, useDraft: boolean) => void
  training: boolean
  outcome: TrainOutcomeUi | null
  /** Trọng số hiệu lực hiện tại (STORE›ENV›DEFAULT — từ tuning state) */
  rewardWeights: { outcome: number; efficiency: number; quality: number }
  /** Nguồn hiệu lực hiển thị (STORE/ENV/DEFAULT) */
  rewardSource: string
  onSetRewardWeight: (key: 'reward_w_outcome' | 'reward_w_efficiency' | 'reward_w_quality', value: number) => void
  onResetRewardWeight: (key: 'reward_w_outcome' | 'reward_w_efficiency' | 'reward_w_quality') => void
  savingRewardKey: string | null
}) {
  const validation = useMemo(
    () => validateBrainDraft({ ...draft, brain: brain.key }, brain.inputDim ?? null),
    [draft, brain.key, brain.inputDim],
  )
  const normWeights = normalizeLossWeights(draft.lossPerHead.map(h => h.weight))
  const canTrain = brain.trainable && brain.lifecycle !== 'dormant'
  // FB-BRAIN-UX-R1-03: server train bản nháp ĐÃ LƯU cuối cùng trong DB — ép
  // khớp UI/bản thật: chỉ train theo nháp khi CÓ bản đã lưu VÀ không đang sửa
  // dở (dirty); đang dirty thì khóa nút + giải thích (user tưởng train theo
  // giá trị trên màn hình — bug 13-a R1-03).
  const useDraft = editorOn && hasSavedDraft && !draftDirty
  const draftBlockReason = !hasSavedDraft
    ? 'Chưa có nháp đã lưu — bấm "Lưu nháp" trước'
    : draftDirty
      ? 'Bản nháp đang sửa chưa lưu — nút này train bản ĐÃ LƯU; bấm "Lưu nháp" trước'
      : null
  const lrExp = Math.log10(draft.hyper.lr)

  // ── Nhóm C: slider trọng số reward commit-on-release ──
  // Slider kéo ra NHIỀU giá trị trung gian (mỗi bước 1 onChange) — POST thẳng
  // từng bước sẽ spam /api/neural-architecture. Giá trị đang kéo giữ ở state
  // cục bộ pendingReward; chỉ POST (onSetRewardWeight) khi user THẢ slider
  // (pointerup) / nhả phím mũi tên (keyup) / rời focus (blur) — tiền đề
  // commit-on-release giống TuningControl (onValueCommit) phía inspector.
  const [pendingReward, setPendingReward] = useState<{ outcome: number; efficiency: number; quality: number } | null>(null)
  const rewardShown = pendingReward ?? rewardWeights
  const commitReward = (key: 'reward_w_outcome' | 'reward_w_efficiency' | 'reward_w_quality', value: number) => {
    if (pendingReward === null) return // không có thay đổi đang treo — không POST thừa
    onSetRewardWeight(key, value)
    setPendingReward(null)
  }

  const setHyper = (patch: Partial<BrainDraftSpec['hyper']>) =>
    onDraftChange({ ...draft, hyper: { ...draft.hyper, ...patch } })

  // Đường cong loss (polyline SVG — thuần, không thư viện)
  const lossCurve = useMemo(() => {
    const h = outcome?.history ?? []
    if (h.length < 2) return null
    const W = 300, H = 70, PAD = 4
    const losses = h.flatMap(p => [p.trainLoss, p.valLoss].filter((v): v is number => v !== null))
    const lo = Math.min(...losses)
    const hi = Math.max(...losses)
    const span = hi - lo > 1e-12 ? hi - lo : 1
    const x = (i: number) => PAD + (i / (h.length - 1)) * (W - 2 * PAD)
    const y = (v: number) => H - PAD - ((v - lo) / span) * (H - 2 * PAD)
    const line = (get: (p: typeof h[number]) => number | null) =>
      h.map((p, i) => { const v = get(p); return v === null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}` })
        .filter((s): s is string => s !== null)
        .join(' ')
    return {
      train: line(p => p.trainLoss),
      val: line(p => p.valLoss),
      lo, hi,
      n: h.length,
    }
  }, [outcome])

  return (
    <div className="space-y-3" role="group" aria-label="Training Console">
      {/* ══ NHÓM A — SIÊU THAM SỐ KHỐI TRAIN ══ */}
      <section className="space-y-2" aria-label="Nhóm A — siêu tham số khối train">
        <div className="flex items-center gap-2">
          <p className="text-[11px] font-semibold text-stone-200">A · Siêu tham số khối train</p>
          <span className="text-[9px] text-stone-600">ghi vào bản nháp UX-1 · phạm vi §9.3</span>
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <label className="flex items-center justify-between gap-2 text-[10px] text-stone-400">
            <span>Optimizer</span>
            <select
              value={draft.hyper.optimizer}
              disabled={!editorOn}
              onChange={e => setHyper({ optimizer: e.target.value as 'sgd' | 'adam' })}
              className="h-7 w-24 rounded border border-stone-700 bg-slate-900 px-1 font-mono text-[10px] text-stone-100 disabled:opacity-50"
            >
              <option value="adam">adam</option>
              <option value="sgd">sgd+momentum</option>
            </select>
          </label>
          <label className="flex items-center justify-between gap-2 text-[10px] text-stone-400" title="Thang log 1e-4 → 1">
            <span>lr (log)</span>
            <span className="flex items-center gap-1">
              <input
                type="range" min={Math.log10(DRAFT_LIMITS.lrMin)} max={0} step={0.05}
                value={lrExp} disabled={!editorOn}
                onChange={e => setHyper({ lr: Math.pow(10, Number.parseFloat(e.target.value)) })}
                className="h-7 w-16 accent-amber-500 disabled:opacity-50"
                aria-label="Learning rate (thang log)"
              />
              <span className="w-12 font-mono text-stone-200">{draft.hyper.lr.toPrecision(2)}</span>
            </span>
          </label>
          {([
            ['epochs', DRAFT_LIMITS.epochsMin, DRAFT_LIMITS.epochsMax, 10, 1],
            ['batch', DRAFT_LIMITS.batchMin, DRAFT_LIMITS.batchMax, 4, 1],
            ['patience', DRAFT_LIMITS.patienceMin, DRAFT_LIMITS.patienceMax, 5, 1],
          ] as const).map(([field, min, max, step, _int]) => (
            <label key={field} className="flex items-center justify-between gap-2 text-[10px] text-stone-400">
              <span>{field}</span>
              <span className="flex items-center gap-1">
                <input
                  type="range" min={min} max={max} step={step}
                  value={draft.hyper[field]}
                  disabled={!editorOn}
                  onChange={e => setHyper({ [field]: Number.parseInt(e.target.value, 10) } as Partial<BrainDraftSpec['hyper']>)}
                  className="h-7 w-16 accent-amber-500 disabled:opacity-50"
                  aria-label={field}
                />
                <span className="w-12 font-mono text-stone-200">{draft.hyper[field]}</span>
              </span>
            </label>
          ))}
          <label className="flex items-center justify-between gap-2 text-[10px] text-stone-400" title="Hệ số L2 (weight decay) 0 → 0.1">
            <span>l2</span>
            <span className="flex items-center gap-1">
              <input
                type="range" min={DRAFT_LIMITS.l2Min} max={DRAFT_LIMITS.l2Max} step={0.005}
                value={draft.hyper.l2} disabled={!editorOn}
                onChange={e => setHyper({ l2: Number.parseFloat(e.target.value) })}
                className="h-7 w-16 accent-amber-500 disabled:opacity-50"
                aria-label="L2"
              />
              <span className="w-12 font-mono text-stone-200">{draft.hyper.l2.toFixed(3)}</span>
            </span>
          </label>
          <label className="flex items-center justify-between gap-2 text-[10px] text-stone-400" title="Tỉ lệ hold-out 10–30% (audit B2)">
            <span>hold-out</span>
            <span className="flex items-center gap-1">
              <input
                type="range" min={DRAFT_LIMITS.holdoutMin} max={DRAFT_LIMITS.holdoutMax} step={0.01}
                value={draft.hyper.holdout} disabled={!editorOn}
                onChange={e => setHyper({ holdout: Number.parseFloat(e.target.value) })}
                className="h-7 w-16 accent-amber-500 disabled:opacity-50"
                aria-label="Hold-out"
              />
              <span className="w-12 font-mono text-stone-200">{(draft.hyper.holdout * 100).toFixed(0)}%</span>
            </span>
          </label>
          <label className="flex items-center justify-between gap-2 text-[10px] text-stone-400" title="Clip chuẩn gradient toàn cục 1–10 (mặc định 5)">
            <span>grad-clip</span>
            <span className="flex items-center gap-1">
              <input
                type="range" min={DRAFT_LIMITS.clipMin} max={DRAFT_LIMITS.clipMax} step={1}
                value={draft.hyper.clip} disabled={!editorOn}
                onChange={e => setHyper({ clip: Number.parseFloat(e.target.value) })}
                className="h-7 w-16 accent-amber-500 disabled:opacity-50"
                aria-label="Grad clip"
              />
              <span className="w-12 font-mono text-stone-200">{draft.hyper.clip.toFixed(0)}</span>
            </span>
          </label>
          <label className="flex items-center justify-between gap-2 text-[10px] text-stone-400" title="Seed tất định — chạy lại ra kết quả y hệt">
            <span>seed</span>
            <input
              type="number" min={0} step={1} value={draft.hyper.seed} disabled={!editorOn}
              onChange={e => { const v = Number.parseInt(e.target.value, 10); if (Number.isFinite(v) && v >= 0) setHyper({ seed: v }) }}
              aria-label="Seed"
              className="h-7 w-16 rounded border border-stone-700 bg-slate-900 px-1 text-center font-mono text-[10px] text-stone-100 disabled:opacity-50"
            />
          </label>
        </div>
      </section>

      {/* ══ NHÓM B — TRỌNG SỐ LOSS TỪNG ĐẦU RA ══ */}
      <section className="space-y-1.5" aria-label="Nhóm B — trọng số loss từng đầu ra">
        <div className="flex items-center gap-2">
          <p className="text-[11px] font-semibold text-stone-200">B · Trọng số loss từng đầu ra</p>
          <span className="text-[9px] text-stone-600">Σλ=1 tự động · hiển thị %</span>
        </div>
        {brain.key === 'surrogate' ? (
          <>
            <div className="space-y-1">
              {draft.lossPerHead.map((h, i) => {
                const names = ['success (BCE 🔒)', 'tokens (Huber/MSE)', 'duration (Huber/MSE)']
                const lockedType = i === 0
                const allowedTypes = i === 0 ? ['huber' as const] : (['huber', 'mse'] as const)
                return (
                  <div key={i} className="flex flex-wrap items-center gap-2 text-[10px]">
                    <span className="w-32 shrink-0 text-stone-400">{names[i]}</span>
                    <input
                      type="range" min={0} max={1} step={0.05} value={h.weight}
                      disabled={!editorOn}
                      onChange={e => onDraftChange({
                        ...draft,
                        lossPerHead: draft.lossPerHead.map((x, j) => j === i ? { ...x, weight: Number.parseFloat(e.target.value) } : x),
                      })}
                      className="h-7 w-20 accent-amber-500 disabled:opacity-50"
                      aria-label={`Trọng số λ đầu ra ${names[i]}`}
                    />
                    <span className="w-10 font-mono text-stone-200">{(normWeights[i] * 100).toFixed(0)}%</span>
                    {lockedType ? (
                      <Badge variant="outline" className="h-4 bg-slate-950/70 px-1 font-mono text-[8.5px] text-stone-500">bce 🔒</Badge>
                    ) : (
                      <select
                        value={h.type}
                        disabled={!editorOn}
                        onChange={e => onDraftChange({
                          ...draft,
                          lossPerHead: draft.lossPerHead.map((x, j) => j === i ? { ...x, type: e.target.value as 'huber' | 'mse' } : x),
                        })}
                        className="h-6 w-20 rounded border border-stone-700 bg-slate-900 px-1 font-mono text-[9.5px] text-stone-100 disabled:opacity-50"
                        aria-label={`Loại loss đầu ra ${names[i]}`}
                      >
                        {allowedTypes.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    )}
                  </div>
                )
              })}
            </div>
            <p className="text-[9px] leading-relaxed text-stone-600">
              Brain-B là 3 MLP MỖI ĐẦU MỘT: L_head = λᵢ×3 × loss_head áp gradient head đó (chia đều = 1.0/head = đúng hành vi trước UX-2).
              Ghi chú trung thực: Adam ~ trung hoà scale (adaptive), tác dụng rõ với SGD+momentum.
            </p>
          </>
        ) : (
          <p className="text-[9.5px] text-stone-500">
            {brain.key === 'calibration_v3'
              ? 'Brain-A đơn đầu ra: loss BCE 🔒 theo hợp đồng output sigmoid — chỉ hiển thị.'
              : 'Brain-C softmax đa lớp: loss CrossEntropy 🔒 theo hợp đồng — chỉ hiển thị.'}
          </p>
        )}
      </section>

      {/* ══ NHÓM C — COMPOSITE REWARD (LOG-ONLY) ══ */}
      <section className="space-y-1.5" aria-label="Nhóm C — composite reward (log-only)">
        <div className="flex items-center gap-2">
          <p className="text-[11px] font-semibold text-stone-200">C · Composite reward w₁w₂w₃</p>
          <Badge variant="outline" className="h-4 bg-amber-950/60 px-1 text-[8.5px] text-amber-400 border-amber-500/40">LOG-ONLY</Badge>
        </div>
        {([
          ['reward_w_outcome', 'w₁ · Outcome*', 'outcome'],
          ['reward_w_efficiency', 'w₂ · Efficiency*', 'efficiency'],
          ['reward_w_quality', 'w₃ · Quality*', 'quality'],
        ] as const).map(([key, label, field]) => (
          <div key={key} className="flex flex-wrap items-center gap-2 text-[10px]">
            <span className="w-32 shrink-0 text-stone-400">{label}</span>
            <input
              type="range" min={0} max={1} step={0.05}
              value={rewardShown[field]}
              onChange={e => setPendingReward({ ...rewardShown, [field]: Number.parseFloat(e.target.value) })}
              onPointerUp={() => commitReward(key, rewardShown[field])}
              onKeyUp={() => commitReward(key, rewardShown[field])}
              onBlur={() => commitReward(key, rewardShown[field])}
              className="h-7 w-20 accent-amber-500"
              aria-label={label}
            />
            <span className="w-16 font-mono text-stone-200">{rewardShown[field].toFixed(2)}</span>
            <button
              onClick={() => { setPendingReward(null); onResetRewardWeight(key) }}
              className="min-h-[44px] md:min-h-[28px] text-[9px] text-stone-500 hover:text-amber-400"
              title="Trả về mặc định 1/3 (bỏ override STORE)"
              aria-label={`Reset ${label}`}
            >↺</button>
            {savingRewardKey === key && <span className="text-[9px] text-stone-500">đang lưu…</span>}
          </div>
        ))}
        <p className="text-[9px] leading-relaxed text-stone-600">
          Chuỗi hiệu lực STORE › ENV › DEFAULT=1/3 (nguồn: khởi điểm 2026-10-12 — sweep chưa khả thi trên DB 0 mẫu, doctrine #1; đổi default CHỈ kèm sweep đã chạy).
          Override đổi số GHI LOG (đợt quan sát 1/2) — KHÔNG đổi quyết định runtime; updateQ giữ nhị phân ±1 (Q1 chốt 2026-10-12).
          Nguồn hiện tại: {rewardSource}.
        </p>
      </section>

      {/* ══ NÚT HUẤN LUYỆN + KẾT QUẢ ══ */}
      <section className="space-y-2 border-t border-slate-800 pt-2" aria-label="Huấn luyện">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            disabled={!canTrain || training || (editorOn && (draftBlockReason !== null || !validation.ok))}
            onClick={() => onTrain(brain.key, useDraft)}
            className="min-h-[44px] md:min-h-[28px] border-amber-500/50 bg-amber-500/15 px-2.5 text-[10.5px] text-amber-300 hover:bg-amber-500/25"
            title={canTrain
              ? (editorOn
                ? (draftBlockReason ?? 'Train batch ngoài request path (A7) — bản active chỉ xuất hiện khi thắng đối chứng CV ngặt · THEO BẢN NHÁP đã lưu')
                : 'Train batch ngoài request path (A7) — bản active chỉ xuất hiện khi thắng đối chứng CV ngặt')
              : 'Chưa đủ mẫu thức tỉnh (ngưỡng §2) — ngủ an toàn'}
          >
            <Play className="mr-1 h-3 w-3" />
            {training
              ? 'Đang huấn luyện…'
              : editorOn
                ? <>Huấn luyện theo nháp{draftDirty && <span className="text-[8.5px] text-stone-500"> • chưa lưu</span>}</>
                : 'Huấn luyện lại'}
          </Button>
          {editorOn && (
            <Button
              size="sm" variant="outline" onClick={onDraftSave} disabled={!draftDirty || !validation.ok}
              className="min-h-[44px] md:min-h-[28px] border-stone-700 px-2 text-[10px] text-stone-300"
              title="Lưu nháp (cùng nút ở Brain Studio)"
            ><Save className="mr-1 h-3 w-3" /> Lưu nháp{draftDirty ? ' •' : ''}</Button>
          )}
          <span className="text-[9px] text-stone-600">
            mỗi lần chạy sinh version+1 — thua đối chứng = bỏ, active giữ nguyên (fail-open)
          </span>
        </div>

        {outcome && outcome.brain === brain.key && (
          <div className="space-y-1.5 rounded-lg border border-stone-700/60 bg-slate-950/60 p-2" role="status">
            <p className="text-[10.5px]">
              <span className="font-semibold text-amber-400">v{outcome.version}</span>
              {' '}
              {outcome.active
                ? <span className="text-emerald-400">ACTIVE — thắng CV</span>
                : <span className="text-stone-400">không thắng CV — giữ hành vi cũ (bản vết audit đã ghi)</span>}
              {outcome.useDraft && <span className="text-stone-500"> · train theo nháp</span>}
            </p>
            <p className="font-mono text-[10px] text-stone-300">
              {outcome.cvText} vs đối chứng {outcome.baselineText}
            </p>
            {lossCurve && (
              <svg viewBox="0 0 300 70" className="h-16 w-full" role="img" aria-label={`Quỹ đạo loss ${lossCurve.n} epoch (train và hold-out)`}>
                <polyline points={lossCurve.train} fill="none" stroke="rgba(251,191,36,0.8)" strokeWidth="1.2" />
                {lossCurve.val && <polyline points={lossCurve.val} fill="none" stroke="rgba(56,189,248,0.65)" strokeWidth="1" strokeDasharray="3 2" />}
              </svg>
            )}
            <p className="text-[9px] text-stone-600">
              {lossCurve
                ? `Quỹ đạo ${viNum(lossCurve.n)} epoch (vàng = train · xanh đứt = hold-out) — hiển thị sau khi train xong (MLP nhỏ chạy ~giây).`
                : 'Quỹ đạo epoch sẽ hiện sau lần train đầu.'}
            </p>
          </div>
        )}
      </section>
    </div>
  )
}
