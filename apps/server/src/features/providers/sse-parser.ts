export interface SseEvent { readonly data: string }
export async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder(); let buffer = ''
  for await (const chunk of body) { buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n'); let at: number
    while ((at = buffer.indexOf('\n\n')) >= 0) { const frame = buffer.slice(0, at); buffer = buffer.slice(at + 2); const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n'); if (data) yield { data } }
  }
  buffer += decoder.decode(); if (buffer.trim().startsWith('data:')) yield { data: buffer.trim().slice(5).trimStart() }
}
