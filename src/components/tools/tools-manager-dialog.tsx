'use client'

/**
 * Tools Manager Dialog — Task 21-c
 *
 * Dialog quản lý TOÀN DIỆN Tools & Skills (user request: "tôi muốn có thể bấm
 * vào từng tools/skills xem và chỉnh sửa nội dung, chọn các agents nào có thể
 * sử dụng được tools nào..."):
 *   - Tab Tools:   click 1 tool → xem mô tả đầy đủ (SỬA ĐƯỢC → ToolConfig
 *                  override vào prompt LLM), parameters JSON (read-only),
 *                  origin + runtime-audit badge (import từ docs/TOOLS_AUDIT.md),
 *                  ma trận 7 agent × 3 trạng thái (default/override-on/override-off)
 *                  → POST /api/tools/assignments (enforce prompt + executor).
 *   - Tab Skills:  67 FS skills + 3 DB skills → click xem nội dung SKILL.md;
 *                  FS skills SỬA ĐƯỢC (PUT /api/openclaw/skills/fs — backup .bak);
 *                  DB skills giữ flow cũ (read-only tại đây).
 *                  2026-09-01: ma trận "Agents — skills access" (9 agent × 3 trạng
 *                  thái) → POST /api/skills/assignments (enforce read_skill
 *                  hard-gate + list_skills ẩn + không inject prompt); nội dung
 *                  skill scroll trong khung (field-sizing fixed + max-height).
 *
 * Component TỰ CHỨA: tự fetch /api/tools/registry + /api/tools/assignments +
 * audit JSON (src/lib/tools-audit-results.json) → page.tsx chỉ 1 import + 1 mount.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import {
  Settings, Wrench, Search, Loader2, X, Check, RotateCcw, Save,
  BookOpen, FileText, ShieldAlert, AlertTriangle,
} from 'lucide-react'
import { authedFetch } from '@/lib/api-auth'
import auditResultsJson from '@/lib/tools-audit-results.json'

// ==================== TYPES ====================

interface RegistryBuiltinTool {
  name: string
  description: string
  category: string
  paramNames: string[]
  agents: Array<{ name: string; short: string }>
  agentCount: number
}
interface RegistryFsSkill { slug: string; hasSkillMd: boolean; description: string }
interface RegistryDbSkill { slug: string; name: string; source: string; enabled: boolean; version: string }
interface RegistryData {
  summary: { builtinToolCount: number; customToolCount: number; filesystemSkillCount: number; dbSkillCount: number }
  builtinTools: RegistryBuiltinTool[]
  filesystemSkills: RegistryFsSkill[]
  dbSkills: RegistryDbSkill[]
}

interface AssignmentRow { agentKey: string; toolName: string; enabled: boolean; updatedBy: string | null; updatedAt: string }
interface ConfigRow { toolName: string; description: string | null; updatedBy: string | null; updatedAt: string }
interface AssignmentsData {
  ok: boolean
  assignments: AssignmentRow[]
  configs: ConfigRow[]
  defaults: Record<string, string[]>
}

/** 2026-09-01 — Agents - skills access: row SkillAssignment từ /api/skills/assignments */
interface SkillAssignmentRow { agentKey: string; slug: string; enabled: boolean; updatedBy: string | null; updatedAt: string }
interface SkillAssignmentsData {
  ok: boolean
  assignments: SkillAssignmentRow[]
}

interface ToolDetailAgent { agentKey: string; label: string; defaultHas: boolean; override: boolean | null }
interface ToolDetail {
  ok: boolean
  name: string
  defaultDescription: string
  description: string
  hasOverride: boolean
  parameters: Record<string, unknown>
  agents: ToolDetailAgent[]
}

interface SkillContent {
  name: string
  slug: string
  content: string
  size?: number
  source: string
  canEdit?: boolean
  hasBackup?: boolean
}

type AuditStatus = { status: string; origin: string; flag: string | null; errorTag?: string }
const auditResults = auditResultsJson as Record<string, AuditStatus>

/** 9 agent key chuẩn (tool-access.ts) — thứ tự hiển thị ma trận skills access.
 * 2026-09-01: đủ TOÀN BỘ agents hiện có — 8 agent thật (khớp AgentProfile:
 * Omega, ALISTA, Opus + 5 Code Team) + bucket NEW_AGENT cho agents động do
 * Omega create_agent tạo. Ma trận Tools dùng cùng bộ key từ API. */
const SKILL_AGENT_COLUMNS: Array<{ key: string; label: string }> = [
  { key: 'OMEGA', label: 'Omega' },
  { key: 'ALISTA', label: 'ALISTA' },
  { key: 'OPUS', label: 'Opus' },
  { key: 'MEGATRON', label: 'MEGATRON' },
  { key: 'SHOCWAVE', label: 'SHOCWAVE' },
  { key: 'RAMPAGE', label: 'RAMPAGE' },
  { key: 'SENTINEL', label: 'SENTINEL' },
  { key: 'CATALYST', label: 'CATALYST' },
  { key: 'NEW_AGENT', label: 'Agent động' },
]

