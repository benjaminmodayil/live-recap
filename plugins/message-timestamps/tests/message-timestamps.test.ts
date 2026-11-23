import { expect, test } from 'claude-code/testing'

import { stamp } from '../hooks/stamp'

// 2026-10-01 15:04:05 UTC; the expected label is formatted in the runner's own zone, as the plugin's is.
const SENT_AT = Date.UTC(2026, 9, 1, 15, 4, 5)
const LABEL = `\`${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(SENT_AT)}\``

test('a reply opening with a paragraph gets its local arrival time inline before its text', () => {
  const text = 'I will add the band hook.'
  const expected = `${LABEL} ${text}`
  expect(stamp(text, SENT_AT)).toBe(expected)
  expect(stamp(text, SENT_AT + 60 * 60_000)).not.toBe(expected)
})

test('a reply opening with block markdown gets the time on its own line, so the markdown still parses', () => {
  const openings = [
    '# Summary',
    '- one\n- two',
    '* one',
    '1. first',
    '2) second',
    '```ts\nconst a = 1\n```',
    '~~~\ncode\n~~~',
    '> quoted',
    '| a | b |',
    '---',
    '    indented code',
  ]
  for (const text of openings) {
    expect(stamp(text, SENT_AT)).toBe(`${LABEL}\n\n${text}`)
  }
})

test('text that merely resembles block markdown stays inline', () => {
  for (const text of ['#hashtag is not a heading', '-1 is negative', '2026 was a year', 'Done.']) {
    expect(stamp(text, SENT_AT)).toBe(`${LABEL} ${text}`)
  }
})

test('a reply block never appended this session (a resumed one) draws unchanged', async ($, on) => {
  const drawn: string[] = []
  on('ui.render', { component: 'AssistantMessage' }, (_$, e) => {
    drawn.push(e.props.text)
    return { type: 'engine', ref: 0 }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'message-timestamps',
      surface,
      component: 'AssistantMessage',
      requestId: `from-resume-${surface}`,
      props: { text: 'Earlier reply.', isFirstOfReply: true },
    })
    await ui.unmount()
  }

  expect(drawn).toEqual(['Earlier reply.', 'Earlier reply.'])
})
