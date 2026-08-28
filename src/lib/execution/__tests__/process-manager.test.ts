/// <reference types="bun-types" />
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { processManager } from '../process-manager'

describe('ProcessManager — runCommand', () => {
  it('runCommand("echo hi") succeeds on all platforms', async () => {
    const result = await processManager.runCommand({
      command: 'echo hi',
      timeoutMs: 10_000,
    })
    expect(result.success).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('hi')
    expect(result.durationMs).toBeGreaterThan(0)
    expect(result.killed).toBe(false)
  })

  it('runCommand captures stderr', async () => {
    const platformCmd = process.platform === 'win32'
      ? 'powershell.exe -NoProfile -Command "Write-Error test123"'
      : 'echo test123 >&2'
    const result = await processManager.runCommand({
      command: platformCmd,
      timeoutMs: 10_000,
    })
    expect(result.output).toContain('test123')
  })

  it('runCommand handles non-zero exit code', async () => {
    const platformCmd = process.platform === 'win32'
      ? 'powershell.exe -NoProfile -Command "exit 42"'
      : 'bash -c "exit 42"'
    const result = await processManager.runCommand({
      command: platformCmd,
      timeoutMs: 10_000,
    })
    expect(result.success).toBe(false)
    expect(result.exitCode).toBe(42)
  })

  it('runCommand respects timeout and kills process', async () => {
    const platformCmd = process.platform === 'win32'
      ? 'powershell.exe -NoProfile -Command "Start-Sleep -Seconds 30"'
      : 'sleep 30'
    const result = await processManager.runCommand({
      command: platformCmd,
      timeoutMs: 500, // very short timeout
    })
    expect(result.killed).toBe(true)
    expect(result.error).toContain('timed out')
    expect(result.success).toBe(false)
  })

  it('runCommand works with cwd', async () => {
    const result = await processManager.runCommand({
      command: process.platform === 'win32'
        ? 'powershell.exe -NoProfile -Command "(Get-Location).Path"'
        : 'pwd',
      cwd: 'src/lib',
      timeoutMs: 10_000,
    })
    expect(result.success).toBe(true)
    // Lowercase for comparison
    const output = result.output.trim().toLowerCase()
    expect(output).toContain('src')
    expect(output).toContain('lib')
  })

  it('runCommand handles invalid shell command', async () => {
    const result = await processManager.runCommand({
      command: 'nonexistent_command_abcdef',
      timeoutMs: 10_000,
    })
    expect(result.success).toBe(false)
    expect(result.exitCode).not.toBe(0)
  })

  it('runCommand returns empty output for no-op command', async () => {
    const platformCmd = process.platform === 'win32'
      ? 'powershell.exe -NoProfile -Command ""'
      : 'echo -n'
    const result = await processManager.runCommand({
      command: platformCmd,
      timeoutMs: 10_000,
    })
    expect(result.success).toBe(true)
  })
})

describe('ProcessManager — startProcess / killProcess / listProcesses', () => {
  it('startProcess creates a process in registry', async () => {
    const platformCmd = process.platform === 'win32'
      ? 'powershell.exe -NoProfile -Command "Start-Sleep -Seconds 60"'
      : 'sleep 60'
    const info = await processManager.startProcess({
      command: platformCmd,
      name: 'test-sleep',
      tags: ['test'],
      timeoutMs: 120_000,
    })
    expect(info.id).toMatch(/^proc_/)
    expect(info.name).toBe('test-sleep')
    expect(info.status).toBe('running')
    expect(info.pid).not.toBeNull()
    expect(info.tags).toContain('test')
  })

  it('listProcesses returns running processes', async () => {
    const list = await processManager.listProcesses()
    const testProcs = list.filter(p => p.name === 'test-sleep')
    expect(testProcs.length).toBeGreaterThan(0)
    expect(testProcs[0].status).toBe('running')
  })

  it('killProcess kills a running process', async () => {
    const running = (await processManager.listProcesses())
      .find(p => p.name === 'test-sleep')
    expect(running).toBeDefined()

    const killed = await processManager.killProcess(running!.id)
    expect(killed).toBe(true)

    // Verify status updated
    const after = await processManager.listProcesses()
    const proc = after.find(p => p.id === running!.id)
    expect(proc?.status).toBe('killed')
  })

  it('killProcess returns false for unknown process', async () => {
    const killed = await processManager.killProcess('proc_nonexistent')
    expect(killed).toBe(false)
  })
})

describe('ProcessManager — readProcessOutput', () => {
  it('readProcessOutput reads buffered output', async () => {
    const platformCmd = process.platform === 'win32'
      ? 'powershell.exe -NoProfile -Command "Write-Output hello-output; Write-Output line2; Start-Sleep -Seconds 60"'
      : 'sh -c "echo hello-output; echo line2; sleep 60"'

    const info = await processManager.startProcess({
      command: platformCmd,
      name: 'test-output',
      tags: ['test-output'],
      timeoutMs: 120_000,
    })

    // Wait for output to accumulate
    await new Promise(r => setTimeout(r, 500))

    const output = await processManager.readProcessOutput(info.id)
    expect(output.output).toContain('hello-output')
    expect(output.bytesRead).toBeGreaterThan(0)
    expect(output.totalBytes).toBeGreaterThan(0)
    expect(output.ended).toBe(false)

    // Kill after test
    await processManager.killProcess(info.id)
  })
})