export type LiveRecapSource = 'haiku' | 'fork'

export type LiveRecapCard = {
  runStartedAt: number
  background: number
  text?: string
  generatedAt?: number
  source?: LiveRecapSource
  endedAt?: number
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'live-recap': {
      card: LiveRecapCard | null
      now: number
    }
  }
}
