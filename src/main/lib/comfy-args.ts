/**
 * Parses ComfyUI's `python main.py --help` output into a structured schema
 * for the args-builder UI. Supports caching per installation version.
 */

import { execFile } from 'child_process'
import * as path from 'path'


// --- Types ---

export interface ComfyArgDef {
  /** CLI flag without leading dashes, e.g. "port" */
  name: string
  /** The full flag string, e.g. "--port" */
  flag: string
  /** Help text from argparse */
  help: string
  /** Argument type for the UI */
  type: 'boolean' | 'value' | 'optional-value'
  /** Metavar from argparse (e.g. "PORT", "IP") */
  metavar?: string
  /** Available choices for select-type args */
  choices?: string[]
  /** Mutually exclusive group id (args sharing a group cannot coexist) */
  exclusiveGroup?: string
  /** UI category for grouping in the helper panel */
  category: string
}

export interface ComfyArgsSchema {
  args: ComfyArgDef[]
  /** Set of all known flag names (without dashes) for validation */
  knownFlags: Set<string>
}

// --- Category mapping ---

const CATEGORY_MAP: Record<string, string> = {
  'listen': 'Network',
  'port': 'Network',
  'tls-keyfile': 'Network',
  'tls-certfile': 'Network',
  'enable-cors-header': 'Network',
  'max-upload-size': 'Network',
  'multi-user': 'Network',
  'enable-compress-response-body': 'Network',

  'base-directory': 'Paths',
  'extra-model-paths-config': 'Paths',
  'output-directory': 'Paths',
  'temp-directory': 'Paths',
  'input-directory': 'Paths',
  'user-directory': 'Paths',
  'front-end-root': 'Paths',

  'auto-launch': 'Launch',
  'disable-auto-launch': 'Launch',
  'windows-standalone-build': 'Launch',

  'cuda-device': 'GPU & VRAM',
  'default-device': 'GPU & VRAM',
  'cuda-malloc': 'GPU & VRAM',
  'disable-cuda-malloc': 'GPU & VRAM',
  'directml': 'GPU & VRAM',
  'oneapi-device-selector': 'GPU & VRAM',
  'disable-ipex-optimize': 'GPU & VRAM',
  'supports-fp8-compute': 'GPU & VRAM',
  'gpu-only': 'GPU & VRAM',
  'highvram': 'GPU & VRAM',
  'normalvram': 'GPU & VRAM',
  'lowvram': 'GPU & VRAM',
  'novram': 'GPU & VRAM',
  'cpu': 'GPU & VRAM',
  'reserve-vram': 'GPU & VRAM',
  'async-offload': 'GPU & VRAM',
  'disable-async-offload': 'GPU & VRAM',
  'disable-dynamic-vram': 'GPU & VRAM',
  'enable-dynamic-vram': 'GPU & VRAM',
  'force-non-blocking': 'GPU & VRAM',
  'disable-smart-memory': 'GPU & VRAM',
  'disable-pinned-memory': 'GPU & VRAM',

  'force-fp32': 'Precision',
  'force-fp16': 'Precision',
  'fp32-unet': 'Precision',
  'fp64-unet': 'Precision',
  'bf16-unet': 'Precision',
  'fp16-unet': 'Precision',
  'fp8_e4m3fn-unet': 'Precision',
  'fp8_e5m2-unet': 'Precision',
  'fp8_e8m0fnu-unet': 'Precision',
  'fp16-vae': 'Precision',
  'fp32-vae': 'Precision',
  'bf16-vae': 'Precision',
  'cpu-vae': 'Precision',
  'fp8_e4m3fn-text-enc': 'Precision',
  'fp8_e5m2-text-enc': 'Precision',
  'fp16-text-enc': 'Precision',
  'fp32-text-enc': 'Precision',
  'bf16-text-enc': 'Precision',
  'fp16-intermediates': 'Precision',
  'force-channels-last': 'Precision',

  'use-split-cross-attention': 'Performance',
  'use-quad-cross-attention': 'Performance',
  'use-pytorch-cross-attention': 'Performance',
  'use-sage-attention': 'Performance',
  'use-flash-attention': 'Performance',
  'disable-xformers': 'Performance',
  'force-upcast-attention': 'Performance',
  'dont-upcast-attention': 'Performance',
  'deterministic': 'Performance',
  'fast': 'Performance',
  'mmap-torch-files': 'Performance',
  'disable-mmap': 'Performance',

  'cache-classic': 'Cache',
  'cache-lru': 'Cache',
  'cache-none': 'Cache',
  'cache-ram': 'Cache',

  'preview-method': 'Preview',
  'preview-size': 'Preview',

  'enable-manager': 'Manager',
  'disable-manager-ui': 'Manager',
  'enable-manager-legacy-ui': 'Manager',

  'front-end-version': 'Frontend',

  'disable-metadata': 'Features',
  'disable-all-custom-nodes': 'Features',
  'whitelist-custom-nodes': 'Features',
  'disable-api-nodes': 'Features',
  'enable-assets': 'Features',

  'verbose': 'Logging',
  'log-stdout': 'Logging',
  'dont-print-server': 'Logging',

  'default-hashing-function': 'Advanced',
  'quick-test-for-ci': 'Advanced',
  'comfy-api-base': 'Advanced',
  'database-url': 'Advanced',
}

