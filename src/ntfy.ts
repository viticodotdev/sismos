/**
 * ntfy publisher — POST /{topic} with a JSON body; headers set the
 * notification chrome. Auth via Bearer token or anonymous.
 */

export interface NtfyConfig {
  baseUrl: string // https://ntfy.example.com — no trailing slash, no /topic
  topic: string
  token?: string
}

export function ntfyConfigFromEnv(env: Record<string, string | undefined>): NtfyConfig {
  const baseUrl = env.NTFY_BASE_URL?.trim()
  const topic = env.NTFY_TOPIC?.trim()
  if (!baseUrl || !topic) throw new Error("NTFY_BASE_URL and NTFY_TOPIC are required")
  return { baseUrl, topic, token: env.NTFY_ACCESS_TOKEN?.trim() || undefined }
}

export function buildNtfyPayload(event: {
  title: string
  message: string
  tags?: string[]
  priority?: number
  click?: string
}): string {
  return JSON.stringify({
    title: event.title,
    message: event.message,
    tags: event.tags ?? [],
    priority: event.priority ?? 3,
    click: event.click,
  })
}

export interface MarkdownField {
  label: string
  value: string
}

/**
 * Build an ntfy message body in markdown: a bold title fact, then labeled
 * content lines ("Label: value"). With more than `groupOver` fields the lines
 * sit under a "## Details" heading so a long alert stays scannable. No plain
 * newline text blocks.
 */
export function markdownMessage(titleFact: string, fields: MarkdownField[], groupOver = 4): string {
  const lines = [`**${titleFact}**`]
  if (fields.length > groupOver) lines.push("", "## Details")
  lines.push("", ...fields.map((f) => `${f.label}: ${f.value}`))
  return lines.join("\n")
}

export async function publishNtfy(cfg: NtfyConfig, body: string): Promise<void> {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(cfg.topic)}`
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "dr-seismic-alerts/1.0",
    "X-Title": "Seismic alert",
  }
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`

  const res = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`ntfy publish failed: ${res.status} ${res.statusText} ${await res.text().catch(() => "")}`)
}