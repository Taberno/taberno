import { describe, it, expect } from 'vitest';
import net from 'net';
import {
  recipientDomain,
  resolveMailHosts,
  createDirectTransport,
  type MxResolver,
} from '../../src/email/transports/direct';
import type { EmailSettings } from '../../src/email/types';

describe('recipientDomain', () => {
  it('extracts the domain from a bare address', () => {
    expect(recipientDomain('jane@example.com')).toBe('example.com');
  });
  it('extracts from a "Name <addr>" form and lowercases', () => {
    expect(recipientDomain('Jane Doe <Jane@Example.COM>')).toBe('example.com');
  });
  it('returns empty for a malformed address', () => {
    expect(recipientDomain('not-an-email')).toBe('');
  });
});

describe('resolveMailHosts', () => {
  it('orders MX records by ascending priority', async () => {
    const resolver: MxResolver = async () => [
      { exchange: 'mx2.example.com', priority: 20 },
      { exchange: 'mx1.example.com', priority: 10 },
    ];
    expect(await resolveMailHosts('example.com', resolver)).toEqual(['mx1.example.com', 'mx2.example.com']);
  });

  it('falls back to the domain itself (implicit MX) when there are no MX records', async () => {
    const resolver: MxResolver = async () => [];
    expect(await resolveMailHosts('example.com', resolver)).toEqual(['example.com']);
  });

  it('falls back to the domain when the lookup throws (ENOTFOUND)', async () => {
    const resolver: MxResolver = async () => { throw new Error('ENOTFOUND'); };
    expect(await resolveMailHosts('example.com', resolver)).toEqual(['example.com']);
  });
});

// Minimal SMTP sink: accepts one message and records the conversation, so we
// can prove the direct transport actually speaks SMTP to the "MX" it resolves.
function smtpSink(): Promise<{ port: number; received: Promise<{ rcpt: string; data: string }>; close: () => void }> {
  return new Promise((resolveServer) => {
    let resolveMsg!: (v: { rcpt: string; data: string }) => void;
    const received = new Promise<{ rcpt: string; data: string }>((r) => { resolveMsg = r; });

    const server = net.createServer((sock) => {
      let inData = false;
      let data = '';
      let rcpt = '';
      sock.write('220 sink ready\r\n');
      sock.on('data', (buf) => {
        const text = buf.toString();
        if (inData) {
          data += text;
          const end = data.indexOf('\r\n.\r\n');
          if (end !== -1) {
            data = data.slice(0, end);
            inData = false;
            sock.write('250 OK queued\r\n');
            // Resolve here, not on QUIT — nodemailer's close() tears down the
            // connection without a graceful QUIT.
            resolveMsg({ rcpt, data });
          }
          return;
        }
        for (const line of text.split('\r\n').filter(Boolean)) {
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 sink\r\n');       // no STARTTLS → stay plaintext
          else if (cmd === 'MAIL') sock.write('250 OK\r\n');
          else if (cmd === 'RCPT') { rcpt = line; sock.write('250 OK\r\n'); }
          else if (cmd === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
          else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
          else sock.write('250 OK\r\n');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolveServer({ port, received, close: () => server.close() });
    });
  });
}

describe('createDirectTransport — SMTP delivery', () => {
  const settings = { fromName: 'Shop', fromAddress: 'orders@myshop.test' } as EmailSettings;

  it('resolves the MX and delivers the message to it', async () => {
    const sink = await smtpSink();
    // Point the "MX" for the recipient domain at our local sink.
    const resolver: MxResolver = async () => [{ exchange: '127.0.0.1', priority: 10 }];
    const transport = createDirectTransport(settings, { resolveMx: resolver, port: sink.port, heloName: 'myshop.test' });

    await transport.send({
      to: 'customer@example.com',
      from: 'orders@myshop.test',
      fromName: 'Shop',
      subject: 'Your order #1001',
      html: '<p>Thanks!</p>',
    });

    const msg = await sink.received;
    sink.close();
    expect(msg.rcpt).toContain('customer@example.com');
    expect(msg.data).toContain('Your order #1001');
  });

  it('adds a Reply-To header when replyTo is set, and none when it is not', async () => {
    const resolver: MxResolver = async () => [{ exchange: '127.0.0.1', priority: 10 }];

    const withReply = await smtpSink();
    const t1 = createDirectTransport(settings, { resolveMx: resolver, port: withReply.port, heloName: 'myshop.test' });
    await t1.send({
      to: 'customer@example.com', from: 'orders@myshop.test', fromName: 'Shop',
      subject: 'Hi', html: '<p>Hi</p>', replyTo: 'support@myshop.test',
    });
    const m1 = await withReply.received;
    withReply.close();
    expect(m1.data).toMatch(/^Reply-To: support@myshop.test$/im);

    const without = await smtpSink();
    const t2 = createDirectTransport(settings, { resolveMx: resolver, port: without.port, heloName: 'myshop.test' });
    await t2.send({
      to: 'customer@example.com', from: 'orders@myshop.test', fromName: 'Shop',
      subject: 'Hi', html: '<p>Hi</p>',
    });
    const m2 = await without.received;
    without.close();
    expect(m2.data).not.toMatch(/reply-to:/i);
  });

  it('reports id "direct"', () => {
    expect(createDirectTransport(settings).id).toBe('direct');
  });
});
