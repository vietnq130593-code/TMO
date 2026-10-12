'use client'

// ========================================================================
// brain-reference — tab "Hàm & công thức" của SECTION 3 (BRAIN-TAB-3PHAN 18-c)
// ========================================================================
//
// TRẢ LỜI CÂU HỎI USER (2026-10-12, nguyên văn): "xác định cho tôi phần
// cuối chứa các thông số chỉnh được như Trainning Console hay Tham số
// runtime liệu đã có thông tin để lựa chọn về các hàm kích hoạt, hàm
// thưởng, hàm mất mát, các thông số liên quan lan truyền tiến và lan
// truyền ngược, đạo hàm và nhiều thông số liên quan có đầy đủ chưa."
//
// 5 khối THAM CHIẾU trình bày thuần (READ-ONLY — KHÔNG fetch, KHÔNG state,
// render hết luôn không collapse):
//   1 · Hàm kích hoạt (9)  — render từ ACTIVATION_MENU (spec-schema §9.2,
//                            single-source cùng dropdown Editor kiến trúc)
//   2 · Hàm mất mát (4)    — metadata trình bày tĩnh (precedent
//                            ACTIVATION_MENU; bản thân hàm ở losses.ts)
//   3 · Hàm thưởng         — composite reward §3.1 (LOG-ONLY nhóm C)
//   4 · Lan truyền tiến    — aˡ = φ(Wˡ·aˡ⁻¹ + bˡ)
//   5 · Lan truyền ngược   — δˡ + grad-clip + SGD/Adam — hằng số optimizer
//                            import từ '@/lib/brain/optimizers' (thuần toán
//                            client-safe — DÙNG biến, không hardcode số).
//
// Nơi CHỈNH thật: Training Console (hyper + loss + reward) và Editor kiến
// trúc (lớp/nơ-ron/activation/α/β) — bảng này chỉ giúp LỰA CHỌN có căn cứ.
// ========================================================================

import { FunctionSquare } from 'lucide-react'
import { ACTIVATION_MENU } from '@/lib/brain/spec-schema'
import { SGD_MOMENTUM, ADAM_BETA1, ADAM_BETA2, ADAM_EPSILON } from '@/lib/brain/optimizers'

/**
 * Metadata TRÌNH BÀY 4 hàm mất mát (bce/mse/huber/crossEntropy) — bản thân
 * hàm + đạo hàm thật sống ở '@/lib/brain/losses' (LOSSES menu). Công thức +
 * "nơi dùng" theo hợp đồng pipeline từng brain (§9.1-2 — khóa/đổi được ghi
 * rõ từng dòng). Precedent: ACTIVATION_MENU là metadata trình bày cho menu
 * 9 activation — loss làm y hệt.
 */
const LOSS_REFERENCE = [
  {
    name: 'bce',
    formula: '−[y·log ŷ + (1−y)·log(1−ŷ)]',
    // FB-BRAIN-TAB-R1-02: 'ŷ − y' là δ của CẶP GỘP sigmoid+BCE (mlp.ts backward
    // gộp sạch) — ∂L/∂ŷ đứng một mình là −(y/ŷ−(1−y)/(1−ŷ)); thêm qualifier
    // '(kèm sigmoid)' cho đúng ngữ nghĩa + nhất quán dòng crossEntropy.
    deriv: 'ŷ − y (kèm sigmoid)',
    where: 'Brain-A output sigmoid 🔒 + Brain-B head success 🔒',
  },
  {
    name: 'mse',
    formula: '(ŷ − y)²',
    deriv: '2(ŷ − y)',
    where: 'Brain-B tokens/duration (chọn được)',
  },
  {
    name: 'huber',
    formula: '|e| ≤ δ: ½e² ; ngược: δ(|e| − ½δ)',
    deriv: 'e nếu |e|≤δ, ngược δ·sign(e)',
    where: 'Brain-B tokens/duration (chọn được) — δ chỉnh được ở Training Console nhóm B (mặc định 1.0)',
  },
  {
    name: 'crossEntropy',
    formula: '−log ŷ_y',
    deriv: 'ŷ − y (kèm softmax)',
    where: 'Brain-C softmax đa lớp 🔒',
  },
] as const

