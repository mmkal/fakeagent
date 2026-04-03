import {test, expect} from 'vitest'
import {spawn} from 'node:child_process'
import {createFakeAgent, parseRequest} from '../src/index.ts'
import {waitForExit} from './helpers/spawn.ts'

const catchAll = async (request: Request) => {
  const parsed = await parseRequest(request)
  return parsed.respond.text('three')
}

test('codex exec hits fakeagent server and gets registered response', async () => {
  await using api = await createFakeAgent({port: 0, fetch: catchAll})

  const child = api.spawn('codex', ['exec', '--json', 'what is one plus two'], {
    cwd: '/tmp/fakeagent-test',
  })

  const {exitCode, stdout, stderr} = await waitForExit(child, 10_000)

  expect(exitCode, `stderr: ${stderr.slice(-500)}`).toBe(0)
  expect(stdout).toContain('three')
}, 15_000)

test('codex TUI receives fakeagent response', async () => {
  await using api = await createFakeAgent({port: 0, fetch: catchAll})
  const {command, args: agentArgs, env} = api.getSpawnArgs('codex')

  const child = spawn('bun', ['test/helpers/tui-test-runner.ts'], {
    env: {
      ...process.env, ...env,
      PTY_COMMAND: command,
      PTY_ARGS: JSON.stringify(agentArgs),
      PTY_SUBMIT: 'cr',
      PTY_WAIT_FOR: 'three',
      PTY_DISMISS: '3',
      PTY_DELAY: '4000',
      PTY_TIMEOUT: '15000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: import.meta.dirname + '/..',
  })

  const {exitCode, stdout, stderr} = await waitForExit(child, 20_000)
  expect(exitCode, `TUI test failed.\nstdout: ${stdout}\nstderr: ${stderr.slice(-500)}`).toBe(0)

  const result = JSON.parse(stdout.trim().split('\n').pop()!)
  expect(result.found).toBe(true)
}, 25_000)
