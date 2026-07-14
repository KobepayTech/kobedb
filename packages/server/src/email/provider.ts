import { config } from '../config.js';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailProvider {
  readonly name: string;
  send(msg: EmailMessage): Promise<void>;
}

// ── log (default / dev): print the email instead of sending it ──────────────
class LogProvider implements EmailProvider {
  name = 'log';
  async send(msg: EmailMessage) {
    // eslint-disable-next-line no-console
    console.log(
      `\n📧 [email:log] to=${msg.to}\n   subject: ${msg.subject}\n   ${msg.text.replace(/\n/g, '\n   ')}\n`,
    );
  }
}

// ── SMTP via nodemailer (Gmail, SendGrid SMTP, Mailgun, Postmark, …) ─────────
class SmtpProvider implements EmailProvider {
  name = 'smtp';
  private transport: any;
  private async tx() {
    if (!this.transport) {
      // @ts-ignore - optional dependency, only required when EMAIL_PROVIDER=smtp
      const nodemailer = await import('nodemailer');
      this.transport = nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpSecure,
        auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
      });
    }
    return this.transport;
  }
  async send(msg: EmailMessage) {
    const tx = await this.tx();
    await tx.sendMail({ from: config.emailFrom, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
  }
}

// ── Resend HTTP API ─────────────────────────────────────────────────────────
class ResendProvider implements EmailProvider {
  name = 'resend';
  async send(msg: EmailMessage) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.emailFrom, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`resend send failed (${res.status}): ${detail}`);
    }
  }
}

let provider: EmailProvider | null = null;
export function emailProvider(): EmailProvider {
  if (!provider) {
    switch (config.emailProvider) {
      case 'smtp':
        provider = new SmtpProvider();
        break;
      case 'resend':
        provider = new ResendProvider();
        break;
      default:
        provider = new LogProvider();
    }
  }
  return provider;
}

/** Whether a real (non-log) provider is configured — used to decide if we return the link in the API response. */
export function emailDeliversExternally(): boolean {
  return config.emailProvider === 'smtp' || config.emailProvider === 'resend';
}
