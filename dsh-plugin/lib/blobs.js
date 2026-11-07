// KV cache: none (this holds sub-call prefixes by content; the bytes sent are the stored text, unchanged)
// Shared sub-call prefixes (a segment for over=, a batch's shared= text), stored once per process by the SHA-256 of
// their text. The REPL sends each distinct prefix once; the `llm` tool's arguments carry its id, so dsh's session log
// records a short reference instead of up to 60,000 characters per sub-call. Ids are checked against the text, so one
// session's code can't plant different text under an id another session uses. Least recently used goes first past
// the size cap; a miss tells the REPL to send the prefix again.
import { createHash } from 'node:crypto'

export const MAX_CHARS = 256 * 1024 * 1024
const store = new Map() // id -> text, oldest first
let held = 0

export function blobId(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Store `text` under `id`; false (and nothing stored) when the id is not the text's SHA-256. */
export function putBlob(id, text) {
  if (typeof id !== 'string' || typeof text !== 'string' || blobId(text) !== id) return false
  if (store.has(id)) {
    store.delete(id)
    store.set(id, text)
    return true
  }
  store.set(id, text)
  held += text.length
  for (const [old, oldText] of store) {
    if (held <= MAX_CHARS || old === id) break
    store.delete(old)
    held -= oldText.length
  }
  return true
}

/** The text stored under `id`, refreshed as recently used; undefined when unknown. */
export function getBlob(id) {
  const text = store.get(id)
  if (text !== undefined) {
    store.delete(id)
    store.set(id, text)
  }
  return text
}

export const MISSING_PREFIX = 'unknown prefix_id'
