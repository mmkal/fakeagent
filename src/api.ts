import * as http from 'node:http'
import {spawn as nodeSpawn, type ChildProcess, type SpawnOptions} from 'node:child_process'
import {agents, type AgentName, type AgentConfig} from './agents.ts'

export interface FakeAgentApi extends AsyncDisposable {
  port: number
  register(pattern: RegExp, handler: () => OpenAIResponse): void
  responses: typeof responses
  spawn(agent: AgentName, args?: string[], options?: SpawnOptions): ChildProcess
  getSpawnArgs(agent: AgentName): {command: string; args: string[]; env: Record<string, string>; spawnOptions: SpawnOptions}
  createCli(): {run(argv?: string[]): ChildProcess}
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
          const content = response.choices[0]?.message.content ?? ''

          if (parsed.stream) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            })
            const chunk = {
              id: response.id,
              object: 'chat.completion.chunk',
              created: response.created,
              model: response.model,
              choices: [{index: 0, delta: {role: 'assistant', content}, finish_reason: null}],
            }
            res.write(`data: ${JSON.stringify(chunk)}\n\n`)
            const done = {
              id: response.id,
              object: 'chat.completion.chunk',
              created: response.created,
              model: response.model,
              choices: [{index: 0, delta: {}, finish_reason: 'stop'}],
              usage: response.usage,
            }
            res.write(`data: ${JSON.stringify(done)}\n\n`)
            res.write('data: [DONE]\n\n')
            res.end()
          } else {
            res.writeHead(200, {'Content-Type': 'application/json'})
            res.end(JSON.stringify(response))
          }
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

  function getSpawnArgs(agent: AgentName) {
    const agentConfig: AgentConfig = agents[agent]
    return {
      command: agentConfig.command,
      args: agentConfig.args ?? [],
      env: agentConfig.getEnv(port),
      spawnOptions: agentConfig.spawnOptions ?? {},
    }
  }

  function spawnAgent(agent: AgentName, args?: string[], options?: SpawnOptions): ChildProcess {
    const config = getSpawnArgs(agent)
    return nodeSpawn(config.command, [...config.args, ...(args ?? [])], {
      ...config.spawnOptions,
      ...options,
      env: {...process.env, ...config.env, ...options?.env},
    })
  }

  return {
    port,
    responses,
    register(pattern, handler) {
      handlers.push({pattern, handler})
    },
    spawn: spawnAgent,
    getSpawnArgs,
    createCli() {
      return {
        run(argv?: string[]) {
          const args = argv ?? process.argv.slice(2)
          const agentName = args[0] as AgentName
          if (!agentName || !agents[agentName]) {
            const available = Object.keys(agents).join(', ')
            console.error(`Usage: <script> <agent> [args...]\nAvailable agents: ${available}`)
            process.exit(1)
          }
          const child = spawnAgent(agentName, args.slice(1), {stdio: 'inherit'})

          // Forward signals and clean up on exit
          const onSignal = (sig: NodeJS.Signals) => {
            child.kill(sig)
          }
          process.on('SIGINT', onSignal)
          process.on('SIGTERM', onSignal)
          child.on('exit', (code) => {
            process.off('SIGINT', onSignal)
            process.off('SIGTERM', onSignal)
            server.close()
            process.exit(code ?? 1)
          })

          return child
        },
      }
    },
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
