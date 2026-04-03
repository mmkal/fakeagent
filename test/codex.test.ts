import {test, expect} from 'vitest'
import {createFakeAgent, parseRequest} from '../src/index.ts'
import {waitForExit, spawnTui} from './helpers/index.ts'

test('codex exec gets fake response', async () => {
  await using api = await createFakeAgent({
    async fetch(request) {
      const parsed = await parseRequest(request)
      return parsed.respond.text('three')
    },
  })

  const child = api.spawn('codex', ['exec', '--json', 'what is one plus two'], {
    cwd: '/tmp/fakeagent-test',
  })

  const {exitCode, stdout, stderr} = await waitForExit(child, 10_000)
  expect(exitCode, `stderr: ${stderr.slice(-500)}`).toBe(0)
  expect(stdout).toContain('three')
}, 15_000)

test('codex TUI text response', async () => {
  await using api = await createFakeAgent({
    async fetch(request) {
      const parsed = await parseRequest(request)
      return parsed.respond.text('three')
    },
  })

  await using tui = await spawnTui(api, 'codex')
  await tui.waitFor('OpenAI Codex')
  await tui.send('what is one plus two')
  await tui.waitFor('three')
}, 25_000)

test.skip('codex TUI tool use', async () => {
  await using api = await createFakeAgent({
    async fetch(request) {
      const parsed = await parseRequest(request)
      if (parsed.lastMessage.match(/read hello/)) {
        return parsed.respond.toolCall('shell', {command: ['cat', '/tmp/fakeagent-test/hello.txt']})
      }
      const hasToolResult = parsed.body.input?.some?.((i: any) => i.type === 'function_call_output')
      if (hasToolResult) {
        return parsed.respond.text('the file says hi')
      }
      return Response.json({error: 'no match'}, {status: 400})
    },
  })

  await using tui = await spawnTui(api, 'codex')
  await tui.waitFor('OpenAI Codex')
  await tui.send('read hello.txt')
  await tui.waitFor('the file says hi')
}, 30_000)
