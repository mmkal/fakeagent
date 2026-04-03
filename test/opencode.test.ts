import {test, expect} from 'vitest'
import {execSync, spawn} from 'node:child_process'
import {createFakeAgent, matchers, responses} from '../src/index.ts'

const catchAll = () => responses.openai.text('three')

test('opencode run hits fakeagent server and gets registered response', async () => {
  await using api = await createFakeAgent({port: 0, fetch: catchAll})

  const child = api.spawn('opencode', ['run', 'what is one plus two', '--format', 'json', '--pure'], {
    cwd: '/tmp/fakeagent-test',
  })

  let stdout = ''
  child.stdout!.on('data', (d: Buffer) => (stdout += d.toString()))
  let stderr = ''
  child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()))

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Timed out.\nstdout: ${stdout}\nstderr: ${stderr.slice(-500)}`))
    }, 5_000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })

  expect(exitCode, `stderr: ${stderr.slice(-500)}`).toBe(0)
  expect(stdout).toContain('"text":"three"')
}, 10_000)

test('opencode TUI receives fakeagent response', async () => {
  // Kill any leftover opencode processes from the previous test
  try { execSync('pkill -9 -f "opencode"', {stdio: 'ignore'}) } catch {}
  await new Promise((r) => setTimeout(r, 1000))

  await using api = await createFakeAgent({port: 0, fetch: catchAll})

  const {env} = api.getSpawnArgs('opencode')

  // Use Bun's built-in PTY support via a standalone helper script
  const child = spawn('bun', ['test/helpers/tui-test-runner.ts'], {
    env: {
      ...process.env,
      ...env,
      FAKEAGENT_PORT: String(api.port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: import.meta.dirname + '/..',
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))

  const exitCode = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(-1)
    }, 15_000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })

  expect(exitCode, `TUI test failed.\nstdout: ${stdout}\nstderr: ${stderr.slice(-500)}`).toBe(0)

  const result = JSON.parse(stdout.trim().split('\n').pop()!)
  expect(result.hasFakeModel).toBe(true)
  expect(result.hasThree).toBe(true)
}, 20_000)
