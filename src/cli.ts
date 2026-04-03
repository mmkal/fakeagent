import {os} from '@orpc/server'
import {createCli} from 'trpc-cli'
import {z} from 'zod'
import {getFakeAgentApi} from './api'
import {agents, type AgentName} from './agents'
import {spawn} from 'node:child_process'

const agentNames = Object.keys(agents) as [AgentName, ...AgentName[]]

const router = os.router({
  run: os
    .input(
      z.object({
        agent: z.enum(agentNames).describe('Agent CLI to run'),
        port: z.number().default(7080).describe('Port for the fake API server'),
        passthrough: z.string().array().optional().describe('Extra args to pass to the agent CLI'),
      }),
    )
    .handler(async ({input}) => {
      const api = await getFakeAgentApi({port: input.port})
      const {command, args, env} = api.getSpawnArgs(input.agent)

      const allArgs = [...args, ...(input.passthrough ?? [])]
      const child = spawn(command, allArgs, {
        stdio: 'inherit',
        env: {...process.env, ...env},
      })

      await new Promise<void>((resolve, reject) => {
        child.on('exit', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`${command} exited with code ${code}`))
        })
        child.on('error', reject)
      })

      await api[Symbol.asyncDispose]()
      return `${command} exited`
    }),
})

const cli = createCli({router, name: 'fakeagent', description: 'Testing tool for coding agent CLIs'})
cli.run()
