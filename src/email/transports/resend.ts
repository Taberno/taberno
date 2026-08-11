import type { EmailMessage, EmailTransport, EmailSettings } from '../types';

/** Talks to the Resend HTTP API directly — no SDK dependency needed for one endpoint. */
export function createResendTransport(settings: EmailSettings): EmailTransport {
  return {
    id: 'resend',
    async send(message: EmailMessage): Promise<void> {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `${message.fromName} <${message.from}>`,
          to: [message.to],
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
          subject: message.subject,
          html: message.html,
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Resend API error (${res.status}): ${body || res.statusText}`);
      }
    },
  };
}
