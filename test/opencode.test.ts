import {test, expect} from 'vitest'
import {createFakeAgent, parseRequest} from '../src/index.ts'
import {waitForExit, spawnTui} from './helpers/index.ts'

test('opencode run hits fakeagent server and gets registered response', async () => {
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

test('opencode TUI receives fakeagent response', async () => {
  await using api = await createFakeAgent({
    async fetch(request) {
      const parsed = await parseRequest(request)
      return parsed.respond.text('three')
    },
  })

  await using tui = await spawnTui(api, 'opencode', {submit: 'lf-cr'})
  await tui.send('what is one plus two')
  await tui.waitFor('three')
}, 20_000)
