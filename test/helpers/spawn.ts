import type {ChildProcess} from 'node:child_process'

/** Wait for a child process to exit, collecting stdout/stderr. Kills on timeout. */
export function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{exitCode: number | null; stdout: string; stderr: string}> {
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
  child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Timed out after ${timeoutMs}ms.\nstdout: ${stdout}\nstderr: ${stderr.slice(-500)}`))
    }, timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({exitCode: code, stdout, stderr})
    })
  })
}
