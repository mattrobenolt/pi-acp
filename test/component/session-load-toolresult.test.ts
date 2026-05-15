import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

class FakeStore {
  constructor(private readonly sessionFile: string) {}

  get(_sessionId: string) {
    return { sessionId: 's1', cwd: '/tmp/project', sessionFile: this.sessionFile, updatedAt: new Date().toISOString() }
  }
  upsert() {}
}

test('PiAcpAgent: loadSession replays toolResult as tool_call + tool_call_update', async () => {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => ({
        messages: [
          {
            role: 'toolResult',
            toolCallId: 'call_1',
            toolName: 'bash',
            content: [{ type: 'text', text: 'hello from bash' }],
            isError: false
          }
        ]
      }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const sessionFile = join(mkdtempSync(join(tmpdir(), 'pi-acp-session-')), 's.jsonl')
    writeFileSync(sessionFile, '', 'utf-8')

    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore(sessionFile)

    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    const updates = conn.updates.map(u => (u as any).update)

    const toolCall = updates.find(u => u?.sessionUpdate === 'tool_call')
    assert.ok(toolCall)
    assert.equal(toolCall.toolCallId, 'call_1')
    assert.equal(toolCall.title, 'bash')

    const toolCallUpdate = updates.find(u => u?.sessionUpdate === 'tool_call_update')
    assert.ok(toolCallUpdate)
    assert.equal(toolCallUpdate.toolCallId, 'call_1')
    assert.equal(toolCallUpdate.status, 'completed')
    assert.equal(toolCallUpdate.content?.[0]?.content?.text, 'hello from bash')
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
