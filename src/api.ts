import * as http from 'node:http'
import {agents, type AgentName} from './agents'

export interface FakeAgentApi extends AsyncDisposable {
  port: number
  register(pattern: RegExp, handler: () => OpenAIResponse): void
  responses: typeof responses
  getAgentEnv(agent: AgentName): Record<string, string>
  getSpawnArgs(agent: AgentName): {command: string; args: string[]; env: Record<string, string>}
}

export interface OpenAIResponse {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    message: {role: string; content: string}
    finish_reason: string
  }>
  usage: {prompt_tokens: number; completion_tokens: number; total_tokens: number}
}

export const responses = {
  openai: {
    text(content: string): OpenAIResponse {
      return {
        id: `chatcmpl-fake-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'fake-model',
        choices: [
          {
            index: 0,
            message: {role: 'assistant', content},
            finish_reason: 'stop',
          },
        ],
        usage: {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0},
      }
    },
  },
}

type Handler = {pattern: RegExp; handler: () => OpenAIResponse}

export async function getFakeAgentApi(options: {port?: number} = {}): Promise<FakeAgentApi> {
  const handlers: Handler[] = []

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/v1/chat/completions')) {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body)
          const messages: Array<{role: string; content: string}> = parsed.messages ?? []
          const concatenated = messages.map((m) => `${m.role}: ${m.content}`).join('\n')

          const match = handlers.find((h) => h.pattern.test(concatenated))
          if (!match) {
            res.writeHead(400, {'Content-Type': 'application/json'})
            res.end(
              JSON.stringify({
                error: {
                  message: `No matching handler for prompt:\n${concatenated}`,
                  type: 'invalid_request_error',
                },
              }),
            )
            return
          }

          const response = match.handler()
          res.writeHead(200, {'Content-Type': 'application/json'})
          res.end(JSON.stringify(response))
        } catch (err) {
          res.writeHead(500, {'Content-Type': 'application/json'})
          res.end(JSON.stringify({error: {message: String(err)}}))
        }
      })
      return
    }

    res.writeHead(404, {'Content-Type': 'application/json'})
    res.end(JSON.stringify({error: {message: 'Not found'}}))
  })

  const port = await new Promise<number>((resolve) => {
    server.listen(options.port ?? 0, () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr ? addr.port : 0)
    })
  })

  return {
    port,
    responses,
    register(pattern, handler) {
      handlers.push({pattern, handler})
    },
    getAgentEnv(agent) {
      const agentConfig = agents[agent]
      return agentConfig.getEnv(port)
    },
    getSpawnArgs(agent) {
      const agentConfig = agents[agent]
      return {
        command: agentConfig.command,
        args: agentConfig.args ?? [],
        env: agentConfig.getEnv(port),
      }
    },
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
