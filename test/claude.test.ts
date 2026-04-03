import {test, expect} from 'vitest'
import {createFakeAgent, parseRequest} from '../src/index.ts'
import {waitForExit, spawnTui} from './helpers/index.ts'

test('claude -p hits fakeagent server and gets registered response', async () => {
  await using api = await createFakeAgent({
    async fetch(request) {
      const parsed = await parseRequest(request)
      return parsed.respond.text('three')
    },
  })

  const child = api.spawn('claude', ['-p', 'what is one plus two', '--output-format', 'json', '--no-session-persistence'], {
    cwd: '/tmp/fakeagent-test',
  })

  const {exitCode, stdout, stderr} = await waitForExit(child, 10_000)

  expect(exitCode, `stderr: ${stderr.slice(-500)}`).toBe(0)

  const result = JSON.parse(stdout)
  expect(result.result).toContain('three')
}, 15_000)

test('claude TUI receives fakeagent response', async () => {
  await using api = await createFakeAgent({
    async fetch(request) {
      const parsed = await parseRequest(request)
      return parsed.respond.text('three')
    },
  })

  await using tui = await spawnTui(api, 'claude')
  await tui.waitFor('Claude Code')
  await tui.send('what is one plus two')
  await tui.waitFor('three')
}, 20_000)
