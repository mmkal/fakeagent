import {test, expect} from 'vitest'
import {createFakeAgent, parseRequest} from '../src/index.ts'
import {waitForExit, spawnTui} from './helpers/index.ts'

test('opencode run gets fake response', async () => {
  await using api = await createFakeAgent({
    async fetch(request) {
      const parsed = await parseRequest(request)
      return parsed.respond.text('three')
    },
  })

  const child = api.spawn('opencode', ['run', 'what is one plus two', '--format', 'json', '--pure'], {
    cwd: '/tmp/fakeagent-test',
  })

  const {exitCode, stdout, stderr} = await waitForExit(child, 5_000)
  expect(exitCode, `stderr: ${stderr.slice(-500)}`).toBe(0)
  expect(stdout).toContain('"text":"three"')
}, 10_000)

test('opencode TUI text response', async () => {
  await using api = await createFakeAgent({
    async fetch(request) {
      const parsed = await parseRequest(request)
      return parsed.respond.text('three')
    },
  })

  await using tui = await spawnTui(api, 'opencode', {submit: 'lf-cr'})
  await tui.waitFor('Ask anything')
  await tui.send('what is one plus two')
  await tui.waitFor('three')
}, 20_000)

test('opencode TUI tool use', async () => {
  await using api = await createFakeAgent({
    async fetch(request) {
      const parsed = await parseRequest(request)
      const hasToolResult = parsed.body.messages?.some((m: any) => m.role === 'tool')
      if (hasToolResult) {
        return parsed.respond.text('the file says hi')
      }
      if (parsed.lastMessage.match(/read hello/) && parsed.hasTools) {
        return parsed.respond.toolCall('read', {filePath: '/tmp/fakeagent-test/hello.txt'})
      }
      return parsed.respond.text('')
    },
  })

  await using tui = await spawnTui(api, 'opencode', {submit: 'lf-cr'})
  await tui.waitFor('Ask anything')
  await tui.send('read hello.txt')
  await tui.waitFor('the file says hi')
}, 25_000)
