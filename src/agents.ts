export interface AgentConfig {
  command: string
  args?: string[]
  getEnv(port: number): Record<string, string>
}

export const agents = {
  opencode: {
    command: 'opencode',
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
      }
      return {
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        ANTHROPIC_API_KEY: 'fake-key',
        OPENAI_API_KEY: 'fake-key',
      }
    },
  },
} satisfies Record<string, AgentConfig>

export type AgentName = keyof typeof agents
