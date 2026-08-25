import { NextResponse } from 'next/server'
import { execSync } from 'child_process'
import { executeBashCommand } from '@/lib/opencode'

export const dynamic = 'force-dynamic'

/**
 * POST /api/opencode/execute
 * Execute a bash command — tries OpenCode server first, falls back to local exec
 * Body: { command: string, sessionId?: string, cwd?: string }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { command, sessionId, cwd } = body

    if (!command) {
      return NextResponse.json({ error: 'command is required' }, { status: 400 })
    }

    // Try OpenCode server first
    const result = await executeBashCommand({ command, sessionId })

    if (result) {
      return NextResponse.json({ ...result, source: 'opencode-server' })
    }

    // Local fallback: execute directly via child_process
    try {
      const output = execSync(command, {
        timeout: 600000, // 10 minutes
        maxBuffer: 1024 * 1024 * 10, // 10MB
        encoding: 'utf-8',
        cwd: cwd || process.cwd(),
        env: { ...process.env, FORCE_COLOR: '0' },
      })
      return NextResponse.json({
        success: true,
        output: output || '',
        command,
        exitCode: 0,
        source: 'local-exec',
      })
    } catch (execError: unknown) {
      const err = execError as { stdout?: string; stderr?: string; status?: number }
      const stdout = err.stdout || ''
      const stderr = err.stderr || ''
      const combinedOutput = (stdout + (stderr ? '\n' + stderr : '')).trim()
      return NextResponse.json({
        success: false,
        output: combinedOutput,
        error: combinedOutput || (execError instanceof Error ? execError.message : 'Command failed'),
        command,
        exitCode: err.status ?? 1,
        source: 'local-exec',
      })
    }
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      command: '',
      exitCode: -1,
    }, { status: 500 })
  }
}
