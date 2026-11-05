// DSH's `runnerCommand` for the agent shell. DSH appends its bwrap profile
// arguments (--ro-bind / / ... -- command); add the rlimits and the masks that
// keep the harness home and its credentials out of the shell, then exec bwrap.
import { spawn } from 'node:child_process'
import { agentRunnerArgs, agentLimits, agentEnv } from '../src/cell.ts'

const args = agentRunnerArgs(process.argv.slice(2))
const child = spawn('prlimit', [...agentLimits, '--', 'bwrap', ...args], { stdio: 'inherit', env: { ...process.env, ...agentEnv } })
child.on('error', (e) => { console.error(`bwrap-agent: ${e.message}`); process.exit(127) })
child.on('exit', (code, signal) => process.exit(signal ? 128 : (code ?? 1)))
