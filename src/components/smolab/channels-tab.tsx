'use client'

// ========================================================================
// channels-tab — Tab Channels (Smolab)
// PERF-SPLIT 2026-09-03: trích xuất nguyên vẹn từ src/app/page.tsx (không đổi logic)
// ========================================================================

import { useState, useCallback, useEffect } from 'react'
import { XCircle, Loader2, RefreshCw, Check, Activity, Play, MessageSquare, Send, Sparkles, MessageCircle, X, Settings, Radio, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/hooks/use-toast'


// ==================== CHANNELS TAB CONTENT (Phase 6) ====================

export function ChannelsTabContent() {
  // Channels list
  const [channels, setChannels] = useState<Array<{
    channelType: string; icon: string; label: string; enabled: boolean;
    connected: boolean; config: Record<string, string>; connectedAt: string | null;
    gatewayStatus: string | null;
  }> | null>(null)
  const [channelsLoading, setChannelsLoading] = useState(false)

  // Selected channel for config
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null)
  const [channelConfig, setChannelConfig] = useState<{
    channelType: string; label: string; enabled: boolean; connectedAt: string | null;
    config: Record<string, string>; fields: Array<{ key: string; label: string; type: string; placeholder?: string; options?: string[] }>;
  } | null>(null)
  const [configLoading, setConfigLoading] = useState(false)
  const [configSaving, setConfigSaving] = useState(false)
  const [editedConfig, setEditedConfig] = useState<Record<string, string>>({})

  // Messages
  const [messages, setMessages] = useState<Array<{
    id: string; channel: string; direction: string; sender: string;
    content: string; timestamp: string; agentReplied: boolean; agentReply: string | null;
  }> | null>(null)
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [msgFilter, setMsgFilter] = useState('all')

  // Reply
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyChannel, setReplyChannel] = useState<string>('webchat')
  const [replyContent, setReplyContent] = useState('')
  const [replySending, setReplySending] = useState(false)

  // Testing channel
  const [testingChannel, setTestingChannel] = useState<string | null>(null)

  // Load channels
  const loadChannels = useCallback(async () => {
    setChannelsLoading(true)
    try {
      const res = await fetch('/api/openclaw/channels')
      const data = await res.json()
      setChannels(data.channels || [])
    } catch (err) {
      console.error('Failed to load channels:', err)
    } finally {
      setChannelsLoading(false)
    }
  }, [])

  // Load channel config
  const loadConfig = useCallback(async (channelType: string) => {
    setConfigLoading(true)
    try {
      const res = await fetch(`/api/openclaw/channels/config?channel=${channelType}`)
      const data = await res.json()
      setChannelConfig(data)
      setEditedConfig(data.config || {})
    } catch (err) {
      console.error('Failed to load config:', err)
    } finally {
      setConfigLoading(false)
    }
  }, [])

  // Load messages
  const loadMessages = useCallback(async (channel?: string) => {
    setMessagesLoading(true)
    try {
      const ch = channel || msgFilter
      const res = await fetch(`/api/openclaw/channels/messages?channel=${ch}&limit=50`)
      const data = await res.json()
      setMessages(data.messages || [])
    } catch (err) {
      console.error('Failed to load messages:', err)
    } finally {
      setMessagesLoading(false)
    }
  }, [msgFilter])

  // (queueMicrotask: defer để không gọi setState đồng bộ trong body effect)
  useEffect(() => { queueMicrotask(() => { loadChannels() }) }, [loadChannels])
  useEffect(() => {
    queueMicrotask(() => { loadMessages() })
    // REQ-AUDIT FIX1 (2026-10-19) — tab ẩn: skip poll tin nhắn kênh
    const interval = setInterval(() => {
      if (document.hidden) return
      void loadMessages()
    }, 30000)
    return () => clearInterval(interval)
  }, [loadMessages])

  // Connect channel
  const handleConnect = async (channelType: string) => {
    try {
      await fetch('/api/openclaw/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'connect', channelType, config: {} }),
      })
      toast({ title: 'Kết nối thành công', description: `Kênh ${channelType} đã được bật` })
      loadChannels()
    } catch {
      toast({ title: 'Lỗi', description: 'Không thể kết nối kênh', variant: 'destructive' })
    }
  }

  // Disconnect channel
  const handleDisconnect = async (channelType: string) => {
    try {
      await fetch('/api/openclaw/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'disconnect', channelType }),
      })
      toast({ title: 'Đã ngắt kết nối', description: `Kênh ${channelType} đã được tắt` })
      loadChannels()
      if (selectedChannel === channelType) {
        setSelectedChannel(null)
        setChannelConfig(null)
      }
    } catch {
      toast({ title: 'Lỗi', description: 'Không thể ngắt kết nối', variant: 'destructive' })
    }
  }

  // Test channel
  const handleTest = async (channelType: string) => {
    setTestingChannel(channelType)
    try {
      const res = await fetch('/api/openclaw/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test', channelType }),
      })
      const data = await res.json()
      if (data.success) {
        toast({ title: 'Test thành công', description: `Kênh ${channelType} phản hồi OK` })
      } else {
        toast({ title: 'Test thất bại', description: data.error || 'Kênh không phản hồi', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi', description: 'Không thể test kênh', variant: 'destructive' })
    } finally {
      setTestingChannel(null)
    }
  }

  // Save config
  const handleSaveConfig = async () => {
    if (!selectedChannel) return
    setConfigSaving(true)
    try {
      const res = await fetch(`/api/openclaw/channels/config?channel=${selectedChannel}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: editedConfig, enabled: true }),
      })
      const data = await res.json()
      if (data.success) {
        toast({ title: 'Đã lưu', description: `Cấu hình ${selectedChannel} đã được cập nhật` })
        loadChannels()
        loadConfig(selectedChannel)
      } else {
        toast({ title: 'Lỗi', description: data.error || 'Không thể lưu', variant: 'destructive' })
      }
    } catch {
      toast({ title: 'Lỗi', description: 'Không thể lưu cấu hình', variant: 'destructive' })
    } finally {
      setConfigSaving(false)
    }
  }

  // Open config for a channel
  const openConfig = (channelType: string) => {
    setSelectedChannel(channelType)
    loadConfig(channelType)
  }

  // Send reply
  const handleReply = async () => {
    if (!replyTo || !replyContent.trim()) return
    setReplySending(true)
    try {
      await fetch('/api/openclaw/channels/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: replyChannel, messageId: replyTo, content: replyContent }),
      })
      toast({ title: 'Đã gửi', description: 'Phản hồi đã được gửi' })
      setReplyTo(null)
      setReplyContent('')
      loadMessages()
    } catch {
      toast({ title: 'Lỗi', description: 'Không thể gửi phản hồi', variant: 'destructive' })
    } finally {
      setReplySending(false)
    }
  }

  const connectedCount = channels?.filter(c => c.connected).length || 0
  const totalMessages = messages?.length || 0

  return (
    <div className="space-y-4 overflow-y-auto max-h-[calc(100vh-160px)] pr-1">
      {/* ─── Header Stats ─── */}
      <div className="grid grid-cols-3 gap-3">
        <div className="nc-wrap nc-teal"><div className="nc-panel nc-sm nc-border-teal metric-sparkle p-3">
          <div className="flex items-center gap-2">
            <Radio className="h-4 w-4 text-teal-400" />
            <span className="text-[10px] text-teal-400/70 uppercase tracking-wider">Kênh đã kết nối</span>
          </div>
          <div className="text-xl font-bold text-teal-300 mt-1">{connectedCount}<span className="text-xs text-stone-500">/{channels?.length || 6}</span></div>
        </div></div>
        <div className="nc-wrap nc-teal"><div className="nc-panel nc-sm nc-border-teal metric-sparkle p-3">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-teal-400" />
            <span className="text-[10px] text-teal-400/70 uppercase tracking-wider">Tin nhắn gần đây</span>
          </div>
          <div className="text-xl font-bold text-teal-300 mt-1">{totalMessages}</div>
        </div></div>
        <div className="nc-wrap nc-teal"><div className="nc-panel nc-sm nc-border-teal metric-sparkle p-3">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-teal-400" />
            <span className="text-[10px] text-teal-400/70 uppercase tracking-wider">Trạng thái</span>
          </div>
          <div className="text-sm font-bold text-teal-300 mt-1">{connectedCount > 0 ? 'Hoạt động' : 'Chưa kết nối'}</div>
        </div></div>
      </div>

      {/* ─── Section 1: Channel List ─── */}
      <div className="nc-wrap nc-teal">
        <div className="nc-panel nc-md nc-border-teal p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Radio className="h-4 w-4 text-teal-400" />
              <h3 className="text-sm font-bold text-teal-300 uppercase tracking-wider">Kênh giao tiếp</h3>
            </div>
            <Button onClick={() => loadChannels()} variant="ghost" size="sm" className="h-6 px-2 text-teal-400 hover:text-teal-300">
              <RefreshCw className={`h-3 w-3 ${channelsLoading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {channelsLoading && !channels ? (
              <div className="col-span-3 text-center py-6"><Loader2 className="h-5 w-5 animate-spin text-teal-400 mx-auto" /></div>
            ) : (channels || []).map(ch => (
              <div key={ch.channelType} className="nc-wrap nc-teal">
                <div className="nc-panel nc-sm nc-border-teal p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-lg">{ch.icon}</span>
                      <span className="text-xs font-bold text-stone-200">{ch.label}</span>
                    </div>
                    <Badge className={`text-[9px] px-1.5 py-0 ${ch.connected ? 'bg-teal-500/20 text-teal-300 border-teal-400/50' : 'bg-slate-700/50 text-stone-500 border-slate-400/50'}`}>
                      {ch.connected ? 'Online' : 'Offline'}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1.5 mt-2">
                    {ch.connected ? (
                      <>
                        <Button onClick={() => openConfig(ch.channelType)} variant="ghost" size="sm" className="h-6 px-2 text-[10px] text-teal-400 hover:text-teal-300 hover:bg-teal-500/10 border border-teal-400/35">
                          <Settings className="h-3 w-3 mr-1" /> Cấu hình
                        </Button>
                        <Button onClick={() => handleTest(ch.channelType)} variant="ghost" size="sm" disabled={testingChannel === ch.channelType} className="h-6 px-2 text-[10px] text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 border border-amber-400/35">
                          {testingChannel === ch.channelType ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Play className="h-3 w-3 mr-1" />} Test
                        </Button>
                        <Button onClick={() => handleDisconnect(ch.channelType)} variant="ghost" size="sm" className="h-6 px-2 text-[10px] text-red-400 hover:text-red-300 hover:bg-red-500/10 border border-red-400/35">
                          <XCircle className="h-3 w-3" />
                        </Button>
                      </>
                    ) : (
                      <Button onClick={() => openConfig(ch.channelType)} variant="ghost" size="sm" className="h-6 px-2 text-[10px] text-teal-400 hover:text-teal-300 hover:bg-teal-500/10 border border-teal-400/35">
                        <Plus className="h-3 w-3 mr-1" /> Cài đặt
                      </Button>
                    )}
                  </div>
                  {ch.connectedAt && (
                    <div className="text-[9px] text-stone-500 mt-1.5">
                      Kết nối: {new Date(ch.connectedAt).toLocaleString('vi-VN')}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ─── Section 2: Channel Config ─── */}
      {selectedChannel && channelConfig && (
        <div className="nc-wrap nc-teal">
          <div className="nc-panel nc-md nc-border-teal p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Settings className="h-4 w-4 text-teal-400" />
                <h3 className="text-sm font-bold text-teal-300 uppercase tracking-wider">Cấu hình {channelConfig.label}</h3>
              </div>
              <Button onClick={() => { setSelectedChannel(null); setChannelConfig(null) }} variant="ghost" size="sm" className="h-6 px-2 text-stone-400 hover:text-stone-200">
                <X className="h-3 w-3" />
              </Button>
            </div>
            {configLoading ? (
              <div className="text-center py-4"><Loader2 className="h-5 w-5 animate-spin text-teal-400 mx-auto" /></div>
            ) : (
              <div className="space-y-3">
                {channelConfig.fields.map(field => (
                  <div key={field.key}>
                    <label className="text-[10px] text-teal-400/70 uppercase tracking-wider mb-1 block">{field.label}</label>
                    {field.type === 'password' ? (
                      <Input
                        type="password"
                        value={editedConfig[field.key] || ''}
                        onChange={e => setEditedConfig(prev => ({ ...prev, [field.key]: e.target.value }))}
                        placeholder={field.placeholder || ''}
                        className="h-7 text-xs bg-slate-950/60 border-teal-400/35 text-stone-200 placeholder:text-stone-600 focus:border-teal-500/40"
                      />
                    ) : field.type === 'select' && field.options ? (
                      <Select value={editedConfig[field.key] || ''} onValueChange={v => setEditedConfig(prev => ({ ...prev, [field.key]: v }))}>
                        <SelectTrigger className="h-7 text-xs bg-slate-950/60 border-teal-400/35 text-stone-200">
                          <SelectValue placeholder={field.placeholder || 'Chọn...'} />
                        </SelectTrigger>
                        <SelectContent className="bg-slate-900 border-teal-400/35">
                          {field.options.map(opt => <SelectItem key={opt} value={opt} className="text-xs text-stone-200">{opt}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    ) : field.type === 'number' ? (
                      <Input
                        type="number"
                        value={editedConfig[field.key] || ''}
                        onChange={e => setEditedConfig(prev => ({ ...prev, [field.key]: e.target.value }))}
                        placeholder={field.placeholder || ''}
                        className="h-7 text-xs bg-slate-950/60 border-teal-400/35 text-stone-200 placeholder:text-stone-600 focus:border-teal-500/40"
                      />
                    ) : (
                      <Input
                        type="text"
                        value={editedConfig[field.key] || ''}
                        onChange={e => setEditedConfig(prev => ({ ...prev, [field.key]: e.target.value }))}
                        placeholder={field.placeholder || ''}
                        className="h-7 text-xs bg-slate-950/60 border-teal-400/35 text-stone-200 placeholder:text-stone-600 focus:border-teal-500/40"
                      />
                    )}
                  </div>
                ))}
                <div className="flex items-center gap-2 pt-2">
                  <Button onClick={handleSaveConfig} disabled={configSaving} className="chamfer-sm h-7 px-3 bg-gradient-to-r from-teal-500/80 to-emerald-600/80 hover:from-teal-600/80 hover:to-emerald-700/80 text-white border-0 text-[10px]">
                    {configSaving ? <><Loader2 className="mr-1 h-3 w-3 animate-spin" /> Đang lưu...</> : <><Check className="mr-1 h-3 w-3" /> Lưu & Kết nối</>}
                  </Button>
                  <Button onClick={() => handleTest(selectedChannel)} disabled={testingChannel === selectedChannel} variant="ghost" size="sm" className="h-7 px-3 text-[10px] text-amber-400 hover:text-amber-300 border border-amber-400/35">
                    {testingChannel === selectedChannel ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Play className="mr-1 h-3 w-3" />} Test kết nối
                  </Button>
                  {channelConfig.enabled && (
                    <Button onClick={() => handleDisconnect(selectedChannel)} variant="ghost" size="sm" className="h-7 px-3 text-[10px] text-red-400 hover:text-red-300 border border-red-400/35">
                      <XCircle className="mr-1 h-3 w-3" /> Ngắt kết nối
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── Section 3: Message Monitor ─── */}
      <div className="nc-wrap nc-teal">
        <div className="nc-panel nc-md nc-border-teal p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-teal-400" />
              <h3 className="text-sm font-bold text-teal-300 uppercase tracking-wider">Theo dõi tin nhắn</h3>
            </div>
            <div className="flex items-center gap-2">
              <Select value={msgFilter} onValueChange={v => { setMsgFilter(v); loadMessages(v) }}>
                <SelectTrigger className="h-6 w-24 text-[10px] bg-slate-950/60 border-teal-400/35 text-stone-200">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-900 border-teal-400/35">
                  <SelectItem value="all" className="text-xs text-stone-200">Tất cả</SelectItem>
                  <SelectItem value="telegram" className="text-xs text-stone-200">💬 Telegram</SelectItem>
                  <SelectItem value="discord" className="text-xs text-stone-200">🎮 Discord</SelectItem>
                  <SelectItem value="slack" className="text-xs text-stone-200">📱 Slack</SelectItem>
                  <SelectItem value="webchat" className="text-xs text-stone-200">🌐 WebChat</SelectItem>
                  <SelectItem value="whatsapp" className="text-xs text-stone-200">📞 WhatsApp</SelectItem>
                  <SelectItem value="signal" className="text-xs text-stone-200">🔒 Signal</SelectItem>
                </SelectContent>
              </Select>
              <Button onClick={() => loadMessages()} variant="ghost" size="sm" className="h-6 px-2 text-teal-400 hover:text-teal-300">
                <RefreshCw className={`h-3 w-3 ${messagesLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto space-y-1.5 custom-scrollbar">
            {messagesLoading && !messages ? (
              <div className="text-center py-6"><Loader2 className="h-5 w-5 animate-spin text-teal-400 mx-auto" /></div>
            ) : (messages || []).length === 0 ? (
              <div className="text-center py-6 text-stone-500 text-xs">Chưa có tin nhắn</div>
            ) : (messages || []).map(msg => {
              const channelIcon: Record<string, string> = { telegram: '💬', discord: '🎮', slack: '📱', webchat: '🌐', whatsapp: '📞', signal: '🔒' }
              return (
                <div key={msg.id} className="flex items-start gap-2 p-2 rounded-lg bg-slate-950/40 border border-teal-400/25 hover:border-teal-400/35 transition-colors">
                  <span className="text-sm mt-0.5">{channelIcon[msg.channel] || '📡'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[10px] font-bold text-teal-300">{msg.sender}</span>
                      <span className="text-[9px] text-stone-600">{new Date(msg.timestamp).toLocaleString('vi-VN')}</span>
                      {msg.direction === 'inbound' ? (
                        <Badge className="text-[8px] px-1 py-0 bg-blue-500/20 text-blue-300 border-blue-400/50">Nhận</Badge>
                      ) : (
                        <Badge className="text-[8px] px-1 py-0 bg-teal-500/20 text-teal-300 border-teal-400/50">Gửi</Badge>
                      )}
                    </div>
                    <p className="text-xs text-stone-300 break-words">{msg.content}</p>
                    {msg.agentReplied && msg.agentReply && (
                      <div className="mt-1 p-1.5 rounded bg-teal-500/5 border border-teal-400/25">
                        <div className="flex items-center gap-1 mb-0.5">
                          <Sparkles className="h-2.5 w-2.5 text-teal-400" />
                          <span className="text-[9px] text-teal-400">Agent phản hồi</span>
                        </div>
                        <p className="text-[11px] text-stone-400 break-words">{msg.agentReply}</p>
                      </div>
                    )}
                  </div>
                  <Button onClick={() => { setReplyTo(msg.id); setReplyChannel(msg.channel); setReplyContent('') }} variant="ghost" size="sm" className="h-5 w-5 p-0 text-stone-500 hover:text-teal-400 flex-shrink-0">
                    <MessageCircle className="h-3 w-3" />
                  </Button>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* ─── Section 4: Reply Panel ─── */}
      {replyTo && (
        <div className="nc-wrap nc-teal">
          <div className="nc-panel nc-md nc-border-teal p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Send className="h-4 w-4 text-teal-400" />
                <h3 className="text-sm font-bold text-teal-300 uppercase tracking-wider">Phản hồi tin nhắn</h3>
              </div>
              <Button onClick={() => { setReplyTo(null); setReplyChannel('webchat'); setReplyContent('') }} variant="ghost" size="sm" className="h-6 px-2 text-stone-400 hover:text-stone-200">
                <X className="h-3 w-3" />
              </Button>
            </div>
            <Textarea
              value={replyContent}
              onChange={e => setReplyContent(e.target.value)}
              placeholder={`Nhập phản hồi trên kênh ${replyChannel}... (Agent sẽ gửi thay bạn)`}
              className="min-h-[60px] text-xs bg-slate-950/60 border-teal-400/35 text-stone-200 placeholder:text-stone-600 focus:border-teal-500/40 resize-none"
            />
            <div className="flex items-center gap-2 mt-2">
              <Button onClick={handleReply} disabled={replySending || !replyContent.trim()} className="chamfer-sm h-7 px-3 bg-gradient-to-r from-teal-500/80 to-emerald-600/80 hover:from-teal-600/80 hover:to-emerald-700/80 text-white border-0 text-[10px]">
                {replySending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Send className="mr-1 h-3 w-3" />} Gửi phản hồi
              </Button>
              <span className="text-[9px] text-stone-600">Hoặc để Agent tự động phản hồi</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

