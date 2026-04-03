import {test, expect} from 'vitest'
import {getFakeAgentApi} from '../src/api'

test('responds to registered pattern with openai text response', async () => {
  await using api = await getFakeAgentApi({port: 0}) // port 0 = random available port

  api.register(/one plus two/, () => api.responses.openai.text('three'))

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
  await using api = await getFakeAgentApi({port: 0})

  api.register(/system.*user.*hello/s, () => api.responses.openai.text('hi there'))

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
  await using api = await getFakeAgentApi({port: 0})

  // Register nothing — all requests should fail
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

test('first matching handler wins', async () => {
  await using api = await getFakeAgentApi({port: 0})

  api.register(/hello/, () => api.responses.openai.text('first'))
  api.register(/hello/, () => api.responses.openai.text('second'))

  const response = await fetch(`http://localhost:${api.port}/v1/chat/completions`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      model: 'fake-model',
      messages: [{role: 'user', content: 'hello'}],
    }),
  })

  const data = await response.json()
  expect(data).toMatchObject({
    choices: [{message: {content: 'first'}}],
  })
})

test('getAgentEnv returns correct env for opencode', async () => {
  await using api = await getFakeAgentApi({port: 0})

  const env = api.getAgentEnv('opencode')
  expect(env.OPENCODE_CONFIG_CONTENT).toBeDefined()

  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!)
  expect(config.provider.fakeagent.api).toBe(`http://localhost:${api.port}/v1`)
  expect(config.model).toBe('fakeagent/fake-model')
})

test('getSpawnArgs returns command and env for agent', async () => {
  await using api = await getFakeAgentApi({port: 0})

  const spawn = api.getSpawnArgs('opencode')
  expect(spawn.command).toBe('opencode')
  expect(spawn.env.OPENCODE_CONFIG_CONTENT).toBeDefined()
  expect(spawn.env.ANTHROPIC_API_KEY).toBe('fake-key')
})
