import dns from 'dns';
import os from 'os';
import nodemailer from 'nodemailer';
import type { EmailMessage, EmailTransport, EmailSettings } from '../types';

/**
 * "Direct" delivery — no relay, no account. Looks up the recipient domain's
 * mail server (MX) and hands the message straight to it on port 25, the way
 * PHP's mail() + a local MTA does.
 *
 * Zero configuration, but best-effort: many hosts block outbound port 25, and
 * without SPF/DKIM for the sending domain the big providers will spam-folder or
 * reject it. Fine for low volume where a "check your spam folder" nudge is
 * acceptable; use SMTP/Resend when deliverability matters.
 */

export interface MxRecord { exchange: string; priority: number }
export type MxResolver = (domain: string) => Promise<MxRecord[]>;

/** Domain part of a bare address or a "Name <a@b.com>" form. */
export function recipientDomain(address: string): string {
  const angle = address.match(/<([^>]+)>/);
  const email = (angle ? angle[1] : address).trim();
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1).toLowerCase();
}

/**
 * Ordered mail hosts to try: MX records by ascending priority, falling back to
 * the domain itself as an implicit MX (RFC 5321 §5.1) when none are published.
 */
export async function resolveMailHosts(domain: string, resolveMx: MxResolver): Promise<string[]> {
  try {
    const hosts = (await resolveMx(domain))
      .filter(r => r.exchange)
      .sort((a, b) => a.priority - b.priority)
      .map(r => r.exchange);
    if (hosts.length) return hosts;
  } catch {
    // No MX records (ENODATA/ENOTFOUND) — fall through to the implicit MX.
  }
  return domain ? [domain] : [];
}

const defaultResolveMx: MxResolver = (domain) => dns.promises.resolveMx(domain);

export interface DirectDeps {
  resolveMx?: MxResolver;
  port?: number;
  heloName?: string;
}

export function createDirectTransport(settings: EmailSettings, deps: DirectDeps = {}): EmailTransport {
  const resolveMx = deps.resolveMx ?? defaultResolveMx;
  const port = deps.port ?? 25;
  // EHLO/HELO name — best effort at a real FQDN (the sending domain) rather
  // than "localhost", which many servers reject outright.
  const heloName = deps.heloName || recipientDomain(settings.fromAddress) || os.hostname();

  return {
    id: 'direct',
    async send(message: EmailMessage): Promise<void> {
      const domain = recipientDomain(message.to);
      if (!domain) throw new Error(`Invalid recipient address: ${message.to}`);

      const hosts = await resolveMailHosts(domain, resolveMx);
      if (!hosts.length) throw new Error(`No mail server found for ${domain}`);

      const mail = {
        to: message.to,
        from: `${message.fromName} <${message.from}>`,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        subject: message.subject,
        html: message.html,
      };

      let lastErr: unknown;
      for (const host of hosts) {
        const transporter = nodemailer.createTransport({
          host,
          port,
          secure: false,                       // port 25 starts plaintext, STARTTLS upgrades opportunistically
          name: heloName,
          connectionTimeout: 10_000,           // fail fast when port 25 is blocked rather than hang the request
          greetingTimeout: 10_000,
          socketTimeout: 20_000,
          tls: { rejectUnauthorized: false },  // opportunistic TLS — don't hard-fail on an MX cert mismatch
        });
        try {
          await transporter.sendMail(mail);
          return;
        } catch (err) {
          lastErr = err;                       // try the next MX in priority order
        } finally {
          transporter.close();
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(`Delivery to ${domain} failed`);
    },
  };
}
