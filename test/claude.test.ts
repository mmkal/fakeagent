import {test, expect} from 'vitest'
import {spawn} from 'node:child_process'
import {createFakeAgent, responses} from '../src/index.ts'
import {waitForExit} from './helpers/spawn.ts'

const catchAll = () => responses.anthropic.text('three')

test('claude -p hits fakeagent server and gets registered response', async () => {
  await using api = await createFakeAgent({port: 0, fetch: catchAll})

  const child = api.spawn('claude', ['-p', 'what is one plus two', '--output-format', 'json', '--bare', '--no-session-persistence'], {
    cwd: '/tmp/fakeagent-test',
  })

  const {exitCode, stdout, stderr} = await waitForExit(child, 10_000)

  expect(exitCode, `stderr: ${stderr.slice(-500)}`).toBe(0)

  const result = JSON.parse(stdout)
  expect(result.result).toContain('three')
}, 15_000)

test('claude TUI receives fakeagent response', async () => {
  await using api = await createFakeAgent({port: 0, fetch: catchAll})
  const {env} = api.getSpawnArgs('claude')

  const child = spawn('bun', ['test/helpers/tui-test-runner.ts'], {
    env: {
      ...process.env, ...env,
      PTY_COMMAND: 'claude',
      PTY_ARGS: JSON.stringify(['--bare']),
      PTY_SUBMIT: 'cr',
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
