import { NextResponse } from 'next/server'
import { execFile } from 'child_process'

export const dynamic = 'force-dynamic'

/**
 * POST /api/opencode/native-folder
 *
 * Mở hộp thoại chọn thư mục NATIVE của hệ điều hành (Windows Explorer /
 * macOS Finder / Linux zenity) ngay trên máy chạy server.
 *
 * User request 2026-08-27: "khi tôi bấm nút Chọn thư mục tôi muốn dựa vào dialog
 * hiện ra tôi có thể chọn thư mục giống như trên Windows".
 *
 * Vì app chạy LOCAL (server và UI cùng máy), dialog hiện trên chính máy user —
 * trả về đường dẫn THẬT (absolute path) để set làm workspaceRoot, khác với
 * File System Access API của browser (showDirectoryPicker) vốn KHÔNG trả về
 * đường dẫn tuyệt đối do giới hạn bảo mật.
 *
 * Platform support:
 *   - win32:   PowerShell + System.Windows.Forms.FolderBrowserDialog (STA)
 *   - darwin:  osascript "choose folder" (POSIX path)
 *   - linux:   zenity --file-selection --directory, fallback kdialog
 *
 * Response:
 *   { supported: true, path: "C:\\Projects\\my-app" }   — user chọn thư mục
 *   { supported: true, canceled: true }                  — user đóng dialog
 *   { supported: false, reason: "..." }                  — headless/ko có display
 */

/** Timeout 10 phút — user có thể browse chậm trong dialog native */
const DIALOG_TIMEOUT_MS = 10 * 60 * 1000

function runCommand(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      cmd,
      args,
      { timeout: DIALOG_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          // exit code != 0 → có thể là user cancel (một số tool trả mã khác 0)
          rejectPromise(Object.assign(err, { stderr: String(stderr || '') }))
        } else {
          resolvePromise({ stdout: String(stdout || ''), stderr: String(stderr || '') })
        }
      }
    )
  })
}

/** Windows: FolderBrowserDialog qua PowerShell (STA thread bắt buộc cho WinForms) */
async function pickFolderWindows(): Promise<{ path?: string; canceled?: boolean; error?: string }> {
  const psScript = `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Chọn thư mục làm việc cho Agent Code'
$dialog.ShowNewFolderButton = $true
$dialog.RootFolder = 'MyComputer'
$Result = $dialog.ShowDialog((New-Object System.Windows.Forms.Form -Property @{TopMost = $true}))
if ($Result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {
  Write-Output $dialog.SelectedPath
}
`
  try {
    const { stdout } = await runCommand('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-STA', '-Command', psScript,
    ])
    const path = stdout.trim()
    if (path) return { path }
    return { canceled: true }
  } catch (err) {
    const e = err as Error & { stderr?: string }
    return { error: `PowerShell dialog failed: ${e.message}${e.stderr ? ` (${e.stderr.slice(0, 200)})` : ''}` }
  }
}

/** macOS: osascript choose folder */
async function pickFolderMacOS(): Promise<{ path?: string; canceled?: boolean; error?: string }> {
  try {
    const { stdout } = await runCommand('osascript', ['-e', 'tell application "System Events" to activate', '-e', 'POSIX path of (choose folder with prompt "Chọn thư mục làm việc")'])
    const path = stdout.trim().replace(/\/$/, '')
    if (path) return { path }
    return { canceled: true }
  } catch (err) {
    const e = err as Error
    // osascript trả exit 1 khi user cancel
    if (/User canceled|cancelled|cancel/i.test(e.message)) return { canceled: true }
    return { error: `osascript failed: ${e.message}` }
  }
}

/** Linux: zenity, fallback kdialog */
async function pickFolderLinux(): Promise<{ path?: string; canceled?: boolean; error?: string }> {
  // zenity exit code 1 = cancel
  try {
    const { stdout } = await runCommand('zenity', ['--file-selection', '--directory', '--title=Chọn thư mục làm việc'])
    const path = stdout.trim()
    if (path) return { path }
    return { canceled: true }
  } catch (zenErr) {
    const ze = zenErr as Error
    // zenity: exit 1 = user cancel; exit 127 = not installed / no display
    if (/exit code 1\b|status 1\b/i.test(ze.message)) return { canceled: true }
    // Try kdialog
    try {
      const { stdout } = await runCommand('kdialog', ['--getexistingdirectory', '/', '--title', 'Chọn thư mục làm việc'])
      const path = stdout.trim()
      if (path) return { path }
      return { canceled: true }
    } catch (kdErr) {
      const ke = kdErr as Error
      if (/cancel/i.test(ke.message)) return { canceled: true }
      return { error: `zenity: ${ze.message} | kdialog: ${ke.message}` }
    }
  }
}

export async function POST() {
  const platform = process.platform

  try {
    let result: { path?: string; canceled?: boolean; error?: string }

    switch (platform) {
      case 'win32':
        result = await pickFolderWindows()
        break
      case 'darwin':
        result = await pickFolderMacOS()
        break
      case 'linux':
        result = await pickFolderLinux()
        break
      default:
        return NextResponse.json({
          supported: false,
          reason: `Platform "${platform}" không hỗ trợ dialog native — dùng trình duyệt thư mục trong app.`,
        })
    }

    if (result.error) {
      return NextResponse.json({
        supported: false,
        reason: result.error,
      })
    }

    if (result.canceled) {
      return NextResponse.json({ supported: true, canceled: true })
    }

    console.log(`[NativeFolder] User chọn thư mục: ${result.path}`)
    return NextResponse.json({ supported: true, path: result.path })
  } catch (err) {
    return NextResponse.json(
      {
        supported: false,
        reason: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    )
  }
}
