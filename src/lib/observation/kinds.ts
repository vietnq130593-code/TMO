/**
 * OBS-P1 (BLUEPRINT-OBSERVATION-P1-P4 §C.2 — chốt §7 Task 23 2026-10-13)
 * ==========================================================================
 *
 * SINGLE-SOURCE danh sách kind sự kiện quan sát — khai báo TỪ v0.1 thống nhất
 * với BLUEPRINT-HYPERNAS §9 (kind search.*) để 2 blueprint triển khai độc
 * lập nhưng không phải đổi tên sau (doctrine #9).
 *
 * Kind là enum chuỗi MỞ (bảng ObservationEvent.kind String) — danh sách này
 * là nguồn tham chiếu cho: ledger ghi · timeline API filter (response.kinds)
 * · UI chip màu + filter bar. Thêm kind = thêm 1 dòng OBS_KINDS (không đổi
 * schema); kind NGOÀI danh sách vẫn ghi/hiển thị được (UI rơi về nhóm 'db'
 * màu trung tính — fail-open).
 */

/** Nhóm kind — quyết định màu chip UI + nhóm filter bar (OBS-P3 C.5-2). */
export type ObsKindGroup =
  | 'run' // vòng đời run agent: run.start | run.end | run.heart (Task 33 — nhịp sống pha EXECUTE)
  | 'db' // ghi bảng học: db.write | qentry.add | verdict.add | learn.episode
  | 'brain' // não: brain.train | brain.infer-ref
  | 'tuning' // tham số & cờ: tuning.change | flag.flip
  | 'reward' // reward.log (log-only — GAP-4)
  | 'search' // HyperNAS HN-P2+ (tương lai — §9 HyperNAS): search.session | search.candidate | proposal.apply
  | 'impact' // OBS-P4: impact.estimate | obs.health
  | 'alert' // Task 26-BE (GAP-2): obs.alert — cảnh báo chủ động stall/token-burn/job-stale

export interface ObsKindDef {
  kind: string
  group: ObsKindGroup
  /** Nhãn tiếng Việt hiển thị chip/filter UI */
  label: string
}

