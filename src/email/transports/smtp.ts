import nodemailer from 'nodemailer';
import type { EmailMessage, EmailTransport, EmailSettings } from '../types';

export interface SmtpSecurity {
  secure: boolean;
  requireTLS: boolean;
}

/**
 * Encryption mode for an SMTP connection. The port dictates it for the
 * well-known ports, so we don't trust the manual "secure" flag there — the #1
 * cause of connection timeouts is port 465 (implicit TLS) connected with
 * secure:false, or 587 (STARTTLS) connected with secure:true. The flag only
 * applies to non-standard ports.
 *
 *   465        → implicit TLS         (secure)
 *   587        → STARTTLS, required   (plaintext then upgrade)
 *   25         → STARTTLS, optional
 *   otherwise  → whatever the flag says
 */
export function resolveSmtpSecurity(port: number, secureFlag: boolean): SmtpSecurity {
  if (port === 465) return { secure: true, requireTLS: false };
  if (port === 587) return { secure: false, requireTLS: true };
  if (port === 25) return { secure: false, requireTLS: false };
  return { secure: secureFlag, requireTLS: false };
}

/**
 * App passwords (Gmail, Yahoo, Outlook, iCloud, Fastmail…) are shown grouped
 * with spaces for readability — "abcd efgh ijkl mnop" — but the actual
 * credential is the 16 characters with no spaces. Pasted verbatim, the spaces
 * get sent over SMTP AUTH and the login is rejected (535 BadCredentials). Real
 * SMTP passwords don't contain whitespace, so stripping it is safe and fixes
 * the most common "app password still doesn't work" case.
 */
export function normalizeSmtpPassword(pass: string): string {
  return pass.replace(/\s+/g, '');
}

export function createSmtpTransport(settings: EmailSettings): EmailTransport {
  const { secure, requireTLS } = resolveSmtpSecurity(settings.smtpPort, settings.smtpSecure);

  const transporter = nodemailer.createTransport({
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure,
    requireTLS,
    // Fail fast instead of hanging on nodemailer's ~2-minute default — a bad
    // host/port/TLS combo (or a blocked outbound port) would otherwise stall
    // the request, including the inline order-confirmation send at checkout.
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    auth: settings.smtpUser
      ? { user: settings.smtpUser.trim(), pass: normalizeSmtpPassword(settings.smtpPass) }
      : undefined,
  });

  return {
    id: 'smtp',
    async send(message: EmailMessage): Promise<void> {
      await transporter.sendMail({
        to: message.to,
        from: `${message.fromName} <${message.from}>`,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        subject: message.subject,
        html: message.html,
      });
    },
  };
}