// ==================== COMPONENT ====================

export function ToolsManagerDialog() {
  const [open, setOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<'tools' | 'skills'>('tools')

  const [registry, setRegistry] = useState<RegistryData | null>(null)
  const [registryLoading, setRegistryLoading] = useState(false)
  const [assignmentsData, setAssignmentsData] = useState<AssignmentsData | null>(null)

  const [toolSearch, setToolSearch] = useState('')
  const [selectedTool, setSelectedTool] = useState<string | null>(null)
  const [toolDetail, setToolDetail] = useState<ToolDetail | null>(null)
  const [toolDetailLoading, setToolDetailLoading] = useState(false)
  /** bump để reload tool detail (sau khi save desc/assignment) mà không đổi selectedTool */
  const [detailReload, setDetailReload] = useState(0)
  const [editDesc, setEditDesc] = useState('')
  const [descDirty, setDescDirty] = useState(false)
  const [savingDesc, setSavingDesc] = useState(false)
  const [assignmentBusy, setAssignmentBusy] = useState<string | null>(null)

  const [skillSearch, setSkillSearch] = useState('')
  const [selectedSkill, setSelectedSkill] = useState<{ slug: string; source: 'fs' | 'db' } | null>(null)
  const [skillContent, setSkillContent] = useState<SkillContent | null>(null)
  const [skillLoading, setSkillLoading] = useState(false)
  /** bump để reload skill content (sau khi lưu) mà không đổi selectedSkill */
  const [skillReload, setSkillReload] = useState(0)
  const [skillDraft, setSkillDraft] = useState('')
  const [skillDirty, setSkillDirty] = useState(false)
  const [skillSaving, setSkillSaving] = useState(false)
  const [confirmSkillSave, setConfirmSkillSave] = useState(false)
  /** 2026-09-01 — Agents - skills access (null = chưa tải → ma trận hiện mặc định) */
  const [skillAssignments, setSkillAssignments] = useState<SkillAssignmentRow[] | null>(null)
  const [skillAssignmentBusy, setSkillAssignmentBusy] = useState<string | null>(null)

  // ── Load registry + assignments khi mở dialog ──
  // (queueMicrotask — tránh sync setState trong effect, pattern page.tsx:2755)
  useEffect(() => {
    if (!open || registry) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setRegistryLoading(true)
      Promise.all([
        authedFetch('/api/tools/registry').then(r => r.ok ? r.json() : null),
        authedFetch('/api/tools/assignments').then(r => r.ok ? r.json() : null),
        authedFetch('/api/skills/assignments').then(r => r.ok ? r.json() : null),
      ]).then(([reg, assign, skillAssign]) => {
        if (cancelled) return
        if (reg && reg.ok) setRegistry(reg as RegistryData)
        if (assign && assign.ok) setAssignmentsData(assign as AssignmentsData)
        // fail-open: skill assignments lỗi → ma trận hiện toàn mặc định (được đọc)
        if (skillAssign && skillAssign.ok) setSkillAssignments((skillAssign as SkillAssignmentsData).assignments)
      }).catch(() => {
        toast.error('Không tải được Tools Registry / Assignments')
      }).finally(() => { if (!cancelled) setRegistryLoading(false) })
    })
    return () => { cancelled = true }
  }, [open, registry])

  const reloadAssignments = useCallback(async () => {
    try {
      const res = await authedFetch('/api/tools/assignments')
      if (res.ok) {
        const data = await res.json()
        if (data.ok) setAssignmentsData(data as AssignmentsData)
      }
    } catch { /* fail-open */ }
  }, [])

  // ── Load tool detail khi chọn 1 tool (queueMicrotask — tránh sync setState) ──
  useEffect(() => {
    if (!selectedTool) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setToolDetailLoading(true)
      authedFetch(`/api/tools/builtin/${encodeURIComponent(selectedTool)}`)
        .then(r => r.ok ? r.json() : null)
        .then((data: ToolDetail | null) => {
          if (cancelled) return
          if (data && data.ok) {
            setToolDetail(data)
            setEditDesc(data.description)
          } else {
            setToolDetail(null)
          }
          setDescDirty(false)
        })
        .catch(() => { if (!cancelled) setToolDetail(null) })
        .finally(() => { if (!cancelled) setToolDetailLoading(false) })
    })
    return () => { cancelled = true }
  }, [selectedTool, detailReload])

  // ── Load skill content khi chọn 1 skill (queueMicrotask — tránh sync setState) ──
  useEffect(() => {
    if (!selectedSkill) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setSkillLoading(true)
      authedFetch(`/api/openclaw/skills?action=content&name=${encodeURIComponent(selectedSkill.slug)}`)
        .then(r => (r.ok ? r.json() : Promise.reject(new Error('404'))))
        .then((data: SkillContent) => {
          if (cancelled) return
          setSkillContent(data)
          setSkillDraft(data.content || '')
          setSkillDirty(false)
        })
        .catch(() => {
          if (cancelled) return
          setSkillContent(null)
          toast.error(`Không đọc được skill "${selectedSkill.slug}"`)
        })
        .finally(() => { if (!cancelled) setSkillLoading(false) })
    })
    return () => { cancelled = true }
  }, [selectedSkill, skillReload])

  // ── Actions ──

  const saveDescription = async (reset: boolean) => {
    if (!selectedTool) return
    setSavingDesc(true)
    try {
      const res = await authedFetch(`/api/tools/builtin/${encodeURIComponent(selectedTool)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reset ? { description: null } : { description: editDesc }),
      })
      const data = await res.json()
      if (res.ok && data.ok) {
        toast.success(data.message || 'Đã lưu mô tả tool')
        setDetailReload(n => n + 1)
      } else {
        toast.error(data.error || 'Lưu mô tả thất bại')
      }
    } catch {
      toast.error('Lưu mô tả thất bại (lỗi mạng)')
    } finally {
      setSavingDesc(false)
    }
  }

  const setAssignment = async (agentKey: string, toolName: string, enabled: boolean | null) => {
    setAssignmentBusy(`${agentKey}::${toolName}`)
    try {
      const res = await authedFetch('/api/tools/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentKey, toolName, enabled }),
      })
      const data = await res.json()
      if (res.ok && data.ok) {
        toast.success(data.message)
        await reloadAssignments()
        setDetailReload(n => n + 1)
      } else {
        toast.error(data.error || 'Cập nhật thất bại')
      }
    } catch {
      toast.error('Cập nhật thất bại (lỗi mạng)')
    } finally {
      setAssignmentBusy(null)
    }
  }

  const saveSkillContent = async () => {
    if (!selectedSkill || !skillContent) return
    setSkillSaving(true)
    try {
      const res = await authedFetch('/api/openclaw/skills/fs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: selectedSkill.slug, content: skillDraft }),
      })
      const data = await res.json()
      if (res.ok && data.ok) {
        toast.success(data.message + (data.backupCreated ? ' — đã backup .bak' : ''))
        setSkillDirty(false)
        setConfirmSkillSave(false)
        setSkillReload(n => n + 1)
      } else {
        toast.error(data.error || 'Lưu skill thất bại')
      }
    } catch {
      toast.error('Lưu skill thất bại (lỗi mạng)')
    } finally {
      setSkillSaving(false)
    }
  }

  /** 2026-09-01 — Gán/chặn/reset quyền đọc 1 skill cho 1 agent */
  const setSkillAssignment = async (agentKey: string, slug: string, enabled: boolean | null) => {
    setSkillAssignmentBusy(`${agentKey}::${slug}`)
    try {
      const res = await authedFetch('/api/skills/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentKey, slug, enabled }),
      })
      const data = await res.json()
      if (res.ok && data.ok) {
        toast.success(data.message)
        // Reload assignments (fail-open — UI tự đúng sau lần mở dialog sau)
        try {
          const r2 = await authedFetch('/api/skills/assignments')
          if (r2.ok) {
            const d2 = await r2.json()
            if (d2.ok) setSkillAssignments(d2.assignments as SkillAssignmentRow[])
          }
        } catch { /* fail-open */ }
      } else {
        toast.error(data.error || 'Cập nhật quyền skill thất bại')
      }
    } catch {
      toast.error('Cập nhật quyền skill thất bại (lỗi mạng)')
    } finally {
      setSkillAssignmentBusy(null)
    }
  }

  // ── Derived data ──

  const assignmentMap = useMemo(() => {
    const map = new Map<string, boolean>()
    if (assignmentsData) {
      for (const a of assignmentsData.assignments) map.set(`${a.agentKey}::${a.toolName}`, a.enabled)
    }
    return map
  }, [assignmentsData])

  const configToolSet = useMemo(() => {
    return new Set((assignmentsData?.configs ?? []).map(c => c.toolName))
  }, [assignmentsData])

  const filteredTools = useMemo(() => {
    if (!registry) return []
    const q = toolSearch.trim().toLowerCase()
    const list = q
      ? registry.builtinTools.filter(t => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
      : registry.builtinTools
    return list
  }, [registry, toolSearch])

  const filteredSkills = useMemo(() => {
    if (!registry) return { fs: [] as RegistryFsSkill[], db: [] as RegistryDbSkill[] }
    const q = skillSearch.trim().toLowerCase()
    const fs = registry.filesystemSkills.filter(s => !q || s.slug.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
    const db = registry.dbSkills.filter(s => !q || s.slug.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
    return { fs, db }
  }, [registry, skillSearch])

  const auditOf = (name: string): AuditStatus | null => auditResults[name] ?? null

  // ── Cell ma trận agent: 3 trạng thái ──
  const renderAgentCell = (agent: ToolDetailAgent) => {
    const override = agent.override
    const effective = override !== null ? override : agent.defaultHas
    const cellBusy = assignmentBusy === `${agent.agentKey}::${toolDetail?.name}`
    const stateClass = override === null
      ? 'border-stone-700/60 bg-stone-900/40'
      : override
        ? 'border-emerald-500/60 bg-emerald-500/10'
        : 'border-red-500/60 bg-red-500/10'
    const stateLabel = override === null
      ? (agent.defaultHas ? 'mặc định ✓' : 'mặc định ✗')
      : override ? 'bật thêm' : 'đã tắt'
    return (
      <div key={agent.agentKey} className={`rounded-md border ${stateClass} p-2 flex flex-col items-center gap-1`}>
        <span className="text-[10px] font-medium text-stone-300 truncate w-full text-center" title={agent.label}>
          {agent.label}
        </span>
        <Switch
          checked={effective}
          disabled={cellBusy}
          onCheckedChange={(checked) => {
            // default → override; override → đổi chiều
            setAssignment(agent.agentKey, toolDetail!.name, checked)
          }}
          className="data-[state=checked]:bg-emerald-600 data-[state=unchecked]:bg-stone-700"
        />
        <span className={`text-[9px] ${override === null ? 'text-stone-500' : override ? 'text-emerald-400' : 'text-red-400'}`}>
          {stateLabel}
        </span>
        {override !== null && (
          <button
            className="text-[9px] text-amber-400 hover:text-amber-300 flex items-center gap-0.5"
            title="Xóa override — reset về mặc định"
            onClick={() => setAssignment(agent.agentKey, toolDetail!.name, null)}
            disabled={cellBusy}
          >
            <RotateCcw className="w-2.5 h-2.5" /> reset
          </button>
        )}
      </div>
    )
  }

  /** 2026-09-01 — Cell ma trận Agents - skills access: 3 trạng thái
   *  (mặc định = MỌI agent đọc được · đỏ = đã chặn · xanh = cấp tường minh) */
  const renderSkillAgentCell = (agentCol: { key: string; label: string }) => {
    const slug = selectedSkill?.slug
    if (!slug) return null
    const row = skillAssignments?.find(a => a.agentKey === agentCol.key && a.slug === slug)
    const override = row ? row.enabled : null
    // Mặc định (không override) = agent ĐỌC ĐƯỢC skill (behavior 2026-09-12)
    const effective = override !== null ? override : true
    const cellBusy = skillAssignmentBusy === `${agentCol.key}::${slug}`
    const stateClass = override === null
      ? 'border-stone-700/60 bg-stone-900/40'
      : override
        ? 'border-emerald-500/60 bg-emerald-500/10'
        : 'border-red-500/60 bg-red-500/10'
    const stateLabel = override === null
      ? 'mặc định ✓'
      : override ? 'đã cấp' : 'đã chặn'
    return (
      <div key={agentCol.key} className={`rounded-md border ${stateClass} p-2 flex flex-col items-center gap-1`}>
        <span className="text-[10px] font-medium text-stone-300 truncate w-full text-center" title={agentCol.label}>
          {agentCol.label}
        </span>
        <Switch
          checked={effective}
          disabled={cellBusy}
          onCheckedChange={(checked) => {
            // mặc định → override chiều checked; override → đổi chiều
            setSkillAssignment(agentCol.key, slug, checked)
          }}
          className="data-[state=checked]:bg-emerald-600 data-[state=unchecked]:bg-stone-700"
        />
        <span className={`text-[9px] ${override === null ? 'text-stone-500' : override ? 'text-emerald-400' : 'text-red-400'}`}>
          {stateLabel}
        </span>
        {override !== null && (
          <button
            className="text-[9px] text-amber-400 hover:text-amber-300 flex items-center gap-0.5"
            title="Xóa override — reset về mặc định (mọi agent đọc được)"
            onClick={() => setSkillAssignment(agentCol.key, slug, null)}
            disabled={cellBusy}
          >
            <RotateCcw className="w-2.5 h-2.5" /> reset
          </button>
        )}
      </div>
    )
  }

  // ==================== RENDER ====================

  return (
    <>
      {/* Trigger — đặt trong header Tools Registry (page.tsx) — stopPropagation
          để không toggle collapse của panel cha */}
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(true) }}
        className="chamfer-sm inline-flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium text-stone-300 bg-stone-800/80 border border-stone-600/60 hover:bg-stone-700 hover:text-white transition-colors"
        title="Quản lý Tools & Skills — xem/sửa nội dung, gán tool cho agents, Omega manage_tools"
      >
        <Settings className="w-3.5 h-3.5 text-amber-400" />
        <span className="hidden sm:inline">Quản lý Tools &amp; Skills</span>
        <span className="sm:hidden">Quản lý</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[100vw] sm:max-w-4xl w-full max-h-[85vh] bg-stone-950 border-stone-700/70 text-stone-200 flex flex-col p-0 gap-0 overflow-hidden [&>button]:text-stone-400">
          <DialogHeader className="px-5 py-4 border-b border-stone-800 shrink-0">
            <DialogTitle className="flex items-center gap-2 text-stone-100">
              <Wrench className="w-5 h-5 text-amber-400" />
              Quản lý Tools &amp; Skills
            </DialogTitle>
            <DialogDescription className="text-stone-400 text-xs">
              Xem + sửa nội dung tool/skill, gán tool cho agents (enforce prompt + executor 2 lớp). Omega có tool <code className="text-amber-300">manage_tools</code> để tự làm việc này qua chat.
            </DialogDescription>
          </DialogHeader>

          {/* Tabs */}
          <div className="flex border-b border-stone-800 shrink-0">
            <button
              className={`flex-1 px-4 py-2.5 text-xs font-semibold transition-colors ${activeTab === 'tools' ? 'text-amber-300 border-b-2 border-amber-400 bg-stone-900/50' : 'text-stone-400 hover:text-stone-200'}`}
              onClick={() => setActiveTab('tools')}
            >
              <Wrench className="w-3.5 h-3.5 inline mr-1.5" />
              Tools {registry ? `(${registry.summary.builtinToolCount})` : ''}
            </button>
            <button
              className={`flex-1 px-4 py-2.5 text-xs font-semibold transition-colors ${activeTab === 'skills' ? 'text-amber-300 border-b-2 border-amber-400 bg-stone-900/50' : 'text-stone-400 hover:text-stone-200'}`}
              onClick={() => setActiveTab('skills')}
            >
              <BookOpen className="w-3.5 h-3.5 inline mr-1.5" />
              Skills {registry ? `(${registry.summary.filesystemSkillCount + registry.summary.dbSkillCount})` : ''}
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-4" style={{ scrollbarWidth: 'thin' }}>
            {registryLoading && !registry ? (
              <div className="flex items-center justify-center gap-2 py-10 text-stone-500 text-sm">
                <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
                <span>Đang tải registry + assignments...</span>
              </div>
            ) : !registry ? (
              <div className="py-10 text-center text-stone-500 text-sm">
                Không tải được Tools Registry. Đóng dialog và thử lại.
              </div>
            ) : activeTab === 'tools' ? (
              /* ══════════ TAB TOOLS ══════════ */
              <div className="space-y-4">
                {/* Bộ lọc */}
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-500" />
                  <Input
                    value={toolSearch}
                    onChange={(e) => setToolSearch(e.target.value)}
                    placeholder="Tìm tool theo tên hoặc mô tả..."
                    className="pl-8 h-8 bg-stone-900/60 border-stone-700 text-stone-200 text-xs"
                  />
                  {toolSearch && (
                    <button className="absolute right-2 top-1/2 -translate-y-1/2 text-stone-500 hover:text-stone-300" onClick={() => setToolSearch('')}>
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
                  {/* Danh sách tools */}
                  <div className="space-y-1 max-h-[52vh] overflow-y-auto pr-1" style={{ scrollbarWidth: 'thin' }}>
                    {filteredTools.map(t => {
                      const audit = auditOf(t.name)
                      const isSelected = selectedTool === t.name
                      const hasOverride = configToolSet.has(t.name)
                      const disabledFor = assignmentsData
                        ? assignmentsData.assignments.filter(a => a.toolName === t.name && !a.enabled).length
                        : 0
                      return (
                        <button
                          key={t.name}
                          onClick={() => setSelectedTool(t.name)}
                          className={`w-full text-left px-2.5 py-2 rounded-md border transition-colors ${isSelected
                            ? 'border-amber-500/70 bg-amber-500/10'
                            : 'border-stone-800 bg-stone-900/40 hover:bg-stone-800/60 hover:border-stone-700'}`}
                        >
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-mono text-stone-200 truncate flex-1">{t.name}</span>
                            {hasOverride && (
                              <span className="text-[9px] text-amber-400" title="Có description override">✎</span>
                            )}
                            {disabledFor > 0 && (
                              <span className="text-[9px] text-red-400" title={`${disabledFor} agent bị tắt tool này`}>
                                <ShieldAlert className="w-3 h-3 inline" />
                              </span>
                            )}
                            {audit && (
                              <span
                                className={`text-[10px] ${audit.status === 'ok' ? 'text-emerald-400' : audit.status === 'fail' ? 'text-red-400' : 'text-stone-500'}`}
                                title={`Runtime audit (21-d): ${audit.status.toUpperCase()}${audit.errorTag ? ' — ' + audit.errorTag : ''}`}
                              >
                                {audit.status === 'ok' ? '✅' : audit.status === 'fail' ? '❌' : '⏭️'}
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-stone-500 truncate mt-0.5">{t.description.split('\n')[0]}</p>
                        </button>
                      )
                    })}
                    {filteredTools.length === 0 && (
                      <p className="text-xs text-stone-500 py-4 text-center">Không tìm thấy tool nào.</p>
                    )}
                  </div>

                  {/* Chi tiết 1 tool */}
                  <div className="min-w-0">
                    {!selectedTool ? (
                      <div className="h-full flex items-center justify-center text-stone-500 text-xs border border-dashed border-stone-800 rounded-lg py-10">
                        ← Chọn 1 tool để xem chi tiết + gán agents
                      </div>
                    ) : toolDetailLoading ? (
                      <div className="flex items-center justify-center gap-2 py-10 text-stone-500 text-sm">
                        <Loader2 className="w-4 h-4 animate-spin text-amber-400" /> Đang tải chi tiết...
                      </div>
                    ) : !toolDetail ? (
                      <div className="py-10 text-center text-stone-500 text-xs">Không tải được chi tiết tool.</div>
                    ) : (
                      <div className="space-y-4">
                        {/* Header + badges */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-sm font-mono font-semibold text-stone-100">{toolDetail.name}</h3>
                          {(() => {
                            const audit = auditOf(toolDetail.name)
                            if (!audit) return null
                            const cls = audit.status === 'ok'
                              ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                              : audit.status === 'fail'
                                ? 'bg-red-500/15 text-red-300 border-red-500/40'
                                : 'bg-stone-700/30 text-stone-400 border-stone-600/50'
                            return (
                              <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${cls}`} title={audit.errorTag || audit.status}>
                                audit: {audit.status === 'ok' ? '✅ OK' : audit.status === 'fail' ? '❌ FAIL' : '⏭️ SKIP'}
                                {audit.flag ? ` · ${audit.flag}` : ''}
                              </Badge>
                            )
                          })()}
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-stone-700/30 text-stone-300 border-stone-600/50">
                            {auditOf(toolDetail.name)?.origin === 'gateway' ? 'openclaw-routed' : 'native'}
                          </Badge>
                          {toolDetail.hasOverride && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-amber-500/15 text-amber-300 border-amber-500/40">
                              ✎ mô tả override
                            </Badge>
                          )}
                        </div>

                        {/* Description (sửa được) */}
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <label className="text-[11px] font-semibold text-stone-300">
                              Mô tả (đưa vào prompt LLM khi agent gọi tool)
                            </label>
                            <span className="text-[10px] text-stone-500">{editDesc.length}/2000</span>
                          </div>
                          <Textarea
                            value={editDesc}
                            onChange={(e) => { setEditDesc(e.target.value); setDescDirty(true) }}
                            rows={4}
                            maxLength={2000}
                            className="bg-stone-900/60 border-stone-700 text-stone-200 text-xs resize-y"
                          />
                          <div className="flex gap-2 mt-2 justify-end">
                            {toolDetail.hasOverride && (
                              <Button size="sm" variant="outline" className="h-7 text-[11px] border-stone-600 text-stone-300 hover:bg-stone-800" onClick={() => saveDescription(true)} disabled={savingDesc}>
                                <RotateCcw className="w-3 h-3 mr-1" /> Reset về mặc định
                              </Button>
                            )}
                            <Button
                              size="sm"
                              className="h-7 text-[11px] bg-emerald-700 hover:bg-emerald-600 text-white"
                              onClick={() => saveDescription(false)}
                              disabled={savingDesc || !descDirty}
                            >
                              {savingDesc ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Save className="w-3 h-3 mr-1" />}
                              Lưu mô tả
                            </Button>
                          </div>
                        </div>

                        {/* Parameters JSON (read-only) */}
                        <div>
                          <label className="text-[11px] font-semibold text-stone-300 block mb-1">
                            Parameters (JSON schema — read-only)
                          </label>
                          <pre className="text-[10px] font-mono bg-stone-900/80 border border-stone-800 rounded-md p-3 overflow-x-auto max-h-40 text-stone-300" style={{ scrollbarWidth: 'thin' }}>
                            {JSON.stringify(toolDetail.parameters, null, 2)}
                          </pre>
                        </div>

                        {/* Ma trận agent 3 trạng thái */}
                        <div>
                          <label className="text-[11px] font-semibold text-stone-300 block mb-2">
                            Agents — tool access (✓/✗ mặc định xám · <span className="text-emerald-400">bật thêm xanh</span> · <span className="text-red-400">đã tắt đỏ</span>)
                          </label>
                          <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 gap-1.5">
                            {toolDetail.agents.map(renderAgentCell)}
                          </div>
                          <p className="text-[10px] text-stone-500 mt-2">
                            Bật/tắt = override (lưu DB, enforce ngay); <span className="text-amber-400">reset</span> = về mặc định code. Tool bị tắt: LLM không thấy trong danh sách + executor chặn thẳng.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              /* ══════════ TAB SKILLS ══════════ */
              <div className="space-y-4">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-500" />
                  <Input
                    value={skillSearch}
                    onChange={(e) => setSkillSearch(e.target.value)}
                    placeholder="Tìm skill theo slug/mô tả..."
                    className="pl-8 h-8 bg-stone-900/60 border-stone-700 text-stone-200 text-xs"
                  />
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
                  {/* Danh sách skills */}
                  <div className="space-y-1 max-h-[52vh] overflow-y-auto pr-1" style={{ scrollbarWidth: 'thin' }}>
                    <p className="text-[10px] uppercase tracking-wider text-stone-500 pt-1 pb-0.5">
                      Filesystem skills — {filteredSkills.fs.length}
                    </p>
                    {filteredSkills.fs.map(s => (
                      <button
                        key={`fs-${s.slug}`}
                        onClick={() => setSelectedSkill({ slug: s.slug, source: 'fs' })}
                        className={`w-full text-left px-2.5 py-2 rounded-md border transition-colors ${selectedSkill?.slug === s.slug && selectedSkill.source === 'fs'
                          ? 'border-amber-500/70 bg-amber-500/10'
                          : 'border-stone-800 bg-stone-900/40 hover:bg-stone-800/60 hover:border-stone-700'}`}
                      >
                        <div className="flex items-center gap-1.5">
                          <FileText className="w-3 h-3 text-stone-500 shrink-0" />
                          <span className="text-xs font-mono text-stone-200 truncate flex-1">{s.slug}</span>
                          {s.hasSkillMd && <span className="text-[9px] text-emerald-500">✓</span>}
                        </div>
                        <p className="text-[10px] text-stone-500 truncate mt-0.5">{s.description}</p>
                      </button>
                    ))}
                    <p className="text-[10px] uppercase tracking-wider text-stone-500 pt-3 pb-0.5">
                      DB skills (SKILL.md Guides) — {filteredSkills.db.length}
                    </p>
                    {filteredSkills.db.map(s => (
                      <button
                        key={`db-${s.slug}`}
                        onClick={() => setSelectedSkill({ slug: s.slug, source: 'db' })}
                        className={`w-full text-left px-2.5 py-2 rounded-md border transition-colors ${selectedSkill?.slug === s.slug && selectedSkill.source === 'db'
                          ? 'border-amber-500/70 bg-amber-500/10'
                          : 'border-stone-800 bg-stone-900/40 hover:bg-stone-800/60 hover:border-stone-700'}`}
                      >
                        <div className="flex items-center gap-1.5">
                          <BookOpen className="w-3 h-3 text-stone-500 shrink-0" />
                          <span className="text-xs font-mono text-stone-200 truncate flex-1">{s.slug}</span>
                          <span className={`text-[9px] ${s.enabled ? 'text-emerald-500' : 'text-stone-600'}`}>{s.enabled ? 'ON' : 'OFF'}</span>
                        </div>
                        <p className="text-[10px] text-stone-500 truncate mt-0.5">{s.name}</p>
                      </button>
                    ))}
                  </div>

                  {/* Nội dung skill */}
                  <div className="min-w-0">
                    {!selectedSkill ? (
                      <div className="h-full flex items-center justify-center text-stone-500 text-xs border border-dashed border-stone-800 rounded-lg py-10">
                        ← Chọn 1 skill để xem nội dung SKILL.md
                      </div>
                    ) : skillLoading ? (
                      <div className="flex items-center justify-center gap-2 py-10 text-stone-500 text-sm">
                        <Loader2 className="w-4 h-4 animate-spin text-amber-400" /> Đang đọc SKILL.md...
                      </div>
                    ) : !skillContent ? (
                      <div className="py-10 text-center text-stone-500 text-xs">Không đọc được skill này.</div>
                    ) : (
                      <div className="space-y-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-sm font-mono font-semibold text-stone-100">{skillContent.slug}</h3>
                          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${skillContent.source === 'filesystem'
                            ? 'bg-stone-700/30 text-stone-300 border-stone-600/50'
                            : 'bg-violet-500/15 text-violet-300 border-violet-500/40'}`}>
                            {skillContent.source === 'filesystem' ? '📁 filesystem' : `💾 DB (${skillContent.source})`}
                          </Badge>
                          {typeof skillContent.size === 'number' && (
                            <span className="text-[10px] text-stone-500">{Math.round(skillContent.size / 1024)}KB</span>
                          )}
                          {skillContent.hasBackup && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-amber-500/15 text-amber-300 border-amber-500/40" title="skills/<slug>/SKILL.md.bak">
                              có backup .bak
                            </Badge>
                          )}
                        </div>

                        {/* 2026-09-01 — Agents - skills access: 9 agent × 3 trạng thái.
                            Mặc định (không override) = MỌI agent đọc được skill qua
                            list_skills/read_skill. Chặn (đỏ) = agent không thấy skill
                            trong list_skills + read_skill bị hard-gate + DB skill
                            không inject vào prompt của agent đó. */}
                        <div>
                          <label className="text-[11px] font-semibold text-stone-300 block mb-2">
                            Agents — skills access (✓ mặc định mọi agent đọc · <span className="text-emerald-400">đã cấp xanh</span> · <span className="text-red-400">đã chặn đỏ</span>)
                          </label>
                          <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 gap-1.5">
                            {SKILL_AGENT_COLUMNS.map(renderSkillAgentCell)}
                          </div>
                          <p className="text-[10px] text-stone-500 mt-2">
                            Chặn = skill ẩn khỏi list_skills + read_skill bị executor chặn + không inject vào prompt agent đó. <span className="text-amber-400">reset</span> = về mặc định (mọi agent đọc được).
                          </p>
                        </div>

                        {skillContent.canEdit ? (
                          <>
                            <div className="flex items-center justify-between mb-1">
                              <label className="text-[11px] font-semibold text-stone-300">
                                Nội dung SKILL.md {skillContent.source === 'filesystem' ? '(sửa được — backup .bak)' : ''}
                              </label>
                              <span className="text-[10px] text-stone-500">{skillDraft.length.toLocaleString('vi-VN')} ký tự</span>
                            </div>
                            <Textarea
                              value={skillDraft}
                              onChange={(e) => { setSkillDraft(e.target.value); setSkillDirty(true) }}
                              rows={18}
                              className="bg-stone-900/60 border-stone-700 text-stone-200 text-xs font-mono resize-y [field-sizing:fixed] max-h-[46vh] overflow-y-auto"
                              placeholder="Nội dung SKILL.md..."
                            />
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-[10px] text-stone-500 flex items-center gap-1">
                                <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" />
                                Sửa file skill gốc trên đĩa — tự backup .bak lần đầu. Agents (Omega) đọc skill này qua read_skill/list_skills.
                              </p>
                              <Button
                                size="sm"
                                className="h-7 text-[11px] bg-emerald-700 hover:bg-emerald-600 text-white shrink-0"
                                onClick={() => setConfirmSkillSave(true)}
                                disabled={skillSaving || !skillDirty}
                              >
                                {skillSaving ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Save className="w-3 h-3 mr-1" />}
                                Lưu SKILL.md
                              </Button>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="flex items-center justify-between mb-1">
                              <label className="text-[11px] font-semibold text-stone-300">Nội dung SKILL.md (DB — read-only)</label>
                              <span className="text-[10px] text-stone-500">{(skillContent.content || '').length.toLocaleString('vi-VN')} ký tự</span>
                            </div>
                            <pre className="text-[11px] font-mono bg-stone-900/80 border border-stone-800 rounded-md p-3 overflow-auto max-h-[46vh] whitespace-pre-wrap text-stone-300" style={{ scrollbarWidth: 'thin' }}>
                              {skillContent.content}
                            </pre>
                            <p className="text-[10px] text-stone-500">
                              DB skill — chỉnh/toggle qua editor sẵn trong panel &quot;SKILL.md Guides&quot; bên dưới (flow cũ).
                            </p>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Confirm dialog ghi đè skill */}
          {confirmSkillSave && selectedSkill && (
            <div className="absolute inset-0 bg-black/70 flex items-center justify-center p-4 z-10">
              <div className="bg-stone-900 border border-stone-700 rounded-lg max-w-md w-full p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5 text-amber-400" />
                  <h4 className="text-sm font-semibold text-stone-100">Xác nhận ghi đè skill gốc</h4>
                </div>
                <p className="text-xs text-stone-400">
                  Bạn sắp ghi đè <code className="text-amber-300">skills/{selectedSkill.slug}/SKILL.md</code>.
                  Hệ thống đã tự tạo backup <code className="text-amber-300">SKILL.md.bak</code> (lần sửa đầu — giữ nguyên nội dung gốc).
                  Hành động này ảnh hưởng đến mọi agent đọc skill này.
                </p>
                <div className="flex gap-2 justify-end">
                  <Button size="sm" variant="ghost" className="text-stone-400 h-8" onClick={() => setConfirmSkillSave(false)} disabled={skillSaving}>
                    Hủy
                  </Button>
                  <Button size="sm" className="h-8 bg-emerald-700 hover:bg-emerald-600 text-white" onClick={saveSkillContent} disabled={skillSaving}>
                    {skillSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Check className="w-3.5 h-3.5 mr-1" />}
                    Xác nhận lưu
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
