/**
 * ROUND-120 TESTS — 31-g · PILL TRẠNG THÁI AGENT 5 MỨC (Hội thoại Smolab)
 * (docs/AGENT-STATUS-DISPLAY-STANDARD.md — audit 31-c: chuẩn sống oldest
 * unimplemented; task 31-g triển khai)
 *
 * Pattern: PURE mapToAgentStatus (import trực tiếp từ src/lib/agent-status.ts)
 * + SOURCE-SCAN pin wiring (r73/r97 precedent — không render thật).
 *
 * Đo lường:
 *   A. Pure map — đủ 5 trạng thái theo doc §1 (ACTIVE/IDLE/BUSY/ERROR/OFFLINE)
 *      + thứ tự ưu tiên (OFFLINE/ERROR chặn > BUSY > trục kết nối) + thoát
 *      ERROR khi gửi tin nhắn mới + biên OFFLINE (ngưỡng grace 10' = cửa sổ
 *      idle-shutdown gateway on-demand) + chống false-positive (gateway tắt
 *      hợp pháp khi run không qua gateway).
 *   B. Dữ liệu hiển thị verbatim theo doc §2/§3/§4 (nhãn tiếng Việt Title Case,
 *      nhãn rút gọn, tooltip, bảng màu hex, icon khác nhau từng trạng thái).
 *   C. Wiring: pill render cạnh tên agent trong header Hội thoại + nguồn dữ
 *      liệu thật (runs phiên hiện tại, isLoading, gateway status + last-seen)
 *      + a11y (role="status", tabindex, aria-live, touch target, reduced-motion).
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  mapToAgentStatus,
  AGENT_STATUS_LABELS,
  AGENT_STATUS_SHORT_LABELS,
  AGENT_STATUS_TOOLTIPS,
  AGENT_STATUS_VISUALS,
  AGENT_OFFLINE_GRACE_MS,
  AGENT_SEEN_SLACK_MS,
  type AgentRunStatusLite,
} from '@/lib/agent-status'

const readSrc = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')
const pillSrc = readSrc('src/components/smolab/agent-status-pill.tsx')
const smolabSrc = readSrc('src/components/smolab/smolab-module.tsx')

// Mốc thời gian cố định (epoch ms) — mọi thời điểm khác suy ra tương đối.
const NOW = 1_700_000_000_000
const MIN = 60 * 1000

const run = (status: AgentRunStatusLite['status'], startedAt: number, endedAt?: number): AgentRunStatusLite =>
  ({ status, startedAt, endedAt })

// ==================== A. Pure map — 5 trạng thái + ưu tiên + biên ====================

describe('r120 · A — mapToAgentStatus pure (doc §1)', () => {
  test('A1 mặc định mở màn hình: chưa từng kết nối, không run → IDLE', () => {
    // doc §1 IDLE: "Đây là trạng thái mặc định khi mở màn hình"
    expect(mapToAgentStatus({ runs: [], chatInFlight: false, gatewayOnline: false, lastSeenOnline: null, now: NOW })).toBe('IDLE')
  })

  test('A2 kết nối sống + không có run → ACTIVE', () => {
    expect(mapToAgentStatus({ runs: [], chatInFlight: false, gatewayOnline: true, lastSeenOnline: NOW - MIN, now: NOW })).toBe('ACTIVE')
  })

  test('A3 run đang chạy (fresh run) → BUSY — kể cả khi gateway online; chatInFlight (vừa gửi, run chưa lên server) cũng BUSY', () => {
    // doc §1 BUSY: "tồn tại run có status running. BUSY là trạng thái có tính
    // thời gian, ghi đè ACTIVE/IDLE"
    expect(mapToAgentStatus({
      runs: [run('running', NOW - 30 * 1000)], chatInFlight: false,
      gatewayOnline: true, lastSeenOnline: NOW - 10 * 1000, now: NOW,
    })).toBe('BUSY')
    // User vừa bấm Gửi — run chưa kịp đăng ký server-side → vẫn phải BUSY ngay
    expect(mapToAgentStatus({
      runs: [], chatInFlight: true,
      gatewayOnline: true, lastSeenOnline: NOW - 10 * 1000, now: NOW,
    })).toBe('BUSY')
  })

  test('A4 run gần nhất lỗi → ERROR; run mới thành công sau đó → ERROR tắt (ACTIVE)', () => {
    // doc §1 ERROR: "run gần nhất kết thúc với lỗi VÀ chưa có run mới thành công"
    const errored = mapToAgentStatus({
      runs: [run('error', NOW - 5 * MIN, NOW - 4 * MIN)], chatInFlight: false,
      gatewayOnline: true, lastSeenOnline: NOW - MIN, now: NOW,
    })
    expect(errored).toBe('ERROR')
    // Run DONE mới hơn run lỗi → "đã có run mới thành công" → trở lại ACTIVE
    const recovered = mapToAgentStatus({
      runs: [run('error', NOW - 5 * MIN, NOW - 4 * MIN), run('done', NOW - 3 * MIN, NOW - 2 * MIN)],
      chatInFlight: false, gatewayOnline: true, lastSeenOnline: NOW - MIN, now: NOW,
    })
    expect(recovered).toBe('ACTIVE')
  })

  test('A5 ERROR thoát khi người dùng gửi tin nhắn mới → BUSY (doc: "Hết trạng thái này khi người dùng gửi tin nhắn mới")', () => {
    expect(mapToAgentStatus({
      runs: [run('error', NOW - 5 * MIN, NOW - 4 * MIN)], chatInFlight: true,
      gatewayOnline: true, lastSeenOnline: NOW - MIN, now: NOW,
    })).toBe('BUSY')
  })

  test('A6 ERROR là trạng thái chặn — ghi đè BUSY (run cũ hơn vẫn running nhưng run gần nhất lỗi)', () => {
    // doc §1: "OFFLINE và ERROR là trạng thái chặn, ghi đè BUSY"
    expect(mapToAgentStatus({
      runs: [run('running', NOW - 8 * MIN), run('error', NOW - 2 * MIN, NOW - 1 * MIN)],
      chatInFlight: false, gatewayOnline: true, lastSeenOnline: NOW - 30 * 1000, now: NOW,
    })).toBe('ERROR')
  })

  test('A7 mất kết nối ngoài ý muốn → OFFLINE (ghi đè cả ERROR lẫn BUSY)', () => {
    // Gateway từng sống trong/dấu hoạt động gần nhất + phiên còn nóng (<10')
    // nhưng giờ mất heartbeat → OFFLINE. Ưu tiên cao nhất theo doc §1.
    const withError = mapToAgentStatus({
      runs: [run('error', NOW - 2 * MIN, NOW - 1 * MIN)], chatInFlight: false,
      gatewayOnline: false, lastSeenOnline: NOW - 30 * 1000, now: NOW,
    })
    expect(withError).toBe('OFFLINE')
    const withRunning = mapToAgentStatus({
      runs: [run('running', NOW - 2 * MIN)], chatInFlight: false,
      gatewayOnline: false, lastSeenOnline: NOW - 30 * 1000, now: NOW,
    })
    expect(withRunning).toBe('OFFLINE')
  })

  test('A8 biên OFFLINE: hoạt động cuối đúng 10\' (cửa sổ idle-shutdown) → đóng sạch theo thiết kế → IDLE; 10\'−1ms → OFFLINE', () => {
    // Ngưỡng = AGENT_OFFLINE_GRACE_MS (idle-shutdown 10' của gateway on-demand)
    expect(AGENT_OFFLINE_GRACE_MS).toBe(10 * 60 * 1000)
    const atGrace = mapToAgentStatus({
      runs: [run('done', NOW - 15 * MIN, NOW - AGENT_OFFLINE_GRACE_MS)], chatInFlight: false,
      gatewayOnline: false, lastSeenOnline: NOW - 30 * 1000, now: NOW,
    })
    expect(atGrace).toBe('IDLE') // đúng ngưỡng → không còn "phiên nóng" → IDLE
    const justInside = mapToAgentStatus({
      runs: [run('done', NOW - 15 * MIN, NOW - AGENT_OFFLINE_GRACE_MS + 1)], chatInFlight: false,
      gatewayOnline: false, lastSeenOnline: NOW - 30 * 1000, now: NOW,
    })
    expect(justInside).toBe('OFFLINE') // lệch 1ms trong ngưỡng → OFFLINE
  })

  test('A9 chưa từng thấy online (lastSeenOnline null) → gateway tắt là on-demand bình thường → IDLE, kể cả khi phiên vừa có run', () => {
    // doc §1 IDLE: "chưa từng kết nối" — chat agent provider riêng không qua gateway
    expect(mapToAgentStatus({
      runs: [run('done', NOW - 2 * MIN, NOW - 1 * MIN)], chatInFlight: false,
      gatewayOnline: false, lastSeenOnline: null, now: NOW,
    })).toBe('IDLE')
  })

  test('A10 đang chờ phản hồi (chatInFlight) → gateway vắng mặt là spawn on-demand hợp pháp → BUSY, không OFFLINE', () => {
    expect(mapToAgentStatus({
      runs: [run('done', NOW - 2 * MIN, NOW - 1 * MIN)], chatInFlight: true,
      gatewayOnline: false, lastSeenOnline: NOW - MIN, now: NOW,
    })).toBe('BUSY')
  })

  test('A11 chống false-positive: gateway thấy online TRƯỚC hoạt động gần nhất của phiên (run không qua gateway) → tắt gateway là idle-shutdown → IDLE', () => {
    // lastSeenOnline (T-20\') < hoạt động cuối (T-2\') − dung sai → gateway
    // không sống trong/dấu run này → mất tích là đóng sạch theo thiết kế.
    expect(AGENT_SEEN_SLACK_MS).toBe(30 * 1000)
    expect(mapToAgentStatus({
      runs: [run('done', NOW - 3 * MIN, NOW - 2 * MIN)], chatInFlight: false,
      gatewayOnline: false, lastSeenOnline: NOW - 20 * MIN, now: NOW,
    })).toBe('IDLE')
  })

  test('A12 run bị hủy (user chủ động dừng) không phải lỗi → rơi về trục kết nối; latest theo startedAt quyết định ERROR', () => {
    expect(mapToAgentStatus({
      runs: [run('cancelled', NOW - 2 * MIN, NOW - 1 * MIN)], chatInFlight: false,
      gatewayOnline: true, lastSeenOnline: NOW - MIN, now: NOW,
    })).toBe('ACTIVE')
    // Run lỗi CŨ hơn run done mới hơn → latest là done → không ERROR
    expect(mapToAgentStatus({
      runs: [run('done', NOW - 2 * MIN, NOW - 90 * 1000), run('error', NOW - 5 * MIN, NOW - 4 * MIN)],
      chatInFlight: false, gatewayOnline: false, lastSeenOnline: null, now: NOW,
    })).toBe('IDLE')
  })
})

// ==================== B. Dữ liệu hiển thị verbatim theo doc §2/§3/§4 ====================

describe('r120 · B — nhãn/tooltip/màu verbatim (doc §2, §3, §4)', () => {
  test('B1 nhãn tiếng Việt Title Case đầy đủ + nhãn rút gọn (header hẹp) đúng từng trạng thái', () => {
    // doc §3: "Nhãn chữ tiếng Việt, Title Case dạng 'Đang hoạt động', 'Đang
    // rảnh', 'Đang bận', 'Lỗi', 'Ngoại tuyến'. Khi header quá hẹp... rút nhãn
    // còn trạng thái ngắn ('Hoạt động', 'Rảnh', 'Bận', 'Lỗi', 'Ngoại tuyến')."
    expect(AGENT_STATUS_LABELS).toEqual({
      ACTIVE: 'Đang hoạt động', IDLE: 'Đang rảnh', BUSY: 'Đang bận', ERROR: 'Lỗi', OFFLINE: 'Ngoại tuyến',
    })
    expect(AGENT_STATUS_SHORT_LABELS).toEqual({
      ACTIVE: 'Hoạt động', IDLE: 'Rảnh', BUSY: 'Bận', ERROR: 'Lỗi', OFFLINE: 'Ngoại tuyến',
    })
  })

  test('B2 tooltip chuẩn từng trạng thái (doc §4) — verbatim', () => {
    expect(AGENT_STATUS_TOOLTIPS.ACTIVE).toBe('Agent đang kết nối và sẵn sàng phản hồi.')
    expect(AGENT_STATUS_TOOLTIPS.IDLE).toBe('Agent đang kết nối và chờ yêu cầu mới.')
    expect(AGENT_STATUS_TOOLTIPS.BUSY).toBe('Agent đang xử lý yêu cầu, phản hồi có thể bị chậm.')
    expect(AGENT_STATUS_TOOLTIPS.ERROR).toBe('Lần xử lý gần nhất gặp lỗi. Gửi tin nhắn mới để thử lại.')
    expect(AGENT_STATUS_TOOLTIPS.OFFLINE).toBe('Không liên lạc được với agent. Kiểm tra mạng hoặc khởi động lại agent.')
  })

  test('B3 bảng màu hex verbatim (doc §2) + icon khác nhau từng trạng thái (màu không phải tín hiệu duy nhất)', () => {
    expect(AGENT_STATUS_VISUALS.ACTIVE).toEqual({ text: '#15803D', bg: '#DCFCE7', border: '#22C55E', icon: 'check-circle-filled' })
    expect(AGENT_STATUS_VISUALS.IDLE).toEqual({ text: '#475569', bg: '#F1F5F9', border: '#94A3B8', icon: 'circle-hollow' })
    expect(AGENT_STATUS_VISUALS.BUSY).toEqual({ text: '#92400E', bg: '#FEF3C7', border: '#F59E0B', icon: 'spinner' })
    expect(AGENT_STATUS_VISUALS.ERROR).toEqual({ text: '#991B1B', bg: '#FEE2E2', border: '#EF4444', icon: 'warning-triangle' })
    expect(AGENT_STATUS_VISUALS.OFFLINE).toEqual({ text: '#374151', bg: '#E5E7EB', border: '#6B7280', icon: 'circle-slash' })
    // 5 icon khác nhau — người mù màu vẫn đọc được (doc §3)
    expect(new Set(Object.values(AGENT_STATUS_VISUALS).map(v => v.icon)).size).toBe(5)
  })
})

// ==================== C. Wiring header Hội thoại + a11y (source-scan) ====================

describe('r120 · C — wiring smolab-module + a11y pill (source-scan)', () => {
  test('C1 header Hội thoại render pill cạnh tên agent (sau span tên, ml-2 = 8px) + nguồn dữ liệu thật', () => {
    // Import + render
    expect(smolabSrc).toContain("import { AgentStatusPill } from '@/components/smolab/agent-status-pill'")
    expect(smolabSrc).toContain("import { mapToAgentStatus } from '@/lib/agent-status'")
    expect(smolabSrc).toMatch(/<span className="text-sm font-semibold text-stone-100">[\s\S]{0,700}?<\/span>\s*\{\/\* 31-g[\s\S]{0,400}?<AgentStatusPill/)
    expect(smolabSrc).toMatch(/<AgentStatusPill\s+status=\{agentHeaderStatus\}\s+agentName=\{agentHeaderName\}/)
    expect(smolabSrc).toContain('className="ml-2"')
    // Dữ liệu thật: runs phiên hiện tại + isLoading + gateway + last-seen
    expect(smolabSrc).toMatch(/mapToAgentStatus\(\{\s*runs: Object\.values\(agentRuns\),\s*chatInFlight: isLoading,\s*gatewayOnline,\s*lastSeenOnline,/)
    // Heartbeat 'online' được ghi dấu trong poll /api/openclaw/status
    expect(smolabSrc).toMatch(/if \(data\.status === 'online'\) setLastSeenOnline\(Date\.now\(\)\)/)
  })

  test('C2 trạng thái chặn kèm hành động: OFFLINE → "Thử lại" (poll lại gateway status ngay), ERROR → "Xem lỗi" (cuộn tới lỗi)', () => {
    // doc §3: "Trạng thái chặn (ERROR, OFFLINE) kèm một hành động nhỏ bên phải pill"
    expect(pillSrc).toContain('Thử lại')
    expect(pillSrc).toContain('Xem lỗi')
    expect(smolabSrc).toMatch(/onRetryConnection=\{retryGatewayStatus\}/)
    expect(smolabSrc).toMatch(/onViewError=\{viewLatestAgentError\}/)
    // "Thử lại" poll lại NGAY: effect gateway status re-run theo tick
    expect(smolabSrc).toContain('}, [gatewayStatusTick])')
    // "Xem lỗi" cuộn tới bubble lỗi / panel run lỗi mới nhất (data-mid hook)
    expect(smolabSrc).toContain('data-mid={msg.id}')
    expect(smolabSrc).toMatch(/\[data-mid="\$\{CSS\.escape\(targetId\)\}"\]/)
  })

  test('C3 a11y doc §4/§5: pill focusable role="status" + aria-label đầy đủ; vùng sống aria-live (assertive cho ERROR); tooltip hover 300ms/focus tức thì/Escape', () => {
    expect(pillSrc).toContain('tabIndex={0}')
    expect(pillSrc).toMatch(/role="status"[\s\S]{0,120}aria-label=\{`\$\{label\} — \$\{tooltip\}`\}/)
    expect(pillSrc).toMatch(/aria-live=\{status === 'ERROR' \? 'assertive' : 'polite'\}/)
    expect(pillSrc).toContain('setTimeout(() => setShowTip(true), 300)')
    expect(pillSrc).toMatch(/if \(e\.key === 'Escape'\) closeTip\(\)/)
    // Thông báo SR chỉ phát khi trạng thái đổi (doc §5) — dạng "Trạng thái agent X: …"
    expect(pillSrc).toContain('prev === null || prev === status')
    expect(pillSrc).toContain('`Trạng thái agent ${agentName}: ${label}.${hint}`')
    expect(pillSrc).toMatch(/' Dùng nút Thử lại để kết nối lại\.'/)
    // Màu hex doc §2 đến từ bảng AGENT_STATUS_VISUALS (không hard-code rời)
    expect(pillSrc).toContain('AGENT_STATUS_VISUALS[status]')
  })

  test('C4 hình dạng + phản hồi giảm chuyển động: pill 22px (doc §3), BUSY xoay motion-reduce, nhãn rút gọn mobile, touch target ≥44px', () => {
    expect(pillSrc).toContain('h-[22px]')
    // Doc §3 "pill bo tròn": app globals.css ép border-radius:0 !important toàn
    // cục (angular design system) → cần Tailwind important `rounded-full!`
    // (class 0,1,0 thắng universal 0,0,0) — pill là ngoại lệ bo tròn có chủ đích.
    expect(pillSrc).toContain("const shapeCls = 'rounded-full!'")
    expect(pillSrc).toContain('whitespace-nowrap')
    expect(pillSrc).toMatch(/animate-spin motion-reduce:animate-none/)
    expect(pillSrc).toMatch(/<span className="sm:hidden">\{AGENT_STATUS_SHORT_LABELS\[status\]\}<\/span>/)
    // Vùng chạm mở rộng pseudo âm (hiển thị 22px nhưng hit-area 44px)
    expect(pillSrc).toContain('before:-inset-y-[11px]')
  })
})