/** Danh sách kind chuẩn (single-source — timeline API trả nguyên cho UI). */
export const OBS_KINDS: readonly ObsKindDef[] = [
  { kind: 'run.start', group: 'run', label: 'Run bắt đầu' },
  { kind: 'run.end', group: 'run', label: 'Run kết thúc' },
  // Task 33 (§0b lượt 2): nhịp sống run trong pha EXECUTE (tool calls) —
  // paced 2 phút/run từ recordAgentRunTool; nuôi rule stall D1.1 khỏi mù.
  { kind: 'run.heart', group: 'run', label: 'Run nhịp sống' },
  // OBS-V3 H8 (BLUEPRINT-OBSERVATION-V3 §C.1 — R34): chat fast-path ĐÃ phát
  // thật từ openclaw/chat/route.ts (R26) nhưng chưa đăng ký — chip rơi nhóm
  // 'db' trung tính. Đăng ký về nhóm 'run' đúng bản chất (vòng đời phản hồi).
  { kind: 'chat.fastpath', group: 'run', label: 'Chat fast-path' },
  { kind: 'db.write', group: 'db', label: 'Ghi DB' },
  { kind: 'qentry.add', group: 'db', label: 'QEntry' },
  { kind: 'verdict.add', group: 'db', label: 'Phán quyết' },
  { kind: 'learn.episode', group: 'db', label: 'Học episode/lesson' },
  // OBS-V3 H2 (R34): lượt KB consult (KbConsultLog D1) — Brain-D + confidence
  // calibrate của Brain-A trên đường KB; queryHash thay nội dung (RO-V3-2).
  { kind: 'kb.consult', group: 'db', label: 'KB consult' },
  // OBS-V3 H5 (R34): sweep escalation tạo SelfDirectionProposal từ pattern
  // lỗi lặp ≥3 (instrumentation-node.ts) — trước giờ chỉ thấy qua UI duyệt.
  { kind: 'learn.escalate', group: 'db', label: 'Escalate bài học' },
  { kind: 'brain.train', group: 'brain', label: 'Brain train' },
  { kind: 'brain.infer-ref', group: 'brain', label: 'Não suy diễn' },
  // OBS-V3 H1 (BLUEPRINT-OBSERVATION-V3 §C.1 — R34): vòng đời EvalRun —
  // sinh nhãn huấn luyện cho Brain-A/D; refusal-rate 100% (R33: 36/36) là
  // tín hiệu chẩn đoán "não không thể thức tỉnh" quan trọng nhất.
  { kind: 'eval.run', group: 'brain', label: 'Eval run' },
  { kind: 'tuning.change', group: 'tuning', label: 'Đổi tham số' },
  { kind: 'flag.flip', group: 'tuning', label: 'Bật/tắt cờ' },
  // R5 (2026-10-14): đồng bộ danh sách model free opencode/zen — mọi lần sync
  // (thêm/bớt/không đổi/thất bại) vào Đài quan sát để thay đổi catalog KHÔNG
  // thể âm thầm (bài học R4: giao thức quan sát phải THẤY cả nguồn cung cấp).
  { kind: 'model.sync', group: 'tuning', label: 'Đồng bộ model free' },
  // OBS-V3 H7 (R34): provider/model fail (toàn chuỗi xoay key NIM hoặc Zen
  // HTTP+CLI) — tiền lệ Zen 403 FreeTierError phát hiện THỦ CÔNG ở R32; từ
  // giờ mọi fail cấp nguồn LLM thành sự kiện (throttle 10'/lỗi).
  { kind: 'model.failover', group: 'tuning', label: 'Failover provider' },
  { kind: 'reward.log', group: 'reward', label: 'Reward (log-only)' },
  // search.* — reserved HyperNAS §9 (chưa có call-site — HN-P2 xếp hàng kế tiếp)
  { kind: 'search.session', group: 'search', label: 'Search session' },
  { kind: 'search.candidate', group: 'search', label: 'Search candidate' },
  { kind: 'proposal.apply', group: 'search', label: 'Áp dụng đề xuất' },
  { kind: 'impact.estimate', group: 'impact', label: 'Ước lượng tác động' },
  { kind: 'obs.health', group: 'impact', label: 'Sức khỏe ledger' },
  // Task 26-BE (GAP-2) — cảnh báo chủ động từ job nền (GIAO_THUC_GIAM_SAT
  // D1.1/D1.4 + HyperNAS §4.2-2b) — phát bởi alerts.ts; badge đếm qua field
  // alerts24h của /api/observation/timeline
  { kind: 'obs.alert', group: 'alert', label: 'Cảnh báo quan sát' },
  // OBS-V3 H6 (R34): Layer 9 chỉ thị TẠM DỪNG mở rộng phạm vi (lỗi lặp ≥3 cách
  // trong session) — trước giờ chỉ SSE omega_escalation, mất theo reload.
  { kind: 'adapt.escalate', group: 'alert', label: 'Thích ứng dừng mở rộng' },
  // §7.10 (2026-10-21) + S6-code — 2 kind memory của MemWatchdog (instrumentation):
  // mem.soft_tier phát từ EXECUTION-EFFICIENCY S6 (đã phát từ trước nhưng thiếu
  // dòng khai báo — fail-open nhóm 'db' trung tính); mem.boot_grace MỚI cho
  // boot-grace HARD-RSS (spike cold-compile được tha). Nhóm 'impact' — tín hiệu
  // sức khỏe process, không phải cảnh báo cần action.
  { kind: 'mem.soft_tier', group: 'impact', label: 'Mem soft-tier' },
  { kind: 'mem.boot_grace', group: 'impact', label: 'Mem boot-grace' },
  // KPI #2 (BLUEPRINT-R17BC §6 — trả nợ 2026-10-21): snapshot p95 interactive
  // tx (ledger + trace) mỗi 1000 write từ drain ledger — tích lũy dài hạn sống
  // sót restart; ops tức thời qua /api/observation/interactive-tx.
  { kind: 'kpi.tx', group: 'impact', label: 'KPI interactive tx' },
]

const KIND_BY_NAME = new Map<string, ObsKindDef>(OBS_KINDS.map(k => [k.kind, k]))

/** Tra def theo kind — kind lạ trả null (caller tự fail-open nhóm/màu mặc định). */
export function obsKindDef(kind: string): ObsKindDef | null {
  return KIND_BY_NAME.get(kind) ?? null
}

/**
 * Màu chip theo nhóm — token Tailwind tĩnh (map const, KHÔNG ghép chuỗi
 * động — an toàn class-scan; bảng màu app: teal/amber/violet/rose/orange/
 * cyan/stone).
 */
export const OBS_GROUP_CLASSES: Record<ObsKindGroup, string> = {
  run: 'bg-teal-500/15 text-teal-300 border-teal-500/30',
  db: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  brain: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  tuning: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  reward: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  search: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
  impact: 'bg-stone-500/15 text-stone-300 border-stone-500/30',
  // Task 26-BE — cảnh báo quan sát (hợp đồng 26-RESTORE: group class amber)
  alert: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
}

/** Actor 'agent:tên' | 'user' | 'system' | 'brain:key' | 'search' → badge màu. */
export function obsActorClass(actor: string): string {
  if (actor.startsWith('agent:')) return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
  if (actor.startsWith('brain:')) return 'bg-violet-500/15 text-violet-300 border-violet-500/30'
  if (actor === 'user') return 'bg-sky-500/15 text-sky-300 border-sky-500/30'
  if (actor === 'search') return 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30'
  return 'bg-stone-500/15 text-stone-300 border-stone-500/30' // system + lạ
}
