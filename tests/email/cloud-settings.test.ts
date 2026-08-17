import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * On Taberno Cloud the control plane owns email delivery and passes it through
 * the store's environment (it opens tenant DBs read-only, so can't seed settings
 * rows). These tests pin the precedence rules:
 *   - self-hosted (CLOUD_MODE off): env is ignored entirely — byte-identical to
 *     reading the stored settings
 *   - managed (CLOUD_MODE on): a NON-EMPTY env var wins; an empty one falls
 *     through to the stored setting (the control plane blanks keys it isn't using)
 */

const STORED: Record<string, string> = {
  email_provider: 'console',
  email_from_name: 'Stored Shop',
  email_from_address: 'stored@shop.test',
  smtp_host: 'stored.smtp.test',
  smtp_port: '2525',
  smtp_user: 'storeduser',
  smtp_pass: 'storedpass',
  smtp_secure: '1',
  resend_api_key: 'stored_key',
  store_name: 'Store',
  store_email: 'contact@shop.test',
};

vi.mock('../../src/db/queries/admin', () => ({
  getAllSettings: () => STORED,
}));

/** Loads a FRESH transport module (and its config) under the given env overlay. */
async function loadEmailSettings(env: Record<string, string | undefined>) {
  const previous = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  const { getEmailSettings } = await import('../../src/email/transport');
  const settings = getEmailSettings();
  process.env = previous;
  return settings;
}

// Env keys the overlay must be able to clear between cases.
const EMAIL_ENV = [
  'CLOUD_MODE', 'EMAIL_PROVIDER', 'EMAIL_FROM_NAME', 'EMAIL_FROM_ADDRESS',
  'RESEND_API_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS',
  'SMTP_SECURE', 'EMAIL_REPLY_TO',
] as const;
const cleared = () => Object.fromEntries(EMAIL_ENV.map((k) => [k, undefined]));

afterEach(() => vi.resetModules());

describe('getEmailSettings — self-hosted (CLOUD_MODE off)', () => {
  it('returns the stored settings verbatim', async () => {
    const s = await loadEmailSettings(cleared());
    expect(s).toEqual({
      provider: 'console',
      fromName: 'Stored Shop',
      fromAddress: 'stored@shop.test',
      smtpHost: 'stored.smtp.test',
      smtpPort: 2525,
      smtpUser: 'storeduser',
      smtpPass: 'storedpass',
      smtpSecure: true,
      resendApiKey: 'stored_key',
      replyTo: '',
    });
  });

  it('ignores the email env vars entirely — they only apply on managed hosting', async () => {
    const s = await loadEmailSettings({
      ...cleared(),
      CLOUD_MODE: 'false',
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 'env_key',
      EMAIL_FROM_ADDRESS: 'env@shop.test',
      EMAIL_REPLY_TO: 'reply@shop.test',
    });
    expect(s.provider).toBe('console');
    expect(s.resendApiKey).toBe('stored_key');
    expect(s.fromAddress).toBe('stored@shop.test');
    expect(s.replyTo).toBe('');
  });
});

describe('getEmailSettings — managed (CLOUD_MODE on)', () => {
  it('lets a non-empty env var take precedence over the stored setting', async () => {
    const s = await loadEmailSettings({
      ...cleared(),
      CLOUD_MODE: 'true',
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 'env_key',
      EMAIL_FROM_ADDRESS: 'shop@mail.example',
      EMAIL_FROM_NAME: 'Env Shop',
      SMTP_SECURE: 'true',
      EMAIL_REPLY_TO: 'reply@shop.test',
    });
    // A store stored as 'console' still sends via Resend from the env address.
    expect(s.provider).toBe('resend');
    expect(s.resendApiKey).toBe('env_key');
    expect(s.fromAddress).toBe('shop@mail.example');
    expect(s.fromName).toBe('Env Shop');
    expect(s.smtpSecure).toBe(true);
    expect(s.replyTo).toBe('reply@shop.test');
    // Vars left unset still fall back to the stored value.
    expect(s.smtpHost).toBe('stored.smtp.test');
    expect(s.smtpPort).toBe(2525);
    expect(s.smtpUser).toBe('storeduser');
  });

  it('treats an empty env var as "not set" and falls back to the stored setting', async () => {
    const s = await loadEmailSettings({
      ...cleared(),
      CLOUD_MODE: 'true',
      EMAIL_PROVIDER: '',
      RESEND_API_KEY: '',
      EMAIL_FROM_ADDRESS: '',
      SMTP_SECURE: '',
      EMAIL_REPLY_TO: '',
    });
    expect(s.provider).toBe('console');
    expect(s.resendApiKey).toBe('stored_key');
    expect(s.fromAddress).toBe('stored@shop.test');
    expect(s.smtpSecure).toBe(true); // stored '1'
    expect(s.replyTo).toBe('');
  });

  it('reads SMTP_SECURE in its env convention (true/false), not the stored 1/0', async () => {
    const off = await loadEmailSettings({ ...cleared(), CLOUD_MODE: 'true', SMTP_SECURE: 'false' });
    expect(off.smtpSecure).toBe(false); // overrides the stored '1'

    const on = await loadEmailSettings({ ...cleared(), CLOUD_MODE: 'true', SMTP_SECURE: 'true' });
    expect(on.smtpSecure).toBe(true);
  });

  it('sets replyTo only from EMAIL_REPLY_TO — empty means no Reply-To', async () => {
    const withReply = await loadEmailSettings({ ...cleared(), CLOUD_MODE: 'true', EMAIL_REPLY_TO: 'r@shop.test' });
    expect(withReply.replyTo).toBe('r@shop.test');

    const without = await loadEmailSettings({ ...cleared(), CLOUD_MODE: 'true' });
    expect(without.replyTo).toBe('');
  });
});
