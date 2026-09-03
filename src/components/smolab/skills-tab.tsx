'use client'

// ========================================================================
// skills-tab — Tab Skills (Smolab) — ToolsManagerDialog
// PERF-SPLIT 2026-09-03: trích xuất nguyên vẹn từ src/app/page.tsx (không đổi logic)
// ========================================================================

import { useState, useCallback, useRef, useEffect } from 'react'
import { Cpu, Loader2, RefreshCw, Check, ChevronDown, ChevronRight, ExternalLink, HardDrive, Globe, FileText, Trash2, Eye, Search, BookOpen, X, Wrench, Plus, Download, Edit3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { toast } from '@/hooks/use-toast'
import { ToolsManagerDialog } from '@/components/tools/tools-manager-dialog'


// ==================== SKILLS & TOOLS TAB (Phase 4) ====================



export function SkillsTabContent() {
  // Installed skills
  const [installedSkills, setInstalledSkills] = useState<Array<{
    id: string; slug: string; name: string; content: string; source: string;
    enabled: boolean; version: string; installedAt: string; updatedAt: string;
  }> | null>(null)
  const [skillsLoading, setSkillsLoading] = useState(false)

  // ClawHub search
  const [clawhubQuery, setClawhubQuery] = useState('')
  const [clawhubResults, setClawhubResults] = useState<Array<{
    slug: string; name: string; version: string; description: string;
    author: string; authorHandle?: string; authorImage?: string;
    downloads: number; installs?: number; stars?: number; score?: number;
    category: string; installed: boolean; source?: string; url?: string;
  }> | null>(null)
  const [clawhubSearching, setClawhubSearching] = useState(false)

  // Skill editor
  const [editingSkill, setEditingSkill] = useState<{
    slug: string; name: string; content: string; source: string;
  } | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editName, setEditName] = useState('')
  const [editSaving, setEditSaving] = useState(false)

  // Custom skill creation
  const [showCreateSkill, setShowCreateSkill] = useState(false)
  const [newSkillSlug, setNewSkillSlug] = useState('')
  const [newSkillName, setNewSkillName] = useState('')
  const [newSkillContent, setNewSkillContent] = useState('')
  const [newSkillCreating, setNewSkillCreating] = useState(false)

  // Skill content dialog
  const [skillDialogOpen, setSkillDialogOpen] = useState(false)
  const [skillDialogContent, setSkillDialogContent] = useState<{
    name: string; slug: string; content: string; version: string;
    source: string; installed: boolean; author?: string; authorHandle?: string;
    description?: string; url?: string;
  } | null>(null)
  const [skillDialogContentLoading, setSkillDialogContentLoading] = useState(false)

  // Collapse/expand panels (user request 2026-08-30): ClawHub Marketplace +
  // SKILL.md Guides + Tools Registry chỉ hiện nội dung khi bấm vào tiêu đề
  const [clawhubOpen, setClawhubOpen] = useState(false)
  const [skillGuidesOpen, setSkillGuidesOpen] = useState(false)
  const [toolsRegistryOpen, setToolsRegistryOpen] = useState(false)

  // Tools Registry — tổng quan TOÀN BỘ skills/tools của app + agents nào dùng được
  // TASK 22 (user directive 2026-09-30 #4): agentMatrix giờ là TOÀN BỘ agents
  // trong DB (Omega, Opus, Code Team, agents do Omega/user tạo thêm) + effective
  // tools TÍNH LIVE mỗi request (profile.tools → standalone/team default →
  // ToolAssignment override) — agent mới / gán tool mới / tắt tool hiện NGAY.
  const [toolsRegistry, setToolsRegistry] = useState<{
    ok: boolean
    generatedAt: string
    summary: {
      builtinToolCount: number; customToolCount: number; filesystemSkillCount: number;
      dbSkillCount: number; agentCount: number; orphanToolCount: number;
    }
    builtinTools: Array<{
      name: string; description: string; category: string; paramNames: string[];
      agents: Array<{ name: string; short: string }>; agentCount: number; totalAgents: number;
      accessibleByAll: boolean;
    }>
    customTools: Array<{
      name: string; description: string; parameters: unknown; version: string;
      source: string; enabled: boolean; callCount: number; skillSlug: string | null;
    }>
    filesystemSkills: Array<{ slug: string; hasSkillMd: boolean; description: string }>
    agentMatrix: Array<{
      name: string; short: string; avatar: string | null; isSystem: boolean;
      team: string | null; position: string | null; openAccess: boolean;
      builtinToolCount: number; canSelfWriteTools: boolean; customToolCount: number; totalUsable: number;
    }>
  } | null>(null)
  const [toolsRegistryLoading, setToolsRegistryLoading] = useState(false)
  const [toolsRegistryFilter, setToolsRegistryFilter] = useState('')

  // Filter cho danh sách filesystem skills trong panel SKILL.md Guides
  // (fix 2026-09-12: panel này trước đây CHỈ hiện 3 DB skills — 68 filesystem
  // skills không hiển thị chỗ nào ngoài Tools Registry => user tưởng app
  // thiếu tài nguyên, thực chất agents đọc được qua list_skills/read_skill)
  const [fsSkillFilter, setFsSkillFilter] = useState('')

  // Load tools registry
  const loadToolsRegistry = useCallback(async () => {
    setToolsRegistryLoading(true)
    try {
      const res = await fetch('/api/tools/registry')
      if (res.ok) {
        const data = await res.json()
        setToolsRegistry(data)
      }
    } catch (error) {
      console.error('Failed to load tools registry:', error)
    } finally {
      setToolsRegistryLoading(false)
    }
  }, [])

  // Load installed skills
  const loadSkills = useCallback(async () => {
    setSkillsLoading(true)
    try {
      const res = await fetch('/api/openclaw/skills?action=installed')
      if (res.ok) {
        const data = await res.json()
        setInstalledSkills(data.skills)
      }
    } catch (error) {
      console.error('Failed to load skills:', error)
    } finally {
      setSkillsLoading(false)
    }
  }, [])

  // Delete a custom tool (agent-written) from Tools Registry UI
  const deleteCustomToolFromUi = useCallback(async (name: string) => {
    if (!confirm(`Xóa custom tool "${name}"? Kèm cả SKILL.md guide của nó.`)) return
    try {
      const res = await fetch('/api/tools/custom', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (res.ok) {
        toast({ title: '🗑️ Đã xóa custom tool', description: name })
        loadToolsRegistry()
        loadSkills()
      } else {
        const data = await res.json()
        toast({ title: '❌ Lỗi', description: data.error || 'Không xóa được', variant: 'destructive' })
      }
    } catch {
      toast({ title: '❌ Lỗi', description: 'Không xóa được custom tool', variant: 'destructive' })
    }
  }, [loadToolsRegistry, loadSkills])

  // Search ClawHub
  const searchClawHub = useCallback(async (queryOverride?: string) => {
    setClawhubSearching(true)
    try {
      const q = queryOverride !== undefined ? queryOverride : clawhubQuery
      // ClawHub API doesn't support '*' wildcard — use 'skill' as broad fallback
      const searchQuery = q.trim() || 'skill'
      const params = new URLSearchParams({ action: 'search', q: searchQuery, limit: '20' })
      const res = await fetch(`/api/openclaw/skills?${params}`)
      if (res.ok) {
        const data = await res.json()
        setClawhubResults(data.skills)
        if (data.source === 'none') {
          toast({ title: '⚠️ Không thể kết nối ClawHub', description: data.message, variant: 'destructive' })
        }
      }
    } catch (error) {
      console.error('ClawHub search failed:', error)
      toast({ title: '❌ Lỗi tìm kiếm', description: 'Không thể tìm kiếm trên ClawHub', variant: 'destructive' })
    } finally {
      setClawhubSearching(false)
    }
  }, [clawhubQuery])

  // Install skill from ClawHub
  const installSkill = useCallback(async (slug: string, ownerHandle?: string) => {
    try {
      const res = await fetch('/api/openclaw/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'install', slug, ownerHandle }),
      })
      if (res.ok) {
        const data = await res.json()
        toast({ title: '✅ Cài đặt thành công', description: data.message })
        loadSkills()
        searchClawHub()
      } else {
        const data = await res.json()
        toast({ title: '❌ Lỗi', description: data.error, variant: 'destructive' })
      }
    } catch {
      toast({ title: '❌ Lỗi', description: 'Không thể cài đặt skill', variant: 'destructive' })
    }
  }, [loadSkills, searchClawHub])

  // Uninstall skill
  const uninstallSkill = useCallback(async (slug: string, name: string) => {
    if (!confirm(`Gỡ cài đặt skill "${name}"? Hành động này không thể hoàn tác.`)) return
    try {
      const res = await fetch('/api/openclaw/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'uninstall', slug }),
      })
      if (res.ok) {
        toast({ title: '🗑️ Đã gỡ cài đặt', description: `Skill "${name}" đã gỡ` })
        loadSkills()
      } else {
        const data = await res.json()
        toast({ title: '❌ Lỗi', description: data.error, variant: 'destructive' })
      }
    } catch {
      toast({ title: '❌ Lỗi', description: 'Không thể gỡ skill', variant: 'destructive' })
    }
  }, [loadSkills])

  // Toggle skill
  const toggleSkill = useCallback(async (slug: string, enabled: boolean) => {
    try {
      const res = await fetch('/api/openclaw/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle', slug, enabled }),
      })
      if (res.ok) {
        const data = await res.json()
        toast({ title: enabled ? '✅ Đã bật' : '⏸️ Đã tắt', description: data.message })
        loadSkills()
      }
    } catch {
      toast({ title: '❌ Lỗi', description: 'Không thể toggle skill', variant: 'destructive' })
    }
  }, [loadSkills])

  // Fetch skill content for dialog
  const fetchSkillContent = useCallback(async (slug: string, ownerHandle?: string) => {
    setSkillDialogContentLoading(true)
    setSkillDialogOpen(true)
    setSkillDialogContent(null)
    try {
      const params = new URLSearchParams({ action: 'content', slug })
      if (ownerHandle) params.set('ownerHandle', ownerHandle)
      const res = await fetch(`/api/openclaw/skills?${params}`)
      if (res.ok) {
        const data = await res.json()
        if (data.error && !data.content) {
          toast({ title: '❌ Lỗi', description: data.error, variant: 'destructive' })
          setSkillDialogOpen(false)
        } else {
          setSkillDialogContent(data)
        }
      }
    } catch {
      toast({ title: '❌ Lỗi', description: 'Không thể tải nội dung skill', variant: 'destructive' })
      setSkillDialogOpen(false)
    } finally {
      setSkillDialogContentLoading(false)
    }
  }, [])

  // Open skill editor
  const openEditor = useCallback((skill: { slug: string; name: string; content: string; source: string }) => {
    setEditingSkill(skill)
    setEditContent(skill.content)
    setEditName(skill.name)
  }, [])

  // Save edited skill
  const saveEditedSkill = useCallback(async () => {
    if (!editingSkill) return
    setEditSaving(true)
    try {
      const res = await fetch('/api/openclaw/skills/custom', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: editingSkill.slug, name: editName, content: editContent }),
      })
      if (res.ok) {
        toast({ title: '✅ Đã lưu', description: `Skill "${editName}" đã cập nhật` })
        setEditingSkill(null)
        loadSkills()
      } else {
        const data = await res.json()
        toast({ title: '❌ Lỗi', description: data.error, variant: 'destructive' })
      }
    } catch {
      toast({ title: '❌ Lỗi', description: 'Không thể lưu skill', variant: 'destructive' })
    } finally {
      setEditSaving(false)
    }
  }, [editingSkill, editName, editContent, loadSkills])

  // Create custom skill
  const createCustomSkill = useCallback(async () => {
    if (!newSkillSlug || !newSkillName || !newSkillContent) {
      toast({ title: '❌ Thiếu thông tin', description: 'Cần slug, tên và nội dung', variant: 'destructive' })
      return
    }
    setNewSkillCreating(true)
    try {
      const res = await fetch('/api/openclaw/skills/custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: newSkillSlug, name: newSkillName, content: newSkillContent, enabled: true }),
      })
      if (res.ok) {
        toast({ title: '✅ Đã tạo', description: `Custom skill "${newSkillName}" đã tạo` })
        setShowCreateSkill(false)
        setNewSkillSlug('')
        setNewSkillName('')
        setNewSkillContent('')
        loadSkills()
      } else {
        const data = await res.json()
        toast({ title: '❌ Lỗi', description: data.error, variant: 'destructive' })
      }
    } catch {
      toast({ title: '❌ Lỗi', description: 'Không thể tạo skill', variant: 'destructive' })
    } finally {
      setNewSkillCreating(false)
    }
  }, [newSkillSlug, newSkillName, newSkillContent, loadSkills])

  // Load data on mount (only once)
  // (queueMicrotask: defer để không gọi setState đồng bộ trong body effect)
  useEffect(() => {
    queueMicrotask(() => {
      loadSkills()
      loadToolsRegistry()
      searchClawHub('skill') // initial load — browse popular skills from ClawHub
    })
  }, [])

  // ===== TASK 22 (user directive 2026-09-30 #4) — TOOLS REGISTRY REAL-TIME =====
  // "khi có thêm agent hoặc agents được setup thêm tools, skills thì phần
  // này có cập real time luôn không" → CÓ: poll mỗi 30s khi panel Tools
  // Registry đang mở (API force-dynamic tính lại agentMatrix từ DB +
  // ToolAssignment live mỗi request — agent mới tạo ở module khác / Omega
  // create_agent chạy nền / gán tắt tool qua Tools Manager hiện trong ≤30s).
  // Kèm dấu thời điểm cập nhật cuối + toast im lặng KHÔNG phát khi dữ liệu
  // chưa từng load (tránh spam tab background).
  const toolsRegistryAgentCountRef = useRef<number>(-1)
  useEffect(() => {
    if (!toolsRegistryOpen) return // panel đóng → không tốn request
    const interval = setInterval(() => {
      loadToolsRegistry()
    }, 30_000)
    return () => clearInterval(interval)
  }, [toolsRegistryOpen, loadToolsRegistry])

  // Phát hiện agent MỚI xuất hiện giữa 2 lần poll → toast thông báo 1 lần
  useEffect(() => {
    if (!toolsRegistry) return
    const count = toolsRegistry.summary.agentCount
    const prev = toolsRegistryAgentCountRef.current
    toolsRegistryAgentCountRef.current = count
    if (prev >= 0 && count > prev) {
      toast({
        title: '🔄 Tools Registry đã cập nhật',
        description: `Phát hiện ${count - prev} agent mới — matrix Agents ↔ tools làm mới tự động`,
        duration: 4000,
      })
    }
  }, [toolsRegistry])

  const sourceBadgeColor: Record<string, string> = {
    bundled: 'bg-violet-500/20 text-violet-300 border-violet-400/50',
    clawhub: 'bg-blue-500/20 text-blue-300 border-blue-400/50',
    custom: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/50',
    template: 'bg-purple-500/20 text-purple-300 border-purple-400/50',
    'agent-tool': 'bg-cyan-500/20 text-cyan-300 border-cyan-400/50',
  }

  return (
    <div className="space-y-4 p-4 max-h-full overflow-y-auto">
      {/* Tools Registry — tổng quan TOÀN BỘ skills/tools (user request 2026-08-30) */}
      <div className="nc-wrap nc-violet">
        <div className="nc-panel nc-md nc-border-violet p-4">
          <div
            className="flex items-center gap-2 cursor-pointer select-none group"
            onClick={() => setToolsRegistryOpen(!toolsRegistryOpen)}
            role="button"
            tabIndex={0}
            aria-expanded={toolsRegistryOpen}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setToolsRegistryOpen(!toolsRegistryOpen) }}
          >
            {toolsRegistryOpen ? <ChevronDown className="w-4 h-4 text-violet-400" /> : <ChevronRight className="w-4 h-4 text-violet-400" />}
            <Wrench className="w-5 h-5 text-violet-400" />
            <h3 className="text-sm font-semibold text-violet-300 uppercase tracking-wider group-hover:text-violet-200 transition-colors">Tools Registry</h3>
            {toolsRegistry && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-violet-500/20 text-violet-300 border-violet-400/50">
                {toolsRegistry.summary.builtinToolCount + toolsRegistry.summary.customToolCount} tools · {toolsRegistry.summary.filesystemSkillCount} skills
              </Badge>
            )}
            {/* TASK 22: số agents trong matrix (real-time — agent mới hiện NGAY) */}
            {toolsRegistry && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-emerald-500/20 text-emerald-300 border-emerald-400/50">
                {toolsRegistry.summary.agentCount} agents
              </Badge>
            )}
            {/* TASK 22: cập nhật thủ công + thời điểm làm mới gần nhất */}
            <button
              onClick={() => { loadSkills(); loadToolsRegistry() }}
              disabled={toolsRegistryLoading}
              title="Làm mới Tools Registry + skills ngay (agent mới / tool mới gán gần đây)"
              className="inline-flex items-center gap-1 rounded-md border border-violet-400/50 bg-violet-500/10 px-2 py-0.5 text-[10px] text-violet-300 hover:bg-violet-500/20 disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={`w-3 h-3 ${toolsRegistryLoading ? 'animate-spin' : ''}`} />
              Làm mới
            </button>
            {/* 21-c: nút mở dialog quản lý Tools & Skills (xem/sửa nội dung + gán tool cho agents) */}
            <ToolsManagerDialog />
            <span className="ml-auto text-[10px] text-slate-500">{toolsRegistryOpen ? 'Thu gọn' : 'Bấm để mở'}{toolsRegistry?.generatedAt ? ` · cập nhật ${new Date(toolsRegistry.generatedAt).toLocaleTimeString('vi-VN')}` : ''} </span>
          </div>

          {toolsRegistryOpen && (
            <div className="mt-4">
              {toolsRegistryLoading && !toolsRegistry ? (
                <div className="flex items-center justify-center gap-2 py-6 text-slate-500 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin text-violet-400" />
                  <span>Đang tải registry...</span>
                </div>
              ) : toolsRegistry ? (
                <div className="space-y-4">
                  {/* Summary cards */}
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                    <div className="nc-panel nc-sm nc-border-violet-soft p-2.5 text-center">
                      <div className="text-lg font-bold text-white">{toolsRegistry.summary.builtinToolCount}</div>
                      <div className="text-[10px] text-slate-500">Built-in Tools</div>
                    </div>
                    <div className="nc-panel nc-sm nc-border-violet-soft p-2.5 text-center">
                      <div className="text-lg font-bold text-cyan-300">{toolsRegistry.summary.customToolCount}</div>
                      <div className="text-[10px] text-slate-500">Custom (Agent viết)</div>
                    </div>
                    <div className="nc-panel nc-sm nc-border-violet-soft p-2.5 text-center">
                      <div className="text-lg font-bold text-emerald-300">{toolsRegistry.summary.filesystemSkillCount}</div>
                      <div className="text-[10px] text-slate-500">Filesystem Skills</div>
                    </div>
                    <div className="nc-panel nc-sm nc-border-violet-soft p-2.5 text-center">
                      <div className="text-lg font-bold text-violet-300">{toolsRegistry.summary.dbSkillCount}</div>
                      <div className="text-[10px] text-slate-500">DB Skills (inject prompt)</div>
                    </div>
                    <div className="nc-panel nc-sm nc-border-violet-soft p-2.5 text-center">
                      <div className="text-lg font-bold text-amber-300">{toolsRegistry.summary.orphanToolCount}</div>
                      <div className="text-[10px] text-slate-500">Chưa cấp agent nào</div>
                    </div>
                  </div>

                  {/* Agent matrix — TASK 22: TOÀN BỘ agents trong DB (Opus, agents
                      động do Omega create_agent / user tạo) + effective tools live;
                      poll 30s + nút Làm mới khi agent mới được setup tools/skills */}
                  <div>
                    <h4 className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5 flex-wrap">
                      <Cpu className="w-3.5 h-3.5 text-violet-400" /> Agents — tools khả dụng
                      <span className="text-[10px] font-normal text-slate-500">
                        ({toolsRegistry.summary.agentCount} agents · custom tools dùng chung cho mọi agents · tự cập nhật mỗi 30s)
                      </span>
                    </h4>
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 gap-2">
                      {toolsRegistry.agentMatrix.map(a => (
                        <div key={a.name} className="nc-panel nc-sm nc-border-violet-soft p-2">
                          <div className="flex items-center gap-1.5">
                            {a.avatar && <span className="text-xs leading-none" title={a.isSystem ? 'Agent hệ thống' : 'Agent do Omega/user tạo'}>{a.avatar}</span>}
                            <span className="text-xs font-medium text-white truncate" title={`${a.name}${a.team ? ` (team: ${a.team}${a.position ? ` · ${a.position}` : ''})` : ''}`}>{a.name}</span>
                            {a.canSelfWriteTools && (
                              <span title="Agent này có thể TỰ VIẾT tools (create_custom_tool)" className="text-[9px] text-cyan-400">✍️</span>
                            )}
                          </div>
                          <div className="text-[10px] text-slate-500 mt-0.5">
                            {a.openAccess ? (
                              <span className="text-emerald-400" title="Whitelist rỗng — goal-loop KHÔNG filter: mọi tool builtin đều được phép gọi">
                                MỌI TOOL (∞)
                              </span>
                            ) : (
                              <>
                                {a.builtinToolCount}/{toolsRegistry.summary.builtinToolCount} built-in
                              </>
                            )}
                            {a.customToolCount > 0 ? ` + ${a.customToolCount} custom` : ''}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Custom tools (agent-written) */}
                  {toolsRegistry.customTools.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
                        <Wrench className="w-3.5 h-3.5 text-cyan-400" /> Custom Tools — agents tự viết
                        <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-cyan-500/20 text-cyan-300 border-cyan-400/50">{toolsRegistry.customTools.length}</Badge>
                      </h4>
                      <div className="space-y-1.5">
                        {toolsRegistry.customTools.map(ct => (
                          <div key={ct.name} className="nc-panel nc-sm nc-border-violet-soft p-2.5 flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-mono font-medium text-cyan-300 truncate">{ct.name}</span>
                                <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-slate-500/20 text-slate-400 border-slate-400/50 flex-shrink-0">v{ct.version}</Badge>
                                {ct.enabled ? (
                                  <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-emerald-500/20 text-emerald-300 border-emerald-400/50 flex-shrink-0">✅ Bật</Badge>
                                ) : (
                                  <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-slate-500/20 text-slate-400 border-slate-400/50 flex-shrink-0">⏸️ Tắt</Badge>
                                )}
                              </div>
                              <p className="text-[11px] text-slate-400 mt-0.5 line-clamp-2">{ct.description}</p>
                            </div>
                            <div className="text-right flex-shrink-0">
                              <div className="text-[10px] text-slate-500">gọi {ct.callCount} lần</div>
                              <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] text-red-400 hover:bg-red-500/10 mt-1" onClick={() => deleteCustomToolFromUi(ct.name)}>
                                <Trash2 className="w-3 h-3 mr-1" /> Xóa
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Built-in tools list */}
                  <div>
                    <h4 className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
                      <Wrench className="w-3.5 h-3.5 text-violet-400" /> Built-in Tools
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-violet-500/20 text-violet-300 border-violet-400/50">{toolsRegistry.summary.builtinToolCount}</Badge>
                      <span className="text-[10px] font-normal text-slate-500">— agents nào dùng được tool nào</span>
                    </h4>
                    <Input
                      placeholder="Lọc tool theo tên..."
                      value={toolsRegistryFilter}
                      onChange={(e) => setToolsRegistryFilter(e.target.value)}
                      className="mb-2 bg-slate-800/50 border-violet-400/35 text-white placeholder:text-slate-500 text-sm h-8"
                    />
                    <div className="max-h-96 overflow-y-auto space-y-1 pr-1" style={{ scrollbarWidth: 'thin' }}>
                      {toolsRegistry.builtinTools
                        .filter(t => !toolsRegistryFilter || t.name.toLowerCase().includes(toolsRegistryFilter.toLowerCase()))
                        .map(t => (
                        <div key={t.name} className="nc-panel nc-sm nc-border-violet-soft p-2 flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-mono font-medium text-white">{t.name}</span>
                              {t.paramNames.length > 0 && (
                                <span className="text-[9px] text-slate-600">({t.paramNames.slice(0, 4).join(', ')}{t.paramNames.length > 4 ? '...' : ''})</span>
                              )}
                            </div>
                            <p className="text-[10px] text-slate-500 mt-0.5 line-clamp-1">{t.description}</p>
                          </div>
                          <div className="flex items-center gap-1 flex-wrap justify-end flex-shrink-0 max-w-[45%]">
                            {t.agentCount === 0 ? (
                              <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-amber-500/20 text-amber-300 border-amber-400/50">Chưa cấp</Badge>
                            ) : (
                              <>
                                {t.accessibleByAll && <span className="text-[9px] text-emerald-400" title="Mọi agents đều dùng được">★</span>}
                                {t.agents.map(a => (
                                  <span key={a.name} title={a.name} className="text-[9px] px-1 py-0.5 rounded bg-violet-500/15 text-violet-300 border border-violet-400/30">{a.short}</span>
                                ))}
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Filesystem skills */}
                  <div>
                    <h4 className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5">
                      <BookOpen className="w-3.5 h-3.5 text-emerald-400" /> Filesystem Skills
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-emerald-500/20 text-emerald-300 border-emerald-400/50">{toolsRegistry.summary.filesystemSkillCount}</Badge>
                      <span className="text-[10px] font-normal text-slate-500">— MỌI agents đọc qua list_skills + read_skill (đã cấp đủ từ 2026-09-12)</span>
                    </h4>
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-1.5 max-h-64 overflow-y-auto pr-1" style={{ scrollbarWidth: 'thin' }}>
                      {toolsRegistry.filesystemSkills.map(fs => (
                        <div key={fs.slug} className="nc-panel nc-sm nc-border-violet-soft p-2">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[11px] font-mono text-emerald-300 truncate">{fs.slug}</span>
                            {!fs.hasSkillMd && <span className="text-[9px] text-amber-500" title="Thiếu SKILL.md">⚠</span>}
                          </div>
                          {fs.description && <p className="text-[9px] text-slate-500 mt-0.5 line-clamp-1">{fs.description}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-center py-4 text-slate-500 text-sm">Không tải được Tools Registry</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ClawHub Marketplace */}
      <div className="nc-wrap nc-violet">
        <div className="nc-panel nc-md nc-border-violet p-4">
          <div
            className="flex items-center gap-2 cursor-pointer select-none group"
            onClick={() => setClawhubOpen(!clawhubOpen)}
            role="button"
            tabIndex={0}
            aria-expanded={clawhubOpen}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setClawhubOpen(!clawhubOpen) }}
          >
            {clawhubOpen ? <ChevronDown className="w-4 h-4 text-violet-400" /> : <ChevronRight className="w-4 h-4 text-violet-400" />}
            <Globe className="w-5 h-5 text-violet-400" />
            <h3 className="text-sm font-semibold text-violet-300 uppercase tracking-wider group-hover:text-violet-200 transition-colors">ClawHub Marketplace</h3>
            {clawhubResults && clawhubResults.length > 0 && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-blue-500/20 text-blue-300 border-blue-400/50">{clawhubResults.length}</Badge>
            )}
            <span className="ml-auto text-[10px] text-slate-500">{clawhubOpen ? 'Thu gọn' : 'Bấm để mở'}</span>
            <a href="https://clawhub.ai/skills" target="_blank" rel="noopener noreferrer" className="text-[10px] text-violet-400 hover:text-violet-300 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <ExternalLink className="w-3 h-3" /> ClawHub.ai
            </a>
          </div>

          {clawhubOpen && (
            <>
          <div className="flex gap-2 mb-3 mt-4">
            <Input
              placeholder="Tìm kiếm skill trên ClawHub.ai..."
              value={clawhubQuery}
              onChange={(e) => setClawhubQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && searchClawHub()}
              className="flex-1 bg-slate-800/50 border-violet-400/35 text-white placeholder:text-slate-500 text-sm"
            />
            <Button size="sm" variant="outline" className="text-violet-400 border-violet-400/50 hover:bg-violet-500/10" onClick={() => searchClawHub()} disabled={clawhubSearching}>
              {clawhubSearching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
            </Button>
          </div>

          {clawhubResults && clawhubResults.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-96 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
              {clawhubResults.map((skill, idx) => {
                // ClawHub slugs are unique per-author, not globally — compose key to avoid duplicate React keys
                const reactKey = `${skill.slug}::${skill.authorHandle || skill.author || `idx-${idx}`}`
                return (
                <div key={reactKey} className="nc-wrap nc-violet-soft cursor-pointer hover:ring-1 hover:ring-violet-400/50 transition-all" onClick={() => fetchSkillContent(skill.slug, skill.authorHandle)}>
                  <div className="nc-panel nc-sm nc-border-violet-soft p-3">
                    <div className="flex items-start justify-between mb-1">
                      <div className="flex items-center gap-2 min-w-0">
                        {skill.authorImage ? (
                          <img src={skill.authorImage} alt="" className="w-5 h-5 rounded-full flex-shrink-0" />
                        ) : (
                          <div className="w-5 h-5 rounded-full bg-violet-500/30 flex items-center justify-center flex-shrink-0">
                            <span className="text-[8px] text-violet-300">{(skill.author || '?')[0]}</span>
                          </div>
                        )}
                        <h4 className="text-sm font-medium text-white truncate">{skill.name}</h4>
                      </div>
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-violet-500/20 text-violet-300 border-violet-400/50 flex-shrink-0 ml-1">
                        v{skill.version}
                      </Badge>
                    </div>
                    <p className="text-xs text-slate-400 mb-2 line-clamp-2">{skill.description}</p>
                    <span className="text-[9px] text-violet-500/70 flex items-center gap-0.5"><Eye className="w-2.5 h-2.5" /> Xem nội dung</span>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 text-[10px] text-slate-500">
                        <span className="truncate max-w-[100px]">👤 {skill.author}</span>
                        {skill.downloads > 0 && <span>⬇️ {skill.downloads >= 1000 ? `${(skill.downloads / 1000).toFixed(1)}k` : skill.downloads}</span>}
                        {skill.stars !== undefined && skill.stars > 0 && <span>⭐ {skill.stars}</span>}
                        {skill.url && (
                          <a href={skill.url} target="_blank" rel="noopener noreferrer" className="text-violet-400 hover:text-violet-300" onClick={(e) => e.stopPropagation()}>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                      {skill.installed ? (
                        <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-emerald-500/20 text-emerald-300 border-emerald-400/50">Đã cài</Badge>
                      ) : (
                        <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] text-violet-400 border-violet-400/50 hover:bg-violet-500/10" onClick={(e) => { e.stopPropagation(); installSkill(skill.slug, skill.authorHandle) }}>
                          <Download className="w-3 h-3 mr-1" /> Cài
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
                )
              })}
            </div>
          ) : (
            <div className="text-center py-4 text-slate-500 text-sm">
              {clawhubSearching ? (
                <div className="flex items-center justify-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-violet-400" />
                  <span>Đang tìm kiếm trên ClawHub.ai...</span>
                </div>
              ) : (
                <div>
                  <p>Nhập từ khóa và bấm tìm kiếm</p>
                  <p className="text-[10px] text-slate-600 mt-1">Dữ liệu từ ClawHub.ai — kho skill cho AI agents</p>
                </div>
              )}
            </div>
          )}
            </>
          )}
        </div>
      </div>

      {/* SKILL.md Guides — Hướng dẫn cho agents (DB inject prompt + filesystem) */}
      {(() => {
        const fsSkills = (toolsRegistry?.filesystemSkills || []).filter(fs => fs.hasSkillMd)
        const dbCount = installedSkills?.length || 0
        if (dbCount === 0 && fsSkills.length === 0) return null
        const fsFiltered = fsSkills.filter(fs =>
          !fsSkillFilter ||
          fs.slug.toLowerCase().includes(fsSkillFilter.toLowerCase()) ||
          (fs.description || '').toLowerCase().includes(fsSkillFilter.toLowerCase())
        )
        return (
        <div className="nc-wrap nc-violet">
          <div className="nc-panel nc-md nc-border-violet p-4">
            <div
              className="flex items-center gap-2 cursor-pointer select-none group"
              onClick={() => setSkillGuidesOpen(!skillGuidesOpen)}
              role="button"
              tabIndex={0}
              aria-expanded={skillGuidesOpen}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSkillGuidesOpen(!skillGuidesOpen) }}
            >
              {skillGuidesOpen ? <ChevronDown className="w-4 h-4 text-violet-400" /> : <ChevronRight className="w-4 h-4 text-violet-400" />}
              <BookOpen className="w-5 h-5 text-violet-400" />
              <h3 className="text-sm font-semibold text-violet-300 uppercase tracking-wider group-hover:text-violet-200 transition-colors">SKILL.md Guides</h3>
              <Badge variant="outline" className="text-violet-400 border-violet-400/50">{dbCount + fsSkills.length}</Badge>
              <span className="text-[10px] text-slate-500 hidden sm:inline">{dbCount} inject prompt · {fsSkills.length} trên đĩa</span>
              <span className="ml-auto text-[10px] text-slate-500">{skillGuidesOpen ? 'Thu gọn' : 'Bấm để mở'}</span>
              <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                <Button size="sm" variant="outline" className="text-violet-400 border-violet-400/50 hover:bg-violet-500/10" onClick={() => setShowCreateSkill(true)}>
                  <Plus className="w-3.5 h-3.5 mr-1" /> Tạo Custom
                </Button>
              </div>
            </div>

            {skillGuidesOpen && (
              <>
            <p className="text-xs text-slate-500 mb-3 mt-4">
              Tài nguyên skills có <strong>2 lớp</strong>: (1) <strong>{dbCount} skill DB</strong> (dưới đây) được inject thẳng vào system prompt của agent — hướng dẫn <em>khi nào</em> và <em>cách nào</em> dùng tool; (2) <strong>{fsSkills.length} skill filesystem</strong> (<code className="text-violet-300">skills/&lt;slug&gt;/SKILL.md</code>) — agents tự liệt kê qua tool <code className="text-violet-300">list_skills</code> và đọc chi tiết qua <code className="text-violet-300">read_skill</code> (đã cấp cho <strong>mọi agents</strong> kể từ 2026-09-12).
            </p>

            {dbCount > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {installedSkills?.map((skill, idx) => (
                <div key={skill.id || `${skill.slug}::idx-${idx}`} className="nc-wrap nc-violet-soft">
                  <div className="nc-panel nc-sm nc-border-violet-soft p-3">
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex-1 min-w-0">
                        <h4 className="text-sm font-medium text-white truncate">{skill.name}</h4>
                        <p className="text-xs text-slate-400 mt-0.5">v{skill.version}</p>
                        <p className="text-[11px] text-slate-500 mt-1 line-clamp-2">
                          {skill.content.split('\n').find(l => l.trim() && !l.startsWith('#'))?.trim() || 'Không có mô tả'}
                        </p>
                      </div>
                      <Switch
                        checked={skill.enabled}
                        onCheckedChange={(checked) => toggleSkill(skill.slug, checked)}
                        className="data-[state=checked]:bg-violet-500 data-[state=unchecked]:bg-slate-700 ml-2 flex-shrink-0"
                      />
                    </div>
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${sourceBadgeColor[skill.source] || sourceBadgeColor.custom}`}>
                        {skill.source === 'bundled' ? '📦 Mặc định' : skill.source === 'clawhub' ? '🏪 ClawHub' : skill.source === 'agent-tool' ? '🔧 Agent Tool' : skill.source === 'template' ? '📋 Template' : '✏️ Custom'}
                      </Badge>
                      <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${skill.enabled ? 'bg-emerald-500/20 text-emerald-300 border-emerald-400/50' : 'bg-slate-500/20 text-slate-400 border-slate-400/50'}`}>
                        {skill.enabled ? '✅ Bật' : '⏸️ Tắt'}
                      </Badge>
                    </div>
                    <div className="flex gap-1.5 mt-2">
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-cyan-400 hover:bg-cyan-500/10" onClick={(e) => { e.stopPropagation(); fetchSkillContent(skill.slug) }}>
                        <Eye className="w-3 h-3 mr-1" /> Xem
                      </Button>
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-violet-400 hover:bg-violet-500/10" onClick={() => openEditor(skill)}>
                        <Edit3 className="w-3 h-3 mr-1" /> Sửa
                      </Button>
                      {skill.source !== 'bundled' && (
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-red-400 hover:bg-red-500/10" onClick={() => uninstallSkill(skill.slug, skill.name)}>
                          <Trash2 className="w-3 h-3 mr-1" /> Gỡ
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            )}

            {/* ===== Filesystem Skills — 68 skills trên đĩa (fix 2026-09-12) ===== */}
            {fsSkills.length > 0 && (
              <div className="mt-4">
                <h4 className="text-xs font-semibold text-slate-300 mb-2 flex items-center gap-1.5 flex-wrap">
                  <HardDrive className="w-3.5 h-3.5 text-emerald-400" /> Filesystem Skills
                  <Badge variant="outline" className="text-[9px] px-1.5 py-0 bg-emerald-500/20 text-emerald-300 border-emerald-400/50">{fsSkills.length}</Badge>
                  <span className="text-[10px] font-normal text-slate-500">— skills/&lt;slug&gt;/SKILL.md · agents đọc qua list_skills + read_skill</span>
                </h4>
                <Input
                  placeholder={`Tìm trong ${fsSkills.length} skills filesystem theo tên hoặc mô tả...`}
                  value={fsSkillFilter}
                  onChange={(e) => setFsSkillFilter(e.target.value)}
                  className="mb-2 bg-slate-800/50 border-violet-400/35 text-white placeholder:text-slate-500 text-sm h-8"
                />
                <div className="max-h-96 overflow-y-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 pr-1" style={{ scrollbarWidth: 'thin' }}>
                  {fsFiltered.map(fs => (
                    <div key={fs.slug} className="nc-panel nc-sm nc-border-violet-soft p-2.5 flex flex-col gap-1.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <FileText className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                        <span className="text-xs font-mono font-medium text-white truncate" title={fs.slug}>{fs.slug}</span>
                      </div>
                      <p className="text-[11px] text-slate-400 line-clamp-2 min-h-[2rem]" title={fs.description || ''}>
                        {fs.description || 'Không có mô tả'}
                      </p>
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-cyan-400 hover:bg-cyan-500/10 w-fit" onClick={() => fetchSkillContent(fs.slug)}>
                        <Eye className="w-3 h-3 mr-1" /> Xem
                      </Button>
                    </div>
                  ))}
                  {fsFiltered.length === 0 && (
                    <div className="col-span-full text-center text-xs text-slate-500 py-4">
                      Không có skill filesystem nào khớp &quot;{fsSkillFilter}&quot;
                    </div>
                  )}
                </div>
              </div>
            )}
              </>
            )}
          </div>
        </div>
        )
      })()}



      {/* Section 3: Skill Editor (Modal-like overlay) */}
      {editingSkill && (
        <div className="nc-wrap nc-violet">
          <div className="nc-panel nc-md nc-border-violet p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Edit3 className="w-5 h-5 text-violet-400" />
                <h3 className="text-sm font-semibold text-violet-300 uppercase tracking-wider">Chỉnh sửa Skill</h3>
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-violet-500/20 text-violet-300 border-violet-400/50">{editingSkill.source}</Badge>
              </div>
              <Button size="sm" variant="ghost" className="text-slate-400 hover:text-white" onClick={() => setEditingSkill(null)}>
                <X className="w-4 h-4" />
              </Button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Slug</label>
                <Input value={editingSkill.slug} disabled className="bg-slate-800/50 border-violet-400/35 text-slate-500 text-sm" />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Tên Skill</label>
                <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="bg-slate-800/50 border-violet-400/35 text-white text-sm" />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Nội dung (SKILL.md)</label>
                <Textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  rows={12}
                  className="bg-slate-800/50 border-violet-400/35 text-white text-sm font-mono resize-y"
                  placeholder="# Skill Title&#10;&#10;## Description&#10;..."
                />
              </div>
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="ghost" className="text-slate-400" onClick={() => setEditingSkill(null)}>Hủy</Button>
                <Button size="sm" className="bg-violet-600 hover:bg-violet-700 text-white" onClick={saveEditedSkill} disabled={editSaving}>
                  {editSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Check className="w-3.5 h-3.5 mr-1" />} Lưu
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Section 4: Create Custom Skill (expandable) */}
      {showCreateSkill && (
        <div className="nc-wrap nc-violet">
          <div className="nc-panel nc-md nc-border-violet p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Plus className="w-5 h-5 text-violet-400" />
                <h3 className="text-sm font-semibold text-violet-300 uppercase tracking-wider">Tạo Custom Skill</h3>
              </div>
              <Button size="sm" variant="ghost" className="text-slate-400 hover:text-white" onClick={() => setShowCreateSkill(false)}>
                <X className="w-4 h-4" />
              </Button>
            </div>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Slug (ID)</label>
                  <Input value={newSkillSlug} onChange={(e) => setNewSkillSlug(e.target.value.replace(/\s+/g, '-').toLowerCase())} placeholder="my-custom-skill" className="bg-slate-800/50 border-violet-400/35 text-white text-sm font-mono" />
                </div>
                <div>
                  <label className="text-xs text-slate-400 mb-1 block">Tên Skill</label>
                  <Input value={newSkillName} onChange={(e) => setNewSkillName(e.target.value)} placeholder="My Custom Skill" className="bg-slate-800/50 border-violet-400/35 text-white text-sm" />
                </div>
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">Nội dung SKILL.md</label>
                <Textarea
                  value={newSkillContent}
                  onChange={(e) => setNewSkillContent(e.target.value)}
                  rows={10}
                  className="bg-slate-800/50 border-violet-400/35 text-white text-sm font-mono resize-y"
                  placeholder="# Skill Title&#10;&#10;## Description&#10;Mô tả skill...&#10;&#10;## When to Use&#10;- Khi nào...&#10;&#10;## Rules&#10;- Quy tắc..."
                />
              </div>
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="ghost" className="text-slate-400" onClick={() => setShowCreateSkill(false)}>Hủy</Button>
                <Button size="sm" className="bg-violet-600 hover:bg-violet-700 text-white" onClick={createCustomSkill} disabled={newSkillCreating}>
                  {newSkillCreating ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Plus className="w-3.5 h-3.5 mr-1" />} Tạo Skill
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Skill Content Dialog */}
      <Dialog open={skillDialogOpen} onOpenChange={setSkillDialogOpen}>
        <DialogContent className="bg-slate-950 border-violet-400/35 text-white max-w-2xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-violet-300">
              <BookOpen className="w-5 h-5" />
              {skillDialogContentLoading ? 'Đang tải...' : skillDialogContent?.name || 'Skill Content'}
              {skillDialogContent && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-violet-500/20 text-violet-300 border-violet-400/50">
                  v{skillDialogContent.version}
                </Badge>
              )}
              {skillDialogContent?.installed && (
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-emerald-500/20 text-emerald-300 border-emerald-400/50">
                  Đã cài
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription className="text-slate-400 text-xs">
              {skillDialogContent?.author && `bởi ${skillDialogContent.author}`}
              {skillDialogContent?.description && ` — ${skillDialogContent.description}`}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-2 overflow-y-auto max-h-[55vh]">
            {skillDialogContentLoading ? (
              <div className="flex items-center justify-center py-12 text-violet-400/60">
                <Loader2 className="w-5 h-5 animate-spin mr-2" /> Đang tải nội dung từ ClawHub...
              </div>
            ) : skillDialogContent?.content ? (
              <pre className="text-xs text-slate-300 whitespace-pre-wrap font-mono bg-slate-900/50 rounded-lg p-4 border border-violet-400/20">
                {skillDialogContent.content}
              </pre>
            ) : (
              <div className="text-center py-8 text-slate-500 text-sm">
                Không có nội dung để hiển thị
              </div>
            )}
          </div>
          <DialogFooter className="flex items-center gap-2 mt-2">
            {skillDialogContent && !skillDialogContent.installed && (
              <Button size="sm" className="bg-violet-600 hover:bg-violet-700 text-white" onClick={() => {
                if (skillDialogContent) {
                  installSkill(skillDialogContent.slug, skillDialogContent.authorHandle)
                  setSkillDialogOpen(false)
                }
              }}>
                <Download className="w-3.5 h-3.5 mr-1" /> Cài đặt Skill
              </Button>
            )}
            {skillDialogContent?.url && (
              <a href={`https://clawhub.ai/${skillDialogContent.authorHandle}/${skillDialogContent.slug}`} target="_blank" rel="noopener noreferrer">
                <Button size="sm" variant="outline" className="text-violet-400 border-violet-400/50 hover:bg-violet-500/10">
                  <ExternalLink className="w-3.5 h-3.5 mr-1" /> ClawHub.ai
                </Button>
              </a>
            )}
            <Button size="sm" variant="ghost" className="text-slate-400" onClick={() => setSkillDialogOpen(false)}>
              Đóng
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

