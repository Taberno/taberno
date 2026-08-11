import { storeUrl as resolveStoreUrl } from '../store-url';
import { getActiveTransport, getEmailSettings } from './transport';
import { renderEmailPreview } from './templates';
import { logEmailAttempt } from '../db/queries/email';
import { unsubscribeToken } from './unsubscribe';
import { getAllSettings } from '../db/queries/admin';
import {
  findBroadcastById, listSubscribedEmails, markBroadcastSending, completeBroadcast,
} from '../db/queries/newsletter';

/** The unsubscribe URL a broadcast recipient clicks — flips their status to unsubscribed. */
export function broadcastUnsubscribeUrl(storeUrl: string, email: string): string {
  const base = storeUrl.replace(/\/$/, '');
  return `${base}/newsletter/unsubscribe?e=${encodeURIComponent(email)}&t=${unsubscribeToken(email)}`;
}

/**
 * Sends a broadcast to every current subscriber, one message at a time (keeps
 * well under provider rate limits and gives an accurate per-recipient log).
 * Every message carries a working unsubscribe link — appended automatically if
 * the composed body doesn't already include the {{unsubscribe_url}} placeholder,
 * so a broadcast can't go out without one. Records sent/failed counts on the row.
 */
export async function sendBroadcast(broadcastId: string): Promise<{ sent: number; failed: number }> {
  const broadcast = findBroadcastById(broadcastId);
  if (!broadcast) throw new Error(`Broadcast ${broadcastId} not found`);

  const settings = getEmailSettings();
  const transport = getActiveTransport(settings);
  if (transport.id !== 'console' && !settings.fromAddress) {
    completeBroadcast(broadcastId, 0, 0);
    throw new Error('No sender address configured — set "Email from address" (or Store email) in Settings → Email.');
  }

  const storeUrl = resolveStoreUrl();
  const storeName = settings.fromName;
  const recipients = listSubscribedEmails();

  markBroadcastSending(broadcastId);

  // Guarantee an unsubscribe link even when the merchant didn't add one.
  const hasUnsubToken = /\{\{\s*unsubscribe_url\s*\}\}/.test(broadcast.body);
  const bodyTemplate = hasUnsubToken
    ? broadcast.body
    : `${broadcast.body}
<p style="margin-top:32px;color:#888;font-size:12px;">You're receiving this because you subscribed to {{store.name}}. <a href="{{unsubscribe_url}}">Unsubscribe</a>.</p>`;

  let sent = 0;
  let failed = 0;

  for (const email of recipients) {
    const data = {
      store: { name: storeName },
      unsubscribe_url: broadcastUnsubscribeUrl(storeUrl, email),
    };
    const { subject, html } = renderEmailPreview(broadcast.subject, bodyTemplate, data);
    try {
      await transport.send({ to: email, from: settings.fromAddress, fromName: settings.fromName, subject, html, replyTo: settings.replyTo });
      logEmailAttempt({ templateKey: 'newsletter_broadcast', to: email, subject, provider: transport.id, status: 'sent' });
      sent++;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logEmailAttempt({ templateKey: 'newsletter_broadcast', to: email, subject, provider: transport.id, status: 'failed', error });
      failed++;
    }
  }

  completeBroadcast(broadcastId, sent, failed);
  return { sent, failed };
}
