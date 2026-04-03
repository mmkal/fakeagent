import {spawn} from 'node:child_process'
import type {FakeAgent} from '../../src/api.ts'
import type {AgentName} from '../../src/agents.ts'

export {waitForExit} from './spawn.ts'

export interface TuiTestOptions {
  /** Text to type into the TUI */
  input?: string
  /** String to wait for in the TUI output */
  waitFor: string
  /** How to submit: "cr" (Enter) or "lf-cr" (\n then \r, needed for opencode) */
  submit?: 'cr' | 'lf-cr'
  /** Number of Enter presses to dismiss startup prompts before typing */
  dismiss?: number
  /** Ms to wait before typing (default: 3000) */
  delay?: number
  /** Ms before giving up (default: 10000) */
  timeout?: number
}

/**
 * Run an agent CLI in a real PTY (via Bun.Terminal), type a prompt, and wait for a response.
 * Returns the parsed result from the TUI runner.
 */
export async function runTuiTest(
  api: FakeAgent,
  agent: AgentName,
  options: TuiTestOptions,
): Promise<{found: boolean; clean: string}> {
  const {command, args: agentArgs, env} = api.getSpawnArgs(agent)
  const timeout = options.timeout ?? 10_000

  const child = spawn('bun', ['test/helpers/tui-test-runner.ts'], {
    env: {
      ...process.env,
      ...env,
      PTY_COMMAND: command,
      PTY_ARGS: JSON.stringify(agentArgs),
      PTY_INPUT: options.input ?? 'hi',
      PTY_SUBMIT: options.submit ?? 'cr',
      PTY_WAIT_FOR: options.waitFor,
      PTY_DISMISS: String(options.dismiss ?? 0),
      PTY_DELAY: String(options.delay ?? 3000),
      PTY_TIMEOUT: String(timeout),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: import.meta.dirname + '/../..',
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`TUI test timed out.\nstdout: ${stdout}\nstderr: ${stderr.slice(-500)}`))
    }, timeout + 5_000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })

  if (exitCode !== 0) {
    throw new Error(`TUI test failed (exit ${exitCode}).\nstdout: ${stdout}\nstderr: ${stderr.slice(-500)}`)
  }

  return JSON.parse(stdout.trim().split('\n').pop()!)
}
