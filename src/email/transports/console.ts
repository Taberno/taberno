import type { EmailMessage, EmailTransport } from '../types';

/** Default transport when no provider is configured yet — logs instead of failing. */
export const consoleTransport: EmailTransport = {
  id: 'console',
  async send(message: EmailMessage): Promise<void> {
    const replyTo = message.replyTo ? `Reply-To: ${message.replyTo}\n` : '';
    console.log(
      `\n── Email (no provider configured) ──────────────────────────\n` +
        `To: ${message.to}\nFrom: ${message.fromName} <${message.from}>\n${replyTo}Subject: ${message.subject}\n\n${message.html}\n` +
        `─────────────────────────────────────────────────────────────\n`,
    );
  },
};
