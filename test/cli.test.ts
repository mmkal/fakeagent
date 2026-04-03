import {test, expect} from 'vitest'
import {execSync} from 'node:child_process'

test('cli --help shows available commands', () => {
  const result = execSync('npx tsx src/cli.ts --help', {
    cwd: '/Users/mmkal/src/fakeagent',
    encoding: 'utf-8',
  })
  expect(result).toContain('fakeagent')
  expect(result).toContain('run')
})

test('cli run --help shows agent options', () => {
  const result = execSync('npx tsx src/cli.ts run --help', {
    cwd: '/Users/mmkal/src/fakeagent',
    encoding: 'utf-8',
  })
  expect(result).toContain('--agent')
  expect(result).toContain('opencode')
})
