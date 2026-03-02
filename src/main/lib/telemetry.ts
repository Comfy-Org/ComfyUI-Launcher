import { PostHog } from 'posthog-node'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import * as settings from '../settings'
import { configDir } from './paths'

const POSTHOG_API_KEY = 'phc_PLACEHOLDER'
const POSTHOG_HOST = 'https://us.i.posthog.com'
const ID_FILE = path.join(configDir(), 'telemetry-id.txt')

let client: PostHog | null = null
let distinctId: string | null = null

function getDistinctId(): string {
  if (distinctId) return distinctId
  try {
    if (fs.existsSync(ID_FILE)) {
      const stored = fs.readFileSync(ID_FILE, 'utf8').trim()
      if (stored) {
        distinctId = stored
        return distinctId
      }
    }
  } catch {}
  distinctId = randomUUID()
  try {
    fs.mkdirSync(path.dirname(ID_FILE), { recursive: true })
    fs.writeFileSync(ID_FILE, distinctId)
  } catch {}
  return distinctId
}

export function initTelemetry(): void {
  if (settings.get('sendAnalytics') !== true) return
  if (client) return

  client = new PostHog(POSTHOG_API_KEY, {
    host: POSTHOG_HOST,
    flushInterval: 30_000,
    flushAt: 20,
  })
  client.on('error', () => {})

  client.register({
    app_version: app.getVersion(),
    platform: process.platform,
    arch: os.arch(),
    os_version: os.release(),
    packaged: app.isPackaged,
  })
}

export async function shutdownTelemetry(): Promise<void> {
  if (!client) return
  try { await client.shutdown() } catch {}
  client = null
}

export function track(event: string, properties?: Record<string, unknown>): void {
  if (!client) return
  client.capture({
    distinctId: getDistinctId(),
    event,
    properties,
  })
}

export function captureError(error: unknown, context?: Record<string, unknown>): void {
  if (!client) return
  client.captureException(error, getDistinctId(), context)
}
