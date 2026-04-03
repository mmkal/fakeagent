# fakeagent

Fake API server for testing tools that use coding agent CLIs (Claude Code, OpenAI Codex, opencode). Intercepts LLM requests, gives you deterministic instant responses.

## Why

You built a tool that spawns `claude` or `codex` as a subprocess. You want to test it without hitting real APIs, spending money, waiting seconds, or getting nondeterministic output.

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
node fake-claude.ts claude      # opens claude TUI pointed at your fake server
node fake-claude.ts opencode    # same for opencode
node fake-claude.ts codex       # same for codex
```

## Supported agents

| Agent | Protocol | Redirect mechanism |
|-------|----------|--------------------|
| `claude` | Anthropic Messages API | `ANTHROPIC_BASE_URL` + `--bare` |
| `opencode` | OpenAI Chat Completions | Custom provider via `OPENCODE_CONFIG_CONTENT` |
| `codex` | OpenAI Responses API (WebSocket) | `config.toml` with `openai_base_url` |

## API

### `createFakeAgent(options)`

Starts an HTTP (+ WebSocket) server on a random port.

```ts
const api = await createFakeAgent({
  port: 8080, // optional, default: random
  fetch(request) { // standard Request -> Response
    return new Response('hello')
  },
})
```

Returns `FakeAgent` (implements `AsyncDisposable`):
- `api.port` - server port
- `api.spawn(agent, args?, options?)` - spawn agent CLI as child process
- `api.createCli()` - returns `{run()}`, reads agent name from `process.argv`
- `api.getSpawnArgs(agent)` - raw `{command, args, env, spawnOptions}` for manual spawning

### `parseRequest(request)`

Detects protocol from URL path, parses body.

```ts
const parsed = await parseRequest(request)

parsed.lastMessage              // last user message, plain string
parsed.respond.text('hello')    // Response in the right format for the detected protocol

parsed.openai?.lastMessage      // non-null for /v1/chat/completions
parsed.anthropic?.lastMessage   // non-null for /v1/messages
parsed.codex?.lastMessage       // non-null for /v1/responses

parsed.body                     // raw parsed JSON
```

### `responses`

For explicit protocol control:

```ts
import {responses} from 'fakeagent'

responses.openai.text('hello')     // OpenAI chat completion Response
responses.anthropic.text('hello')  // Anthropic message Response
responses.codex.text('hello')      // OpenAI responses API Response
```

JSON responses are auto-converted to SSE/streaming when the client requests it.
