import {test, expect} from 'vitest'
import {createFakeAgent, parseRequest} from '../src/index.ts'
import {waitForExit, spawnTui} from './helpers/index.ts'

test('claude -p gets fake response', async () => {
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
  expect(JSON.parse(stdout).result).toContain('three')
}, 15_000)

test('claude TUI text response', async () => {
  await using api = await createFakeAgent({
    async fetch(request) {
      const parsed = await parseRequest(request)
      return parsed.respond.text('three')
    },
  })

  await using tui = await spawnTui(api, 'claude')
  await tui.waitFor('Haiku')
  await tui.send('what is one plus two')
  await tui.waitFor('three')
}, 20_000)

test('claude TUI tool use', async () => {
  await using api = await createFakeAgent({
    async fetch(request) {
      const parsed = await parseRequest(request)
      if (!parsed.hasTools) return parsed.respond.text('{"title": "Test"}')
      const hasToolResult = parsed.body.messages?.some((m: any) =>
        Array.isArray(m.content) && m.content.some((c: any) => c.type === 'tool_result'),
      )
      if (hasToolResult) {
        return parsed.respond.text('the file says hi')
      }
      if (parsed.lastMessage.match(/read hello/)) {
        return parsed.respond.toolCall('Read', {file_path: '/tmp/fakeagent-test/hello.txt'})
      }
      return parsed.respond.text('')
    },
  })

  await using tui = await spawnTui(api, 'claude')
  await tui.waitFor('Haiku')
  await tui.send('read hello.txt')
  await tui.waitFor('the file says hi')
}, 25_000)