const CATEGORY_ORDER = [
  'Network', 'Launch', 'GPU & VRAM', 'Precision', 'Performance',
  'Cache', 'Preview', 'Manager', 'Frontend', 'Features',
  'Paths', 'Logging', 'Advanced', 'Other',
]

function getCategory(flagName: string): string {
  return CATEGORY_MAP[flagName] || 'Other'
}

// --- Help output parser ---

/**
 * Parse the usage line to extract mutually exclusive groups.
 * argparse formats them as: [--flag1 | --flag2 | --flag3]
 */
function parseExclusiveGroups(usageLine: string): Map<string, string> {
  const flagToGroup = new Map<string, string>()
  // Match bracketed or parenthesized groups with pipes: [--a | --b] or (--a | --b)
  const groupRegex = /[[(]([^\])]*\|[^\])]*)[)\]]/g
  let match: RegExpExecArray | null
  let groupId = 0
  while ((match = groupRegex.exec(usageLine)) !== null) {
    const content = match[1]!
    // Extract flag names from the group
    const flags = content.match(/--[\w_-]+/g)
    if (flags && flags.length > 1) {
      const gid = `group_${groupId++}`
      for (const flag of flags) {
        flagToGroup.set(flag.slice(2), gid)
      }
    }
  }
  return flagToGroup
}

/**
 * Parse a single argument entry from the options section.
 * Returns the flag name, type, metavar, choices, and help text.
 */
interface ParsedOption {
  name: string
  flag: string
  type: 'boolean' | 'value' | 'optional-value'
  metavar?: string
  choices?: string[]
  help: string
}

function parseOptionsSection(optionsText: string): ParsedOption[] {
  const results: ParsedOption[] = []

  // argparse formats options as:
  //   --flag-name METAVAR    Help text starts here
  //                          continuation of help
  //   --another-flag         Help text on same line
  //
  // Flag definitions start at column 2. Help text is aligned ~column 24+.
  // We split on the large whitespace gap between flag and help.
  const lines = optionsText.split('\n')
  let current: { flagLine: string; helpLines: string[] } | null = null

  for (const line of lines) {
    // New option starts with 2-space indent + --
    const optMatch = line.match(/^ {2}(--\S+(?:\s+(?:\[?\S+\]?(?:\s+\.\.\.)?))*)\s{2,}(.*)$/)
    if (optMatch) {
      if (current) results.push(parseOptionBlock(current.flagLine, current.helpLines.join(' ')))
      current = { flagLine: optMatch[1]!, helpLines: [] }
      if (optMatch[2]!.trim()) current.helpLines.push(optMatch[2]!.trim())
    } else {
      // Check for flag-only lines (no help on this line, e.g. long flag names)
      const flagOnly = line.match(/^ {2}(--\S+(?:\s+\S+)*)\s*$/)
      if (flagOnly) {
        if (current) results.push(parseOptionBlock(current.flagLine, current.helpLines.join(' ')))
        current = { flagLine: flagOnly[1]!, helpLines: [] }
      } else if (current) {
        // Continuation line (help text) — usually indented more
        const trimmed = line.trim()
        if (trimmed) current.helpLines.push(trimmed)
      }
    }
  }
  if (current) results.push(parseOptionBlock(current.flagLine, current.helpLines.join(' ')))

  return results
}

