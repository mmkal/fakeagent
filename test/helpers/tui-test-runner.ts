// Standalone Bun script: spawns an agent CLI with a real PTY, types a prompt, checks output.
// Exit code 0 = pass, 1 = fail.
// Env vars:
//   PTY_COMMAND: command to spawn (required)
//   PTY_ARGS: JSON array of args (default: "[]")
//   PTY_INPUT: text to type (default: "hi")
//   PTY_SUBMIT: how to submit — "cr" (just \r), "lf-cr" (\n then \r), or raw bytes as hex (default: "cr")
//   PTY_WAIT_FOR: string to wait for in output (required)
//   PTY_DELAY: ms to wait before typing (default: "3000")
//   PTY_TIMEOUT: ms before giving up (default: "10000")

const command = process.env.PTY_COMMAND!
if (!command) {
  console.error('PTY_COMMAND required')
  process.exit(1)
}
const args: string[] = JSON.parse(process.env.PTY_ARGS || '[]')
const input = process.env.PTY_INPUT ?? 'hi'
const submitMode = process.env.PTY_SUBMIT ?? 'cr'
const waitFor = process.env.PTY_WAIT_FOR!
const delay = parseInt(process.env.PTY_DELAY ?? '3000')
const timeout = parseInt(process.env.PTY_TIMEOUT ?? '10000')

let output = ''
let resolveWait: () => void
const waitDone = new Promise<void>((r) => (resolveWait = r))

const proc = Bun.spawn([command, ...args], {
  terminal: {
    cols: 120,
    rows: 40,
    data(_term: any, data: any) {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
      output += text
      if (waitFor && output.includes(waitFor)) {
        resolveWait()
      }
    },
  },
  cwd: process.env.PTY_CWD || '/tmp/fakeagent-test',
})

function gracefulKill() {
  try { proc.terminal!.write('\x03') } catch {}
  setTimeout(() => { try { proc.kill('SIGTERM') } catch {} }, 500)
}

// Type after TUI renders
setTimeout(() => proc.terminal!.write(input), delay)

// Submit
if (submitMode === 'lf-cr') {
  setTimeout(() => proc.terminal!.write(new Uint8Array([0x0a])), delay + 500)
  setTimeout(() => proc.terminal!.write(new Uint8Array([0x0d])), delay + 1500)
} else {
  // default: cr
  setTimeout(() => proc.terminal!.write('\r'), delay + 500)
}

const timer = setTimeout(() => {
  gracefulKill()
  resolveWait()
}, timeout)

await waitDone
clearTimeout(timer)
await Bun.sleep(200)
gracefulKill()
await Bun.sleep(500)
try { proc.terminal!.close() } catch {}

const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\[\?[0-9;]*[a-zA-Z]/g, '')
const found = waitFor ? clean.includes(waitFor) : true

console.log(JSON.stringify({found, clean: clean.slice(-500)}))
process.exit(found ? 0 : 1)

export {}
