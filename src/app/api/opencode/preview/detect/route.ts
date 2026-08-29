import { NextResponse } from 'next/server'
import { readFile, stat, readdir } from 'fs/promises'
import { join, resolve } from 'path'
import { existsSync } from 'fs'
import { allowPreviewPort } from '@/lib/preview-ports'

export const dynamic = 'force-dynamic'

// Phase 3: TMO itself runs on PORT (default 3000) — ports 3000..3004 are
// reserved for the app. NEVER suggest/detect them as preview ports (the old
// bug: preview "detected" TMO's own port 3000 and iframed TMO itself).
const TMO_PORT = parseInt(process.env.PORT || '3000', 10)
const TMO_RESERVED = [TMO_PORT, TMO_PORT + 1, TMO_PORT + 2, TMO_PORT + 3, TMO_PORT + 4]

/**
 * GET /api/opencode/preview/detect?root=xxx
 * Smart detection of dev server configuration:
 * 1. Reads package.json → extracts dev scripts
 * 2. Reads framework config files → extracts configured port
 * 3. Scans common ports for running dev servers
 * 4. Returns framework info, suggested command, detected port
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const root = searchParams.get('root')

  if (!root) {
    return NextResponse.json({ error: 'root parameter is required' }, { status: 400 })
  }

  const resolvedRoot = resolve(root)

  if (!existsSync(resolvedRoot)) {
    return NextResponse.json({ error: 'Directory not found' }, { status: 404 })
  }

  const result: {
    framework: string | null
    frameworkIcon: string
    devCommand: string | null
    devScript: string | null
    configuredPort: number | null
    detectedPort: number | null
    detectedPorts: Array<{ port: number; status: number }>
    configFile: string | null
    packageManager: string
  } = {
    framework: null,
    frameworkIcon: '📦',
    devCommand: null,
    devScript: null,
    configuredPort: null,
    detectedPort: null,
    detectedPorts: [],
    configFile: null,
    packageManager: 'npm',
  }

  // 1. Detect package manager
  if (existsSync(join(resolvedRoot, 'bun.lockb')) || existsSync(join(resolvedRoot, 'bun.lock'))) {
    result.packageManager = 'bun'
  } else if (existsSync(join(resolvedRoot, 'pnpm-lock.yaml'))) {
    result.packageManager = 'pnpm'
  } else if (existsSync(join(resolvedRoot, 'yarn.lock'))) {
    result.packageManager = 'yarn'
  }

  // 2. Read package.json
  let packageJson: Record<string, unknown> | null = null
  const pkgPath = join(resolvedRoot, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkgContent = await readFile(pkgPath, 'utf-8')
      packageJson = JSON.parse(pkgContent)
    } catch { /* ignore */ }
  }

  // 3. Detect framework & dev script
  const deps = { ...(packageJson?.dependencies as Record<string, string> || {}), ...(packageJson?.devDependencies as Record<string, string> || {}) }
  const scripts = packageJson?.scripts as Record<string, string> | undefined

  if (deps['next']) {
    result.framework = 'Next.js'
    result.frameworkIcon = '▲'
    result.configFile = 'next.config'
  } else if (deps['nuxt'] || deps['nuxt3']) {
    result.framework = 'Nuxt'
    result.frameworkIcon = '💚'
    result.configFile = 'nuxt.config'
  } else if (deps['vite'] || deps['@vitejs/plugin-react'] || deps['@vitejs/plugin-vue']) {
    result.framework = 'Vite'
    result.frameworkIcon = '⚡'
    result.configFile = 'vite.config'
  } else if (deps['@angular/core']) {
    result.framework = 'Angular'
    result.frameworkIcon = '🅰️'
    result.configFile = 'angular.json'
  } else if (deps['svelte'] || deps['@sveltejs/kit']) {
    result.framework = 'SvelteKit'
    result.frameworkIcon = '🔥'
    result.configFile = 'svelte.config'
  } else if (deps['@remix-run/react']) {
    result.framework = 'Remix'
    result.frameworkIcon = '💿'
    result.configFile = 'remix.config'
  } else if (deps['astro']) {
    result.framework = 'Astro'
    result.frameworkIcon = '🚀'
    result.configFile = 'astro.config'
  } else if (deps['gatsby']) {
    result.framework = 'Gatsby'
    result.frameworkIcon = '💜'
    result.configFile = 'gatsby-config'
  } else if (packageJson) {
    result.framework = 'Node.js'
    result.frameworkIcon = '📦'
  }

  // 4. Find dev script
  if (scripts) {
    if (scripts['dev']) {
      result.devScript = 'dev'
      result.devCommand = `${result.packageManager} run dev`
    } else if (scripts['start']) {
      result.devScript = 'start'
      result.devCommand = `${result.packageManager} run start`
    } else if (scripts['serve']) {
      result.devScript = 'serve'
      result.devCommand = `${result.packageManager} run serve`
    }
  }

  // 5. Try to read configured port from config files
  // Next.js: next.config.js/m/ts → no default port config (always 3000)
  // Vite: vite.config.ts/js → server.port
  // Angular: angular.json → serve.options.port
  // Nuxt: nuxt.config.ts → server.port

  // Try Vite config
  for (const ext of ['.ts', '.js', '.mjs']) {
    const viteConfigPath = join(resolvedRoot, `vite.config${ext}`)
    if (existsSync(viteConfigPath)) {
      try {
        const viteContent = await readFile(viteConfigPath, 'utf-8')
        const portMatch = viteContent.match(/port\s*:\s*(\d+)/)
        if (portMatch) {
          result.configuredPort = parseInt(portMatch[1])
        }
      } catch { /* ignore */ }
      break
    }
  }

  // Try angular.json
  if (result.framework === 'Angular') {
    const angularConfigPath = join(resolvedRoot, 'angular.json')
    if (existsSync(angularConfigPath)) {
      try {
        const angularContent = await readFile(angularConfigPath, 'utf-8')
        const portMatch = angularContent.match(/"port"\s*:\s*(\d+)/)
        if (portMatch) {
          result.configuredPort = parseInt(portMatch[1])
        }
      } catch { /* ignore */ }
    }
  }

  // 6. Scan ports — priority order based on framework
  const portCandidates: number[] = []

  // Configured port first (highest priority)
  if (result.configuredPort) {
    portCandidates.push(result.configuredPort)
  }

  // Framework-specific default ports
  if (result.framework === 'Next.js') {
    portCandidates.push(3005, 3006, 3007, 3008)
  } else if (result.framework === 'Vite') {
    portCandidates.push(5173, 5174, 5175)
  } else if (result.framework === 'Angular') {
    portCandidates.push(4200)
  } else if (result.framework === 'Nuxt') {
    portCandidates.push(3005, 3006)
  } else if (result.framework === 'Astro') {
    portCandidates.push(4321, 4322)
  } else if (result.framework === 'Gatsby') {
    portCandidates.push(8000)
  } else if (result.framework === 'Remix') {
    portCandidates.push(3005, 3006)
  } else if (result.framework === 'SvelteKit') {
    portCandidates.push(5173, 5174)
  } else {
    portCandidates.push(3005, 3006, 3007, 3008, 5173, 5174, 8080, 4000, 4200, 8000, 4173, 8888)
  }

  // Remove duplicates
  const uniquePorts = [...new Set(portCandidates)]

  // Phase 3: filter TMO's reserved ports (self-collision guard) — this also
  // covers a configuredPort that happens to fall inside 3000-3004.
  const scannedPorts = uniquePorts.filter((p) => !TMO_RESERVED.includes(p))

  // Scan each port
  const detectedPorts: Array<{ port: number; status: number }> = []
  for (const port of scannedPorts) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 1500)
      const checkRes = await fetch(`http://127.0.0.1:${port}`, {
        method: 'HEAD',
        signal: controller.signal,
      })
      clearTimeout(timeout)
      detectedPorts.push({ port, status: checkRes.status })
      // Preview proxy allowlist (user request 2026-09-10): port dev server đang
      // chạy (scan thấy) → cho phép forward qua same-origin proxy route.
      allowPreviewPort(port)
      if (!result.detectedPort) {
        result.detectedPort = port
      }
    } catch {
      // Port not responding
    }
  }
  result.detectedPorts = detectedPorts

  return NextResponse.json(result)
}
