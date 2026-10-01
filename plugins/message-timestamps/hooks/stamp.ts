// The module's environment carries the host's locale and time zone, so the default formatter is the user's own.
const formatTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

// Markdown that only parses at the start of a line: a stamp ahead of it would turn it into a plain paragraph.
const BLOCK_START = /^(#{1,6}\s|```|~~~|[-*+]\s|>|\||\d+[.)]\s|(-{3,}|\*{3,}|_{3,})\s*$| {4}|\t)/

/**
 * Prefixes reply markdown with the local time it arrived, as inline code.
 *
 * @param text the reply block's markdown, as the transcript draws it
 * @param at epoch milliseconds the block arrived
 * @returns the text led by the time: inline when the text opens with a paragraph, on its own line when it opens with block markdown (heading, list, fence, quote, table, rule, indented code)
 * @example
 * stamp('Done.', at) // '`11:04 AM` Done.'
 */
export const stamp = (text: string, at: number) => {
  const label = `\`${formatTime.format(at)}\``
  return BLOCK_START.test(text) ? `${label}\n\n${text}` : `${label} ${text}`
}
