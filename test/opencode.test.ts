import {test, expect} from 'vitest'
import {spawn} from 'node:child_process'
import {createFakeAgent, parseRequest} from '../src/index.ts'
import {waitForExit} from './helpers/spawn.ts'

const catchAll = async (request: Request) => {
  const parsed = await parseRequest(request)
  return parsed.respond.text('three')
}

test('opencode run hits fakeagent server and gets registered response', async () => {
  await using api = await createFakeAgent({port: 0, fetch: catchAll})

  const child = api.spawn('opencode', ['run', 'what is one plus two', '--format', 'json', '--pure'], {
    cwd: '/tmp/fakeagent-test',
  })

  const {exitCode, stdout, stderr} = await waitForExit(child, 5_000)

  expect(exitCode, `stderr: ${stderr.slice(-500)}`).toBe(0)
  expect(stdout).toContain('"text":"three"')
}, 10_000)

test('opencode TUI receives fakeagent response', async () => {
  await using api = await createFakeAgent({port: 0, fetch: catchAll})
  const {command, args: agentArgs, env} = api.getSpawnArgs('opencode')

  const child = spawn('bun', ['test/helpers/tui-test-runner.ts'], {
    env: {
      ...process.env, ...env,
      PTY_COMMAND: command,
      PTY_ARGS: JSON.stringify(agentArgs),
      PTY_SUBMIT: 'lf-cr',
      PTY_WAIT_FOR: 'three',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: import.meta.dirname + '/..',
  })

  const {exitCode, stdout, stderr} = await waitForExit(child, 15_000)
  expect(exitCode, `TUI test failed.\nstdout: ${stdout}\nstderr: ${stderr.slice(-500)}`).toBe(0)

  const result = JSON.parse(stdout.trim().split('\n').pop()!)
  expect(result.found).toBe(true)
}, 20_000)
