// Standalone Bun script that runs the full TUI integration test.
// Spawns opencode with a real PTY, types a prompt, checks for response.
// Exit code 0 = pass, 1 = fail.
// Env vars: FAKEAGENT_PORT (required)

const port = parseInt(process.env.FAKEAGENT_PORT!)
if (!port) {
  console.error('FAKEAGENT_PORT required')
  process.exit(1)
}

const runId = Date.now()

let output = ''
let resolveWait: () => void
const waitDone = new Promise<void>((r) => (resolveWait = r))

const proc = Bun.spawn(['opencode'], {
  terminal: {
    cols: 120,
    rows: 40,
    data(_term, data) {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
      output += text
      if (output.includes('three')) {
        resolveWait()
      }
    },
  },
  cwd: '/tmp/fakeagent-test',
  env: {
    ...process.env,
    XDG_DATA_HOME: `/tmp/fakeagent-tui-data-${runId}`,
    XDG_CONFIG_HOME: `/tmp/fakeagent-tui-config-${runId}`,
  },
})

function gracefulKill() {
  // Send Ctrl+C via the PTY so opencode can restore terminal state
  try { proc.terminal!.write('\x03') } catch {}
  // Follow up with SIGTERM after a short delay
  setTimeout(() => {
    try { proc.kill('SIGTERM') } catch {}
  }, 500)
}

// Type after TUI renders
setTimeout(() => proc.terminal!.write('hi'), 2000)
// Submit: \n primes the textarea, then \r triggers submit
setTimeout(() => proc.terminal!.write(new Uint8Array([0x0a])), 2500)
setTimeout(() => proc.terminal!.write(new Uint8Array([0x0d])), 3500)

const timer = setTimeout(() => {
  gracefulKill()
  resolveWait()
}, 10000)

// Wait for "three" to appear OR timeout
await waitDone
clearTimeout(timer)

// Give a moment for remaining data to flush, then exit gracefully
await Bun.sleep(200)
gracefulKill()
await Bun.sleep(500)

try {
  proc.terminal!.close()
} catch {}

const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\[\?[0-9;]*[a-zA-Z]/g, '')
const hasThree = clean.includes('three')
const hasFakeModel = clean.includes('Fake Model')

console.log(JSON.stringify({hasThree, hasFakeModel}))
process.exit(hasThree ? 0 : 1)

export {}
