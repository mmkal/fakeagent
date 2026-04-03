import {test, expect} from 'vitest'
import {createFakeAgent, parseRequest, responses} from '../src/index.ts'

test('responds to registered pattern with openai text response', async () => {
  await using api = await createFakeAgent({
    port: 0,
    async fetch(request) {
      const parsed = await parseRequest(request)
      if (parsed.openai?.lastMessage.match(/one plus two/)) {
        return responses.openai.text('three')
      }
      return Response.json({error: {message: 'unmatched'}}, {status: 400})
    },
  })

  const response = await fetch(`http://localhost:${api.port}/v1/chat/completions`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      model: 'fake-model',
      messages: [{role: 'user', content: 'what is one plus two'}],
    }),
  })

  expect(response.status).toBe(200)
  const data = await response.json()
  expect(data).toMatchObject({
    choices: [{message: {role: 'assistant', content: 'three'}}],
  })
})

test('matches against last user message only', async () => {
  await using api = await createFakeAgent({
    port: 0,
    async fetch(request) {
      const parsed = await parseRequest(request)
      if (parsed.openai?.lastMessage.match(/hello/)) {
        return responses.openai.text('hi there')
      }
      return Response.json({error: {message: 'unmatched'}}, {status: 400})
    },
  })

  const response = await fetch(`http://localhost:${api.port}/v1/chat/completions`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      model: 'fake-model',
      messages: [
        {role: 'system', content: 'You are a system prompt'},
        {role: 'user', content: 'hello world'},
      ],
    }),
  })

  expect(response.status).toBe(200)
  const data = await response.json()
  expect(data).toMatchObject({
    choices: [{message: {content: 'hi there'}}],
  })
})

test('unmatched request returns error', async () => {
  await using api = await createFakeAgent({
    port: 0,
    fetch() {
      return Response.json({error: {message: 'No matching handler'}}, {status: 400})
    },
  })

  const response = await fetch(`http://localhost:${api.port}/v1/chat/completions`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      model: 'fake-model',
      messages: [{role: 'user', content: 'unmatched prompt'}],
    }),
  })

  expect(response.status).toBe(400)
  const data = await response.json()
  expect(data).toMatchObject({
    error: {message: expect.stringContaining('No matching handler')},
  })
})

test('fetch handler has access to full request body', async () => {
  let capturedModel = ''
  await using api = await createFakeAgent({
    port: 0,
    async fetch(request) {
      const parsed = await parseRequest(request)
      capturedModel = parsed.body.model
      if (parsed.openai?.lastMessage.match(/hello/)) {
        return responses.openai.text('first')
      }
      return responses.openai.text('fallback')
    },
  })

  const response = await fetch(`http://localhost:${api.port}/v1/chat/completions`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      model: 'gpt-test',
      messages: [{role: 'user', content: 'hello'}],
    }),
  })

  const data = await response.json()
  expect(data).toMatchObject({choices: [{message: {content: 'first'}}]})
  expect(capturedModel).toBe('gpt-test')
})

test('anthropic lastMessage matches last user message', async () => {
  await using api = await createFakeAgent({
    port: 0,
    async fetch(request) {
      const parsed = await parseRequest(request)
      if (parsed.anthropic?.lastMessage.match(/hello/)) {
        return responses.anthropic.text('matched')
      }
      return Response.json({error: {message: 'unmatched'}}, {status: 400})
    },
  })

  const response = await fetch(`http://localhost:${api.port}/v1/messages`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: 'Be careful',
      messages: [{role: 'user', content: 'hello'}],
    }),
  })

  expect(response.status).toBe(200)
  const data = await response.json()
  expect(data).toMatchObject({
    content: [{type: 'text', text: 'matched'}],
  })
})

test('parseRequest detects protocol from URL path', async () => {
  await using api = await createFakeAgent({
    port: 0,
    async fetch(request) {
      const parsed = await parseRequest(request)
      // Return which protocol was detected so we can assert from outside
      return Response.json({
        openai: parsed.openai !== null,
        anthropic: parsed.anthropic !== null,
      })
    },
  })

  const anthropicRes = await fetch(`http://localhost:${api.port}/v1/messages`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({model: 'claude', messages: [{role: 'user', content: 'hi'}]}),
  })
  expect(await anthropicRes.json()).toMatchObject({openai: false, anthropic: true})

  const openaiRes = await fetch(`http://localhost:${api.port}/v1/chat/completions`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({model: 'gpt', messages: [{role: 'user', content: 'hi'}]}),
  })
  expect(await openaiRes.json()).toMatchObject({openai: true, anthropic: false})
})

