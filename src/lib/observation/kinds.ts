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
  | 'run' // vòng đời run agent: run.start | run.end
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
  { kind: 'db.write', group: 'db', label: 'Ghi DB' },
  { kind: 'qentry.add', group: 'db', label: 'QEntry' },
  { kind: 'verdict.add', group: 'db', label: 'Phán quyết' },
  { kind: 'learn.episode', group: 'db', label: 'Học episode/lesson' },
  { kind: 'brain.train', group: 'brain', label: 'Brain train' },
  { kind: 'brain.infer-ref', group: 'brain', label: 'Não suy diễn' },
  { kind: 'tuning.change', group: 'tuning', label: 'Đổi tham số' },
  { kind: 'flag.flip', group: 'tuning', label: 'Bật/tắt cờ' },
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
