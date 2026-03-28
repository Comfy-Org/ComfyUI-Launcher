import { spawn } from 'child_process'

export interface LoggedProcessResult {
  exitCode: number
  stdout: string
  stderr: string
  signal: string | null
}

/**
 * Spawn a process with stdout/stderr streaming to a callback, capturing
 * full output for error reporting.
 */
export function runLoggedProcess(
  cmd: string,
  args: string[],
  options: {
    cwd: string
    env?: NodeJS.ProcessEnv
    sendOutput: (text: string) => void
  }
): Promise<LoggedProcessResult> {
  return new Promise<LoggedProcessResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    const proc = spawn(cmd, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: options.env,
    })
    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      stdout += text
      options.sendOutput(text)
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      stderr += text
      options.sendOutput(text)
    })
    proc.on('error', (err: Error) => {
      options.sendOutput(`Error: ${err.message}\n`)
      resolve({ exitCode: 1, stdout: '', stderr: err.message, signal: null })
    })
    proc.on('close', (code: number | null, sig: string | null) => {
      resolve({ exitCode: code ?? 1, stdout, stderr, signal: sig })
    })
  })
}

/**
 * Format a process failure into a user-facing error message.
 * Uses the last 20 lines of stderr/stdout as detail.
 */
export function formatProcessError(
  prefix: string,
  result: LoggedProcessResult,
  context?: { cmd?: string; script?: string }
): string {
  const detail = (result.stderr || result.stdout).trim().split('\n').slice(-20).join('\n')
  if (detail) {
    return `${prefix}\n\n${detail}`
  }
  if (result.signal) {
    const extra = context ? `\n${context.cmd ? `python: ${context.cmd}` : ''}${context.script ? `\nscript: ${context.script}` : ''}` : ''
    return `${prefix}\n\nProcess was killed by signal ${result.signal}.${extra}`
  }
  const extra = context ? `\n${context.cmd ? `python: ${context.cmd}` : ''}${context.script ? `\nscript: ${context.script}` : ''}` : ''
  return `${prefix}\n\nProcess produced no output.${extra}`
}
