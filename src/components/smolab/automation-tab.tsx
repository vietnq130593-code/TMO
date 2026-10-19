'use client'

// ========================================================================
// automation-tab — Tab Automation (Smolab) — cron + task flows
// PERF-SPLIT 2026-09-03: trích xuất nguyên vẹn từ src/app/page.tsx (không đổi logic)
// ========================================================================

import { useState, useCallback, useEffect, useMemo } from 'react'
import { Loader2, RefreshCw, Zap, ChevronDown, ChevronRight, ChevronUp, Play, Shield, Clock, Trash2, ListChecks, Route, Cable, X, Plus, Edit3, Users, CalendarDays, Repeat as RepeatIcon, Timer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/hooks/use-toast'
import { describeSchedule, parseExpressionToSchedule, parseScheduleJson, DOW_LABELS_VI, type CronScheduleConfig } from '@/lib/cron-schedule'


// ==================== AUTOMATION TAB (Phase 5) ====================

export const CRON_PRESETS = [
  { label: 'Mỗi 30 phút', expression: '*/30 * * * *' },
  { label: 'Mỗi giờ', expression: '0 * * * *' },
  { label: 'Mỗi ngày lúc 9:00', expression: '0 9 * * *' },
  { label: 'Mỗi thứ Hai lúc 8:00', expression: '0 8 * * 1' },
  { label: 'Mỗi ngày đầu tháng', expression: '0 0 1 * *' },
]


/** Convert a cron expression to a human-readable Vietnamese description */
export function describeCronExpression(expr: string): string {
  if (expr.startsWith('heartbeat:')) return `Heartbeat mỗi ${expr.replace('heartbeat:', '')}`

  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return expr

  const [min, hour, day, month, dow] = parts

  // Every N minutes
  const everyMinMatch = min.match(/^\*\/(\d+)$/)
  if (everyMinMatch && hour === '*' && day === '*' && month === '*' && dow === '*') {
    return `Mỗi ${everyMinMatch[1]} phút`
  }

  // Every minute
  if (min === '*' && hour === '*' && day === '*' && month === '*' && dow === '*') {
    return 'Mỗi phút'
  }

  // Hourly at specific minute
  if (min !== '*' && hour === '*' && day === '*' && month === '*' && dow === '*') {
    return `Mỗi giờ lúc phút ${min}`
  }

  // Daily at HH:MM
  if (min !== '*' && hour !== '*' && day === '*' && month === '*' && dow === '*') {
    return `Mỗi ngày lúc ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
  }

  // Weekly on specific day at HH:MM
  const dayNames: Record<string, string> = { '0': 'Chủ nhật', '1': 'thứ Hai', '2': 'thứ Ba', '3': 'thứ Tư', '4': 'thứ Năm', '5': 'thứ Sáu', '6': 'thứ Bảy' }
  if (min !== '*' && hour !== '*' && day === '*' && month === '*' && dow !== '*') {
    const dayName = dayNames[dow] || `ngày ${dow}`
    return `Mỗi ${dayName} lúc ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
  }

  // Monthly on specific day at HH:MM
  if (min !== '*' && hour !== '*' && day !== '*' && month === '*' && dow === '*') {
    return `Ngày ${day} hàng tháng lúc ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
  }

  return expr
}


// Kiểu item của Automation tab — tách ra để editingCron/editingWebhook tham chiếu
// (trước đây dùng conditional type `typeof cronJobs extends Array<infer T> | null ? T : never | null`
// → resolve thành T (không có null) → setEditingCron(null) bị TS2345)
export interface CronJobItem {
  id: string; agentId: string; expression: string; taskPrompt: string;
  enabled: boolean; lastRunAt: string | null; nextRunAt: string | null;
  createdAt: string; updatedAt: string;
  // CRON BUILDER (user request 2026-09-14)
  scheduleJson: string | null;   // lịch có cấu trúc {mode, times, daysOfWeek?, daysOfMonth?, repeat}
  executor: string | null;      // '' | agent name | 'team:xxx' (TL điều phối)
  status: string;               // 'active' | 'paused' | 'completed' | 'failed'
}


export interface WebhookItem {
  id: string; agentId: string; url: string; events: string;
  secret: string | null; enabled: boolean; createdAt: string; updatedAt: string;
}


// ==================== TASK FLOW (user request 2026-09-13) ====================
// Quy trình tự động hóa THIẾT KẾ ĐƯỢC (Trigger → Action → Condition → Result)
// — user tinh chỉnh qua designer này, Omega tinh chỉnh qua tool manage_automation.

export interface TaskFlowStepUi {
  id: string
  type: 'trigger' | 'action' | 'condition' | 'result'
  title: string
  config: {
    kind?: string          // trigger: cron|webhook|manual · action: agent_task|webhook
    expression?: string    // trigger cron
    events?: string[]      // trigger webhook
    taskPrompt?: string    // action agent_task
    url?: string           // action webhook
    payload?: string       // action webhook payload
    description?: string   // condition
    resultKind?: string    // result: log|notify
    note?: string          // result note
  }
}


export interface TaskFlowUi {
  id: string; name: string; description: string; steps: TaskFlowStepUi[];
  enabled: boolean; createdBy: string;
  lastRunAt: string | null; nextRunAt: string | null;
  createdAt: string; updatedAt: string;
}


export const FLOW_STEP_META: Record<TaskFlowStepUi['type'], { label: string; hint: string }> = {
  trigger: { label: 'Trigger', hint: 'Cron / Webhook / Manual' },
  action: { label: 'Action', hint: 'LLM task / Webhook POST' },
  condition: { label: 'Condition', hint: 'Cổng logic — đạt mới chạy tiếp' },
  result: { label: 'Result', hint: 'Log / Notify webhooks' },
}


export function newFlowStep(type: TaskFlowStepUi['type']): TaskFlowStepUi {
  const id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
  const base = { id, type, title: FLOW_STEP_META[type].label }
  if (type === 'trigger') return { ...base, config: { kind: 'manual' } }
  if (type === 'action') return { ...base, config: { kind: 'agent_task', taskPrompt: '' } }
  if (type === 'condition') return { ...base, config: { description: '' } }
  return { ...base, config: { resultKind: 'log' } }
}


// ==================== CRON BUILDER HELPERS (user request 2026-09-14) ====================

export const CRON_MODE_META: Record<CronScheduleConfig['mode'], { label: string; icon: typeof CalendarDays }> = {
  day: { label: 'Ngày', icon: CalendarDays },
  week: { label: 'Tuần', icon: CalendarDays },
  month: { label: 'Tháng', icon: CalendarDays },
}


/** Mô tả Lặp theo mode — hint dưới nút Lặp */
export function cronRepeatHint(mode: CronScheduleConfig['mode'], repeat: boolean): string {
  if (mode === 'day') {
    return repeat
      ? 'Lặp BẬT — tác vụ thực hiện lặp lại HÀNG NGÀY vào các giờ đã chọn'
      : 'Lặp TẮT — tác vụ chạy ĐÚNG MỘT LẦN vào giờ đã chọn (lần khớp gần nhất)'
  }
  if (mode === 'week') {
    return repeat
      ? 'Lặp BẬT — cứ đến đúng các ngày + giờ đã chọn là thực hiện tác vụ HÀNG TUẦN'
      : 'Lặp TẮT — chạy đúng một lần vào ngày + giờ khớp kế tiếp'
  }
  return repeat
    ? 'Lặp BẬT — cứ đến đúng các ngày + giờ đã chọn là thực hiện tác vụ HÀNG THÁNG'
    : 'Lặp TẮT — chạy đúng một lần vào ngày + giờ khớp kế tiếp'
}


/** Thứ hiển thị theo T2..CN (index JS getDay()) */
export const DOW_ORDER_UI = [1, 2, 3, 4, 5, 6, 0]


export function AutomationTabContent() {
  // Cron Jobs
  const [cronJobs, setCronJobs] = useState<Array<CronJobItem> | null>(null)
  const [cronLoading, setCronLoading] = useState(false)

  // Cron Editor — CRON BUILDER: nút chọn Ngày/Tuần/Tháng → chọn ngày → chọn
  // giờ+phút (nút Thêm để thêm nhiều giờ) → nút Lặp → chọn Agent/Team thực thi
  const [showCronEditor, setShowCronEditor] = useState(false)
  const [editingCron, setEditingCron] = useState<CronJobItem | null>(null)
  const [cronTaskPrompt, setCronTaskPrompt] = useState('')
  const [cronEnabled, setCronEnabled] = useState(true)
  const [cronSaving, setCronSaving] = useState(false)
  // Lịch có cấu trúc
  const [cronMode, setCronMode] = useState<CronScheduleConfig['mode']>('day')
  const [cronHour, setCronHour] = useState(9)
  const [cronMinute, setCronMinute] = useState(0)
  const [cronTimes, setCronTimes] = useState<string[]>([])
  const [cronDaysOfWeek, setCronDaysOfWeek] = useState<number[]>([])
  const [cronDaysOfMonth, setCronDaysOfMonth] = useState<number[]>([])
  const [cronRepeat, setCronRepeat] = useState(true)
  // Nâng cao: cron expression thô (job legacy / power user)
  const [cronAdvanced, setCronAdvanced] = useState(false)
  const [cronExpression, setCronExpression] = useState('')
  // Executor: '' (Automation Agent mặc định) | agent name | 'team:xxx' (TL điều phối)
  const [cronExecutor, setCronExecutor] = useState('')
  const [cronAgents, setCronAgents] = useState<Array<{ name: string; team: string | null; position: string | null; enabled: boolean; avatar: string | null }> | null>(null)

  // Webhooks
  const [webhooks, setWebhooks] = useState<Array<WebhookItem> | null>(null)
  const [webhookLoading, setWebhookLoading] = useState(false)

  // Webhook Editor
  const [showWebhookEditor, setShowWebhookEditor] = useState(false)
  const [editingWebhook, setEditingWebhook] = useState<WebhookItem | null>(null)
  const [whUrl, setWhUrl] = useState('')
  const [whEvents, setWhEvents] = useState('')
  const [whSecret, setWhSecret] = useState('')
  const [whEnabled, setWhEnabled] = useState(true)
  const [whSaving, setWhSaving] = useState(false)

  // Standing Orders
  const [orders, setOrders] = useState<Array<{
    id: string; agentId: string; order: string; priority: number;
    enabled: boolean; createdAt: string;
  }> | null>(null)
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [newOrder, setNewOrder] = useState('')
  const [newOrderPriority, setNewOrderPriority] = useState(0)

  // Task History
  const [history, setHistory] = useState<Array<{
    id: string; jobId: string | null; type: string; status: string;
    result: string | null; errorMessage: string | null;
    startedAt: string; completedAt: string | null;
  }> | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyFilter, setHistoryFilter] = useState('all')

  // Task Flows (user request 2026-09-13 — thiết kế được, tinh chỉnh được)
  const [flows, setFlows] = useState<TaskFlowUi[] | null>(null)
  const [flowsLoading, setFlowsLoading] = useState(false)
  const [showFlowEditor, setShowFlowEditor] = useState(false)
  const [editingFlow, setEditingFlow] = useState<TaskFlowUi | null>(null)
  const [flowName, setFlowName] = useState('')
  const [flowDescription, setFlowDescription] = useState('')
  const [flowSteps, setFlowSteps] = useState<TaskFlowStepUi[]>([])
  const [flowEnabled, setFlowEnabled] = useState(true)
  const [flowSaving, setFlowSaving] = useState(false)
  const [flowRunning, setFlowRunning] = useState<string | null>(null)

  // Load cron jobs
  const loadCronJobs = useCallback(async () => {
    setCronLoading(true)
    try {
      const res = await fetch('/api/openclaw/automation?type=cron')
      if (res.ok) { const data = await res.json(); setCronJobs(data.jobs || []) }
    } catch (e) { console.error('Failed to load cron jobs:', e) }
    finally { setCronLoading(false) }
  }, [])

  // Load webhooks
  const loadWebhooks = useCallback(async () => {
    setWebhookLoading(true)
    try {
      const res = await fetch('/api/openclaw/automation?type=webhook')
      if (res.ok) { const data = await res.json(); setWebhooks(data.webhooks || []) }
    } catch (e) { console.error('Failed to load webhooks:', e) }
    finally { setWebhookLoading(false) }
  }, [])

  // Load agents cho executor selector (Agent / Team — TL điều phối)
  const loadCronAgents = useCallback(async () => {
    try {
      const res = await fetch('/api/agents?enabled=true')
      if (res.ok) { const data = await res.json(); setCronAgents(data.agents || []) }
    } catch (e) { console.error('Failed to load agents for executor selector:', e) }
  }, [])

  // Load standing orders
  const loadOrders = useCallback(async () => {
    setOrdersLoading(true)
    try {
      const res = await fetch('/api/openclaw/automation/orders')
      if (res.ok) { const data = await res.json(); setOrders(data.orders || []) }
    } catch (e) { console.error('Failed to load orders:', e) }
    finally { setOrdersLoading(false) }
  }, [])

  // Load history
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      const params = new URLSearchParams()
      if (historyFilter !== 'all') params.set('type', historyFilter)
      params.set('limit', '30')
      const res = await fetch(`/api/openclaw/automation/history?${params}`)
      if (res.ok) { const data = await res.json(); setHistory(data.tasks || []) }
    } catch (e) { console.error('Failed to load history:', e) }
    finally { setHistoryLoading(false) }
  }, [historyFilter])

  // Load task flows
  const loadFlows = useCallback(async () => {
    setFlowsLoading(true)
    try {
      const res = await fetch('/api/task-flows')
      if (res.ok) { const data = await res.json(); setFlows(data.flows || []) }
    } catch (e) { console.error('Failed to load task flows:', e) }
    finally { setFlowsLoading(false) }
  }, [])

  // Initial load (only data that doesn't depend on volatile filters)
  // (queueMicrotask: defer để không gọi setState đồng bộ trong body effect)
  // [CRON BUILDER] Heartbeat ĐÃ BỎ (user request 2026-09-14) — cần kiểm tra
  // định kỳ thì tạo Cron Job bằng builder; không load heartbeat nữa.
  useEffect(() => { queueMicrotask(() => { loadCronJobs(); loadWebhooks(); loadCronAgents(); loadOrders(); loadHistory(); loadFlows() }) }, [loadCronJobs, loadWebhooks, loadCronAgents, loadOrders, loadFlows])

  // Reload history when filter changes (separate from main load to avoid re-fetching all data)
  useEffect(() => { queueMicrotask(() => { loadHistory() }) }, [loadHistory])

  // Scheduler auto-poll — triggers cron/task-flow execution every 30s
  useEffect(() => {
    const interval = setInterval(async () => {
      // REQ-AUDIT FIX1 (2026-10-19) — tab ẩn: skip scheduler poll
      if (document.hidden) return
      try {
        const res = await fetch('/api/openclaw/automation/scheduler')
        if (res.ok) {
          const data = await res.json()
          // If any jobs were executed, refresh the data
          if (data.cron?.executed > 0 || data.cron?.failed > 0 || data.taskFlows?.executed > 0) {
            loadCronJobs()
            loadHistory()
            loadFlows()
          }
        }
      } catch { /* silent */ }
    }, 30000) // Poll every 30 seconds
    return () => clearInterval(interval)
  }, [loadCronJobs, loadHistory, loadFlows])

  // ─── Cron Actions ───
  const saveCron = useCallback(async () => {
    if (!cronTaskPrompt.trim()) {
      toast({ title: '❌ Thiếu nhiệm vụ', description: 'Vui lòng nhập nội dung tác vụ cần thực hiện', variant: 'destructive' })
      return
    }

    // Dựng body — builder (lịch có cấu trúc) hoặc nâng cao (expression thô)
    let schedule: CronScheduleConfig | null = null
    if (!cronAdvanced) {
      if (cronTimes.length === 0) {
        toast({ title: '❌ Chưa chọn giờ', description: 'Chọn giờ + phút rồi bấm Thêm để thêm ít nhất 1 giờ thực thi', variant: 'destructive' })
        return
      }
      if (cronMode === 'week' && cronDaysOfWeek.length === 0) {
        toast({ title: '❌ Chưa chọn ngày trong tuần', description: 'Tích ít nhất 1 ngày trong tuần (T2–CN)', variant: 'destructive' })
        return
      }
      if (cronMode === 'month' && cronDaysOfMonth.length === 0) {
        toast({ title: '❌ Chưa chọn ngày trong tháng', description: 'Chọn ít nhất 1 ngày trong tháng (1–31)', variant: 'destructive' })
        return
      }
      schedule = {
        mode: cronMode,
        times: [...cronTimes].sort(),
        ...(cronMode === 'week' ? { daysOfWeek: [...cronDaysOfWeek].sort((a, b) => a - b) } : {}),
        ...(cronMode === 'month' ? { daysOfMonth: [...cronDaysOfMonth].sort((a, b) => a - b) } : {}),
        repeat: cronRepeat,
      }
    } else if (!cronExpression.trim()) {
      toast({ title: '❌ Thiếu cron expression', description: 'Nhập cron expression (vd 0 9 * * 1-5) hoặc dùng trình dựng lịch', variant: 'destructive' })
      return
    }

    setCronSaving(true)
    try {
      const action = editingCron ? 'update-cron' : 'create-cron'
      const body: Record<string, unknown> = {
        action,
        taskPrompt: cronTaskPrompt,
        enabled: cronEnabled,
        executor: cronExecutor,
        ...(schedule ? { schedule } : { expression: cronExpression }),
      }
      if (editingCron) body.id = editingCron.id
      const res = await fetch('/api/openclaw/automation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        toast({ title: editingCron ? '✅ Đã cập nhật' : '✅ Đã tạo', description: 'Cron job đã được lưu' })
        setShowCronEditor(false); setEditingCron(null); setCronTaskPrompt(''); setCronEnabled(true)
        setCronTimes([]); setCronDaysOfWeek([]); setCronDaysOfMonth([]); setCronRepeat(true)
        setCronMode('day'); setCronAdvanced(false); setCronExpression(''); setCronExecutor('')
        setCronHour(9); setCronMinute(0)
        loadCronJobs()
      } else { const d = await res.json(); toast({ title: '❌ Lỗi', description: d.error, variant: 'destructive' }) }
    } catch { toast({ title: '❌ Lỗi', description: 'Không thể lưu cron job', variant: 'destructive' }) }
    finally { setCronSaving(false) }
  }, [editingCron, cronTaskPrompt, cronEnabled, cronExecutor, cronAdvanced, cronExpression, cronTimes, cronDaysOfWeek, cronDaysOfMonth, cronRepeat, cronMode, loadCronJobs])

  const deleteCron = useCallback(async (id: string) => {
    if (!confirm('Xóa cron job này?')) return
    try {
      const res = await fetch('/api/openclaw/automation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete-cron', id }),
      })
      if (res.ok) { toast({ title: '🗑️ Đã xóa', description: 'Cron job đã bị xóa' }); loadCronJobs() }
    } catch { toast({ title: '❌ Lỗi', description: 'Không thể xóa cron job', variant: 'destructive' }) }
  }, [loadCronJobs])

  const toggleCron = useCallback(async (id: string, enabled: boolean) => {
    try {
      const res = await fetch('/api/openclaw/automation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update-cron', id, enabled }),
      })
      if (res.ok) { toast({ title: enabled ? '▶️ Đã bật' : '⏸️ Đã tắt' }); loadCronJobs() }
    } catch { toast({ title: '❌ Lỗi', variant: 'destructive' }) }
  }, [loadCronJobs])

  const runCronNow = useCallback(async (id: string) => {
    try {
      toast({ title: '⏳ Đang chạy task...', description: 'Gọi LLM thực thi cron job' })
      const res = await fetch('/api/openclaw/automation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run-cron', id }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.success) {
          const exec = data.execution || {}
          toast({
            title: '✅ Task hoàn tất',
            description: exec.llmResponse
              ? exec.llmResponse.slice(0, 150) + (exec.llmResponse.length > 150 ? '...' : '')
              : `Thực thi trong ${exec.durationMs || 0}ms`,
          })
        } else {
          toast({ title: '⚠️ Task thất bại', description: data.execution?.error || 'LLM error', variant: 'destructive' })
        }
        loadCronJobs(); loadHistory()
      }
    } catch { toast({ title: '❌ Lỗi', variant: 'destructive' }) }
  }, [loadCronJobs, loadHistory])

  const openCronEditor = useCallback((job?: CronJobItem) => {
    if (job) {
      setEditingCron(job); setCronTaskPrompt(job.taskPrompt); setCronEnabled(job.enabled)
      setCronExecutor(job.executor || '')
      // Ưu tiên lịch có cấu trúc; job legacy → best-effort parse expression
      let parsed: CronScheduleConfig | null = parseScheduleJson(job.scheduleJson)
      if (!parsed) parsed = parseExpressionToSchedule(job.expression)
      if (parsed) {
        setCronAdvanced(false)
        setCronMode(parsed.mode)
        setCronTimes(parsed.times)
        setCronDaysOfWeek(parsed.daysOfWeek ?? [])
        setCronDaysOfMonth(parsed.daysOfMonth ?? [])
        setCronRepeat(parsed.repeat)
        const [h, m] = (parsed.times[0] || '09:00').split(':').map(Number)
        setCronHour(Number.isFinite(h) ? h : 9); setCronMinute(Number.isFinite(m) ? m : 0)
      } else {
        // Expression phức tạp không dựng lại được → chế độ nâng cao
        setCronAdvanced(true); setCronExpression(job.expression)
        setCronMode('day'); setCronTimes([]); setCronDaysOfWeek([]); setCronDaysOfMonth([]); setCronRepeat(true)
      }
    } else {
      setEditingCron(null); setCronTaskPrompt(''); setCronEnabled(true); setCronExecutor('')
      setCronAdvanced(false); setCronExpression('')
      setCronMode('day'); setCronTimes([]); setCronDaysOfWeek([]); setCronDaysOfMonth([]); setCronRepeat(true)
      setCronHour(9); setCronMinute(0)
    }
    setShowCronEditor(true)
  }, [])

  // ─── Webhook Actions ───
  const saveWebhook = useCallback(async () => {
    if (!whUrl.trim()) { toast({ title: '❌ Thiếu URL', variant: 'destructive' }); return }
    setWhSaving(true)
    try {
      const action = editingWebhook ? 'update-webhook' : 'create-webhook'
      const eventsArr = whEvents.split(',').map(e => e.trim()).filter(Boolean)
      const body: Record<string, unknown> = { action, url: whUrl, events: eventsArr, enabled: whEnabled }
      if (whSecret) body.secret = whSecret
      if (editingWebhook) body.id = editingWebhook.id
      const res = await fetch('/api/openclaw/automation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        toast({ title: editingWebhook ? '✅ Đã cập nhật' : '✅ Đã tạo', description: 'Webhook đã được lưu' })
        setShowWebhookEditor(false); setEditingWebhook(null); setWhUrl(''); setWhEvents(''); setWhSecret(''); setWhEnabled(true)
        loadWebhooks()
      } else { const d = await res.json(); toast({ title: '❌ Lỗi', description: d.error, variant: 'destructive' }) }
    } catch { toast({ title: '❌ Lỗi', variant: 'destructive' }) }
    finally { setWhSaving(false) }
  }, [editingWebhook, whUrl, whEvents, whSecret, whEnabled, loadWebhooks])

  const deleteWebhook = useCallback(async (id: string) => {
    if (!confirm('Xóa webhook này?')) return
    try {
      const res = await fetch('/api/openclaw/automation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete-webhook', id }),
      })
      if (res.ok) { toast({ title: '🗑️ Đã xóa' }); loadWebhooks() }
    } catch { toast({ title: '❌ Lỗi', variant: 'destructive' }) }
  }, [loadWebhooks])

  const testWebhook = useCallback(async (id: string) => {
    try {
      toast({ title: '🧪 Đang test webhook...', description: 'Gửi HTTP POST đến webhook URL' })
      const res = await fetch('/api/openclaw/automation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test-webhook', id }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.success) {
          toast({
            title: '✅ Webhook thành công',
            description: `HTTP ${data.dispatch?.httpStatus} — ${data.dispatch?.durationMs || 0}ms`,
          })
        } else {
          toast({
            title: '⚠️ Webhook thất bại',
            description: data.dispatch?.error || `HTTP ${data.dispatch?.httpStatus}`,
            variant: 'destructive',
          })
        }
        loadHistory()
      }
    } catch { toast({ title: '❌ Lỗi', variant: 'destructive' }) }
  }, [loadHistory])

  const openWebhookEditor = useCallback((wh?: NonNullable<typeof webhooks>[number]) => {
    if (wh) {
      setEditingWebhook(wh); setWhUrl(wh.url)
      try { const arr = JSON.parse(wh.events); setWhEvents(Array.isArray(arr) ? arr.join(', ') : wh.events) } catch { setWhEvents(wh.events) }
      setWhSecret(wh.secret || ''); setWhEnabled(wh.enabled)
    } else {
      setEditingWebhook(null); setWhUrl(''); setWhEvents(''); setWhSecret(''); setWhEnabled(true)
    }
    setShowWebhookEditor(true)
  }, [])

  // ─── Task Flow Actions (user request 2026-09-13 — designer + tinh chỉnh) ───
  const openFlowEditor = useCallback((flow?: TaskFlowUi) => {
    if (flow) {
      setEditingFlow(flow); setFlowName(flow.name); setFlowDescription(flow.description || '')
      setFlowSteps(flow.steps.map(s => ({ ...s, config: { ...s.config } }))); setFlowEnabled(flow.enabled)
    } else {
      setEditingFlow(null); setFlowName(''); setFlowDescription('')
      // Flow mới: 1 action mẫu để user bắt đầu ngay (trigger manual ngầm hiểu)
      setFlowSteps([newFlowStep('action')]); setFlowEnabled(true)
    }
    setShowFlowEditor(true)
  }, [])

  const saveFlow = useCallback(async () => {
    if (!flowName.trim()) {
      toast({ title: '❌ Thiếu tên flow', description: 'Đặt tên cho task flow', variant: 'destructive' })
      return
    }
    const hasAction = flowSteps.some(s => s.type === 'action')
    if (!hasAction) {
      toast({ title: '❌ Flow cần ít nhất 1 Action', description: 'Thêm bước Action (LLM task hoặc Webhook POST) để flow làm được việc', variant: 'destructive' })
      return
    }
    setFlowSaving(true)
    try {
      const body = { name: flowName.trim(), description: flowDescription, steps: flowSteps, enabled: flowEnabled }
      const res = editingFlow
        ? await fetch(`/api/task-flows/${editingFlow.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await fetch('/api/task-flows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (res.ok) {
        toast({ title: editingFlow ? '✅ Đã cập nhật flow' : '✅ Đã tạo flow', description: `"${flowName}" — ${flowSteps.length} bước` })
        setShowFlowEditor(false); setEditingFlow(null)
        loadFlows()
      } else {
        const d = await res.json().catch(() => ({ error: 'Lỗi không rõ' }))
        toast({ title: '❌ Lưu flow thất bại', description: d.error, variant: 'destructive' })
      }
    } catch {
      toast({ title: '❌ Lỗi', description: 'Không thể lưu task flow', variant: 'destructive' })
    } finally { setFlowSaving(false) }
  }, [editingFlow, flowName, flowDescription, flowSteps, flowEnabled, loadFlows])

  const deleteFlow = useCallback(async (id: string) => {
    if (!confirm('Xóa task flow này?')) return
    try {
      const res = await fetch(`/api/task-flows/${id}`, { method: 'DELETE' })
      if (res.ok) { toast({ title: '🗑️ Đã xóa flow' }); loadFlows() }
    } catch { toast({ title: '❌ Lỗi', variant: 'destructive' }) }
  }, [loadFlows])

  const toggleFlowEnabled = useCallback(async (id: string, enabled: boolean) => {
    try {
      const res = await fetch(`/api/task-flows/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (res.ok) { toast({ title: enabled ? '▶️ Đã bật flow' : '⏸️ Đã tắt flow' }); loadFlows() }
    } catch { toast({ title: '❌ Lỗi', variant: 'destructive' }) }
  }, [loadFlows])

  const runFlowNow = useCallback(async (id: string) => {
    setFlowRunning(id)
    toast({ title: '⏳ Đang chạy flow...', description: 'Thực thi từng bước qua LLM' })
    try {
      const res = await fetch(`/api/task-flows/${id}`, { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        const r = data.result
        if (r.success) {
          const executed = (r.steps || []).filter((s: { outcome: string }) => s.outcome === 'executed').length
          toast({ title: '✅ Flow hoàn tất', description: `${executed}/${r.steps?.length || 0} bước chạy · ${Math.round((r.durationMs || 0) / 1000)}s` })
        } else if (r.stopReason) {
          toast({ title: '⛔ Flow dừng ở condition', description: r.stopReason })
        } else {
          toast({ title: '⚠️ Flow thất bại', description: r.error || 'Lỗi không rõ', variant: 'destructive' })
        }
        loadFlows(); loadHistory()
      }
    } catch { toast({ title: '❌ Lỗi', description: 'Không chạy được flow', variant: 'destructive' }) }
    finally { setFlowRunning(null) }
  }, [loadFlows, loadHistory])

  /** Sửa 1 bước trong draft editor (immutable update) */
  const patchFlowStep = useCallback((idx: number, patch: Partial<TaskFlowStepUi>) => {
    setFlowSteps(prev => prev.map((s, i) => i === idx ? { ...s, ...patch, config: patch.config ? { ...s.config, ...patch.config } : s.config } : s))
  }, [])

  const moveFlowStep = useCallback((idx: number, dir: -1 | 1) => {
    setFlowSteps(prev => {
      const next = [...prev]
      const target = idx + dir
      if (target < 0 || target >= next.length) return prev
      ;[next[idx], next[target]] = [next[target], next[idx]]
      return next
    })
  }, [])

  const removeFlowStep = useCallback((idx: number) => {
    setFlowSteps(prev => prev.filter((_, i) => i !== idx))
  }, [])

  // ─── Standing Order Actions ───
  const addOrder = useCallback(async () => {
    if (!newOrder.trim()) return
    try {
      const res = await fetch('/api/openclaw/automation/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: newOrder, priority: newOrderPriority }),
      })
      if (res.ok) { toast({ title: '✅ Đã thêm order' }); setNewOrder(''); setNewOrderPriority(0); loadOrders() }
    } catch { toast({ title: '❌ Lỗi', variant: 'destructive' }) }
  }, [newOrder, newOrderPriority, loadOrders])

  const deleteOrder = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/openclaw/automation/orders?id=${id}`, { method: 'DELETE' })
      if (res.ok) { toast({ title: '🗑️ Đã xóa order' }); loadOrders() }
    } catch { toast({ title: '❌ Lỗi', variant: 'destructive' }) }
  }, [loadOrders])

  const toggleOrder = useCallback(async (id: string, enabled: boolean) => {
    try {
      const res = await fetch('/api/openclaw/automation/orders', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, enabled }),
      })
      if (res.ok) { loadOrders() }
    } catch { toast({ title: '❌ Lỗi', variant: 'destructive' }) }
  }, [loadOrders])

  // Format time ago
  const timeAgo = (dateStr: string | null) => {
    if (!dateStr) return '—'
    const diff = Date.now() - new Date(dateStr).getTime()
    if (diff < 60000) return 'vừa xong'
    if (diff < 3600000) return `${Math.floor(diff / 60000)} phút trước`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} giờ trước`
    return `${Math.floor(diff / 86400000)} ngày trước`
  }

  const formatDuration = (start: string, end: string | null) => {
    if (!end) return '—'
    const ms = new Date(end).getTime() - new Date(start).getTime()
    if (ms < 1000) return `${ms}ms`
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
    return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
  }

  // Filter out heartbeat jobs from regular cron display
  const regularCronJobs = cronJobs?.filter(j => !j.expression.startsWith('heartbeat:')) || []

  // CRON BUILDER: thêm giờ đang chọn vào danh sách giờ thực thi (nút Thêm)
  const addCronTime = useCallback(() => {
    const t = `${String(cronHour).padStart(2, '0')}:${String(cronMinute).padStart(2, '0')}`
    setCronTimes(prev => (prev.includes(t) ? prev : [...prev, t].sort()))
  }, [cronHour, cronMinute])

  // Nhãn executor cho list row — team thì kèm tên TL điều phối
  const cronExecutorLabel = (executor: string | null | undefined): string | null => {
    const raw = (executor || '').trim()
    if (!raw) return null
    if (raw.startsWith('team:')) {
      const team = raw.slice('team:'.length)
      const tl = cronAgents?.find(a => a.team === team && a.position === 'TL')
      return `Team ${team}${tl ? ` — ${tl.name} (TL)` : ''}`
    }
    return raw
  }

  // Teams cho executor selector — TL = agent có position 'TL'
  const executorTeamOptions = useMemo(() => {
    const teams = new Map<string, { team: string; tlName: string | null }>()
    for (const a of cronAgents || []) {
      if (!a.team) continue
      const entry = teams.get(a.team) ?? { team: a.team, tlName: null }
      if (a.position === 'TL' && !entry.tlName) entry.tlName = a.name
      teams.set(a.team, entry)
    }
    return [...teams.values()]
  }, [cronAgents])

  return (
    <div className="space-y-4 p-4 max-h-full overflow-y-auto">

      {/* Section 1: Cron Jobs */}
      <div className="nc-wrap nc-orange">
        <div className="nc-panel nc-md nc-border-orange p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Clock className="w-5 h-5 text-orange-400" />
              <h3 className="text-sm font-semibold text-orange-300 uppercase tracking-wider">Cron Jobs</h3>
              {regularCronJobs.length > 0 && (
                <Badge variant="outline" className="text-orange-400 border-orange-500/30">{regularCronJobs.length}</Badge>
              )}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="text-orange-400 border-orange-500/30 hover:bg-orange-500/10" onClick={() => openCronEditor()}>
                <Plus className="w-3.5 h-3.5 mr-1" /> Tạo Cron
              </Button>
              <Button size="sm" variant="outline" className="text-orange-400 border-orange-500/30 hover:bg-orange-500/10" onClick={loadCronJobs} disabled={cronLoading}>
                <RefreshCw className={`w-3.5 h-3.5 ${cronLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>

          {cronLoading && !cronJobs ? (
            <div className="flex items-center justify-center py-8"><Loader2 className="w-6 h-6 text-orange-400 animate-spin" /></div>
          ) : regularCronJobs.length === 0 ? (
            <div className="text-center py-8 text-stone-500 text-xs">Chưa có cron job nào. Nhấn &quot;Tạo Cron&quot; để bắt đầu.</div>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {regularCronJobs.map(job => {
                const sched = parseScheduleJson(job.scheduleJson)
                const schedDesc = sched ? describeSchedule(sched) : describeCronExpression(job.expression)
                const executorLbl = cronExecutorLabel(job.executor)
                const isDone = !job.enabled && job.status === 'completed'
                return (
                  <div key={job.id} className="nc-wrap nc-orange-soft">
                    <div className="nc-panel nc-sm nc-border-orange-soft p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                            {sched && (
                              <Badge className="text-[9px] bg-orange-950/60 text-orange-400 border border-orange-500/25">{CRON_MODE_META[sched.mode].label}</Badge>
                            )}
                            <code className="text-xs text-orange-300 bg-orange-950/50 px-1.5 py-0.5 rounded font-mono">{job.expression}</code>
                            {sched && (
                              <Badge className={`text-[9px] inline-flex items-center gap-0.5 ${sched.repeat ? 'bg-amber-950/50 text-amber-400' : 'bg-slate-800 text-stone-400'}`}>
                                {sched.repeat ? <RepeatIcon className="w-2.5 h-2.5" /> : null}
                                {sched.repeat ? 'Lặp' : 'Một lần'}
                              </Badge>
                            )}
                            {isDone ? (
                              <Badge className="text-[9px] bg-cyan-950/50 text-cyan-400">Hoàn tất</Badge>
                            ) : (
                              <Badge className={`text-[9px] ${job.enabled ? 'bg-emerald-950/50 text-emerald-400' : 'bg-slate-800 text-stone-500'}`}>
                                {job.enabled ? 'Active' : 'Paused'}
                              </Badge>
                            )}
                            {executorLbl && (
                              <Badge className="text-[9px] bg-violet-950/50 text-violet-300 inline-flex items-center gap-0.5">
                                <Users className="w-2.5 h-2.5" /> {executorLbl}
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-stone-300 truncate">{job.taskPrompt}</p>
                          <p className="text-[9px] text-orange-400/70 mt-0.5">— {schedDesc}</p>
                          <div className="flex items-center gap-3 mt-1.5 text-[10px] text-stone-500">
                            <span>Chạy cuối: {timeAgo(job.lastRunAt)}</span>
                            {job.nextRunAt && <span>Tiếp: {new Date(job.nextRunAt).toLocaleString('vi-VN')}</span>}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-stone-400 hover:text-orange-400" onClick={() => runCronNow(job.id)} title="Chạy ngay">
                            <Play className="w-3.5 h-3.5" />
                          </Button>
                          <Switch checked={job.enabled} onCheckedChange={(checked) => toggleCron(job.id, checked)} className="scale-75" />
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-stone-400 hover:text-orange-400" onClick={() => openCronEditor(job)} title="Sửa">
                            <Edit3 className="w-3.5 h-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-stone-400 hover:text-red-400" onClick={() => deleteCron(job.id)} title="Xóa">
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Cron Editor (inline) — CRON BUILDER: Ngày/Tuần/Tháng → giờ+phút
              (nút Thêm) → Lặp → chọn Agent/Team thực thi (user request 2026-09-14) */}
          {showCronEditor && (
            <div className="mt-4 pt-4 border-t border-orange-400/35">
              <h4 className="text-xs font-semibold text-orange-300 mb-3">{editingCron ? '✏️ Sửa Cron Job' : '➕ Tạo Cron Job'}</h4>
              <div className="space-y-3">

                {!cronAdvanced ? (
                  <>
                    {/* Bước 1: Nút chọn kiểu lịch */}
                    <div>
                      <label className="text-[10px] text-stone-400 uppercase tracking-wider mb-1.5 block">Kiểu lịch</label>
                      <div className="flex flex-wrap gap-1.5">
                        {(['day', 'week', 'month'] as const).map(m => (
                          <Button key={m} size="sm" variant={cronMode === m ? 'default' : 'outline'}
                            className={`h-8 text-xs ${cronMode === m ? 'bg-orange-500 text-white' : 'text-orange-400 border-orange-400/35 hover:bg-orange-500/10'}`}
                            onClick={() => setCronMode(m)}>
                            <CalendarDays className="w-3.5 h-3.5 mr-1" /> {CRON_MODE_META[m].label}
                          </Button>
                        ))}
                      </div>
                      <p className="text-[9px] text-stone-500 mt-1">
                        {cronMode === 'day' ? 'Chọn giờ thực thi trong ngày — bật Lặp để chạy hàng ngày' : cronMode === 'week' ? 'Tích các ngày trong tuần, rồi chọn giờ thực thi' : 'Chọn các ngày trong tháng, rồi chọn giờ thực thi'}
                      </p>
                    </div>

                    {/* Bước 2a: Tuần — tích các ngày trong tuần */}
                    {cronMode === 'week' && (
                      <div>
                        <label className="text-[10px] text-stone-400 uppercase tracking-wider mb-1.5 block">Các ngày trong tuần</label>
                        <div className="flex flex-wrap gap-1">
                          {DOW_ORDER_UI.map(d => (
                            <button key={d} type="button" aria-pressed={cronDaysOfWeek.includes(d)}
                              className={`h-8 min-w-[40px] px-1 rounded-md border text-xs font-medium transition-colors ${cronDaysOfWeek.includes(d) ? 'bg-orange-500 text-white border-orange-500' : 'bg-slate-950/60 text-orange-400 border-orange-400/35 hover:bg-orange-500/10'}`}
                              onClick={() => setCronDaysOfWeek(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d])}>
                              {DOW_LABELS_VI[d]}
                            </button>
                          ))}
                        </div>
                        {cronDaysOfWeek.length > 0 && <p className="text-[9px] text-orange-400/70 mt-1">Đã chọn {cronDaysOfWeek.length} ngày trong tuần</p>}
                      </div>
                    )}

                    {/* Bước 2b: Tháng — chọn các ngày trong tháng */}
                    {cronMode === 'month' && (
                      <div>
                        <label className="text-[10px] text-stone-400 uppercase tracking-wider mb-1.5 block">Các ngày trong tháng</label>
                        <div className="grid grid-cols-8 sm:grid-cols-10 gap-1">
                          {Array.from({ length: 31 }, (_, i) => i + 1).map(d => (
                            <button key={d} type="button" aria-pressed={cronDaysOfMonth.includes(d)}
                              className={`h-7 rounded border text-[10px] font-medium transition-colors ${cronDaysOfMonth.includes(d) ? 'bg-orange-500 text-white border-orange-500' : 'bg-slate-950/60 text-orange-400 border-orange-400/30 hover:bg-orange-500/10'}`}
                              onClick={() => setCronDaysOfMonth(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d])}>
                              {d}
                            </button>
                          ))}
                        </div>
                        {cronDaysOfMonth.length > 0 && <p className="text-[9px] text-orange-400/70 mt-1">Đã chọn {cronDaysOfMonth.length} ngày (tháng không đủ ngày 29–31 sẽ tự nhảy tháng kế tiếp)</p>}
                      </div>
                    )}

                    {/* Bước 3: Chọn giờ + phút, nút Thêm để thêm giờ thực thi */}
                    <div>
                      <label className="text-[10px] text-stone-400 uppercase tracking-wider mb-1.5 block">Giờ thực thi</label>
                      <div className="flex items-center gap-2">
                        <Select value={String(cronHour)} onValueChange={v => setCronHour(parseInt(v, 10))}>
                          <SelectTrigger className="h-8 w-[86px] text-xs bg-slate-950/60 border-orange-400/35 text-stone-200" aria-label="Chọn giờ">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="max-h-64">
                            {Array.from({ length: 24 }, (_, h) => (
                              <SelectItem key={h} value={String(h)} className="text-xs">Giờ {String(h).padStart(2, '0')}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <span className="text-stone-500 text-xs">:</span>
                        <Select value={String(cronMinute)} onValueChange={v => setCronMinute(parseInt(v, 10))}>
                          <SelectTrigger className="h-8 w-[94px] text-xs bg-slate-950/60 border-orange-400/35 text-stone-200" aria-label="Chọn phút">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="max-h-64">
                            {Array.from({ length: 60 }, (_, m) => (
                              <SelectItem key={m} value={String(m)} className="text-xs">Phút {String(m).padStart(2, '0')}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button size="sm" className="h-8 bg-gradient-to-r from-orange-500 to-amber-600 hover:from-orange-600 hover:to-amber-700 text-white text-xs" onClick={addCronTime}>
                          <Plus className="w-3.5 h-3.5 mr-1" /> Thêm
                        </Button>
                      </div>
                      {cronTimes.length > 0 ? (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {cronTimes.map(t => (
                            <button key={t} type="button" title="Bấm để bỏ giờ này"
                              className="inline-flex items-center gap-1 h-6 px-2 rounded-full bg-orange-500/15 border border-orange-500/35 text-orange-300 text-[10px] font-mono hover:bg-orange-500/25 transition-colors"
                              onClick={() => setCronTimes(prev => prev.filter(x => x !== t))}>
                              <Timer className="w-3 h-3" /> {t} <X className="w-3 h-3 text-orange-400/60" />
                            </button>
                          ))}
                        </div>
                      ) : (
                        <p className="text-[9px] text-stone-500 mt-1.5">Chưa có giờ nào — chọn giờ + phút rồi bấm Thêm (thêm được nhiều giờ thực thi)</p>
                      )}
                    </div>

                    {/* Bước 4: Nút Lặp bật/tắt */}
                    <div className="flex items-start justify-between gap-3 p-2.5 rounded-lg bg-orange-950/20 border border-orange-500/10">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <RepeatIcon className={`w-4 h-4 ${cronRepeat ? 'text-orange-400' : 'text-stone-500'}`} />
                          <span className="text-xs text-stone-200 font-medium">Lặp</span>
                          <Switch checked={cronRepeat} onCheckedChange={setCronRepeat} className="data-[state=checked]:bg-orange-500" aria-label="Bật/tắt lặp lại" />
                        </div>
                        <p className="text-[9px] text-stone-500 mt-1">{cronRepeatHint(cronMode, cronRepeat)}</p>
                      </div>
                    </div>
                  </>
                ) : (
                  /* Nâng cao — cron expression thô (job legacy / power user) */
                  <div>
                    <label className="text-[10px] text-stone-400 uppercase tracking-wider mb-1 block">Cron Expression (nâng cao)</label>
                    <Input value={cronExpression} onChange={e => setCronExpression(e.target.value)} placeholder="0 9 * * *" className="h-8 text-xs font-mono bg-slate-950/60 border-orange-400/35 text-stone-200" />
                    {cronExpression && <p className="text-[9px] text-orange-400/70 mt-1">{describeCronExpression(cronExpression)}</p>}
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {CRON_PRESETS.map(p => (
                        <Button key={p.expression} size="sm" variant="outline" className="h-6 text-[9px] text-orange-400 border-orange-400/35 hover:bg-orange-500/10" onClick={() => setCronExpression(p.expression)}>
                          {p.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Chọn Agent hoặc Team agents thực thi tác vụ */}
                <div>
                  <label className="text-[10px] text-stone-400 uppercase tracking-wider mb-1.5 block">Agent thực thi tác vụ</label>
                  <Select value={cronExecutor || '__default__'} onValueChange={v => setCronExecutor(v === '__default__' ? '' : v)}>
                    <SelectTrigger className="h-8 text-xs bg-slate-950/60 border-orange-400/35 text-stone-200">
                      <SelectValue placeholder="Chọn agent hoặc team" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default__" className="text-xs">⚙️ Automation Agent (mặc định)</SelectItem>
                      {(cronAgents || []).map(a => (
                        <SelectItem key={a.name} value={a.name} className="text-xs">
                          {a.avatar || '🤖'} {a.name}{a.team ? ` — ${a.position || 'member'} Team ${a.team}` : ' — agent độc lập'}
                        </SelectItem>
                      ))}
                      {executorTeamOptions.map(t => (
                        <SelectItem key={`team:${t.team}`} value={`team:${t.team}`} className="text-xs">
                          👥 Team {t.team}{t.tlName ? ` — ${t.tlName} (TL điều phối)` : ' (chưa có TL)'}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[9px] text-stone-500 mt-1">Chọn 1 agent riêng — hoặc chọn team: TL (Team Leader) của team đó sẽ là agent điều phối triển khai toàn bộ tác vụ</p>
                </div>

                <div>
                  <label className="text-[10px] text-stone-400 uppercase tracking-wider mb-1 block">Task Prompt</label>
                  <textarea value={cronTaskPrompt} onChange={e => setCronTaskPrompt(e.target.value)} placeholder="Tóm tắt tin tức mỗi sáng..." rows={3} className="w-full text-xs bg-slate-950/60 border border-orange-400/35 rounded-md px-3 py-2 text-stone-200 focus:outline-none focus:border-orange-500/40 resize-none" />
                </div>
                <div className="flex items-center gap-3">
                  <label className="text-[10px] text-stone-400 uppercase tracking-wider">Bật ngay</label>
                  <Switch checked={cronEnabled} onCheckedChange={setCronEnabled} className="data-[state=checked]:bg-orange-500" />
                </div>

                <button type="button" className="text-[10px] text-orange-400/70 hover:text-orange-300 underline underline-offset-2"
                  onClick={() => setCronAdvanced(prev => !prev)}>
                  {cronAdvanced ? '← Quay lại trình dựng lịch (Ngày / Tuần / Tháng)' : 'Nâng cao: nhập cron expression thô →'}
                </button>

                <div className="flex gap-2">
                  <Button size="sm" className="bg-gradient-to-r from-orange-500 to-amber-600 hover:from-orange-600 hover:to-amber-700 text-white text-xs" onClick={saveCron} disabled={cronSaving}>
                    {cronSaving ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : null} {editingCron ? 'Cập nhật' : 'Tạo'}
                  </Button>
                  <Button size="sm" variant="outline" className="text-xs text-stone-400 border-stone-600" onClick={() => { setShowCronEditor(false); setEditingCron(null) }}>Hủy</Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Section 2: Webhooks */}
      <div className="nc-wrap nc-orange">
        <div className="nc-panel nc-md nc-border-orange p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Cable className="w-5 h-5 text-orange-400" />
              <h3 className="text-sm font-semibold text-orange-300 uppercase tracking-wider">Webhooks</h3>
              {webhooks && webhooks.length > 0 && (
                <Badge variant="outline" className="text-orange-400 border-orange-500/30">{webhooks.length}</Badge>
              )}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="text-orange-400 border-orange-500/30 hover:bg-orange-500/10" onClick={() => openWebhookEditor()}>
                <Plus className="w-3.5 h-3.5 mr-1" /> Thêm Webhook
              </Button>
              <Button size="sm" variant="outline" className="text-orange-400 border-orange-500/30 hover:bg-orange-500/10" onClick={loadWebhooks} disabled={webhookLoading}>
                <RefreshCw className={`w-3.5 h-3.5 ${webhookLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>

          {webhookLoading && !webhooks ? (
            <div className="flex items-center justify-center py-8"><Loader2 className="w-6 h-6 text-orange-400 animate-spin" /></div>
          ) : !webhooks || webhooks.length === 0 ? (
            <div className="text-center py-8 text-stone-500 text-xs">Chưa có webhook nào.</div>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {webhooks.map(wh => {
                let eventsList: string[] = []
                try { eventsList = JSON.parse(wh.events) } catch { eventsList = [wh.events] }
                return (
                  <div key={wh.id} className="nc-wrap nc-orange-soft">
                    <div className="nc-panel nc-sm nc-border-orange-soft p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-orange-300 font-mono truncate">{wh.url}</p>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {eventsList.map((ev, i) => (
                              <Badge key={i} className="text-[8px] bg-orange-950/50 text-orange-400">{ev}</Badge>
                            ))}
                          </div>
                          <div className="flex items-center gap-2 mt-1.5">
                            <Badge className={`text-[9px] ${wh.enabled ? 'bg-emerald-950/50 text-emerald-400' : 'bg-slate-800 text-stone-500'}`}>
                              {wh.enabled ? 'Active' : 'Inactive'}
                            </Badge>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-stone-400 hover:text-orange-400" onClick={() => testWebhook(wh.id)} title="Test">
                            <Zap className="w-3.5 h-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-stone-400 hover:text-orange-400" onClick={() => openWebhookEditor(wh)} title="Sửa">
                            <Edit3 className="w-3.5 h-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-stone-400 hover:text-red-400" onClick={() => deleteWebhook(wh.id)} title="Xóa">
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Webhook Editor (inline) */}
          {showWebhookEditor && (
            <div className="mt-4 pt-4 border-t border-orange-400/35">
              <h4 className="text-xs font-semibold text-orange-300 mb-3">{editingWebhook ? '✏️ Sửa Webhook' : '➕ Thêm Webhook'}</h4>
              <div className="space-y-3">
                <div>
                  <label className="text-[10px] text-stone-400 uppercase tracking-wider mb-1 block">URL</label>
                  <Input value={whUrl} onChange={e => setWhUrl(e.target.value)} placeholder="https://hooks.slack.com/services/..." className="h-8 text-xs font-mono bg-slate-950/60 border-orange-400/35 text-stone-200" />
                </div>
                <div>
                  <label className="text-[10px] text-stone-400 uppercase tracking-wider mb-1 block">Events (phẩy ngăn cách)</label>
                  <Input value={whEvents} onChange={e => setWhEvents(e.target.value)} placeholder="document.uploaded, query.completed" className="h-8 text-xs bg-slate-950/60 border-orange-400/35 text-stone-200" />
                </div>
                <div>
                  <label className="text-[10px] text-stone-400 uppercase tracking-wider mb-1 block">Secret (tùy chọn)</label>
                  <Input value={whSecret} onChange={e => setWhSecret(e.target.value)} placeholder="whsec_..." type="password" className="h-8 text-xs font-mono bg-slate-950/60 border-orange-400/35 text-stone-200" />
                </div>
                <div className="flex items-center gap-3">
                  <Switch checked={whEnabled} onCheckedChange={setWhEnabled} className="data-[state=checked]:bg-orange-500" />
                  <span className="text-xs text-stone-400">Bật ngay</span>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" className="bg-gradient-to-r from-orange-500 to-amber-600 hover:from-orange-600 hover:to-amber-700 text-white text-xs" onClick={saveWebhook} disabled={whSaving}>
                    {whSaving ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : null} {editingWebhook ? 'Cập nhật' : 'Tạo'}
                  </Button>
                  <Button size="sm" variant="outline" className="text-xs text-stone-400 border-stone-600" onClick={() => { setShowWebhookEditor(false); setEditingWebhook(null) }}>Hủy</Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Section 4: Standing Orders */}
      <div className="nc-wrap nc-orange">
        <div className="nc-panel nc-md nc-border-orange p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-orange-400" />
              <h3 className="text-sm font-semibold text-orange-300 uppercase tracking-wider">Standing Orders</h3>
              {orders && <Badge variant="outline" className="text-orange-400 border-orange-500/30">{orders.length}</Badge>}
            </div>
            <Button size="sm" variant="outline" className="text-orange-400 border-orange-500/30 hover:bg-orange-500/10" onClick={loadOrders} disabled={ordersLoading}>
              <RefreshCw className={`w-3.5 h-3.5 ${ordersLoading ? 'animate-spin' : ''}`} />
            </Button>
          </div>

          {ordersLoading && !orders ? (
            <div className="flex items-center justify-center py-4"><Loader2 className="w-5 h-5 text-orange-400 animate-spin" /></div>
          ) : orders && orders.length > 0 ? (
            <div className="space-y-2 mb-4 max-h-64 overflow-y-auto">
              {orders.map((o, idx) => (
                <div key={o.id} className="flex items-center gap-3 p-2.5 rounded-lg bg-orange-950/20 border border-orange-500/10">
                  <span className="text-xs text-orange-400/60 font-mono w-5 text-right">{idx + 1}</span>
                  <Switch checked={o.enabled} onCheckedChange={(checked) => toggleOrder(o.id, checked)} className="scale-75 data-[state=checked]:bg-orange-500" />
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs truncate ${o.enabled ? 'text-stone-200' : 'text-stone-500 line-through'}`}>{o.order}</p>
                  </div>
                  <Badge className="text-[8px] bg-orange-950/50 text-orange-400">P{o.priority}</Badge>
                  <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-stone-500 hover:text-red-400" onClick={() => deleteOrder(o.id)}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-4 text-stone-500 text-xs mb-4">Chưa có standing order nào.</div>
          )}

          {/* Add new order inline */}
          <div className="flex gap-2">
            <Input value={newOrder} onChange={e => setNewOrder(e.target.value)} placeholder="Thêm standing order mới..." className="h-8 text-xs bg-slate-950/60 border-orange-400/35 text-stone-200 flex-1"
              onKeyDown={e => { if (e.key === 'Enter') addOrder() }} />
            <Input value={newOrderPriority || ''} onChange={e => setNewOrderPriority(parseInt(e.target.value) || 0)} placeholder="P" type="number" min={0} max={100} className="h-8 text-xs bg-slate-950/60 border-orange-400/35 text-stone-200 w-14" />
            <Button size="sm" className="bg-gradient-to-r from-orange-500 to-amber-600 hover:from-orange-600 hover:to-amber-700 text-white text-xs" onClick={addOrder}>
              <Plus className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* Section 5: Task History */}
      <div className="nc-wrap nc-orange">
        <div className="nc-panel nc-md nc-border-orange p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <ListChecks className="w-5 h-5 text-orange-400" />
              <h3 className="text-sm font-semibold text-orange-300 uppercase tracking-wider">Lịch sử thực thi</h3>
              {history && <Badge variant="outline" className="text-orange-400 border-orange-500/30">{history.length}</Badge>}
            </div>
            <div className="flex items-center gap-2">
              <Select value={historyFilter} onValueChange={setHistoryFilter}>
                <SelectTrigger className="h-7 w-28 text-[10px] bg-slate-950/60 border-orange-400/35 text-stone-200">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tất cả</SelectItem>
                  <SelectItem value="cron">Cron</SelectItem>
                  <SelectItem value="webhook">Webhook</SelectItem>
                  <SelectItem value="heartbeat">Heartbeat</SelectItem>
                  <SelectItem value="manual">Manual</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" className="text-orange-400 border-orange-500/30 hover:bg-orange-500/10" onClick={loadHistory} disabled={historyLoading}>
                <RefreshCw className={`w-3.5 h-3.5 ${historyLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>

          {historyLoading && !history ? (
            <div className="flex items-center justify-center py-4"><Loader2 className="w-5 h-5 text-orange-400 animate-spin" /></div>
          ) : !history || history.length === 0 ? (
            <div className="text-center py-4 text-stone-500 text-xs">Chưa có lịch sử thực thi nào.</div>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-orange-500/10">
                    <th className="text-left text-[10px] text-stone-500 uppercase tracking-wider py-2 pr-2">Thời gian</th>
                    <th className="text-left text-[10px] text-stone-500 uppercase tracking-wider py-2 pr-2">Loại</th>
                    <th className="text-left text-[10px] text-stone-500 uppercase tracking-wider py-2 pr-2">Trạng thái</th>
                    <th className="text-left text-[10px] text-stone-500 uppercase tracking-wider py-2 pr-2">Thời lượng</th>
                    <th className="text-left text-[10px] text-stone-500 uppercase tracking-wider py-2">Kết quả</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(task => (
                    <tr key={task.id} className="border-b border-orange-500/5 hover:bg-orange-950/10">
                      <td className="py-2 pr-2 text-stone-400 whitespace-nowrap">{new Date(task.startedAt).toLocaleString('vi-VN')}</td>
                      <td className="py-2 pr-2">
                        <Badge className={`text-[8px] ${task.type === 'cron' ? 'bg-orange-950/50 text-orange-400' : task.type === 'webhook' ? 'bg-blue-950/50 text-blue-400' : task.type === 'heartbeat' ? 'bg-emerald-950/50 text-emerald-400' : 'bg-slate-800 text-stone-400'}`}>
                          {task.type}
                        </Badge>
                      </td>
                      <td className="py-2 pr-2">
                        <Badge className={`text-[8px] ${task.status === 'completed' ? 'bg-emerald-950/50 text-emerald-400' : task.status === 'failed' ? 'bg-red-950/50 text-red-400' : task.status === 'running' ? 'bg-amber-950/50 text-amber-400' : 'bg-slate-800 text-stone-400'}`}>
                          {task.status === 'completed' ? '✅ Done' : task.status === 'failed' ? '❌ Failed' : task.status === 'running' ? '⏳ Running' : '⏸️ Pending'}
                        </Badge>
                      </td>
                      <td className="py-2 pr-2 text-stone-400">{formatDuration(task.startedAt, task.completedAt)}</td>
                      <td className="py-2 text-stone-500 truncate max-w-48">
                        {task.errorMessage ? <span className="text-red-400">{task.errorMessage}</span> : task.result ? (
                          <details><summary className="cursor-pointer hover:text-orange-400">Xem</summary><pre className="mt-1 text-[9px] text-stone-400 whitespace-pre-wrap max-h-24 overflow-y-auto">{task.result}</pre></details>
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Section 6: Task Flow Designer (user request 2026-09-13 — thiết kế + tinh chỉnh được) */}
      <div className="nc-wrap nc-orange">
        <div className="nc-panel nc-md nc-border-orange p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Route className="w-5 h-5 text-orange-400" />
              <h3 className="text-sm font-semibold text-orange-300 uppercase tracking-wider">Task Flow</h3>
              {flows && <Badge variant="outline" className="text-orange-400 border-orange-500/30">{flows.length}</Badge>}
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" className="text-orange-400 border-orange-500/30 hover:bg-orange-500/10" onClick={loadFlows} disabled={flowsLoading}>
                <RefreshCw className={`w-3.5 h-3.5 ${flowsLoading ? 'animate-spin' : ''}`} />
              </Button>
              <Button size="sm" className="bg-gradient-to-r from-orange-500 to-amber-600 hover:from-orange-600 hover:to-amber-700 text-white text-xs" onClick={() => openFlowEditor()}>
                <Plus className="w-3.5 h-3.5 mr-1" /> Thiết kế flow
              </Button>
            </div>
          </div>
          <p className="text-[10px] text-stone-500 mb-4">
            Quy trình tự động hóa nhiều bước: <span className="text-orange-400/80">Trigger</span> → <span className="text-orange-400/80">Action</span> → <span className="text-orange-400/80">Condition</span> → <span className="text-orange-400/80">Result</span>.
            Tinh chỉnh được bởi <span className="text-stone-300">bạn</span> (designer này) và <span className="text-stone-300">Omega</span> (tool manage_automation).
          </p>

          {/* Danh sách flows */}
          {flowsLoading && !flows ? (
            <div className="flex items-center justify-center py-4"><Loader2 className="w-5 h-5 text-orange-400 animate-spin" /></div>
          ) : flows && flows.length > 0 ? (
            <div className="space-y-2 mb-4 max-h-72 overflow-y-auto">
              {flows.map(flow => {
                const trigger = flow.steps.find(s => s.type === 'trigger')
                const triggerLabel = trigger?.config.kind === 'cron' ? `⏰ ${trigger.config.expression}` : trigger?.config.kind === 'webhook' ? `🔗 ${flow.steps[0]?.config.events?.join(', ') || 'webhook'}` : '👆 Manual'
                return (
                  <div key={flow.id} className="p-3 rounded-lg bg-orange-950/20 border border-orange-500/10">
                    <div className="flex items-start gap-3">
                      <Switch checked={flow.enabled} onCheckedChange={(checked) => toggleFlowEnabled(flow.id, checked)} className="scale-75 data-[state=checked]:bg-orange-500 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className={`text-xs font-medium truncate ${flow.enabled ? 'text-stone-200' : 'text-stone-500'}`}>{flow.name}</p>
                          <Badge className="text-[8px] bg-orange-950/50 text-orange-400 border border-orange-400/30">{flow.steps.length} bước</Badge>
                          <Badge className="text-[8px] bg-slate-800 text-stone-400">{triggerLabel}</Badge>
                          {flow.createdBy && flow.createdBy !== 'user' && (
                            <Badge className="text-[8px] bg-violet-950/50 text-violet-400 border border-violet-400/30">{flow.createdBy.startsWith('omega') ? '⚡ Omega' : flow.createdBy.startsWith('self-direction') ? '✅ Duyệt qua Self-direction' : `🤖 ${flow.createdBy}`}</Badge>
                          )}
                        </div>
                        {flow.description && <p className="text-[10px] text-stone-500 mt-0.5 truncate">{flow.description}</p>}
                        {/* Chuỗi bước dạng compact */}
                        <div className="flex items-center gap-1 mt-1.5 overflow-x-auto pb-1">
                          {flow.steps.map((s, i) => (
                            <span key={s.id} className="flex items-center gap-1 flex-shrink-0">
                              {i > 0 && <ChevronRight className="w-3 h-3 text-orange-400/40 flex-shrink-0" />}
                              <span className={`px-1.5 py-0.5 rounded text-[9px] border ${
                                s.type === 'trigger' ? 'bg-amber-950/40 text-amber-400 border-amber-500/20'
                                : s.type === 'action' ? 'bg-orange-950/40 text-orange-400 border-orange-500/20'
                                : s.type === 'condition' ? 'bg-violet-950/40 text-violet-400 border-violet-500/20'
                                : 'bg-emerald-950/40 text-emerald-400 border-emerald-500/20'
                              }`}>{s.title}</span>
                            </span>
                          ))}
                        </div>
                        {(flow.lastRunAt || flow.nextRunAt) && (
                          <p className="text-[9px] text-stone-600 mt-1">
                            {flow.lastRunAt ? `Chạy cuối: ${new Date(flow.lastRunAt).toLocaleString('vi-VN')}` : 'Chưa chạy'}
                            {flow.enabled && flow.nextRunAt ? ` · Kế tiếp: ${new Date(flow.nextRunAt).toLocaleString('vi-VN')}` : ''}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-stone-400 hover:text-emerald-400" onClick={() => runFlowNow(flow.id)} disabled={flowRunning === flow.id} title="Chạy ngay">
                          {flowRunning === flow.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-stone-400 hover:text-orange-400" onClick={() => openFlowEditor(flow)} title="Tinh chỉnh">
                          <Edit3 className="w-3.5 h-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-stone-400 hover:text-red-400" onClick={() => deleteFlow(flow.id)} title="Xóa">
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="text-center py-4 text-stone-500 text-xs mb-4">
              Chưa có task flow nào — bấm <span className="text-orange-400">"Thiết kế flow"</span> để tạo quy trình tự động hóa đầu tiên.
            </div>
          )}

          {/* Flow Designer (inline) */}
          {showFlowEditor && (
            <div className="mt-2 pt-4 border-t border-orange-400/35">
              <h4 className="text-xs font-semibold text-orange-300 mb-3">{editingFlow ? `✏️ Tinh chỉnh "${editingFlow.name}"` : '➕ Thiết kế Task Flow mới'}</h4>
              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] text-stone-400 uppercase tracking-wider mb-1 block">Tên flow</label>
                    <Input value={flowName} onChange={e => setFlowName(e.target.value)} placeholder="vd: Báo cáo sáng hằng ngày" className="h-8 text-xs bg-slate-950/60 border-orange-400/35 text-stone-200" />
                  </div>
                  <div>
                    <label className="text-[10px] text-stone-400 uppercase tracking-wider mb-1 block">Mô tả (tùy chọn)</label>
                    <Input value={flowDescription} onChange={e => setFlowDescription(e.target.value)} placeholder="Flow này làm gì..." className="h-8 text-xs bg-slate-950/60 border-orange-400/35 text-stone-200" />
                  </div>
                </div>

                {/* Các bước */}
                <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                  {flowSteps.map((step, idx) => (
                    <div key={step.id} className="p-2.5 rounded-lg bg-slate-950/60 border border-orange-500/15">
                      <div className="flex items-center gap-2 mb-2">
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold border ${
                          step.type === 'trigger' ? 'bg-amber-950/40 text-amber-400 border-amber-500/30'
                          : step.type === 'action' ? 'bg-orange-950/40 text-orange-400 border-orange-500/30'
                          : step.type === 'condition' ? 'bg-violet-950/40 text-violet-400 border-violet-500/30'
                          : 'bg-emerald-950/40 text-emerald-400 border-emerald-500/30'
                        }`}>{idx + 1}. {FLOW_STEP_META[step.type].label}</span>
                        <Input value={step.title} onChange={e => patchFlowStep(idx, { title: e.target.value })} className="h-6 text-[11px] bg-slate-900/60 border-stone-700 text-stone-200 flex-1" placeholder="Tên bước" />
                        <div className="flex items-center gap-0.5">
                          <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-stone-500 hover:text-orange-400" onClick={() => moveFlowStep(idx, -1)} disabled={idx === 0} title="Lên">
                            <ChevronUp className="w-3 h-3" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-stone-500 hover:text-orange-400" onClick={() => moveFlowStep(idx, 1)} disabled={idx === flowSteps.length - 1} title="Xuống">
                            <ChevronDown className="w-3 h-3" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-stone-500 hover:text-red-400" onClick={() => removeFlowStep(idx)} title="Xóa bước">
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>

                      {/* Config theo loại bước */}
                      {step.type === 'trigger' && (
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          <div>
                            <label className="text-[9px] text-stone-500 mb-1 block">Loại trigger</label>
                            <Select value={step.config.kind || 'manual'} onValueChange={v => patchFlowStep(idx, { config: { kind: v, ...(v === 'cron' && !step.config.expression ? { expression: '0 8 * * *' } : {}) } })}>
                              <SelectTrigger className="h-7 text-[11px] bg-slate-900/60 border-stone-700 text-stone-200"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="manual">👆 Manual (chạy tay)</SelectItem>
                                <SelectItem value="cron">⏰ Cron (theo lịch)</SelectItem>
                                <SelectItem value="webhook">🔗 Webhook event</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          {step.config.kind === 'cron' && (
                            <div className="sm:col-span-2">
                              <label className="text-[9px] text-stone-500 mb-1 block">Cron expression (phút giờ ngày tháng thứ)</label>
                              <Input value={step.config.expression || ''} onChange={e => patchFlowStep(idx, { config: { expression: e.target.value } })} placeholder="0 8 * * * (8h sáng hằng ngày)" className="h-7 text-[11px] font-mono bg-slate-900/60 border-stone-700 text-stone-200" />
                            </div>
                          )}
                          {step.config.kind === 'webhook' && (
                            <div className="sm:col-span-2">
                              <label className="text-[9px] text-stone-500 mb-1 block">Events (phẩy ngăn cách)</label>
                              <Input value={(step.config.events || []).join(', ')} onChange={e => patchFlowStep(idx, { config: { events: e.target.value.split(',').map(s => s.trim()).filter(Boolean) } })} placeholder="document.uploaded, query.completed" className="h-7 text-[11px] bg-slate-900/60 border-stone-700 text-stone-200" />
                            </div>
                          )}
                        </div>
                      )}
                      {step.type === 'action' && (
                        <div className="space-y-2">
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                            <div>
                              <label className="text-[9px] text-stone-500 mb-1 block">Loại action</label>
                              <Select value={step.config.kind || 'agent_task'} onValueChange={v => patchFlowStep(idx, { config: { kind: v } })}>
                                <SelectTrigger className="h-7 text-[11px] bg-slate-900/60 border-stone-700 text-stone-200"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="agent_task">🤖 Agent task (LLM)</SelectItem>
                                  <SelectItem value="webhook">📤 Webhook POST</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          </div>
                          {step.config.kind === 'webhook' ? (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              <div>
                                <label className="text-[9px] text-stone-500 mb-1 block">URL đích (HTTPS công khai)</label>
                                <Input value={step.config.url || ''} onChange={e => patchFlowStep(idx, { config: { url: e.target.value } })} placeholder="https://hooks.slack.com/..." className="h-7 text-[11px] font-mono bg-slate-900/60 border-stone-700 text-stone-200" />
                              </div>
                              <div>
                                <label className="text-[9px] text-stone-500 mb-1 block">Payload JSON (tùy chọn)</label>
                                <Input value={step.config.payload || ''} onChange={e => patchFlowStep(idx, { config: { payload: e.target.value } })} placeholder='{"text": "Báo cáo sẵn sàng"}' className="h-7 text-[11px] font-mono bg-slate-900/60 border-stone-700 text-stone-200" />
                              </div>
                            </div>
                          ) : (
                            <div>
                              <label className="text-[9px] text-stone-500 mb-1 block">Nhiệm vụ (LLM thực thi — thấy kết quả các bước trước)</label>
                              <Textarea value={step.config.taskPrompt || ''} onChange={e => patchFlowStep(idx, { config: { taskPrompt: e.target.value } })} placeholder="vd: Tóm tắt các bản ghi KB mới trong 24h qua thành báo cáo 5 điểm..." className="min-h-[52px] text-[11px] bg-slate-900/60 border-stone-700 text-stone-200" />
                            </div>
                          )}
                        </div>
                      )}
                      {step.type === 'condition' && (
                        <div>
                          <label className="text-[9px] text-stone-500 mb-1 block">Điều kiện chạy tiếp (LLM đánh giá true/false theo kết quả các bước trước — không đạt thì flow dừng)</label>
                          <Textarea value={step.config.description || ''} onChange={e => patchFlowStep(idx, { config: { description: e.target.value } })} placeholder="vd: Báo cáo có ít nhất 3 điểm đáng chú ý mới đáng gửi thông báo" className="min-h-[52px] text-[11px] bg-slate-900/60 border-stone-700 text-stone-200" />
                        </div>
                      )}
                      {step.type === 'result' && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <div>
                            <label className="text-[9px] text-stone-500 mb-1 block">Kiểu kết thúc</label>
                            <Select value={step.config.resultKind || 'log'} onValueChange={v => patchFlowStep(idx, { config: { resultKind: v } })}>
                              <SelectTrigger className="h-7 text-[11px] bg-slate-900/60 border-stone-700 text-stone-200"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="log">📝 Log (ghi tóm tắt)</SelectItem>
                                <SelectItem value="notify">🔔 Notify (POST tới webhooks)</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <label className="text-[9px] text-stone-500 mb-1 block">Ghi chú (tùy chọn)</label>
                            <Input value={step.config.note || ''} onChange={e => patchFlowStep(idx, { config: { note: e.target.value } })} placeholder="Ghi chú hiển thị trong tóm tắt" className="h-7 text-[11px] bg-slate-900/60 border-stone-700 text-stone-200" />
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Thêm bước */}
                <div className="flex flex-wrap gap-1.5">
                  {(Object.keys(FLOW_STEP_META) as TaskFlowStepUi['type'][]).map(t => (
                    <Button key={t} size="sm" variant="outline" className="h-7 text-[10px] text-stone-400 border-stone-600 hover:text-orange-400 hover:border-orange-500/40" onClick={() => setFlowSteps(prev => [...prev, newFlowStep(t)])}>
                      <Plus className="w-3 h-3 mr-1" /> {FLOW_STEP_META[t].label}
                    </Button>
                  ))}
                </div>

                <div className="flex items-center gap-3">
                  <Switch checked={flowEnabled} onCheckedChange={setFlowEnabled} className="data-[state=checked]:bg-orange-500" />
                  <span className="text-xs text-stone-400">Bật ngay (trigger cron sẽ tự chạy theo lịch)</span>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" className="bg-gradient-to-r from-orange-500 to-amber-600 hover:from-orange-600 hover:to-amber-700 text-white text-xs" onClick={saveFlow} disabled={flowSaving}>
                    {flowSaving ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : null} {editingFlow ? 'Cập nhật flow' : 'Tạo flow'}
                  </Button>
                  <Button size="sm" variant="outline" className="text-xs text-stone-400 border-stone-600" onClick={() => { setShowFlowEditor(false); setEditingFlow(null) }}>Hủy</Button>
                </div>
              </div>
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <Badge className="text-[9px] bg-orange-950/50 text-orange-400 border border-orange-400/35">Cron Jobs: {regularCronJobs.length}</Badge>
            <Badge className="text-[9px] bg-blue-950/50 text-blue-400 border border-blue-400/35">Webhooks: {webhooks?.length || 0}</Badge>
            <Badge className="text-[9px] bg-emerald-950/50 text-emerald-400 border border-emerald-400/35">Task Flows: {flows?.length || 0}</Badge>
            <Badge className="text-[9px] bg-amber-950/50 text-amber-400 border border-amber-400/35">Orders: {orders?.length || 0}</Badge>
            <Badge className="text-[9px] bg-slate-800 text-stone-400 border border-stone-600">Executions: {history?.length || 0}</Badge>
          </div>
        </div>
      </div>
    </div>
  )
}

