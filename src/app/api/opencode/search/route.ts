import { NextRequest, NextResponse } from 'next/server'
import { spawn } from 'child_process'
import { resolve } from 'path'
import { getActiveWorkspaceRoot } from '@/lib/workspace/workspace-manager'

export const dynamic = 'force-dynamic'

interface SearchHit {
  path: string
  line: number
  text: string
}

interface RgOutcome {
  hits: SearchHit[]
  exitCode: number | null
  stderr: string
  timedOut: boolean
}

/**
 * POST /api/opencode/search
 * Body: { query: string, root?: string, glob?: string, max?: number (default 100) }
 *
 * ripgrep (-i --json) over the workspace, skipping node_modules/.git/dist/
 * build/.next, max 20 matches per file. rg exit 1 = "no matches" → OK empty
 * {ok, exitCode:1, results:[], count:0}; exit 2 = error → 500. Timeout 20s →
 * kill rg + return the partial results collected so far.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { query } = body

    if (!query || typeof query !== 'string' || !query.trim()) {
      return NextResponse.json({ ok: false, error: 'query is required' }, { status: 400 })
    }

    const root = resolve(body.root || (await getActiveWorkspaceRoot()) || process.cwd())
    const glob = typeof body.glob === 'string' && body.glob ? body.glob : null
    const max = Math.min(Math.max(Number(body.max) || 100, 1), 500)

    const args = [
      '-i', '--json',
      '-g', '!node_modules/**',
      '-g', '!.git/**',
      '-g', '!dist/**',
      '-g', '!build/**',
      '-g', '!.next/**',
      '--max-count', '20',
    ]
    if (glob) args.push('-g', glob)
    args.push(query, root)

    const outcome: RgOutcome = await new Promise((resolvePromise) => {
      const hits: SearchHit[] = []
      let stdoutBuf = ''
      let stderrBuf = ''
      let timedOut = false
      let settled = false

      let child: ReturnType<typeof spawn>
      try {
        child = spawn('rg', args, { cwd: root })
      } catch {
        resolvePromise({ hits, exitCode: 2, stderr: 'spawn rg failed', timedOut: false })
        return
      }

      const finish = (code: number | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolvePromise({ hits, exitCode: code, stderr: stderrBuf, timedOut })
      }

      // 20s watchdog — kill rg, keep whatever we already parsed (partial results)
      const timer = setTimeout(() => {
        timedOut = true
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        finish(-1)
      }, 20000)
      timer.unref?.()

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf-8')
        // Parse complete JSON lines; keep the trailing partial line buffered
        const lines = stdoutBuf.split('\n')
        stdoutBuf = lines.pop() || ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const evt = JSON.parse(trimmed)
            if (evt && evt.type === 'match' && evt.data) {
              const hit: SearchHit = {
                path: typeof evt.data.path?.text === 'string' ? evt.data.path.text : '',
                line: typeof evt.data.line_number === 'number' ? evt.data.line_number : 0,
                text: (typeof evt.data.lines?.text === 'string' ? evt.data.lines.text : '').trim(),
              }
              if (hit.path) {
                if (hits.length >= max) { try { child.kill('SIGKILL') } catch { /* ignore */ } }
                else hits.push(hit)
              }
            }
          } catch { /* non-JSON / partial line — skip */ }
        }
      })

      child.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString('utf-8') })
      child.on('error', () => finish(2))
      child.on('close', (code) => finish(code))
    })

    // exit 2 = rg hard error (bad regex, missing dir, ...)
    if (outcome.exitCode === 2) {
      return NextResponse.json(
        { ok: false, error: `rg failed: ${outcome.stderr.trim().slice(0, 300) || 'unknown ripgrep error'}` },
        { status: 500 },
      )
    }

    // exit 1 = no matches (fine) | exit 0 = matches | -1 = timeout w/ partial
    return NextResponse.json({
      ok: true,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      results: outcome.hits,
      count: outcome.hits.length,
      root,
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    )
  }
}
