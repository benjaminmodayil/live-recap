import { atom, memberOf, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { stamp } from './stamp'

const sentAt = atom({ plugin: 'message-timestamps', key: 'sentAt' } as const, 0)

export const register: Register = on => {
  // The append is the one moment a reply block is new, so its time is fixed there and never recomputed on redraw.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    const at = await $.clock.now()
    const stored = await next(e)
    const hasText = e.message.content.some(block => block.type === 'text')

    if (stored.uuid !== undefined && e.message.type === 'assistant' && hasText) {
      await update($, memberOf(sentAt, { requestId: stored.uuid }), () => at)
    }

    return stored
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const at = await read($, memberOf(sentAt, e))

    // Rows loaded by a resume were never appended in this session, so they draw unstamped.
    if (at === 0) {
      return next(e)
    }

    return next({ ...e, props: { ...e.props, text: stamp(e.props.text, at) } })
  })
}
