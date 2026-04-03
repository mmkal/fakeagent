// Bun-only: spawns an agent CLI with a real PTY and exposes an HTTP control server.
// The control server accepts commands to type, submit, wait for output, and kill.
// Env vars:
//   PTY_COMMAND: command to spawn (required)
//   PTY_ARGS: JSON array of args (default: "[]")
//   PTY_SUBMIT: how to submit — "cr" or "lf-cr" (default: "cr")
//   PTY_CWD: working directory (default: /tmp/fakeagent-test)

const command = process.env.PTY_COMMAND!
if (!command) {
  process.exit(1)
}
const args: string[] = JSON.parse(process.env.PTY_ARGS || '[]')
const submitMode = process.env.PTY_SUBMIT ?? 'cr'

let output = ''
const waiters: Array<{pattern: string; resolve: () => void}> = []

function cleanOutput(raw: string): string {
  return raw
    // Replace cursor-right movement (ESC[nC) with spaces
    .replace(/\x1b\[(\d+)C/g, (_m, n) => ' '.repeat(parseInt(n)))
    // CSI sequences: ESC [ (params) letter
    .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '')
    // OSC sequences: ESC ] ... BEL/ST
    .replace(/\x1b\].*?(?:\x07|\x1b\\)/g, '')
    // Other 2-byte ESC sequences: ESC + single char
    .replace(/\x1b[^[\]]/g, '')
}

function checkWaiters() {
  const clean = cleanOutput(output)
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (clean.includes(waiters[i].pattern)) {
      waiters[i].resolve()
      waiters.splice(i, 1)
    }
  }
}

const proc = Bun.spawn([command, ...args], {
  terminal: {
    cols: 120,
    rows: 40,
    data(_term: any, data: any) {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
      output += text
      checkWaiters()
    },
  },
  cwd: process.env.PTY_CWD || '/tmp/fakeagent-test',
})

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === '/send') {
      const {text} = await request.json() as {text: string}
      proc.terminal!.write(text)
      // Wait for TUI to process the typed text before submitting
      await Bun.sleep(1000)
      if (submitMode === 'lf-cr') {
        proc.terminal!.write(new Uint8Array([0x0a]))
        await Bun.sleep(1000)
        proc.terminal!.write(new Uint8Array([0x0d]))
      } else {
        proc.terminal!.write('\r')
      }
      // Wait for submit to be processed before returning
      await Bun.sleep(500)
      return Response.json({ok: true})
    }

    if (url.pathname === '/dismiss') {
      proc.terminal!.write('\r')
      return Response.json({ok: true})
    }

    if (url.pathname === '/wait') {
      const {pattern, timeout = 10000} = await request.json() as {pattern: string; timeout?: number}
      const clean = cleanOutput(output)
      if (clean.includes(pattern)) {
        return Response.json({found: true})
      }
      const found = await Promise.race([
        new Promise<true>((resolve) => waiters.push({pattern, resolve: () => resolve(true)})),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), timeout)),
      ])
      return Response.json({found})
    }

    if (url.pathname === '/kill') {
      try { proc.terminal!.write('\x03') } catch {}
      setTimeout(() => { try { proc.kill('SIGTERM') } catch {} }, 500)
      setTimeout(() => { server.stop(); process.exit(0) }, 1000)
      return Response.json({ok: true})
    }

    if (url.pathname === '/output') {
      return Response.json({raw: output.slice(-2000), clean: cleanOutput(output).slice(-2000)})
    }

    return new Response('not found', {status: 404})
  },
})

// Print the control server port so the parent can connect
console.log(server.port)

export {}
