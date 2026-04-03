import {test, expect} from 'vitest'
import {createFakeAgent, parseRequest, responses} from '../src/index.ts'

test('responds to registered pattern with openai text response', async () => {
  await using api = await createFakeAgent({
    port: 0,
    async fetch(request) {
      const parsed = await parseRequest(request)
      if (parsed.openaiChat?.matches(/one plus two/)) {
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

test('matches against concatenated message content', async () => {
  await using api = await createFakeAgent({
    port: 0,
    async fetch(request) {
      const parsed = await parseRequest(request)
      if (parsed.openaiChat?.matches(/system.*user.*hello/s)) {
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
      if (parsed.openaiChat?.matches(/hello/)) {
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

test('anthropicMessages matches with top-level system field', async () => {
  await using api = await createFakeAgent({
    port: 0,
    async fetch(request) {
      const parsed = await parseRequest(request)
      if (parsed.anthropicMessages?.matches(/system.*careful.*user.*hello/s)) {
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
