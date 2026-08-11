import { getActiveTransport, getEmailSettings } from './transport';
import { renderEmailTemplate, renderEmailPreview } from './templates';
import { logEmailAttempt } from '../db/queries/email';

/** Renders a stored template by key and sends it, logging the outcome either way. */
export async function sendTemplatedEmail(
  templateKey: string,
  to: string,
  data: Record<string, unknown>,
): Promise<void> {
  const settings = getEmailSettings();
  const transport = getActiveTransport(settings);
  const { subject, html } = renderEmailTemplate(templateKey, data);

  // A live provider with no sender address produces `From: Name <>`, which SMTP
  // servers reject with an opaque error. Fail with an actionable one instead.
  if (transport.id !== 'console' && !settings.fromAddress) {
    const error = 'No sender address configured — set "Email from address" (or Store email) in Settings → Email.';
    logEmailAttempt({ templateKey, to, subject, provider: transport.id, status: 'failed', error });
    throw new Error(error);
  }

  try {
    await transport.send({ to, from: settings.fromAddress, fromName: settings.fromName, subject, html, replyTo: settings.replyTo });
    logEmailAttempt({ templateKey, to, subject, provider: transport.id, status: 'sent' });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logEmailAttempt({ templateKey, to, subject, provider: transport.id, status: 'failed', error });
    throw err;
  }
}

/** Sends an ad-hoc subject/body (not a stored template) — used for the settings "send test" action. */
export async function sendTestEmail(to: string, subject: string, body: string): Promise<void> {
  const settings = getEmailSettings();
  const transport = getActiveTransport(settings);
  const { html } = renderEmailPreview(subject, body, { store: { name: settings.fromName } });

  if (transport.id !== 'console' && !settings.fromAddress) {
    const error = 'No sender address configured — set "Email from address" (or Store email) in Settings → Email.';
    logEmailAttempt({ templateKey: null, to, subject, provider: transport.id, status: 'failed', error });
    throw new Error(error);
  }

  try {
    await transport.send({ to, from: settings.fromAddress, fromName: settings.fromName, subject, html, replyTo: settings.replyTo });
    logEmailAttempt({ templateKey: null, to, subject, provider: transport.id, status: 'sent' });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logEmailAttempt({ templateKey: null, to, subject, provider: transport.id, status: 'failed', error });
    throw err;
  }
}
