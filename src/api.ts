import * as http from 'node:http'
import {spawn as nodeSpawn, type ChildProcess, type SpawnOptions} from 'node:child_process'
import {agents, type AgentName, type AgentConfig} from './agents.ts'

export interface FakeAgent extends AsyncDisposable {
  port: number
  spawn(agent: AgentName, args?: string[], options?: SpawnOptions): ChildProcess
  getSpawnArgs(agent: AgentName): {command: string; args: string[]; env: Record<string, string>; spawnOptions: SpawnOptions}
  createCli(): {run(argv?: string[]): ChildProcess}
}

export const responses = {
  openai: {
    /** Return an OpenAI chat completion response. Auto-converted to SSE when the client requests streaming. */
    text(content: string): Response {
      return Response.json({
        id: `chatcmpl-fake-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'fake-model',
        choices: [{index: 0, message: {role: 'assistant', content}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0},
      })
    },
  },
  anthropic: {
    /** Return an Anthropic Messages API response. Auto-converted to SSE when the client requests streaming. */
    text(content: string): Response {
      return Response.json({
        id: `msg_fake_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: [{type: 'text', text: content}],
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {input_tokens: 0, output_tokens: 0},
      })
    },
  },
}

export interface ParsedProtocol {
  lastMessage: string
}

export interface ParsedRequest {
  /** Non-null if this is an OpenAI chat completion request (/v1/chat/completions) */
  openai: ParsedProtocol | null
  /** Non-null if this is an Anthropic messages request (/v1/messages) */
  anthropic: ParsedProtocol | null
  /** Last user message from whichever protocol was detected */
  lastMessage: string
  /** Return a text response in the correct format for the detected protocol */
  respond: {text(content: string): Response}
  /** The raw parsed body */
  body: any
}

function extractText(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
  return ''
}

/** Just a helper which does basic parsing of (some) common API requests and gives you a few helpers for matching and responding. You could trivially do this yourself though. */
export async function parseRequest(request: Request): Promise<ParsedRequest> {
  const text = await request.text()
  const body: any = text ? JSON.parse(text) : {}
  const messages: Array<{role: string; content: any}> = body.messages ?? []

  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')
  const lastMessage = lastUserMessage ? extractText(lastUserMessage.content) : ''

  const path = new URL(request.url).pathname
  const isAnthropic = path.includes('/v1/messages')
  const isOpenAI = path.includes('/v1/chat/completions')

  const protocol: ParsedProtocol = {lastMessage}
  const respond = isAnthropic ? responses.anthropic : responses.openai

  return {
    openai: isOpenAI ? protocol : null,
    anthropic: isAnthropic ? protocol : null,
    lastMessage,
    respond,
    body,
  }
}

export interface CreateFakeAgentOptions {
  port?: number
  fetch(request: Request): Response | Promise<Response>
}

function sseResponse(events: Array<{event?: string; data: string}>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const {event, data} of events) {
        if (event) controller.enqueue(encoder.encode(`event: ${event}\n`))
        controller.enqueue(encoder.encode(`data: ${data}\n\n`))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    headers: {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive'},
  })
}

function jsonToSSE(json: any): Response {
  // Anthropic Messages API format (has .type === 'message')
  if (json.type === 'message') {
    const content = json.content?.[0]?.text ?? ''
    return sseResponse([
      {event: 'message_start', data: JSON.stringify({type: 'message_start', message: {...json, stop_reason: null, content: [], usage: {input_tokens: json.usage?.input_tokens ?? 0, output_tokens: 1}}})},
      {event: 'content_block_start', data: JSON.stringify({type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}})},
      {event: 'ping', data: JSON.stringify({type: 'ping'})},
      {event: 'content_block_delta', data: JSON.stringify({type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: content}})},
      {event: 'content_block_stop', data: JSON.stringify({type: 'content_block_stop', index: 0})},
      {event: 'message_delta', data: JSON.stringify({type: 'message_delta', delta: {stop_reason: 'end_turn', stop_sequence: null}, usage: {output_tokens: json.usage?.output_tokens ?? 0}})},
      {event: 'message_stop', data: JSON.stringify({type: 'message_stop'})},
    ])
  }

  // OpenAI Chat Completions format (has .choices)
  const content = json.choices?.[0]?.message?.content ?? ''
  return sseResponse([
    {data: JSON.stringify({id: json.id, object: 'chat.completion.chunk', created: json.created, model: json.model, choices: [{index: 0, delta: {role: 'assistant', content}, finish_reason: null}]})},
    {data: JSON.stringify({id: json.id, object: 'chat.completion.chunk', created: json.created, model: json.model, choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage: json.usage})},
    {data: '[DONE]'},
  ])
}

export async function createFakeAgent(options: CreateFakeAgentOptions): Promise<FakeAgent> {
  const server = http.createServer(async (req, res) => {
    try {
      // Health check — claude sends HEAD / on startup
      if (req.method === 'HEAD') {
        res.writeHead(200)
        res.end()
        return
      }

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

      // Auto-convert JSON responses to SSE when the client requested streaming.
      // This lets fetch handlers return plain responses.openai.text() or responses.anthropic.text()
      // without worrying about streaming wire formats.
      const isStreamRequest = body.includes('"stream":true') || body.includes('"stream": true')
      const isJsonResponse = response.headers.get('content-type')?.includes('application/json')
      if (isStreamRequest && isJsonResponse && response.ok) {
        const json = await response.json() as any
        response = jsonToSSE(json)
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