export function BrainReference() {
  return (
    <div className="space-y-4" role="group" aria-label="Tham chiếu hàm và công thức">
      <div className="flex flex-wrap items-center gap-1.5">
        <FunctionSquare className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        <h4 className="text-xs font-semibold text-stone-100">Hàm &amp; công thức — bảng tham chiếu</h4>
        <span className="text-[10px] text-stone-500">READ-ONLY · mọi thứ chỉnh được nằm ở Training Console + Editor kiến trúc</span>
      </div>

      {/* ── 1 · Hàm kích hoạt (9) — ACTIVATION_MENU single-source ── */}
      <section className="space-y-1.5" aria-label="Hàm kích hoạt">
        <div className="flex flex-wrap items-center gap-1.5">
          <h5 className="text-[11px] font-semibold text-stone-100">1 · Hàm kích hoạt (9 hàm)</h5>
          <span className="text-[9.5px] text-stone-500">menu engine activations.ts · metadata ACTIVATION_MENU (spec-schema §9.2 — cùng nguồn dropdown Editor kiến trúc)</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="border-b border-slate-800 text-stone-500">
                <th className="py-1.5 pr-2 text-left font-medium">Tên</th>
                <th className="py-1.5 pr-2 text-left font-medium">Công thức</th>
                <th className="py-1.5 pr-2 text-left font-medium">Đạo hàm φ′(z)</th>
                <th className="py-1.5 pr-2 text-left font-medium">Init</th>
                <th className="py-1.5 text-left font-medium">Ghi chú</th>
              </tr>
            </thead>
            <tbody>
              {ACTIVATION_MENU.map(m => (
                <tr
                  key={m.name}
                  className={`border-b border-slate-900/80 ${m.name === 'softmax' ? 'bg-amber-500/10' : 'hover:bg-slate-950/40'}`}
                  title={m.where === 'output-multiclass' ? 'softmax CHỈ hợp lệ lớp output đa lớp (audit B1)' : undefined}
                >
                  <td className="py-1.5 pr-2 font-mono text-amber-300">{m.name}</td>
                  <td className="py-1.5 pr-2 font-mono text-stone-200">{m.formula}</td>
                  <td className="py-1.5 pr-2 font-mono text-stone-300">{m.derivative}</td>
                  <td className="py-1.5 pr-2 text-stone-400">{m.init}</td>
                  <td className="py-1.5 text-stone-400">{m.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[9.5px] text-stone-500">
          α/β (leakyRelu/elu/swish) chỉnh ở phần trên — Editor kiến trúc; mặc định α 0.01 (leakyRelu) / 1.0 (elu), β 1.0 (swish).
        </p>
      </section>

      {/* ── 2 · Hàm mất mát (4) ── */}
      <section className="space-y-1.5" aria-label="Hàm mất mát">
        <div className="flex flex-wrap items-center gap-1.5">
          <h5 className="text-[11px] font-semibold text-stone-100">2 · Hàm mất mát (4 hàm)</h5>
          <span className="text-[9.5px] text-stone-500">engine losses.ts (LOSSES menu) · đạo hàm là ∂L/∂ŷ — cặp gộp sigmoid+BCE / softmax+CE cho δ thẳng</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="border-b border-slate-800 text-stone-500">
                <th className="py-1.5 pr-2 text-left font-medium">Tên</th>
                <th className="py-1.5 pr-2 text-left font-medium">Công thức</th>
                <th className="py-1.5 pr-2 text-left font-medium">Đạo hàm</th>
                <th className="py-1.5 text-left font-medium">Nơi dùng</th>
              </tr>
            </thead>
            <tbody>
              {LOSS_REFERENCE.map(l => (
                <tr key={l.name} className="border-b border-slate-900/80 hover:bg-slate-950/40">
                  <td className="py-1.5 pr-2 font-mono text-amber-300">{l.name}</td>
                  <td className="py-1.5 pr-2 font-mono text-stone-200">{l.formula}</td>
                  <td className="py-1.5 pr-2 font-mono text-stone-300">{l.deriv}</td>
                  <td className="py-1.5 text-stone-400">{l.where}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[9.5px] text-stone-500">
          Loss từng đầu khóa theo hợp đồng pipeline (§9.1-2) — chỉ Brain-B 2 head hồi quy đổi huber⇄mse + δ.
        </p>
      </section>

      {/* ── 3 · Hàm thưởng (composite reward) ── */}
      <section className="space-y-1.5" aria-label="Hàm thưởng">
        <div className="flex flex-wrap items-center gap-1.5">
          <h5 className="text-[11px] font-semibold text-stone-100">3 · Hàm thưởng (composite reward)</h5>
          <span className="text-[9.5px] text-stone-500">blueprint §3.1 · BRAIN-P4</span>
        </div>
        <div className="rounded border bg-slate-950/60 p-2 font-mono text-[10px] text-stone-200">
          R = w₁·Outcome* + w₂·Efficiency* + w₃·Quality*
        </div>
        <ul className="space-y-0.5 text-[10px] text-stone-400">
          <li>• Mỗi thành phần (Outcome/Efficiency/Quality) được <span className="text-stone-200">chuẩn hoá trước</span> khi nhân trọng số (blueprint §3.1).</li>
          <li>• w₁ w₂ w₃ chỉnh ở <span className="text-stone-200">Training Console nhóm C</span> — LOG-ONLY: chỉ ghi nhận để quan sát, KHÔNG đổi quyết định runtime (updateQ giữ ±1).</li>
          <li>• Nguồn giá trị hiệu lực: STORE › ENV › DEFAULT = 1/3.</li>
        </ul>
      </section>

      {/* ── 4 · Lan truyền tiến ── */}
      <section className="space-y-1.5" aria-label="Lan truyền tiến">
        <div className="flex flex-wrap items-center gap-1.5">
          <h5 className="text-[11px] font-semibold text-stone-100">4 · Lan truyền tiến</h5>
          <span className="text-[9.5px] text-stone-500">mlp.ts forward — điểm sáng thật của các lớp xem ở Đài quan sát (section 2)</span>
        </div>
        <div className="space-y-1 rounded border bg-slate-950/60 p-2 font-mono text-[10px] text-stone-200">
          <p>aˡ = φ(Wˡ·aˡ⁻¹ + bˡ)</p>
          <p className="text-stone-400">a⁰ = one-hot cấu hình (Brain-B) · features chuẩn hoá (Brain-A) · task-features (Brain-C)</p>
          <p className="text-stone-400">φ mỗi lớp chọn ở bảng 1 (lớp ẩn — dropdown Editor kiến trúc; lớp input/output khóa theo hợp đồng §9.1-2)</p>
        </div>
      </section>

      {/* ── 5 · Lan truyền ngược + tối ưu ── */}
      <section className="space-y-1.5" aria-label="Lan truyền ngược và tối ưu">
        <div className="flex flex-wrap items-center gap-1.5">
          <h5 className="text-[11px] font-semibold text-stone-100">5 · Lan truyền ngược + tối ưu</h5>
          <span className="text-[9.5px] text-stone-500">mlp.ts backward + optimizers.ts — hằng số khóa engine, hiển thị trung thực</span>
        </div>
        <div className="space-y-1 rounded border bg-slate-950/60 p-2 font-mono text-[10px] text-stone-200">
          <p>δᴸ = ∇L ⊙ φ′(zᴸ)</p>
          <p>δˡ = (Wˡ⁺¹)ᵀ·δˡ⁺¹ ⊙ φ′(zˡ)</p>
          <p>∇Wˡ = δˡ·(aˡ⁻¹)ᵀ + λ₂·Wˡ (L2)</p>
          <p>g ← g · min(1, clip/‖g‖₂) (grad-clip toàn cục — chỉnh nhóm A)</p>
          <p>{`SGD: v = β·v − lr·g ; p += v (β=${SGD_MOMENTUM} khóa)`}</p>
          <p>{`Adam: m̂/(√v̂+ε) (β₁=${ADAM_BETA1}, β₂=${ADAM_BETA2}, ε=${ADAM_EPSILON.toExponential(0)} khóa)`}</p>
        </div>
        <p className="text-[9.5px] text-stone-500">
          mini-batch shuffle Fisher–Yates tất định theo seed · early-stop patience epoch trên hold-out · lr/epochs/batch/l2/patience/hold-out/clip/seed chỉnh ở Training Console nhóm A.
        </p>
      </section>

      {/* ── Footer — đâu là THAM CHIẾU, đâu là CHỈNH ĐƯỢC ── */}
      <p className="rounded border border-amber-500/30 bg-amber-950/20 p-2 text-[9.5px] leading-relaxed text-stone-400">
        Đủ/thiếu gì: bảng này là THAM CHIẾU — mọi thứ chỉnh được nằm ở Training Console (hyper + loss + reward)
        và Editor kiến trúc (lớp/nơ-ron/activation/α/β). Xem điểm sáng lan truyền thật ở Đài quan sát.
      </p>
    </div>
  )
}
