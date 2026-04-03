import type {SpawnOptions} from 'node:child_process'
import {mkdirSync, writeFileSync} from 'node:fs'

export interface AgentConfig {
  command: string
  args?: string[]
  spawnOptions?: SpawnOptions
  getEnv(port: number): Record<string, string>
}

export const agents = {
  opencode: {
    command: 'opencode',
    // stdin must be ignored — opencode reads stdin to EOF when it's not a TTY, causing hangs
    spawnOptions: {stdio: ['ignore', 'pipe', 'pipe']},
    getEnv(port) {
      const config = {
        provider: {
          fakeagent: {
            name: 'Fake Agent',
            api: `http://localhost:${port}/v1`,
            models: {
              'fake-model': {
                name: 'Fake Model',
                tool_call: true,
                reasoning: false,
                attachment: false,
                temperature: true,
                limit: {context: 128000, output: 8192},
                cost: {input: 0, output: 0},
                release_date: '2025-01-01',
              },
            },
          },
        },
        model: 'fakeagent/fake-model',
        // Disable MCP servers to avoid spending seconds connecting to user's configured servers
        mcp: {},
      }
      return {
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        ANTHROPIC_API_KEY: 'fake-key',
        OPENAI_API_KEY: 'fake-key',
        // Isolate from user's global config (MCP servers, plugins, etc.) and database
        XDG_CONFIG_HOME: '/tmp/fakeagent-opencode-config',
        XDG_DATA_HOME: '/tmp/fakeagent-opencode-data',
      }
    },
  },
  claude: {
    command: 'claude',
    // --bare: skip OAuth/keychain, use only ANTHROPIC_API_KEY. Also skips hooks, LSP, etc.
    args: ['--bare'],
    getEnv(port) {
      return {
        ANTHROPIC_BASE_URL: `http://localhost:${port}`,
        ANTHROPIC_API_KEY: 'fake-key',
      }
    },
  },
  codex: {
    command: 'codex',
    getEnv(port) {
      const dir = '/tmp/fakeagent-codex-home'
      mkdirSync(dir, {recursive: true})
      // Trust the cwd so codex skips the trust/onboarding prompts
      const cwd = process.cwd()
      writeFileSync(`${dir}/config.toml`, [
        `model = "gpt-5.4"`,
        `openai_base_url = "http://localhost:${port}/v1"`,
        `check_for_update_on_startup = false`,
        ``,
        `[projects."${cwd}"]`,
        `trust_level = "trusted"`,
        ``,
        `[projects."/tmp/fakeagent-test"]`,
        `trust_level = "trusted"`,
      ].join('\n') + '\n')
      writeFileSync(`${dir}/auth.json`, JSON.stringify({OPENAI_API_KEY: 'fake-key'}))
      return {
        CODEX_API_KEY: 'fake-key',
        CODEX_HOME: dir,
      }
    },
  },
} satisfies Record<string, AgentConfig>

export type AgentName = keyof typeof agents
