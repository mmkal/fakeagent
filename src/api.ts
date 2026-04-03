import * as http from 'node:http'
import {spawn as nodeSpawn, type ChildProcess, type SpawnOptions} from 'node:child_process'
import {agents, type AgentName, type AgentConfig} from './agents.ts'

export interface ChatCompletionRequest {
  model: string
  messages: Array<{role: string; content: string}>
  stream?: boolean
  [key: string]: unknown
}

export interface FakeAgent extends AsyncDisposable {
  port: number
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
    /** Return a chat completion response. The server auto-converts to SSE when the client requests streaming. */
    text(content: string): Response {
      const body: OpenAIResponse = {
        id: `chatcmpl-fake-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'fake-model',
        choices: [{index: 0, message: {role: 'assistant', content}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0},
      }
      return Response.json(body)
    },
  },
}

export const matchers = {
  /** Parse the request body as a chat completion request */
  async chatCompletionRequest(request: Request): Promise<ChatCompletionRequest> {
    return request.json() as Promise<ChatCompletionRequest>
  },

  /** Test a regex against concatenated "role: content" message lines */
  promptMatches(body: ChatCompletionRequest, pattern: RegExp): boolean {
    const concatenated = body.messages.map((m) => `${m.role}: ${m.content}`).join('\n')
    return pattern.test(concatenated)
  },
}

export interface CreateFakeAgentOptions {
  port?: number
  fetch(request: Request): Response | Promise<Response>
}

export async function createFakeAgent(options: CreateFakeAgentOptions): Promise<FakeAgent> {
  const server = http.createServer(async (req, res) => {
    try {
      // Convert node IncomingMessage to a standard Request
      const body = await new Promise<string>((resolve) => {
        let data = ''
        req.on('data', (chunk: string) => (data += chunk))
        req.on('end', () => resolve(data))
      })
      const url = `http://localhost${req.url}`
      const request = new Request(url, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
      })

      let response = await options.fetch(request)

      // Auto-convert JSON chat completion responses to SSE when the client requested streaming.
      // This lets fetch handlers return plain responses.openai.text() without worrying about streaming.
      const isStreamRequest = body.includes('"stream":true') || body.includes('"stream": true')
      const isJsonResponse = response.headers.get('content-type')?.includes('application/json')
      if (isStreamRequest && isJsonResponse && response.ok) {
        const json = await response.json() as OpenAIResponse
        const content = json.choices?.[0]?.message?.content ?? ''
        const encoder = new TextEncoder()
        const chunk = JSON.stringify({
          id: json.id, object: 'chat.completion.chunk', created: json.created, model: json.model,
          choices: [{index: 0, delta: {role: 'assistant', content}, finish_reason: null}],
        })
        const done = JSON.stringify({
          id: json.id, object: 'chat.completion.chunk', created: json.created, model: json.model,
          choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage: json.usage,
        })
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${chunk}\n\n`))
            controller.enqueue(encoder.encode(`data: ${done}\n\n`))
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          },
        })
        response = new Response(stream, {
          headers: {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive'},
        })
      }

      // Convert standard Response back to node response
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
      if (response.body) {
        const reader = response.body.getReader()
        while (true) {
          const {done, value} = await reader.read()
          if (done) break
          res.write(value)
        }
      }
      res.end()
    } catch (err) {
      res.writeHead(500, {'Content-Type': 'application/json'})
      res.end(JSON.stringify({error: {message: String(err)}}))
    }
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
