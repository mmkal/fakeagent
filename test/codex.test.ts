import {test, expect} from 'vitest'
import {createFakeAgent, parseRequest} from '../src/index.ts'
import {waitForExit, runTuiTest} from './helpers/index.ts'

test('codex exec hits fakeagent server and gets registered response', async () => {
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

test('codex TUI receives fakeagent response', async () => {
  await using api = await createFakeAgent({
    async fetch(request) {
      const parsed = await parseRequest(request)
      return parsed.respond.text('three')
    },
  })

  const result = await runTuiTest(api, 'codex', {
    waitFor: 'three',
    dismiss: 3,
    delay: 4000,
    timeout: 15_000,
  })

  expect(result.found).toBe(true)
}, 25_000)
