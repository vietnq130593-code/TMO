import { NextResponse } from 'next/server'
import { terminalManager } from '@/lib/terminal-session-manager'

export const dynamic = 'force-dynamic'

/**
 * GET /api/opencode/terminal/stream?sessionId=xxx
 * Server-Sent Events feed for a persistent terminal session.
 * Frames:
 *   data: {"type":"init","data":"<cumulative output>"}\n\n   (ALWAYS, even when empty)
 *   data: {"type":"chunk","data":"<new bytes>"}\n\n       (per stdout/stderr write)
 *   data: {"type":"exit","code":N}\n\n                  (session ended, then close)
 *   : hb\n\n                                        (keepalive every 10s)
 * If the session does not exist we still send init + exit so clients get a
 * deterministic lifecycle instead of hanging forever (also enables replay).
 * Auth: HttpOnly cookie from /api/auth/setup (EventSource cannot set headers).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const sessionId = searchParams.get('sessionId')

  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId parameter is required' }, { status: 400 })
  }

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      let timer: ReturnType<typeof setInterval> | undefined

      const send = (payload: unknown): void => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
        } catch {
          closed = true
        }
      }

      const close = (): void => {
        if (closed) return
        closed = true
        if (timer !== undefined) clearInterval(timer)
        terminalManager.removeListener(`output:${sessionId}`, onOutput)
        terminalManager.removeListener(`exit:${sessionId}`, onExit)
        try {
          controller.close()
        } catch {
          // already closed
        }
      }

      const onOutput = (chunk: string): void => {
        send({ type: 'chunk', data: chunk })
      }

      const onExit = (code: number | null): void => {
        send({ type: 'exit', code })
        close()
      }

      // Always send init (even empty) — deterministic client readiness + replay
      send({ type: 'init', data: terminalManager.getOutput(sessionId) ?? '' })

      if (!terminalManager.exists(sessionId)) {
        // Dead/unknown session: end the stream immediately, don't hang.
        send({ type: 'exit', code: null })
        close()
        return
      }

      terminalManager.on(`output:${sessionId}`, onOutput)
      terminalManager.on(`exit:${sessionId}`, onExit)

      // Heartbeat every 10s keeps proxies from timing the connection out.
      timer = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(': hb\n\n'))
        } catch {
          close()
        }
      }, 10000)

      // Client disconnect — drop listeners so we never leak per-session handlers
      request.signal.addEventListener('abort', close)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
