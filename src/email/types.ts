export interface EmailMessage {
  to: string;
  from: string;
  fromName: string;
  subject: string;
  html: string;
  /** Reply-To address. When set, transports add a Reply-To header; omitted otherwise. */
  replyTo?: string;
}

export interface EmailTransport {
  /** Provider id stored in email_log.provider, e.g. 'smtp', 'resend', 'console'. */
  readonly id: string;
  send(message: EmailMessage): Promise<void>;
}

export interface EmailSettings {
  provider: string;
  fromName: string;
  fromAddress: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpSecure: boolean;
  resendApiKey: string;
  /** Reply-To address, populated from EMAIL_REPLY_TO on managed hosting; empty means none. */
  replyTo: string;
}
