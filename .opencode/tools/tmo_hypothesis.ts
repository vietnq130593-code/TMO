import { tool } from "@opencode-ai/plugin"
import { callTmoTool } from "./_tmo-common"

// TASK 21 (2026-10-21) — SHR structured hypothesis bridge (SELF_REFLECTION_DESIGN §2).
// op=propose: sinh hypothesis về CƠ CHẾ hệ thống (MỘT quan hệ nhân quả ≤12 từ).
// op=judge: phán quyết confirmed/refuted kèm bằng chứng tool — hệ thống TMO
// đối chiếu bằng chứng THẬT cuối chu kỳ rồi mới cập nhật α/β (λ-grounded).
// op=list: xem hypothesis sống của session.
export default tool({
  description:
    "Structured hypothesis repository (SHR) — hypothesis về cơ chế hệ thống sống xuyên chu kỳ. " +
    "propose: ghi hypothesis mới (mechanicsClaim = MỘT quan hệ nhân quả ≤12 từ, predictedDelta = dự đoán kiểm định được). " +
    "judge: ghi phán quyết confirmed/refuted kèm evidenceTool + evidenceQuote (trích từ kết quả tool thật) — hệ thống verify cuối chu kỳ. " +
    "list: liệt kê hypothesis sống. Promote ≥0.80 → belief-state chu kỳ sau.",
  args: {
    op: tool.schema.string().describe("propose | judge | list"),
    mechanicsClaim: tool.schema.string().describe("[propose] MỘT quan hệ nhân quả ≤12 từ (vd: 'prisma db push tạo bảng mới trong sqlite')"),
    contextSig: tool.schema.string().describe("[propose] từ khóa ngữ cảnh, space-joined (vd: 'prisma sqlite schema')"),
    intervention: tool.schema.string().describe("[propose] hành động do(X) (vd: 'sửa schema rồi chạy db push')"),
    predictedDelta: tool.schema.string().describe("[propose] hệ quả dự kiến kiểm định được (vd: 'bảng mới xuất hiện khi query sqlite_master')"),
    sourceCycle: tool.schema.number().describe("[propose] chu kỳ hiện tại (optional)"),
    hypothesisId: tool.schema.string().describe("[judge] id hypothesis (từ propose/list)"),
    verdict: tool.schema.string().describe("[judge] confirmed | refuted"),
    evidenceTool: tool.schema.string().describe("[judge] tên tool đã chạy thành công cho bằng chứng (vd: shell)"),
    evidenceQuote: tool.schema.string().describe("[judge] trích đoạn ngắn từ KẾT QUẢ tool đó"),
    status: tool.schema.string().describe("[list] lọc status: candidate|promoted|demoted|parrot_suspect (optional)"),
  },
  async execute(args) {
    const clean: Record<string, unknown> = { op: args.op }
    for (const k of [
      "mechanicsClaim", "contextSig", "intervention", "predictedDelta",
      "hypothesisId", "verdict", "evidenceTool", "evidenceQuote", "status",
    ] as const) {
      if (args[k] !== undefined && args[k] !== "") clean[k] = args[k]
    }
    if (typeof args.sourceCycle === "number") clean.sourceCycle = args.sourceCycle
    return callTmoTool("hypothesis_write", clean)
  },
})
