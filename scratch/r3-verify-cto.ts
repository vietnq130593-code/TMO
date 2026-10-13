import { runGoalDrivenLoop } from '/home/z/tmo-app/src/lib/agent-goal-loop'
import { getOpusProfile } from '/home/z/tmo-app/src/lib/opus/opus-agent'

async function main() {
  const profile = await getOpusProfile()
  console.log('Opus profile:', profile?.provider, profile?.model, 'maxTokens:', profile?.maxTokens)
  const t0 = Date.now()
  const result = await runGoalDrivenLoop({
    systemPrompt: (profile?.instruction ?? '').slice(0, 200) + '\n[System prompt test R3-03]',
    userMessage: 'Đánh giá ngắn gọn: hệ thống TMO hiện có nên ưu tiên nâng cấp gì trong 2 tuần tới?',
    chatHistory: [],
    agentProvider: profile?.provider ?? 'zen',
    agentModel: profile?.model ?? 'space-bunny-free',
    agentId: profile?.id ?? 'unknown',
    agentName: 'Opus',
    agentTemperature: profile?.temperature ?? 0.4,
    agentMaxTokens: profile?.maxTokens ?? -1,
    agentSessionId: 'sess_r3_cto_test',
  })
  console.log(`\n=== KẾT QUẢ CTO MODE (${Math.round((Date.now() - t0) / 1000)}s) ===`)
  console.log('runId:', result.runId)
  console.log('iterations:', result.iterations, '| toolCalls:', result.toolCallsExecuted, '| goalLoop:', JSON.stringify(result.goalLoop))
  console.log('content (300 chars):', result.content.slice(0, 300))
  console.log('content bắt đầu bằng "Error:"?', result.content.startsWith('Error:'))
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
