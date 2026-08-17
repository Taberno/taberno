import { getAllSettings } from '../db/queries/admin';
import config from '../config';
import type { EmailSettings, EmailTransport } from './types';
import { consoleTransport } from './transports/console';
import { createSmtpTransport } from './transports/smtp';
import { createResendTransport } from './transports/resend';
import { createDirectTransport } from './transports/direct';

/**
 * On Taberno Cloud the control plane owns email delivery and passes the
 * configuration through the store's environment (it opens tenant databases
 * read-only, so it can't write settings rows). Returns the env value only when
 * cloudMode is on AND the variable is set to a non-empty string — the control
 * plane writes every key on each start, blanking them when a store has no
 * provider, and an empty value must fall through to the stored setting rather
 * than override it with "". Self-hosted (cloudMode off) always returns '', so
 * every caller falls back to the stored setting and behaviour is unchanged.
 */
function cloudEnv(name: string): string {
  if (!config.cloudMode) return '';
  return (process.env[name] ?? '').trim();
}

export function getEmailSettings(): EmailSettings {
  const s = getAllSettings();
  // SMTP_SECURE arrives as 'true'/'false' in the environment, but is stored as
  // '1'/'0' in settings — resolve each in its own convention.
  const smtpSecureEnv = cloudEnv('SMTP_SECURE');
  return {
    provider: cloudEnv('EMAIL_PROVIDER') || s.email_provider || 'console',
    fromName: cloudEnv('EMAIL_FROM_NAME') || s.email_from_name || s.store_name || 'Store',
    fromAddress: cloudEnv('EMAIL_FROM_ADDRESS') || s.email_from_address || s.store_email || '',
    smtpHost: cloudEnv('SMTP_HOST') || s.smtp_host || '',
    smtpPort: parseInt(cloudEnv('SMTP_PORT') || s.smtp_port || '587', 10),
    smtpUser: cloudEnv('SMTP_USER') || s.smtp_user || '',
    smtpPass: cloudEnv('SMTP_PASS') || s.smtp_pass || '',
    smtpSecure: smtpSecureEnv ? smtpSecureEnv === 'true' : s.smtp_secure === '1',
    resendApiKey: cloudEnv('RESEND_API_KEY') || s.resend_api_key || '',
    // No stored reply_to today — this is a Cloud-only setting. Empty means no
    // Reply-To header at all, which is the current (self-hosted) behaviour.
    replyTo: cloudEnv('EMAIL_REPLY_TO'),
  };
}

export function getActiveTransport(settings: EmailSettings = getEmailSettings()): EmailTransport {
  switch (settings.provider) {
    case 'smtp':
      return createSmtpTransport(settings);
    case 'resend':
      return createResendTransport(settings);
    case 'direct':
      return createDirectTransport(settings);
    default:
      return consoleTransport;
  }
}
