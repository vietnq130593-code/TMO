/**
 * OpenClaw Skills API — Manage agent skills
 *
 * GET  /api/openclaw/skills — List installed skills or search ClawHub
 * POST /api/openclaw/skills — Install/uninstall/toggle skill
 *
 * Query params: ?action=installed|search&q=searchTerm&category=All
 */

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { writeFileSync, mkdirSync, unlinkSync, existsSync, readdirSync, rmdirSync } from 'fs'
import { join } from 'path'

export const dynamic = 'force-dynamic'

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789'
const CLAWHUB_API = 'https://clawhub.ai/api/v1'

// Default bundled skills
const BUNDLED_SKILLS = [
  {
    slug: 'knowledge-search',
    name: 'Knowledge Search',
    content: `# Knowledge Search

## Description
Search the local Knowledge Base using semantic search and graph expansion.

## When to Use
- When the user asks about any topic that might be in the Knowledge Base
- When you need factual information from indexed documents
- Before answering any question, always search the KB first

## How to Use
1. Call the \`knowledge_search\` tool with the user's query
2. Review the results: chunks, entities, relationships
3. Synthesize an answer based on the data
4. Cite sources from the results

## Rules
- ALWAYS search the KB before answering
- If no results found, say so clearly
- Never fabricate information not in the KB
- Cite document sources when available`,
    source: 'bundled',
    enabled: true,
    version: '1.0.0',
  },
  {
    slug: 'knowledge-graph',
    name: 'Knowledge Graph',
    content: `# Knowledge Graph

## Description
Query the Neo4j Knowledge Graph for entity relationships and graph traversal.

## When to Use
- When the user asks about relationships between entities
- When you need to find paths between concepts
- When exploring connected knowledge

## How to Use
1. Call \`knowledge_graph\` with a Cypher query or entity name
2. For exploration: provide an entity name
3. For path finding: provide source and target entity names
4. Review and present the graph structure

## Rules
- Only use MATCH queries (read-only)
- Limit results to 50 nodes
- Explain relationships in natural language`,
    source: 'bundled',
    enabled: true,
    version: '1.0.0',
  },
  {
    slug: 'knowledge-write',
    name: 'Knowledge Write',
    content: `# Knowledge Write

## Description
Write new entities and relationships to the Knowledge Base.

## When to Use
- When you discover new information not in the KB
- When the user explicitly asks you to save information
- After a successful correction

## How to Use
1. Call \`knowledge_write\` with entity or relationship data
2. For entities: provide name, type, description, domain
3. For relationships: provide source, target, type, description
4. Data will be buffered in SQLite and synced to Neo4j

## Rules
- ALWAYS ask the user before writing new data
- Never delete existing data without explicit permission
- Provide clear descriptions for all entities
- Use consistent entity types (Algorithm, Concept, Tool, etc.)`,
    source: 'bundled',
    enabled: true,
    version: '1.0.0',
  },
]

// ClawHub API search — uses real ClawHub.ai /api/v1/search endpoint