function parseOptionBlock(flagLine: string, helpText: string): ParsedOption {
  // Examples of flagLine patterns:
  //   --listen [IP]
  //   --port PORT
  //   --force-fp32
  //   --preview-method [none,auto,latent2rgb,taesd]
  //   --verbose [{DEBUG,INFO,WARNING,ERROR,CRITICAL}]
  //   --cache-lru CACHE_LRU
  //   --async-offload [NUM_STREAMS]
  //   --default-hashing-function {md5,sha1,sha256,sha512}
  //   --fast [FAST ...]
  //   --whitelist-custom-nodes WHITELIST_CUSTOM_NODES [WHITELIST_CUSTOM_NODES ...]

  // Extract the primary flag (first --xxx token)
  const flagMatch = flagLine.match(/--([\w_][\w_-]*)/)
  if (!flagMatch) {
    return { name: 'unknown', flag: '--unknown', type: 'boolean', help: helpText }
  }

  const name = flagMatch[1]!
  const flag = `--${name}`
  const afterFlag = flagLine.slice(flagLine.indexOf(flag) + flag.length).trim()

  // Check for choices: {a,b,c} or [a,b,c] or [{a,b,c}] or [a,b,c,d]
  const choicesMatch = afterFlag.match(/\[?\{([^}]+)\}\]?/) || afterFlag.match(/\[([\w,]+)\]/)
  if (choicesMatch) {
    const choices = choicesMatch[1]!.split(',').map((s) => s.trim())
    // If choices are in brackets [], it's optional (can be used without a value)
    const isOptional = afterFlag.startsWith('[')
    return {
      name, flag, help: helpText, choices,
      type: isOptional ? 'optional-value' : 'value',
      metavar: undefined,
    }
  }

  // Check for metavar: UPPER_CASE or [UPPER_CASE] or [UPPER_CASE ...]
  const metaMatch = afterFlag.match(/\[?([A-Z][A-Z0-9_]*(?:\s+\.\.\.)?)(?:\s+\[.*\])?\]?/)
  if (metaMatch) {
    const isOptional = afterFlag.startsWith('[')
    return {
      name, flag, help: helpText,
      type: isOptional ? 'optional-value' : 'value',
      metavar: metaMatch[1]!.replace(/\s+\.\.\./, ''),
    }
  }

  // No metavar, no choices = boolean flag
  if (!afterFlag || afterFlag.startsWith('  ')) {
    return { name, flag, type: 'boolean', help: helpText }
  }

  // Fallback: treat as value
  return { name, flag, type: 'value', help: helpText }
}

/**
 * Parse the full --help output into a structured schema.
 */
