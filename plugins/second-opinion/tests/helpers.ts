import type { HttpInit, HttpResponse } from 'claude-code'

import { resolveSettings } from '../hooks/config'
import type { PanelIo } from '../hooks/panel'

export const settingsWith = (options: Record<string, unknown> = {}, env: Record<string, string> = {}) =>
  resolveSettings(
    {
      openrouterApiKey: 'fake-openrouter-key',
      strongModels: 'openrouter/openai/gpt-a, openrouter/google/gemini-b, openrouter/z-ai/glm-c, openrouter/x-ai/grok-d',
      balancedModels: '',
      fastModels: 'openrouter/z-ai/glm-flash',
      ...options,
    },
    env,
  )

export type Verdict = {
  verdict: string
  score?: number
  summary?: string
  blocking?: Array<{ file?: string; line?: number; claim: string; evidence?: string }>
  not_verified?: string
}

/** A chat completion response carrying a reviewer's JSON reply. */
export const chatResponse = (reply: Verdict | string, extra: { cost?: number; headers?: Record<string, string> } = {}): HttpResponse => ({
  status: 200,
  ok: true,
  headers: extra.headers ?? {},
  text: JSON.stringify({
    choices: [
      {
        message: { role: 'assistant', content: typeof reply === 'string' ? reply : JSON.stringify({ score: 8, summary: 'ok', blocking: [], not_verified: '', ...reply }) },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, ...(extra.cost !== undefined ? { cost: extra.cost } : {}) },
  }),
})

export const errorResponse = (status: number, message: string): HttpResponse => ({
  status,
  ok: false,
  headers: {},
  text: JSON.stringify({ error: { message, code: status } }),
})

type Answer = HttpResponse | 'hang' | Error

/**
 * A PanelIo whose fetch answers per model. A `hang` answer never resolves, so
 * that reviewer meets its deadline, which falls a few microtasks later than any
 * answer that does resolve.
 */
export const fakeIo = (answer: (model: string, body: any) => Answer) => {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = []
  const io: PanelIo = {
    fetch: async (url: string, init: HttpInit) => {
      const body = JSON.parse(String(init.body))
      calls.push({ url, body, headers: init.headers ?? {} })
      const reply = answer(body.model, body)
      if (reply === 'hang') return new Promise<HttpResponse>(() => {})
      if (reply instanceof Error) throw reply
      return reply
    },
    sleep: async () => {
      for (let i = 0; i < 25; i++) await Promise.resolve()
    },
    now: async () => 0,
  }
  return { io, calls }
}

export const ARTIFACT = { title: 'PLAN.md', content: '# Plan\n\n1. Ship it.', path: '/proj/PLAN.md' }