// Ensure default bundled skills exist in DB
async function ensureBundledSkills() {
  for (const skill of BUNDLED_SKILLS) {
    const existing = await db.agentSkill.findUnique({
      where: { agentId_slug: { agentId: 'default', slug: skill.slug } },
    })
    if (!existing) {
      await db.agentSkill.create({
        data: {
          agentId: 'default',
          slug: skill.slug,
          name: skill.name,
          content: skill.content,
          source: skill.source,
          enabled: skill.enabled,
          version: skill.version,
        },
      })

      // Sync bundled skill to filesystem for z.ai platform layer injection
      try {
        const skillsDir = join(process.cwd(), 'skills', skill.slug)
        mkdirSync(skillsDir, { recursive: true })
        writeFileSync(join(skillsDir, 'SKILL.md'), skill.content, 'utf-8')
        console.log(`[Skills] Wrote bundled SKILL.md to filesystem: skills/${skill.slug}/SKILL.md`)
      } catch (fsErr) {
        console.warn(`[Skills] Failed to write bundled SKILL.md to filesystem:`, fsErr instanceof Error ? fsErr.message : String(fsErr))
      }
    }
  }
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const action = searchParams.get('action') || 'installed'
  const query = searchParams.get('q') || ''
  const category = searchParams.get('category') || 'All'

  // Ensure bundled skills exist (only for installed action)
  if (action === 'installed') {
    await ensureBundledSkills()
  }

  if (action === 'installed') {
    // Get installed skills from SQLite
    const skills = await db.agentSkill.findMany({
      where: { agentId: 'default' },
      orderBy: { installedAt: 'desc' },
    })
    return NextResponse.json({ skills, total: skills.length })
  }

  if (action === 'search') {
    // Get installed slugs for marking
    const installed = await db.agentSkill.findMany({
      where: { agentId: 'default' },
      select: { slug: true },
    })
    const installedSlugs = new Set(installed.map(s => s.slug))

    // Try real ClawHub.ai API first
    try {
      const searchQuery = query || '*'
      const limit = searchParams.get('limit') || '20'
      const clawhubUrl = `${CLAWHUB_API}/search?q=${encodeURIComponent(searchQuery)}&limit=${limit}`
      const res = await fetch(clawhubUrl, {
        signal: AbortSignal.timeout(10000),
        headers: { 'Accept': 'application/json' },
      })
      if (res.ok) {
        const data = await res.json()
        if (data.results && Array.isArray(data.results)) {
          const skills = data.results.map((r: {
            slug: string; displayName: string; summary: string;
            ownerHandle: string; owner?: { handle: string; displayName: string; image?: string };
            score: number; updatedAt: number;
            tags?: Record<string, string>; stats?: { downloads: number; installsAllTime: number; stars: number };
            latestVersion?: { version: string };
          }) => ({
            slug: r.slug,
            name: r.displayName,
            version: r.latestVersion?.version || r.tags?.latest || '0.0.0',
            description: r.summary || '',
            author: r.owner?.displayName || r.ownerHandle || '',
            authorHandle: r.ownerHandle,
            authorImage: r.owner?.image || '',
            downloads: r.stats?.downloads || 0,
            installs: r.stats?.installsAllTime || 0,
            stars: r.stats?.stars || 0,
            score: r.score || 0,
            category: 'All',
            installed: installedSlugs.has(r.slug),
            source: 'clawhub',
            url: `https://clawhub.ai/${r.ownerHandle}/${r.slug}`,
          }))
          return NextResponse.json({ skills, total: skills.length, source: 'clawhub-api' })
        }
      }
    } catch (error) {
      console.error('ClawHub API failed:', error)
      // Fall through to gateway fallback
    }

    // Try OpenClaw gateway as fallback
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/skills/search?q=${encodeURIComponent(query)}&category=${category}`, {
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.skills && data.skills.length > 0) {
          return NextResponse.json(data)
        }
      }
    } catch {
      // Gateway unavailable
    }

    // No results from any source
    return NextResponse.json({ skills: [], total: 0, source: 'none', message: 'Không thể kết nối ClawHub.ai. Vui lòng thử lại sau.' })
  }

  if (action === 'detail') {
    // Get single skill detail (from local DB)
    const slug = searchParams.get('slug')
    if (!slug) {
      return NextResponse.json({ error: 'Missing slug parameter' }, { status: 400 })
    }
    const skill = await db.agentSkill.findUnique({
      where: { agentId_slug: { agentId: 'default', slug } },
    })
    if (!skill) {
      return NextResponse.json({ error: 'Skill not found' }, { status: 404 })
    }
    return NextResponse.json({ skill })
  }

  if (action === 'content') {
    // Fetch skill content (SKILL.md) — DB → filesystem fallback (21-c) → ClawHub
    // 21-c: hỗ trợ cả param `name` lẫn `slug` (Tools Manager gọi ?action=content&name=X)
    const slug = searchParams.get('slug') || searchParams.get('name')
    const ownerHandle = searchParams.get('ownerHandle') || ''
    if (!slug) {
      return NextResponse.json({ error: 'Missing slug parameter' }, { status: 400 })
    }

    // First check if it's already installed locally
    const local = await db.agentSkill.findUnique({
      where: { agentId_slug: { agentId: 'default', slug } },
    })
    if (local) {
      return NextResponse.json({
        name: local.name,
        slug: local.slug,
        content: local.content,
        version: local.version,
        source: local.source,
        installed: true,
      })
    }

    // 21-c — FILESYSTEM FALLBACK: 67 skills sống trên đĩa (skills/<slug>/SKILL.md)
    // nhưng KHÔNG có trong DB → trước đây action=content chỉ tra DB→ClawHub nên
    // UI không xem được nội dung. Giờ: DB miss → đọc trực tiếp file (validate slug
    // chống path traversal trong readFsSkill). canEdit=true → PUT /api/openclaw/skills/fs.
    try {
      const { readFsSkill } = await import('@/lib/fs-skills')
      const fsSkill = await readFsSkill(slug)
      if (fsSkill) {
        return NextResponse.json({
          name: slug,
          slug,
          content: fsSkill.content,
          size: fsSkill.size,
          hasBackup: fsSkill.hasBackup,
          version: 'filesystem',
          source: 'filesystem',
          installed: true,
          canEdit: true,
        })
      }
    } catch { /* fall-through sang ClawHub */ }

    // Try to fetch from ClawHub API
    if (ownerHandle) {
      try {
        const contentRes = await fetch(`${CLAWHUB_API}/skills/${ownerHandle}/${slug}`, {
          signal: AbortSignal.timeout(8000),
        })
        if (contentRes.ok) {
          const contentData = await contentRes.json()
          return NextResponse.json({
            name: contentData.displayName || slug,
            slug,
            content: contentData.skillMd || contentData.content || '',
            version: contentData.latestVersion?.version || contentData.tags?.latest || '0.0.0',
            source: 'clawhub',
            installed: false,
            author: contentData.owner?.displayName || ownerHandle,
            authorHandle: ownerHandle,
            description: contentData.summary || '',
          })
        }
      } catch (error) {
        console.error('ClawHub content fetch failed:', error)
      }
    }

    // Fallback: try searching for the skill to get basic info
    try {
      const searchRes = await fetch(`${CLAWHUB_API}/search?q=${encodeURIComponent(slug)}&limit=5`, {
        signal: AbortSignal.timeout(8000),
      })
      if (searchRes.ok) {
        const searchData = await searchRes.json()
        const match = searchData.results?.find((r: { slug: string }) => r.slug === slug || r.slug === slug.split('/').pop())
        if (match) {
          return NextResponse.json({
            name: match.displayName || match.slug,
            slug,
            content: `# ${match.displayName || match.slug}\n\n${match.summary || ''}\n\n## Chi tiết\nNội dung đầy đủ cần tải về từ ClawHub.ai.\n\nVisit https://clawhub.ai/${match.ownerHandle}/${slug} for more details.`,
            version: match.latestVersion?.version || match.tags?.latest || '0.0.0',
            source: 'clawhub',
            installed: false,
            author: match.owner?.displayName || match.ownerHandle || '',
            authorHandle: match.ownerHandle,
            description: match.summary || '',
          })
        }
      }
    } catch {
      // Search fallback failed
    }

    return NextResponse.json({ error: 'Không thể tải nội dung skill từ ClawHub', name: slug, slug, content: '', source: 'none', installed: false }, { status: 404 })
  }

  if (action === 'categories') {
    const categories = ['All', 'Browser', 'File System', 'Developer', 'Data', 'Communication', 'Productivity', 'Media', 'Smart Home']
    return NextResponse.json({ categories })
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action, slug, name, content, enabled } = body

    if (action === 'install' && slug) {
      // Try to get skill info from ClawHub.ai API
      let skillName = slug
      let skillDescription = ''
      let skillVersion = '0.0.0'
      let skillAuthor = ''
      let skillContent = ''

      // Try fetching skill detail from ClawHub
      try {
        const searchRes = await fetch(`${CLAWHUB_API}/search?q=${encodeURIComponent(slug)}&limit=5`, {
          signal: AbortSignal.timeout(8000),
        })
        if (searchRes.ok) {
          const searchData = await searchRes.json()
          const match = searchData.results?.find((r: { slug: string; ownerHandle: string }) =>
            r.slug === slug || r.slug === slug.split('/').pop()
          )
          if (match) {
            skillName = match.displayName || match.slug
            skillDescription = match.summary || ''
            skillVersion = match.latestVersion?.version || match.tags?.latest || '0.0.0'
            skillAuthor = match.owner?.displayName || match.ownerHandle || ''
          }
        }
      } catch {
        // API unavailable, use slug as name
      }

      // Try to fetch the actual SKILL.md content from ClawHub
      try {
        const ownerHandle = body.ownerHandle || ''
        if (ownerHandle) {
          const contentRes = await fetch(`${CLAWHUB_API}/skills/${ownerHandle}/${slug}`, {
            signal: AbortSignal.timeout(5000),
          })
          if (contentRes.ok) {
            const contentData = await contentRes.json()
            if (contentData.skillMd) {
              skillContent = contentData.skillMd
            }
          }
        }
      } catch {
        // Content fetch failed
      }

      if (!skillContent) {
        skillContent = `# ${skillName}\n\n${skillDescription}\n\n## Usage\nThis skill was installed from ClawHub.\n\nVisit https://clawhub.ai for more details.`
      }

      // Check if already installed
      const existing = await db.agentSkill.findUnique({
        where: { agentId_slug: { agentId: 'default', slug } },
      })

      const skill = await db.agentSkill.upsert({
        where: { agentId_slug: { agentId: 'default', slug } },
        create: {
          agentId: 'default',
          slug,
          name: skillName,
          content: skillContent,
          source: 'clawhub',
          enabled: true,
          version: skillVersion,
        },
        update: {
          name: skillName,
          version: skillVersion,
          source: 'clawhub',
          content: skillContent,
        },
      })

      // Write SKILL.md to filesystem for z.ai platform layer injection
      try {
        const skillsDir = join(process.cwd(), 'skills', slug)
        mkdirSync(skillsDir, { recursive: true })
        writeFileSync(join(skillsDir, 'SKILL.md'), skillContent, 'utf-8')
        console.log(`[Skills] Wrote SKILL.md to filesystem: skills/${slug}/SKILL.md`)
      } catch (fsErr) {
        console.warn(`[Skills] Failed to write SKILL.md to filesystem:`, fsErr instanceof Error ? fsErr.message : String(fsErr))
        // Non-critical: DB storage is the primary mechanism
      }

      const message = existing
        ? `Skill "${skillName}" đã cập nhật lên v${skillVersion}`
        : `Skill "${skillName}" đã cài đặt thành công`

      return NextResponse.json({ success: true, skill, message })
    }

    if (action === 'uninstall' && slug) {
      const skill = await db.agentSkill.findUnique({
        where: { agentId_slug: { agentId: 'default', slug } },
      })
      if (!skill) {
        return NextResponse.json({ error: 'Skill not found' }, { status: 404 })
      }
      if (skill.source === 'bundled') {
        return NextResponse.json({ error: 'Không thể gỡ skill mặc định' }, { status: 400 })
      }
      // Allow uninstall for clawhub, custom, and template sources
      await db.agentSkill.delete({
        where: { agentId_slug: { agentId: 'default', slug } },
      })

      // Remove SKILL.md from filesystem and clean up empty directory
      try {
        const skillDir = join(process.cwd(), 'skills', slug)
        const skillFilePath = join(skillDir, 'SKILL.md')
        if (existsSync(skillFilePath)) {
          unlinkSync(skillFilePath)
          console.log(`[Skills] Removed SKILL.md from filesystem: skills/${slug}/SKILL.md`)
        }
        // Clean up empty directory
        if (existsSync(skillDir)) {
          try {
            const files = readdirSync(skillDir)
            if (files.length === 0) rmdirSync(skillDir)
          } catch {}
        }
      } catch (fsErr) {
        console.warn(`[Skills] Failed to remove SKILL.md from filesystem:`, fsErr instanceof Error ? fsErr.message : String(fsErr))
      }

      return NextResponse.json({ success: true, message: `Skill "${skill.name}" đã gỡ cài đặt` })
    }

    if (action === 'toggle' && slug) {
      const skill = await db.agentSkill.findUnique({
        where: { agentId_slug: { agentId: 'default', slug } },
      })
      if (!skill) {
        return NextResponse.json({ error: 'Skill not found' }, { status: 404 })
      }
      const newEnabled = enabled !== undefined ? enabled : !skill.enabled
      await db.agentSkill.update({
        where: { agentId_slug: { agentId: 'default', slug } },
        data: { enabled: newEnabled },
      })

      // Sync filesystem with enabled state
      try {
        const skillFilePath = join(process.cwd(), 'skills', slug, 'SKILL.md')
        if (newEnabled) {
          const skillsDir = join(process.cwd(), 'skills', slug)
          mkdirSync(skillsDir, { recursive: true })
          writeFileSync(skillFilePath, skill.content, 'utf-8')
          console.log(`[Skills] Synced SKILL.md to filesystem (enabled): skills/${slug}/SKILL.md`)
        } else {
          if (existsSync(skillFilePath)) {
            unlinkSync(skillFilePath)
            console.log(`[Skills] Removed SKILL.md from filesystem (disabled): skills/${slug}/SKILL.md`)
          }
        }
      } catch (fsErr) {
        console.warn(`[Skills] Failed to sync filesystem for toggle:`, fsErr instanceof Error ? fsErr.message : String(fsErr))
      }

      return NextResponse.json({ success: true, enabled: newEnabled, message: `Skill "${skill.name}" ${newEnabled ? 'đã bật' : 'đã tắt'}` })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
}
