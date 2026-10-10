// Shared helpers for gateway tests: SSE fixtures, generator collection and a
// programmable mock upstream server. Zero-dependency (node:test).
import { createServer, type Server } from "node:http"
import { once } from "node:events"

/** Build a ReadableStream from raw SSE text, chunked like a real socket feed. */
export function sseStream(text: string, chunkSize = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      const end = Math.min(offset + chunkSize, bytes.length)
      controller.enqueue(bytes.slice(offset, end))
      offset = end
    },
  })
}

/** Collect every frame a converter generator yields. */
export async function collect(generator: AsyncGenerator<string>): Promise<string[]> {
  const frames: string[] = []
  for await (const frame of generator) frames.push(frame)
  return frames
}

export type MockRoute = (
  request: { method: string; url: string; headers: Record<string, string> },
  body: string,
  hit: number,
) => { status: number; headers?: Record<string, string>; body: string; cutAfterBytes?: number } | Promise<{ status: number; headers?: Record<string, string>; body: string; cutAfterBytes?: number }>

export type MockUpstream = {
  readonly server: Server
  readonly port: number
  readonly baseURL: string
  readonly requests: { url: string; headers: Record<string, string>; body: string }[]
  close(): Promise<void>
}

/** Start one mock upstream server; `route` decides every response. */
export async function startMockUpstream(route: MockRoute): Promise<MockUpstream> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8")
      requests.push({
        url: String(request.url),
        headers: { ...request.headers } as Record<string, string>,
        body,
      })
      const handled = await route(
        {
          method: String(request.method),
          url: String(request.url),
          headers: { ...request.headers } as Record<string, string>,
        },
        body,
        requests.length,
      )
      response.writeHead(handled.status, handled.headers ?? { "content-type": "application/json" })
      if (typeof handled.cutAfterBytes === "number") {
        // Relay only a prefix and kill the connection: the mid-body cut an
        // HTTP client reports as `TypeError: terminated`. Headers are flushed
        // first so this is a body-level failure, not a connect-level one.
        response.flushHeaders()
        const bytes = Buffer.from(handled.body, "utf8")
        if (handled.cutAfterBytes > 0) response.write(bytes.subarray(0, handled.cutAfterBytes))
        setTimeout(() => response.socket?.destroy(), 5)
        return
      }
      response.end(handled.body)
    })
  })
  const requests: { url: string; headers: Record<string, string>; body: string }[] = []
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const port = (server.address() as { port: number }).port
  return {
    server,
    port,
    baseURL: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/** Parse a data: payload out of one SSE frame emitted by the converters.
 * The terminal `[DONE]` sentinel is returned as a raw string. */
export function frameData(frame: string): any {
  for (const line of frame.split("\n")) {
    if (line.startsWith("data: ")) {
      const value = line.slice(6)
      try {
        return JSON.parse(value)
      } catch {
        return value
      }
    }
  }
  return undefined
}

/** Join a converter's frames into one SSE text blob (fixture-ish input helper). */
export function joinFrames(frames: string[]): string {
  return frames.join("")
}
