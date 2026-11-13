/**
 * pi-telegram-bridge — Types
 */

export interface TelegramConfig {
  /** Telegram Bot API token from @BotFather */
  botToken: string;
  /** Target chat ID to send messages to and listen from */
  chatId: string;
}

/** Session state persisted across restarts */
export interface TelegramSessionState {
  update_id: number;
}
