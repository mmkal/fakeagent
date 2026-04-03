// Bun-only helper: spawns a command with a real PTY via Bun.Terminal.
// Usage: bun test/helpers/pty-driver.ts <command> [args...]
// Env vars:
//   PTY_INPUT: string to type, submitted with Enter
//   PTY_DELAY: ms to wait before typing (default: 2000)
//   PTY_TIMEOUT: ms before killing (default: 10000)
//   PTY_WAIT_FOR: if set, exit once this appears in output
//   PTY_CWD: working directory for the spawned process

const command = process.argv[2]
const args = process.argv.slice(3)
const input = process.env.PTY_INPUT ?? ''
const delay = parseInt(process.env.PTY_DELAY ?? '2000')
const timeout = parseInt(process.env.PTY_TIMEOUT ?? '10000')
const waitFor = process.env.PTY_WAIT_FOR
const cwd = process.env.PTY_CWD || process.cwd()

let output = ''
let resolveWait: () => void
const waitDone = new Promise<void>((r) => (resolveWait = r))

const proc = Bun.spawn([command, ...args], {
  terminal: {
    cols: 120,
    rows: 40,
    data(_term, data) {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
      output += text
      process.stdout.write(text)
      if (waitFor && output.includes(waitFor)) {
        resolveWait()
      }
    },
  },
  cwd,
})

if (input) {
  // Type the input after delay
  setTimeout(() => {
    console.error('[pty-driver] typing:', input)
    proc.terminal!.write(input)
  }, delay)

  // Submit: send \n first (needed to prime @opentui/core's textarea), then \r to trigger submit
  setTimeout(() => {
    console.error('[pty-driver] sending LF')
    proc.terminal!.write(new Uint8Array([0x0a]))
  }, delay + 500)
  setTimeout(() => {
    console.error('[pty-driver] sending CR')
    proc.terminal!.write(new Uint8Array([0x0d]))
  }, delay + 1500)
}

const timer = setTimeout(() => {
  proc.kill()
  resolveWait()
}, timeout)

await Promise.race([proc.exited, waitDone])
clearTimeout(timer)
try {
  proc.terminal!.close()
} catch {}
process.exit(proc.exitCode ?? 0)
