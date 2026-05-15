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
  upsert() {
    // noop
  }
}

test('PiAcpAgent: does not emit startup info on loadSession', async () => {
  // spy on timers (commands update is scheduled)
  const realSetTimeout = globalThis.setTimeout
  const timeouts: Array<unknown> = []
  ;(globalThis as any).setTimeout = (fn: unknown, _ms?: number) => {
    timeouts.push(fn)
    return 0 as any
  }

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => ({ messages: [] }),
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

    // Inject store so loadSession resolves without depending on actual filesystem.
    ;(agent as any).store = new FakeStore(sessionFile)

    const res = await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    assert.equal((res as any)?._meta?.piAcp?.startupInfo, null)

    // Only available_commands_update should be scheduled.
    assert.equal(timeouts.length, 1)
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
    PiRpcProcess.spawn = originalSpawn
  }
})
