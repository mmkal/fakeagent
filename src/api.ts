import * as http from 'node:http'
import {spawn as nodeSpawn, type ChildProcess, type SpawnOptions} from 'node:child_process'
import {WebSocketServer, WebSocket} from 'ws'
import {agents, type AgentName, type AgentConfig} from './agents.ts'

export interface FakeAgent extends AsyncDisposable {
  port: number
  spawn(agent: AgentName, args?: string[], options?: SpawnOptions): ChildProcess
  getSpawnArgs(agent: AgentName): {command: string; args: string[]; env: Record<string, string>; spawnOptions: SpawnOptions}
  createCli(): {run(argv?: string[]): ChildProcess}
}

export const responses = {
  openai: {
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
    toolCall(name: string, args: Record<string, unknown>, callId = `call_fake_${Date.now()}`): Response {
      return Response.json({
        id: `chatcmpl-fake-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'fake-model',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            tool_calls: [{id: callId, type: 'function', function: {name, arguments: JSON.stringify(args)}}],
          },
          finish_reason: 'tool_calls',
        }],
        usage: {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0},
      })
    },
  },
  anthropic: {
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
    toolUse(name: string, input: Record<string, unknown>, toolUseId = `toolu_fake_${Date.now()}`): Response {
      return Response.json({
        id: `msg_fake_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: [{type: 'tool_use', id: toolUseId, name, input}],
        model: 'claude-sonnet-4-20250514',
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: {input_tokens: 0, output_tokens: 0},
      })
    },
  },
  codex: {
    text(content: string): Response {
      const id = `resp_fake_${Date.now()}`
      const msgId = `msg_fake_${Date.now()}`
      return Response.json({
        id,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model: 'fake-model',
        status: 'completed',
        output: [{
          type: 'message',
          role: 'assistant',
          id: msgId,
          content: [{type: 'output_text', text: content}],
        }],
        usage: {input_tokens: 0, output_tokens: 0, total_tokens: 0},
        error: null,
        incomplete_details: null,
      })
    },
    functionCall(name: string, args: Record<string, unknown>, callId = `call_fake_${Date.now()}`): Response {
      const id = `resp_fake_${Date.now()}`
      return Response.json({
        id,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model: 'fake-model',
        status: 'completed',
        output: [{
          id: `item_fake_${Date.now()}`,
          type: 'function_call',
          call_id: callId,
          name,
          arguments: JSON.stringify(args),
        }],
        usage: {input_tokens: 0, output_tokens: 0, total_tokens: 0},
        error: null,
        incomplete_details: null,
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
  /** Non-null if this is an OpenAI Responses API request (/v1/responses) */
  codex: ParsedProtocol | null
  /** Last user message from whichever protocol was detected */
  lastMessage: string
  /** System prompt / instructions text */
  systemPrompt: string
  /** Whether this request includes tool definitions */
  hasTools: boolean
  /** Return a response in the correct format for the detected protocol */
  respond: {
    text(content: string): Response
    toolCall(name: string, args: Record<string, unknown>): Response
  }
  /** The raw parsed body */
  body: any
}

function extractText(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === 'text' || b.type === 'input_text' || b.type === 'output_text')
      .map((b: any) => b.text)
      .join('\n')
  }
  return ''
}

/** Just a helper which does basic parsing of (some) common API requests and gives you a few helpers for matching and responding. You could trivially do this yourself though. */
export async function parseRequest(request: Request): Promise<ParsedRequest> {
  const text = await request.text()
  const body: any = text ? JSON.parse(text) : {}

  const path = new URL(request.url).pathname
  const isAnthropic = path.includes('/v1/messages')
  const isOpenAI = path.includes('/v1/chat/completions')
  const isCodex = path.includes('/v1/responses')

  // Codex uses `input` (string or array), OpenAI/Anthropic use `messages`
  const messages: Array<{role: string; content: any}> = isCodex
    ? (typeof body.input === 'string' ? [{role: 'user', content: body.input}] : body.input ?? [])
    : body.messages ?? []

  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')
  const lastMessage = lastUserMessage ? extractText(lastUserMessage.content) : ''

  const protocol: ParsedProtocol = {lastMessage}
  const proto = isAnthropic ? responses.anthropic : isCodex ? responses.codex : responses.openai
  const respond = {
    text: (content: string) => proto.text(content),
    toolCall: (name: string, args: Record<string, unknown>) =>
      isAnthropic ? responses.anthropic.toolUse(name, args)
        : isCodex ? responses.codex.functionCall(name, args)
        : responses.openai.toolCall(name, args),
  }

  // System prompt location differs by protocol
  const systemPrompt = isAnthropic ? extractText(body.system)
    : isCodex ? (body.instructions ?? '')
    : extractText(messages.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => m.content).join('\n'))

  const hasTools = (body.tools?.length ?? 0) > 0

  return {
    openai: isOpenAI ? protocol : null,
    anthropic: isAnthropic ? protocol : null,
    codex: isCodex ? protocol : null,
    lastMessage,
    systemPrompt,
    hasTools,
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

function responsesApiEvents(json: any): Array<{event: string; data: string}> {
  const inProgressResponse = {...json, status: 'in_progress', output: []}
  const events: Array<{event: string; data: string}> = [
    {event: 'response.created', data: JSON.stringify({type: 'response.created', response: inProgressResponse})},
    {event: 'response.in_progress', data: JSON.stringify({type: 'response.in_progress', response: inProgressResponse})},
  ]
  for (let i = 0; i < (json.output?.length ?? 0); i++) {
    const item = json.output[i]
    if (item.type === 'function_call') {
      events.push({event: 'response.output_item.added', data: JSON.stringify({type: 'response.output_item.added', output_index: i, item: {...item, arguments: ''}})})
      events.push({event: 'response.function_call_arguments.delta', data: JSON.stringify({type: 'response.function_call_arguments.delta', item_id: item.id, output_index: i, delta: item.arguments})})
      events.push({event: 'response.function_call_arguments.done', data: JSON.stringify({type: 'response.function_call_arguments.done', item_id: item.id, output_index: i, arguments: item.arguments})})
      events.push({event: 'response.output_item.done', data: JSON.stringify({type: 'response.output_item.done', output_index: i, item})})
    } else {
      const content = item.content?.[0]?.text ?? ''
      const msgId = item.id ?? `msg_fake_${Date.now()}`
      events.push({event: 'response.output_item.added', data: JSON.stringify({type: 'response.output_item.added', output_index: i, item: {type: 'message', role: 'assistant', id: msgId, content: []}})})
      events.push({event: 'response.content_part.added', data: JSON.stringify({type: 'response.content_part.added', item_id: msgId, output_index: i, content_index: 0, part: {type: 'output_text', text: ''}})})
      events.push({event: 'response.output_text.delta', data: JSON.stringify({type: 'response.output_text.delta', item_id: msgId, output_index: i, content_index: 0, delta: content})})
      events.push({event: 'response.output_text.done', data: JSON.stringify({type: 'response.output_text.done', item_id: msgId, output_index: i, content_index: 0, text: content})})
      events.push({event: 'response.content_part.done', data: JSON.stringify({type: 'response.content_part.done', item_id: msgId, output_index: i, content_index: 0, part: {type: 'output_text', text: content}})})
      events.push({event: 'response.output_item.done', data: JSON.stringify({type: 'response.output_item.done', output_index: i, item})})
    }
  }
  events.push({event: 'response.completed', data: JSON.stringify({type: 'response.completed', response: json})})
  return events
}

function jsonToSSE(json: any): Response {
  // Anthropic Messages API format (has .type === 'message')
  if (json.type === 'message') {
    const events: Array<{event: string; data: string}> = [
      {event: 'message_start', data: JSON.stringify({type: 'message_start', message: {...json, stop_reason: null, content: [], usage: {input_tokens: json.usage?.input_tokens ?? 0, output_tokens: 1}}})},
    ]
    const contentBlocks: any[] = json.content ?? []
    for (let i = 0; i < contentBlocks.length; i++) {
      const block = contentBlocks[i]
      if (block.type === 'tool_use') {
        events.push({event: 'content_block_start', data: JSON.stringify({type: 'content_block_start', index: i, content_block: {type: 'tool_use', id: block.id, name: block.name, input: {}}})})
        events.push({event: 'content_block_delta', data: JSON.stringify({type: 'content_block_delta', index: i, delta: {type: 'input_json_delta', partial_json: JSON.stringify(block.input)}})})
        events.push({event: 'content_block_stop', data: JSON.stringify({type: 'content_block_stop', index: i})})
      } else {
        events.push({event: 'content_block_start', data: JSON.stringify({type: 'content_block_start', index: i, content_block: {type: 'text', text: ''}})})
        events.push({event: 'content_block_delta', data: JSON.stringify({type: 'content_block_delta', index: i, delta: {type: 'text_delta', text: block.text ?? ''}})})
        events.push({event: 'content_block_stop', data: JSON.stringify({type: 'content_block_stop', index: i})})
      }
    }
    if (contentBlocks.length === 0) {
      events.push({event: 'content_block_start', data: JSON.stringify({type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}})})
      events.push({event: 'content_block_stop', data: JSON.stringify({type: 'content_block_stop', index: 0})})
    }
    events.push({event: 'message_delta', data: JSON.stringify({type: 'message_delta', delta: {stop_reason: json.stop_reason ?? 'end_turn', stop_sequence: null}, usage: {output_tokens: json.usage?.output_tokens ?? 0}})})
    events.push({event: 'message_stop', data: JSON.stringify({type: 'message_stop'})})
    return sseResponse(events)
  }

  // OpenAI Responses API format (has .object === 'response')
  if (json.object === 'response') {
    return sseResponse(responsesApiEvents(json))
  }

  // OpenAI Chat Completions format (fallback)
  const message = json.choices?.[0]?.message ?? {}
  const finishReason = json.choices?.[0]?.finish_reason ?? 'stop'
  if (message.tool_calls) {
    const events: Array<{data: string}> = []
    // First chunk: role + tool call header (id, type, name, empty arguments)
    const toolCallHeaders = message.tool_calls.map((tc: any, i: number) => ({
      index: i, id: tc.id, type: 'function', function: {name: tc.function.name, arguments: ''},
    }))
    events.push({data: JSON.stringify({id: json.id, object: 'chat.completion.chunk', created: json.created, model: json.model, choices: [{index: 0, delta: {role: 'assistant', tool_calls: toolCallHeaders}, finish_reason: null}]})})
    // Second chunk: arguments for each tool call
    for (let i = 0; i < message.tool_calls.length; i++) {
      events.push({data: JSON.stringify({id: json.id, object: 'chat.completion.chunk', created: json.created, model: json.model, choices: [{index: 0, delta: {tool_calls: [{index: i, function: {arguments: message.tool_calls[i].function.arguments}}]}, finish_reason: null}]})})
    }
    // Final chunk: finish_reason
    events.push({data: JSON.stringify({id: json.id, object: 'chat.completion.chunk', created: json.created, model: json.model, choices: [{index: 0, delta: {}, finish_reason: finishReason}], usage: json.usage})})
    events.push({data: '[DONE]'})
    return sseResponse(events)
  }
  return sseResponse([
    {data: JSON.stringify({id: json.id, object: 'chat.completion.chunk', created: json.created, model: json.model, choices: [{index: 0, delta: {role: 'assistant', content: message.content ?? ''}, finish_reason: null}]})},
    {data: JSON.stringify({id: json.id, object: 'chat.completion.chunk', created: json.created, model: json.model, choices: [{index: 0, delta: {}, finish_reason: finishReason}], usage: json.usage})},
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

  // WebSocket support for codex (OpenAI Responses API uses WebSocket)
  const wss = new WebSocketServer({noServer: true})
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })
  wss.on('connection', (ws) => {
    ws.on('message', async (data) => {
      try {
        const body = JSON.parse(data.toString())
        // Build a fake Request so the fetch handler can parse it
        const request = new Request('http://localhost/v1/responses', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(body),
        })
        const response = await options.fetch(request)

        if (!response.ok) {
          const errBody = await response.text()
          const id = `resp_err_${Date.now()}`
          const errResponse = {
            id, object: 'response', status: 'failed',
            output: [], usage: {input_tokens: 0, output_tokens: 0, total_tokens: 0},
            error: {type: 'invalid_request_error', code: 'invalid_prompt', message: errBody},
          }
          ws.send(JSON.stringify({type: 'response.created', response: {...errResponse, status: 'in_progress'}}))
          ws.send(JSON.stringify({type: 'response.failed', response: errResponse}))
          return
        }

        const json = await response.json() as any

        // Send Responses API streaming events as individual WS messages
        for (const e of responsesApiEvents(json)) {
          ws.send(e.data)
        }
      } catch (err) {
        ws.send(JSON.stringify({type: 'error', message: String(err)}))
      }
    })
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
      wss.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
