/**
 * ntfy publisher — POST /{topic} with a plain-text (markdown) body. All
 * structured fields (title, tags, priority, click) travel as HTTP headers, not
 * a JSON body. Rationale: some ntfy deployments (or their proxies) fail to
 * parse a JSON payload and instead store the whole JSON string as the message
 * — which renders as raw `\n` / `**` / `##` garbage. Header-based publishing
 * gives ntfy nothing to mis-parse: the body is just the markdown message, and
 * ntfy renders it. Auth via Bearer token or anonymous.
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

export interface NtfyPayloadResult {
  message: string
  opts?: { title?: string; tags?: string[]; priority?: number; click?: string }
}

/** Kept for the module internals: wraps a payload into the split publish form. */
export function buildNtfyPayload(p: {
  title?: string
  message: string
  tags?: string[]
  priority?: number
  click?: string
}): NtfyPayloadResult {
  return { message: p.message, opts: { title: p.title, tags: p.tags, priority: p.priority, click: p.click } }
}

export interface MarkdownField {
  label: string
  value: string
}

/**
 * Build an ntfy message body in markdown: a bold title fact, then labeled
 * content lines ("Label: value"). With more than `groupOver` fields the lines
 * sit under a "## Details" heading so a long alert stays scannable.
 */
export function markdownMessage(titleFact: string, fields: MarkdownField[], groupOver = 4): string {
  const lines = [`**${titleFact}**`]
  if (fields.length > groupOver) lines.push("", "## Details")
  lines.push("", ...fields.map((f) => `${f.label}: ${f.value}`))
  return lines.join("\n")
}

/** Deep-link to the EMSC event detail page for a unid. */
export function eventUrl(unid: string): string {
  return `https://www.seismicportal.eu/eventdetails.html?unid=${encodeURIComponent(unid)}`
}

/** One publish: body = markdown message; title/tags/priority/click via headers. */
export async function publishNtfy(
  cfg: NtfyConfig,
  message: string,
  opts?: { title?: string; tags?: string[]; priority?: number; click?: string },
): Promise<void> {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(cfg.topic)}`
  const headers: Record<string, string> = {
    "Content-Type": "text/markdown",
    "User-Agent": "dr-seismic-alerts/1.0",
  }
  if (opts?.title) headers.Title = opts.title
  if (opts?.tags?.length) headers.Tags = opts.tags.join(",")
  if (opts?.priority !== undefined) headers.Priority = String(opts.priority)
  if (opts?.click) headers.Click = opts.click
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: message,
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`ntfy publish failed: ${res.status} ${res.statusText} ${await res.text().catch(() => "")}`)
}
