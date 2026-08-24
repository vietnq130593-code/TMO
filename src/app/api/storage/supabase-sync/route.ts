/**
 * Supabase Sync API — backup/restore ephemeral data
 *
 * POST /api/storage/supabase-sync           — push SQLite → Supabase (backup)
 * POST /api/storage/supabase-sync?action=pull — pull Supabase → SQLite (restore)
 * GET  /api/storage/supabase-sync           — health check + sync status
 */

import { NextRequest, NextResponse } from 'next/server'
import { pushToSupabase, pullFromSupabase, checkSupabaseHealth, isSupabaseConfigured } from '@/lib/supabase-sync'

export const dynamic = 'force-dynamic'

// ==================== POST — SYNC (push or pull) ====================

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { error: 'Supabase not configured. Set SUPABASE_URL + SUPABASE_SERVICE_KEY in .env' },
      { status: 503 }
    )
  }

  const { searchParams } = new URL(request.url)
  const action = searchParams.get('action') || 'push'

  try {
    if (action === 'pull') {
      console.log('[Supabase API] Pulling data from Supabase → SQLite (restore)')
      const result = await pullFromSupabase()
      return NextResponse.json({
        success: true,
        action: 'pull',
        ...result,
      })
    } else {
      console.log('[Supabase API] Pushing data from SQLite → Supabase (backup)')
      const result = await pushToSupabase()
      return NextResponse.json({
        success: true,
        action: 'push',
        ...result,
      })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Supabase API] Sync error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// ==================== GET — STATUS ====================

export async function GET() {
  const health = await checkSupabaseHealth()
  return NextResponse.json({
    configured: health.configured,
    connected: health.connected,
    tableCount: health.tableCount,
    error: health.error,
    tables: [
      'agent_profiles_backup',
      'agent_skills_backup',
      'agent_memory_backup',
      'memory_archive_backup',
      'memory_access_log_backup',
      'agent_sessions_backup',
      'chat_messages_backup',
      'token_usage_backup',
      'mcp_bridge_config_backup',
      'knowledge_access_policy_backup',
      'user_profile_backup',
      'agent_insight_backup',
      'agent_preference_backup',
      'agent_correction_backup',
      'documents_backup',
      'local_entities_backup',
      'local_relationships_backup',
      'local_resolved_entities_backup',
      // Phase 3 SMOLAB Prop 10 — 5 learning tables added:
      'learning_log_backup',
      'auto_learn_record_backup',
      'execution_metrics_backup',
      'failure_pattern_backup',
      'strategy_adaptation_log_backup',
      'sync_log',
    ],
    endpoints: {
      'POST ?action=push': 'Backup SQLite → Supabase',
      'POST ?action=pull': 'Restore Supabase → SQLite',
    },
  })
}
