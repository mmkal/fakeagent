# fakeagent

Fake API server for testing tools that use coding agent CLIs (Claude Code, OpenAI Codex, opencode) under the hood. Intercepts LLM requests so you get deterministic, instant responses instead of hitting real APIs.

## Why

You built a tool that spawns `claude` or `codex` as a subprocess. Now you need to test it. But you can't — every run hits the real API, costs money, takes seconds, and returns different text each time.

fakeagent gives you a local server that speaks the right protocol for each CLI, a `fetch` handler you control, and helpers to spawn the CLI pointed at your server. Your tests become fast, free, and deterministic.

## Install

```sh
npm install fakeagent
```

## Usage

### In tests

```ts
import {createFakeAgent, parseRequest} from 'fakeagent'

const api = await createFakeAgent({
  async fetch(request) {
    const parsed = await parseRequest(request)
    if (parsed.lastMessage.match(/review.*pr/i)) {
      return parsed.respond.text('LGTM, no issues found.')
    }
    return parsed.respond.text('Done.')
  },
})

// spawn your tool, which internally runs `claude -p "review this PR"`
const result = await myTool.reviewPR({
  command: `node my-cli.js --agent-command="${api.spawnCommand('claude')}"`,
})

expect(result.summary).toContain('LGTM')

await api[Symbol.asyncDispose]()
```

### As a CLI wrapper

Write a script that registers handlers then spawns the agent interactively:

```ts
// fake-claude.ts
import {createFakeAgent, parseRequest} from 'fakeagent'

const api = await createFakeAgent({
  async fetch(request) {
    const parsed = await parseRequest(request)
    if (parsed.lastMessage.match(/one plus two/)) {
      return parsed.respond.text('three')
    }
    return Response.json({error: 'no match'}, {status: 400})
  },
})

api.createCli().run() // reads agent name from argv
```

```sh
node fake-claude.ts claude      # opens claude TUI, pointed at your fake server
node fake-claude.ts opencode    # same for opencode
node fake-claude.ts codex       # same for codex
```

## Supported agents

| Agent | Protocol | How it's redirected |
|-------|----------|-------------------|
| `claude` | Anthropic Messages API | `ANTHROPIC_BASE_URL` + `--bare` |
| `opencode` | OpenAI Chat Completions | Custom provider via `OPENCODE_CONFIG_CONTENT` |
| `codex` | OpenAI Responses API (WebSocket) | `config.toml` with `openai_base_url` |

## API

### `createFakeAgent(options)`

Starts an HTTP server (+ WebSocket for codex) on a random available port.

```ts
const api = await createFakeAgent({
  port: 8080, // optional, default: random
  fetch(request) { // standard Request → Response
    return new Response('hello')
  },
})
```

Returns a `FakeAgent` (implements `AsyncDisposable`):
- `api.port` — server port
- `api.spawn(agent, args?, options?)` — spawn agent CLI as child process
- `api.createCli()` — returns `{run()}` which reads agent from `process.argv` and spawns it
- `api.getSpawnArgs(agent)` — get raw `{command, args, env, spawnOptions}` for manual spawning

### `parseRequest(request)`

Detects the protocol from the URL path and parses the body.

```ts
const parsed = await parseRequest(request)

// Protocol-agnostic (use for simple cases):
parsed.lastMessage              // last user message as a string
parsed.respond.text('hello')    // Response in the correct format

// Protocol-specific (non-null only for that protocol):
parsed.openai?.lastMessage      // /v1/chat/completions
parsed.anthropic?.lastMessage   // /v1/messages
parsed.codex?.lastMessage       // /v1/responses

parsed.body                     // raw parsed JSON
```

### `responses`

Response helpers for when you need explicit protocol control:

```ts
import {responses} from 'fakeagent'

responses.openai.text('hello')     // OpenAI chat completion Response
responses.anthropic.text('hello')  // Anthropic message Response
responses.codex.text('hello')      // OpenAI responses API Response
```

JSON responses are automatically converted to SSE/streaming when the client requests it. You don't need to handle streaming yourself.
