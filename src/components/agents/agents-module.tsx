'use client'

// ========================================================================
// agents-module — Module Agents (Team Code + Team Research)
// PERF-SPLIT 2026-09-03: trích xuất nguyên vẹn từ src/app/page.tsx (không đổi logic)
// ========================================================================

import React, { useState, useCallback, useEffect, useMemo } from 'react'
import { Database, Loader2, RefreshCw, AlertTriangle, Trash2, Bot, X, AlertCircle, Plus, GraduationCap, Pencil, User, Code2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { toast } from '@/hooks/use-toast'
import { AVATAR_OPTIONS, PROVIDER_OPTIONS, TEAM_OPTIONS, POSITION_LABELS, TEAM_POSITIONS, CODE_POSITIONS, RESEARCH_POSITIONS, PROVIDER_BADGE_COLORS } from '@/lib/agent-constants'
import { SkillsTabContent } from '@/components/smolab/skills-tab'


// ==================== AGENTS MODULE ====================

export function AgentsModule() {
  const [agents, setAgents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingAgent, setEditingAgent] = useState<any | null>(null)
  const [availableModels, setAvailableModels] = useState<any[]>([])
  const [formError, setFormError] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  // Tab: 'agents' = danh sách agent · 'skills' = Tools & Skills (tái dùng SkillsTabContent của Smolab)
  const [activeAgentsTab, setActiveAgentsTab] = useState<'agents' | 'skills'>('agents')

  // Form state
  const [formName, setFormName] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formInstruction, setFormInstruction] = useState('')
  const [formProvider, setFormProvider] = useState('nvidia')
  const [formModel, setFormModel] = useState('')
  const [formTemperature, setFormTemperature] = useState(0.7)
  const [formMaxTokens, setFormMaxTokens] = useState(-1) // -1 = unlimited (Task 39)
  const [formTeam, setFormTeam] = useState<string | null>(null)
  const [formPosition, setFormPosition] = useState<string | null>(null)
  const [formAvatar, setFormAvatar] = useState('🤖')
  const [saving, setSaving] = useState(false)

  // Fetch agents
  const fetchAgents = useCallback(async () => {
    try {
      setLoading(true)
      setLoadError(null)
      const res = await fetch('/api/agents')
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        const errMsg = errData.details || errData.error || `HTTP ${res.status}`
        throw new Error(errMsg)
      }
      const data = await res.json()
      // FALLBACK GUARD (fix 2026-09-09 "local không load agents"): khi DB schema
      // drift và self-heal thất bại, API trả HTTP 200 + agents rỗng + warning —
      // nếu không check sẽ hiện danh sách TRỐNG câm lặng, user không biết lý do.
      if (data.source === 'fallback' && (!data.agents || data.agents.length === 0)) {
        throw new Error(data.warning || 'Database chưa khớp schema — chạy: bun run db:push')
      }
      setAgents(data.agents || [])
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Không thể tải danh sách Agent'
      setLoadError(msg)
      toast({ title: 'Lỗi tải Agents', description: msg, variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [])

  // P6-M4 (BLUEPRINT-STATS-LEARNING §P6-M4): lời khuyên Q học được — top model
  // theo Q-value (advisory, chỉ khi đã có dữ liệu học visits>0)
  const [qAdvice, setQAdvice] = useState<{ stateKey: string; top: Array<{ model: string; q: number; visits: number }> } | null>(null)

  // Fetch available models
  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch('/api/agents/models')
      if (!res.ok) throw new Error('Failed to fetch models')
      const data = await res.json()
      setAvailableModels(data.providers || [])
      setQAdvice(data?.advice ?? null)
    } catch {
      // Silently fail for models — not critical
    }
  }, [])

  useEffect(() => {
    // (queueMicrotask: defer để không gọi setState đồng bộ trong body effect)
    queueMicrotask(() => {
      void fetchAgents()
      void fetchModels()
    })
  }, [fetchAgents, fetchModels])

  // Get models for current provider
  const currentProviderModels = useMemo(() => {
    const provider = availableModels.find((p: any) => p.key === formProvider)
    return provider?.models || []
  }, [availableModels, formProvider])

  // Reset form
  const resetForm = useCallback(() => {
    setFormName('')
    setFormDescription('')
    setFormInstruction('')
    setFormProvider('nvidia')
    setFormModel('')
    setFormTemperature(0.7)
    setFormMaxTokens(4096)
    setFormTeam(null)
    setFormPosition(null)
    setFormAvatar('🤖')
    setFormError('')
    setEditingAgent(null)
  }, [])

  // Open create dialog
  const openCreateDialog = useCallback(() => {
    resetForm()
    setDialogOpen(true)
  }, [resetForm])

  // Open edit dialog
  const openEditDialog = useCallback((agent: any) => {
    setEditingAgent(agent)
    setFormName(agent.name || '')
    setFormDescription(agent.description || '')
    setFormInstruction(agent.instruction || '')
    setFormProvider(agent.provider || 'nvidia')
    setFormModel(agent.model || '')
    setFormTemperature(agent.temperature ?? 0.7)
    setFormMaxTokens(agent.maxTokens ?? -1)
    setFormTeam(agent.team || null)
    setFormPosition(agent.position || null)
    setFormAvatar(agent.avatar || '🤖')
    setFormError('')
    setDialogOpen(true)
  }, [])

  // Close dialog
  const closeDialog = useCallback(() => {
    setDialogOpen(false)
    resetForm()
  }, [resetForm])

  // Validate form
  const validateForm = useCallback((): string | null => {
    if (!formName || formName.trim().length < 2 || formName.trim().length > 50) {
      return 'Tên Agent phải từ 2-50 ký tự'
    }
    if (!formDescription || formDescription.trim().length === 0) {
      return 'Mô tả vai trò không được để trống'
    }
    if (formDescription.trim().length > 10000) {
      return 'Mô tả vai trò không được quá 10000 ký tự'
    }
    if (!formInstruction || formInstruction.trim().length === 0) {
      return 'Hướng dẫn chi tiết không được để trống'
    }
    if (formInstruction.trim().length > 10000) {
      return 'Hướng dẫn chi tiết không được quá 10000 ký tự'
    }
    if (!formProvider) return 'Vui lòng chọn Provider'
    if (!formModel) return 'Vui lòng chọn Model'
    if (formTemperature < 0 || formTemperature > 2) return 'Temperature phải từ 0.0 đến 2.0'
    // TASK 39: -1 = KHÔNG giới hạn (Zen omit max_tokens → model output max
    // 512k); > 0 phải trong khoảng 256..524288
    if (formMaxTokens !== -1 && (formMaxTokens < 256 || formMaxTokens > 524288)) return 'Max Tokens phải từ 256 đến 524288 (hoặc -1 = không giới hạn)'
    if (formTeam && !formPosition) return 'Vui lòng chọn vị trí trong Team'
    return null
  }, [formName, formDescription, formInstruction, formProvider, formModel, formTemperature, formMaxTokens, formTeam, formPosition])

  // Save agent (create or update)
  const saveAgent = useCallback(async () => {
    const validationError = validateForm()
    if (validationError) {
      setFormError(validationError)
      return
    }
    setSaving(true)
    setFormError('')
    try {
      const payload: Record<string, unknown> = {
        name: formName,
        description: formDescription,
        instruction: formInstruction,
        provider: formProvider,
        model: formModel,
        temperature: formTemperature,
        maxTokens: formMaxTokens,
        team: formTeam || null,
        position: formPosition || null,
        avatar: formAvatar,
      }
      if (editingAgent) {
        payload.id = editingAgent.id
        const res = await fetch('/api/agents', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!res.ok) {
          const data = await res.json()
          throw new Error(data.error || 'Cập nhật Agent thất bại')
        }
        toast({ title: 'Thành công', description: `Đã cập nhật Agent "${formName}"` })
      } else {
        const res = await fetch('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!res.ok) {
          const data = await res.json()
          throw new Error(data.error || 'Tạo Agent thất bại')
        }
        toast({ title: 'Thành công', description: `Đã tạo Agent "${formName}"` })
      }
      closeDialog()
      void fetchAgents()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Đã xảy ra lỗi')
    } finally {
      setSaving(false)
    }
  }, [validateForm, editingAgent, formName, formDescription, formInstruction, formProvider, formModel, formTemperature, formMaxTokens, formTeam, formPosition, formAvatar, closeDialog, fetchAgents])

  // Delete agent
  const deleteAgent = useCallback(async (id: string, name: string) => {
    if (!confirm(`Xóa Agent "${name}"? Các phiên chat liên quan sẽ được giữ lại.`)) return
    try {
      const res = await fetch(`/api/agents?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Xóa Agent thất bại')
      }
      toast({ title: 'Đã xóa', description: `Agent "${name}" đã được xóa` })
      void fetchAgents()
    } catch (err) {
      toast({ title: 'Không thể xóa', description: err instanceof Error ? err.message : 'Xóa Agent thất bại', variant: 'destructive' })
    }
  }, [fetchAgents])

  // Toggle agent enabled
  const toggleAgent = useCallback(async (id: string, enabled: boolean) => {
    try {
      const res = await fetch('/api/agents', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, enabled }),
      })
      if (!res.ok) throw new Error('Toggle failed')
      void fetchAgents()
    } catch {
      toast({ title: 'Lỗi', description: 'Không thể cập nhật trạng thái Agent', variant: 'destructive' })
    }
  }, [fetchAgents])

  // Handle provider change — reset model
  const handleProviderChange = useCallback((val: string) => {
    setFormProvider(val)
    setFormModel('')
  }, [])

  // Handle team change — reset position
  const handleTeamChange = useCallback((val: string) => {
    if (val === '_none') {
      setFormTeam(null)
      setFormPosition(null)
    } else {
      setFormTeam(val)
      setFormPosition(null)
    }
  }, [])

  // Group agents by team
  const codeAgents = useMemo(() => {
    const positions = CODE_POSITIONS
    return agents
      .filter((a: any) => a.team === 'code')
      .sort((a: any, b: any) => {
        const ai = positions.indexOf(a.position) ?? 99
        const bi = positions.indexOf(b.position) ?? 99
        return ai - bi
      })
  }, [agents])

  const researchAgents = useMemo(() => {
    const positions = RESEARCH_POSITIONS
    return agents
      .filter((a: any) => a.team === 'research')
      .sort((a: any, b: any) => {
        const ai = positions.indexOf(a.position) ?? 99
        const bi = positions.indexOf(b.position) ?? 99
        return ai - bi
      })
  }, [agents])

  const unaffiliatedAgents = useMemo(() =>
    agents.filter((a: any) => !a.team),
    [agents]
  )

  // Agent card renderer — plain render function (see renderTeamSection note:
  // defining this as a component would remount every card on each parent render).
  // `key` is applied to the returned root element so array children stay keyed.
  const renderAgentCard = (agent: any, accentColor: string, key?: string) => (
    <div
      key={key}
      className={`p-3.5 rounded-xl bg-slate-950/50 border ${accentColor} hover:border-opacity-60 transition-all group`}
    >
      {/* Top: Avatar + Name + Position */}
      <div className="flex items-start gap-3 mb-2.5">
        <span className="text-2xl leading-none flex-shrink-0 mt-0.5">{agent.avatar || '🤖'}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h3 className="text-sm font-semibold text-stone-200 truncate">{agent.name}</h3>
            {agent.isSystem && (
              <Badge variant="outline" className="text-[7px] h-3.5 px-1 bg-fuchsia-950/50 text-fuchsia-300 border-fuchsia-500/55 font-bold tracking-wider">SYS</Badge>
            )}
            {agent.position && (
              <Badge variant="outline" className={`text-[8px] h-4 px-1 ${agent.position === 'TL' ? 'bg-amber-950/50 text-amber-300 border-amber-500/55' : 'bg-slate-950/50 text-stone-400 border-stone-500/55'}`}>
                {agent.position}
              </Badge>
            )}
            {agent.enabled === false && (
              <Badge variant="outline" className="text-[8px] h-4 px-1 bg-red-950/50 text-red-400 border-red-500/55">Tắt</Badge>
            )}
          </div>
          <p className="text-[11px] text-stone-400 line-clamp-2 mt-0.5">{agent.description}</p>
        </div>
      </div>

      {/* Badges */}
      <div className="flex flex-wrap gap-1.5 mb-2.5">
        <Badge variant="outline" className={`text-[9px] h-4.5 px-1.5 ${PROVIDER_BADGE_COLORS[agent.provider] || 'bg-slate-950/50 text-stone-400 border-stone-700'}`}>
          {PROVIDER_OPTIONS.find((p: any) => p.value === agent.provider)?.icon} {agent.provider}
        </Badge>
        <Badge variant="outline" className="text-[9px] h-4.5 px-1.5 bg-slate-950/50 text-stone-300 border-stone-500/55 truncate max-w-[140px]">
          {agent.model}
        </Badge>
        {/* Đề xuất 3 (2026-08-25; cập nhật R25 2026-10-18): badge trực quan
            hóa MODEL POLICY — space-bunny-free = lõi chính (emerald); 4 model
            NIM được duyệt (glm-5.3-flash/glm-5.3/ds-v4.1-flash/nemotron-550b)
            = NIM (amber); model khác = tùy chỉnh (slate). */}
        {agent.model === 'space-bunny-free' ? (
          <Badge variant="outline" className="text-[8px] h-4 px-1.5 bg-emerald-950/50 text-emerald-300 border-emerald-500/55 font-semibold">⭐ mặc định</Badge>
        ) : agent.model === 'z-ai/glm-5.3-flash' || agent.model === 'z-ai/glm-5.3' || agent.model === 'deepseek-ai/deepseek-v4.1-flash' || agent.model === 'nvidia/nemotron-3-ultra-550b-a55b' ? (
          <Badge variant="outline" className="text-[8px] h-4 px-1.5 bg-amber-950/50 text-amber-300 border-amber-500/55 font-semibold">🎮 NIM</Badge>
        ) : (
          <Badge variant="outline" className="text-[8px] h-4 px-1.5 bg-slate-950/50 text-stone-500 border-stone-600/55">↩️ tùy chỉnh</Badge>
        )}
      </div>

      {/* Stats */}
      <div className="flex items-center gap-3 mb-2.5 text-[10px] text-stone-500">
        <span>🌡️ {agent.temperature ?? 0.7}</span>
        <span>📦 {agent.maxTokens != null && agent.maxTokens < 0 ? '∞ tokens' : (agent.maxTokens ?? 4096).toLocaleString()}</span>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between pt-2 border-t border-white/5">
        <div className="flex items-center gap-2">
          <Switch
            checked={agent.enabled ?? true}
            onCheckedChange={(checked) => void toggleAgent(agent.id, checked)}
            className="scale-75 data-[state=checked]:bg-emerald-500"
          />
          <span className="text-[10px] text-stone-500">{agent.enabled !== false ? 'Bật' : 'Tắt'}</span>
        </div>
        <div className="flex items-center gap-0.5 opacity-60 group-hover:opacity-100 transition-opacity">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-stone-400 hover:text-amber-400 hover:bg-amber-950/30"
            onClick={() => openEditDialog(agent)}
          >
            <Pencil className="h-3 w-3" />
          </Button>
          {!agent.isSystem && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 text-stone-400 hover:text-red-400 hover:bg-red-950/30"
              onClick={() => void deleteAgent(agent.id, agent.name)}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )

  // Team section renderer — 3-per-row grid layout.
  // PERF FIX: this is a plain render FUNCTION (not a component created during render).
  // Defining it as `const TeamSection = (...) => <div>...` and using <TeamSection/>
  // created a NEW component type on every AgentsModule render, forcing React to
  // unmount/remount the whole team subtree (losing AgentCard internal state and
  // wasting DOM work) on every state change. Calling it as a function keeps the
  // output inline in the parent's element tree.
  const renderTeamSection = ({ teamKey, label, icon, iconBg, agents: teamAgents, borderColor, accentBg }: {
    teamKey: string; label: string; icon: React.ReactNode; iconBg: string
    agents: any[]; borderColor: string; accentBg: string
  }) => (
    <div className="space-y-3">
      {/* Team header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className={`p-1.5 rounded-lg ${iconBg}`}>
            {icon}
          </div>
          <h3 className="text-sm font-semibold text-stone-100">{label}</h3>
          <Badge className={`text-[10px] ${accentBg}`}>{teamAgents.length}</Badge>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[10px] text-stone-400 hover:text-stone-200 hover:bg-slate-950/60"
          onClick={() => { resetForm(); setFormTeam(teamKey); setDialogOpen(true) }}
        >
          <Plus className="h-3 w-3 mr-1" /> Thêm vào {label}
        </Button>
      </div>

      {/* Empty team */}
      {teamAgents.length === 0 && (
        <div className={`p-6 rounded-xl border border-dashed ${borderColor} text-center`}>
          <p className="text-xs text-stone-500">Chưa có thành viên — nhấn "Thêm vào {label}" để tạo</p>
        </div>
      )}

      {/* 3-per-row grid */}
      {teamAgents.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {teamAgents.map((agent: any) => renderAgentCard(agent, borderColor, agent.id))}
        </div>
      )}
    </div>
  )

  return (
    <div className="nc-wrap nc-magenta">
      {/* ==================== AGENTS MODULE ==================== */}
      <Card className="nc-panel nc-md nc-border-magenta">
        <CardContent className="pt-5 pb-5">
          {/* ==================== TABS: AGENTS / SKILLS ==================== */}
          <div className="flex items-center gap-1.5 p-1 rounded-lg bg-slate-950/60 border border-stone-700/50 mb-5 w-fit" role="tablist" aria-label="Agents module tabs" data-testid="agents-tabs">
            <button
              type="button"
              role="tab"
              aria-selected={activeAgentsTab === 'agents'}
              data-testid="agents-tab-agents"
              onClick={() => setActiveAgentsTab('agents')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${activeAgentsTab === 'agents' ? 'bg-fuchsia-600/85 text-white' : 'text-stone-400 hover:text-stone-200'}`}
            >
              Agents
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeAgentsTab === 'skills'}
              data-testid="agents-tab-skills"
              onClick={() => setActiveAgentsTab('skills')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${activeAgentsTab === 'skills' ? 'bg-fuchsia-600/85 text-white' : 'text-stone-400 hover:text-stone-200'}`}
            >
              Tools &amp; Skills
            </button>
          </div>

          {activeAgentsTab === 'skills' ? (
            <SkillsTabContent />
          ) : (
          <>
          {/* Module Header */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-gradient-to-br from-fuchsia-500 to-pink-600">
                <Bot className="h-4 w-4 text-white" />
              </div>
              <h2 className="text-sm font-semibold tracking-tight text-stone-100">Agents</h2>
              <Badge className="text-[10px] bg-fuchsia-950/50 text-fuchsia-400 border border-fuchsia-500/55">
                {agents.length}
              </Badge>
            </div>
            <Button
              onClick={openCreateDialog}
              size="sm"
              className="h-8 px-3 text-xs bg-gradient-to-r from-fuchsia-600 to-pink-600 hover:from-fuchsia-500 hover:to-pink-500 text-white border-0"
            >
              <Plus className="h-3.5 w-3.5 mr-1" /> Tạo Agent mới
            </Button>
          </div>

          {/* Loading */}
          {loading && (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-8 w-8 animate-spin text-fuchsia-400" />
            </div>
          )}

          {/* Error state — show when API fails */}
          {!loading && loadError && agents.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="p-4 rounded-2xl bg-red-950/30 border border-red-500/40 mb-4">
                <AlertTriangle className="h-10 w-10 text-red-400/70" />
              </div>
              <p className="text-sm text-red-400 font-medium mb-1">Không thể tải danh sách Agents</p>
              <p className="text-xs text-stone-500 max-w-md mb-3">{loadError}</p>
              <div className="text-[10px] text-stone-600 space-y-1 mb-4">
                <p>💡 Kiểm tra:</p>
                <p>• Đã chạy <code className="text-stone-400 bg-slate-950/60 px-1 rounded">bun run db:push</code> chưa?</p>
                <p>• File <code className="text-stone-400 bg-slate-950/60 px-1 rounded">.env</code> đã có DATABASE_URL chưa?</p>
                <p>• Dev server đang chạy trên port 3000?</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-4 text-xs border-fuchsia-400/35 text-fuchsia-400 hover:bg-fuchsia-950/30"
                onClick={() => void fetchAgents()}
              >
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Thử lại
              </Button>
            </div>
          )}

          {/* Empty state — no agents but no error */}
          {!loading && !loadError && agents.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="p-4 rounded-2xl bg-slate-950/50 border border-fuchsia-400/35 mb-4">
                <Bot className="h-10 w-10 text-fuchsia-400/60" />
              </div>
              <p className="text-sm text-stone-400 mb-1">Chưa có Agent nào</p>
              <p className="text-xs text-stone-500">Tạo Agent đầu tiên để bắt đầu xây dựng hệ thống đa tác nhân</p>
            </div>
          )}

          {/* Team Sections */}
          {!loading && agents.length > 0 && (
            <div className="space-y-6">
              {/* ═══ Team Code ═══ */}
              {renderTeamSection({
                teamKey: 'code',
                label: '💻 Team Code',
                icon: <Code2 className="h-4 w-4 text-white" />,
                iconBg: 'bg-gradient-to-br from-amber-500 to-orange-600',
                agents: codeAgents,
                borderColor: 'border-amber-400/35',
                accentBg: 'bg-amber-950/50 text-amber-400 border border-amber-500/55',
              })}

              {/* Divider */}
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-fuchsia-500/10" />
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-1.5 rounded-full bg-fuchsia-500/30" />
                  <div className="h-1.5 w-1.5 rounded-full bg-fuchsia-500/20" />
                  <div className="h-1.5 w-1.5 rounded-full bg-fuchsia-500/10" />
                </div>
                <div className="flex-1 h-px bg-fuchsia-500/10" />
              </div>

              {/* ═══ Team Research ═══ */}
              {renderTeamSection({
                teamKey: 'research',
                label: '🔬 Team Research',
                icon: <GraduationCap className="h-4 w-4 text-white" />,
                iconBg: 'bg-gradient-to-br from-cyan-500 to-teal-600',
                agents: researchAgents,
                borderColor: 'border-cyan-400/35',
                accentBg: 'bg-cyan-950/50 text-cyan-400 border border-cyan-500/55',
              })}

              {/* Unaffiliated Agents */}
              {unaffiliatedAgents.length > 0 && (
                <>
                  <div className="flex items-center gap-3">
                    <div className="flex-1 h-px bg-fuchsia-500/10" />
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-1.5 rounded-full bg-fuchsia-500/30" />
                      <div className="h-1.5 w-1.5 rounded-full bg-fuchsia-500/20" />
                      <div className="h-1.5 w-1.5 rounded-full bg-fuchsia-500/10" />
                    </div>
                    <div className="flex-1 h-px bg-fuchsia-500/10" />
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center gap-2.5">
                      <div className="p-1.5 rounded-lg bg-gradient-to-br from-stone-500 to-stone-600">
                        <User className="h-4 w-4 text-white" />
                      </div>
                      <h3 className="text-sm font-semibold text-stone-100">Độc lập</h3>
                      <Badge className="text-[10px] bg-slate-950/50 text-stone-400 border border-stone-500/55">{unaffiliatedAgents.length}</Badge>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                      {unaffiliatedAgents.map((agent: any) => renderAgentCard(agent, 'border-stone-500/45', agent.id))}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
          </>
          )}
        </CardContent>
      </Card>

      {/* ==================== CREATE/EDIT AGENT DIALOG ==================== */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) closeDialog() }}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto overflow-x-hidden bg-slate-950 border-fuchsia-400/35 text-stone-200 dialog-scrollbar pr-5">
          <DialogHeader>
            <DialogTitle className="text-fuchsia-400 flex items-center gap-2">
              <Bot className="h-5 w-5" />
              {editingAgent ? 'Sửa Agent' : 'Tạo Agent mới'}
            </DialogTitle>
            <DialogDescription className="text-stone-400 text-xs">
              {editingAgent ? 'Chỉnh sửa thông tin và cấu hình Agent' : 'Thiết lập Agent mới với vai trò, hướng dẫn và cấu hình AI'}
            </DialogDescription>
          </DialogHeader>

          {/* Error message */}
          {formError && (
            <div className="p-3 rounded-lg bg-red-950/30 border border-red-500/55 text-xs text-red-400 flex items-center gap-2">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
              {formError}
            </div>
          )}

          {/* Avatar Picker */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-stone-300">Avatar</label>
            <div className="flex flex-wrap gap-1.5">
              {AVATAR_OPTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => setFormAvatar(emoji)}
                  className={`h-8 w-8 rounded-lg text-base flex items-center justify-center border transition-all ${
                    formAvatar === emoji
                      ? 'border-fuchsia-500 bg-fuchsia-950/40 ring-1 ring-fuchsia-500/50'
                      : 'border-stone-500/55 bg-slate-950/30 hover:border-stone-600'
                  }`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>

          {/* Tên Agent */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-stone-300">
              Tên Agent <span className="text-red-400">*</span>
            </label>
            <Input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="VD: Code Architect"
              maxLength={50}
              className="text-xs h-9 bg-slate-950/50 border-fuchsia-400/35 text-stone-200 placeholder:text-stone-600 focus:border-fuchsia-500/50"
            />
            <p className="text-[10px] text-stone-500">{formName.length}/50</p>
          </div>

          {/* Mô tả vai trò — Textarea với giới hạn 10000 */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-stone-300">
              Mô tả vai trò <span className="text-red-400">*</span>
            </label>
            <Textarea
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              placeholder="Mô tả chi tiết vai trò, trách nhiệm và chuyên môn của Agent..."
              maxLength={10000}
              rows={4}
              className="text-xs bg-slate-950/50 border-fuchsia-400/35 text-stone-200 placeholder:text-stone-600 focus:border-fuchsia-500/50 resize-none max-h-40 dialog-scrollbar overflow-y-auto"
            />
            <p className="text-[10px] text-stone-500">{formDescription.length}/10,000</p>
          </div>

          {/* Hướng dẫn chi tiết — Textarea với giới hạn 10000 */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-stone-300">
              Hướng dẫn chi tiết (System Prompt) <span className="text-red-400">*</span>
            </label>
            <Textarea
              value={formInstruction}
              onChange={(e) => setFormInstruction(e.target.value)}
              placeholder="Nhập hướng dẫn chi tiết cho Agent — nội dung này sẽ được sử dụng làm system prompt khi Agent hoạt động..."
              maxLength={10000}
              rows={6}
              className="text-xs bg-slate-950/50 border-fuchsia-400/35 text-stone-200 placeholder:text-stone-600 focus:border-fuchsia-500/50 resize-none max-h-52 dialog-scrollbar overflow-y-auto"
            />
            <p className="text-[10px] text-stone-500">{formInstruction.length}/10,000</p>
          </div>

          {/* Divider — AI Core */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-fuchsia-500/20" />
            <span className="text-[10px] text-fuchsia-400/60 font-medium uppercase tracking-wider">Lõi AI</span>
            <div className="flex-1 h-px bg-fuchsia-500/20" />
          </div>

          {/* Provider + Model + Team + Position — all in one row */}
          <div className="grid grid-cols-4 gap-2">
            {/* Provider */}
            <div className="space-y-1">
              <label className="text-[10px] font-medium text-stone-300">
                Provider <span className="text-red-400">*</span>
              </label>
              <Select value={formProvider} onValueChange={handleProviderChange}>
                <SelectTrigger className="w-full h-8 text-[10px] rounded-lg border-fuchsia-400/35 text-stone-200 bg-slate-950/50 focus:border-fuchsia-500/50">
                  <SelectValue placeholder="Provider" />
                </SelectTrigger>
                <SelectContent className="bg-slate-950/95 border-fuchsia-400/35">
                  {PROVIDER_OPTIONS.map((p) => (
                    <SelectItem key={p.value} value={p.value} className="text-stone-200 focus:text-white focus:bg-stone-800/80 text-xs">
                      {p.icon} {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Model */}
            <div className="space-y-1">
              <label className="text-[10px] font-medium text-stone-300">
                Model <span className="text-red-400">*</span>
              </label>
              {/* FB-P6-R1-C-06: refetch khi mở dropdown — badge Q không stale
                  suốt đời module (mirror pattern refetch-on-open của smolab) */}
              <Select value={formModel} onValueChange={setFormModel} onOpenChange={(open) => { if (open) void fetchModels() }}>
                <SelectTrigger className="w-full h-8 text-[10px] rounded-lg border-fuchsia-400/35 text-stone-200 bg-slate-950/50 focus:border-fuchsia-500/50">
                  <SelectValue placeholder="Model" />
                </SelectTrigger>
                <SelectContent className="bg-slate-950/95 border-fuchsia-400/35">
                  {currentProviderModels.map((m: any) => {
                    // P6-M4 — badge "Q đề xuất" trên model top-Q (FB-P6-R1-C-04 sửa
                    // comment: SelectItem CHẤP NHẬN span con — text-marker là lựa chọn
                    // thiết kế giữ markup 1 dòng, không phải giới hạn Radix).
                    // FB-P6-R1-C-05: chỉ đề xuất khi Q thực sự DƯƠNG (q>0) —
                    // "phần thưởng trung bình cao nhất" trong nhóm toàn âm là gây hiểu nhầm.
                    const qTop = qAdvice?.top?.[0]
                    const isQRecommended = qTop && qTop.model === m.id && qTop.visits > 0 && qTop.q > 0
                    return (
                    <SelectItem
                      key={m.id}
                      value={m.id}
                      className="text-stone-200 focus:text-white focus:bg-stone-800/80 text-xs"
                      title={isQRecommended ? `Q học được đề xuất (P6): phần thưởng trung bình cao nhất (${qTop!.q.toFixed(2)}, ${qTop!.visits} runs) — tham khảo, không bắt buộc.` : undefined}
                    >
                      {m.label || m.id}{isQRecommended ? ' · ★ Q đề xuất' : ''}
                    </SelectItem>
                    )
                  })}
                  {currentProviderModels.length === 0 && (
                    <div className="px-3 py-2 text-xs text-stone-500">Chọn provider trước</div>
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* Team */}
            <div className="space-y-1">
              <label className="text-[10px] font-medium text-stone-300">Team</label>
              <Select value={formTeam || '_none'} onValueChange={handleTeamChange}>
                <SelectTrigger className="w-full h-8 text-[10px] rounded-lg border-fuchsia-400/35 text-stone-200 bg-slate-950/50 focus:border-fuchsia-500/50">
                  <SelectValue placeholder="Team" />
                </SelectTrigger>
                <SelectContent className="bg-slate-950/95 border-fuchsia-400/35">
                  <SelectItem value="_none" className="text-stone-200 focus:text-white focus:bg-stone-800/80 text-xs">
                    Không chọn
                  </SelectItem>
                  {TEAM_OPTIONS.map((t) => (
                    <SelectItem key={t.value} value={t.value} className="text-stone-200 focus:text-white focus:bg-stone-800/80 text-xs">
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Position */}
            <div className="space-y-1">
              <label className="text-[10px] font-medium text-stone-300">
                Vị trí {formTeam && <span className="text-red-400">*</span>}
              </label>
              <Select value={formPosition || ''} onValueChange={setFormPosition} disabled={!formTeam}>
                <SelectTrigger className="w-full h-8 text-[10px] rounded-lg border-fuchsia-400/35 text-stone-200 bg-slate-950/50 focus:border-fuchsia-500/50 disabled:opacity-40">
                  <SelectValue placeholder={formTeam ? 'Vị trí' : '—'} />
                </SelectTrigger>
                <SelectContent className="bg-slate-950/95 border-fuchsia-400/35">
                  {(TEAM_POSITIONS[formTeam!] || []).map((pos) => (
                    <SelectItem key={pos} value={pos} className="text-stone-200 focus:text-white focus:bg-stone-800/80 text-xs">
                      {pos} — {POSITION_LABELS[pos] || pos}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Temperature + Max Tokens — inline row */}
          <div className="grid grid-cols-[1fr_auto] gap-4 items-end">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-stone-300 flex items-center justify-between">
                <span>Temperature</span>
                <span className="text-fuchsia-400 font-mono">{formTemperature.toFixed(1)}</span>
              </label>
              <Slider
                value={[formTemperature]}
                onValueChange={([val]) => setFormTemperature(val)}
                min={0}
                max={2}
                step={0.1}
                className="py-2 [&_[data-slot=slider-range]]:bg-fuchsia-500 [&_[data-slot=slider-thumb]]:border-fuchsia-500"
              />
              <div className="flex justify-between text-[9px] text-stone-600">
                <span>0.0 (Precise)</span>
                <span>2.0 (Creative)</span>
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-stone-300 flex items-center justify-between">
                <span>Max Tokens</span>
                {/* TASK 39 — -1 = unlimited: Zen bỏ max_tokens → model output tối đa 512k */}
                <span className="text-fuchsia-400 font-mono">{formMaxTokens < 0 ? '∞ không giới hạn' : formMaxTokens.toLocaleString()}</span>
              </label>
              <Input
                type="number"
                value={formMaxTokens}
                onChange={(e) => setFormMaxTokens(Number(e.target.value))}
                min={-1}
                max={524288}
                className="text-xs h-8 bg-slate-950/50 border-fuchsia-400/35 text-stone-200 focus:border-fuchsia-500/50 w-28"
              />
              <div className="flex justify-between text-[9px] text-stone-600">
                <button type="button" className="hover:text-fuchsia-400" onClick={() => setFormMaxTokens(-1)}>-1 = ∞ tùy ý</button>
                <span>256 → 524288</span>
              </div>
            </div>
          </div>

          {/* Dialog Actions */}
          <DialogFooter className="pt-2 border-t border-fuchsia-500/10">
            <Button
              variant="ghost"
              size="sm"
              className="h-9 px-4 text-xs text-stone-400 hover:text-stone-200"
              onClick={closeDialog}
            >
              Hủy
            </Button>
            <Button
              size="sm"
              className="h-9 px-4 text-xs bg-gradient-to-r from-fuchsia-600 to-pink-600 hover:from-fuchsia-500 hover:to-pink-500 text-white border-0"
              disabled={saving}
              onClick={() => void saveAgent()}
            >
              {saving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
              {editingAgent ? 'Lưu thay đổi' : 'Tạo Agent'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