test('dual-protocol handler returns correct format per protocol', async () => {
  await using api = await createFakeAgent({
    port: 0,
    async fetch(request) {
      const parsed = await parseRequest(request)
      if (parsed.openai?.lastMessage.match(/hi/)) return responses.openai.text('openai-response')
      if (parsed.anthropic?.lastMessage.match(/hi/)) return responses.anthropic.text('anthropic-response')
      return Response.json({error: 'no match'}, {status: 400})
    },
  })

  const anthropicRes = await fetch(`http://localhost:${api.port}/v1/messages`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({model: 'claude', messages: [{role: 'user', content: 'hi'}]}),
  })
  const anthropicData = await anthropicRes.json()
  expect(anthropicData).toMatchObject({type: 'message', content: [{text: 'anthropic-response'}]})

  const openaiRes = await fetch(`http://localhost:${api.port}/v1/chat/completions`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({model: 'gpt', messages: [{role: 'user', content: 'hi'}]}),
  })
  const openaiData = await openaiRes.json()
  expect(openaiData).toMatchObject({choices: [{message: {content: 'openai-response'}}]})
})

test('matches only matches the last user message, not conversation history', async () => {
  await using api = await createFakeAgent({
    port: 0,
    async fetch(request) {
      const parsed = await parseRequest(request)
      if (parsed.anthropic?.lastMessage.match(/one plus two/)) {
        return responses.anthropic.text('three')
      }
      return Response.json({error: {message: 'no match'}}, {status: 400})
    },
  })

  // First turn: "one plus two" matches
  const res1 = await fetch(`http://localhost:${api.port}/v1/messages`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      model: 'claude',
      messages: [{role: 'user', content: 'one plus two'}],
    }),
  })
  expect(res1.status).toBe(200)

  // Second turn: "hello" should NOT match, even though history contains "one plus two"
  const res2 = await fetch(`http://localhost:${api.port}/v1/messages`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      model: 'claude',
      messages: [
        {role: 'user', content: 'one plus two'},
        {role: 'assistant', content: 'three'},
        {role: 'user', content: 'hello'},
      ],
    }),
  })
  expect(res2.status).toBe(400)
})

test('parsed.lastMessage and parsed.respond work across protocols', async () => {
  await using api = await createFakeAgent({
    port: 0,
    async fetch(request) {
      const parsed = await parseRequest(request)
      if (parsed.lastMessage.match(/one plus two/)) {
        return parsed.respond.text('three')
      }
      return Response.json({error: {message: 'no match'}}, {status: 400})
    },
  })

  // OpenAI request gets OpenAI-format response
  const openaiRes = await fetch(`http://localhost:${api.port}/v1/chat/completions`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({model: 'gpt', messages: [{role: 'user', content: 'one plus two'}]}),
  })
  expect(openaiRes.status).toBe(200)
  expect(await openaiRes.json()).toMatchObject({choices: [{message: {content: 'three'}}]})

  // Anthropic request gets Anthropic-format response
  const anthropicRes = await fetch(`http://localhost:${api.port}/v1/messages`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({model: 'claude', messages: [{role: 'user', content: 'one plus two'}]}),
  })
  expect(anthropicRes.status).toBe(200)
  expect(await anthropicRes.json()).toMatchObject({type: 'message', content: [{text: 'three'}]})

  // Non-matching gets 400 regardless of protocol
  const noMatch = await fetch(`http://localhost:${api.port}/v1/messages`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({model: 'claude', messages: [{role: 'user', content: 'hello'}]}),
  })
  expect(noMatch.status).toBe(400)
})

test('getSpawnArgs returns command and env for agent', async () => {
  await using api = await createFakeAgent({
    port: 0,
    fetch: () => new Response('not found', {status: 404}),
  })

  const opencode = api.getSpawnArgs('opencode')
  expect(opencode.command).toBe('opencode')
  expect(opencode.env.OPENCODE_CONFIG_CONTENT).toBeDefined()

  const claude = api.getSpawnArgs('claude')
  expect(claude.command).toBe('claude')
  expect(claude.env.ANTHROPIC_BASE_URL).toBe(`http://localhost:${api.port}`)
})