export function parseHelpOutput(helpText: string): ComfyArgsSchema {
  // Normalize Windows line endings
  helpText = helpText.replace(/\r\n/g, '\n')
  // Split into usage section and options section
  const usageMatch = helpText.match(/^usage:.*?(?=\n\noptions:|$)/s)
  const usageLine = usageMatch ? usageMatch[0].replace(/\n\s+/g, ' ') : ''
  const exclusiveGroups = parseExclusiveGroups(usageLine)

  const optionsMatch = helpText.match(/\noptions:\n([\s\S]*)$/)
  const optionsText = optionsMatch ? optionsMatch[1]! : ''

  const parsedOptions = parseOptionsSection(optionsText)
  const knownFlags = new Set<string>()

  const args: ComfyArgDef[] = []
  for (const opt of parsedOptions) {
    if (opt.name === 'h' || opt.name === 'help') continue
    knownFlags.add(opt.name)
    args.push({
      name: opt.name,
      flag: opt.flag,
      help: opt.help,
      type: opt.type,
      metavar: opt.metavar,
      choices: opt.choices,
      exclusiveGroup: exclusiveGroups.get(opt.name),
      category: getCategory(opt.name),
    })
  }

  // Sort by category order, then by original order within category
  args.sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a.category)
    const bi = CATEGORY_ORDER.indexOf(b.category)
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
  })

  return { args, knownFlags }
}

// --- Runtime: call --help on a ComfyUI installation ---

const schemaCache = new Map<string, { schema: ComfyArgsSchema; version: string }>()

/**
 * Run `python main.py --help` and parse the output.
 * Results are cached per installationId+version.
 */
export async function getComfyArgsSchema(
  pythonPath: string,
  mainPyPath: string,
  cwd: string,
  installationId: string,
  version?: string
): Promise<ComfyArgsSchema> {
  // Check cache
  const cached = schemaCache.get(installationId)
  if (cached && version && cached.version === version) {
    return cached.schema
  }

  const helpText = await runHelp(pythonPath, mainPyPath, cwd)
  const schema = parseHelpOutput(helpText)

  // Cache it
  if (version) {
    schemaCache.set(installationId, { schema, version })
  }

  return schema
}

function runHelp(pythonPath: string, mainPyPath: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const mainPyRel = path.relative(cwd, mainPyPath)
    execFile(pythonPath, ['-s', mainPyRel, '--help'], { cwd, timeout: 15000 }, (err, stdout, stderr) => {
      // argparse prints help to stdout and exits with code 0
      if (stdout && stdout.includes('usage:')) {
        resolve(stdout)
      } else if (stderr && stderr.includes('usage:')) {
        // Some configurations may print help to stderr
        resolve(stderr)
      } else if (err) {
        const detail = stderr ? `\nstderr: ${stderr.slice(0, 500)}` : ''
        reject(new Error(`Failed to get ComfyUI --help: ${err.message}${detail}`))
      } else {
        reject(new Error('No help output from ComfyUI'))
      }
    })
  })
}

/**
 * Validate user args against a known schema.
 * Returns list of flag names that are not recognized by ComfyUI.
 */
export function validateArgs(userArgs: string[], schema: ComfyArgsSchema): string[] {
  const unsupported: string[] = []
  for (const arg of userArgs) {
    if (arg.startsWith('--')) {
      const name = arg.slice(2).replace(/=.*$/, '')
      if (!schema.knownFlags.has(name)) {
        unsupported.push(name)
      }
    }
  }
  return unsupported
}

/**
 * Filter out unsupported args from a parsed args array.
 * Returns only args that are known to ComfyUI.
 */
export function filterUnsupportedArgs(userArgs: string[], schema: ComfyArgsSchema): string[] {
  const result: string[] = []
  let i = 0
  while (i < userArgs.length) {
    const arg = userArgs[i]!
    if (arg.startsWith('--')) {
      const name = arg.slice(2).replace(/=.*$/, '')
      const hasInlineValue = arg.includes('=')
      const hasTrailingValue = !hasInlineValue && i + 1 < userArgs.length && !userArgs[i + 1]!.startsWith('--')
      if (schema.knownFlags.has(name)) {
        result.push(arg)
        if (hasTrailingValue) result.push(userArgs[i + 1]!)
      }
      // Advance past trailing value if present (whether known or skipped)
      if (hasTrailingValue) {
        i += 2
        continue
      }
    } else {
      result.push(arg)
    }
    i++
  }
  return result
}

/** Clear the schema cache for an installation (e.g. after version update). */
export function clearSchemaCache(installationId: string): void {
  schemaCache.delete(installationId)
}
