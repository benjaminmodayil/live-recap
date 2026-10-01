// Epoch ms a reply block was appended; 0 while unknown.
export type MessageTimestampsSentAt = number

declare module 'claude-code' {
  interface PluginState {
    'message-timestamps': {
      // One per reply block, keyed by the row's uuid.
      sentAt: StateFamily<MessageTimestampsSentAt>
    }
  }
}
