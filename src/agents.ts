import type {SpawnOptions} from 'node:child_process'

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
} satisfies Record<string, AgentConfig>

export type AgentName = keyof typeof agents
