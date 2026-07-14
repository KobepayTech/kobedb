import { emailProvider, type EmailMessage } from './provider.js';

export async function sendMagicLinkEmail(to: string, actionLink: string): Promise<void> {
  const msg: EmailMessage = {
    to,
    subject: 'Your KobeDB sign-in link',
    text: [
      'Sign in to KobeDB',
      '',
      'Click the link below to sign in. It expires in 15 minutes and can be used once.',
      '',
      actionLink,
      '',
      "If you didn't request this, you can safely ignore this email.",
    ].join('\n'),
    html: `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a1a">
      <h2 style="margin:0 0 8px">⚡ Sign in to KobeDB</h2>
      <p style="color:#555;margin:0 0 20px">Click the button below to sign in. This link expires in 15 minutes and can be used once.</p>
      <a href="${actionLink}" style="display:inline-block;background:#3ecf8e;color:#04130c;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px">Sign in</a>
      <p style="color:#888;font-size:12px;margin:24px 0 0;word-break:break-all">Or paste this URL into your browser:<br>${actionLink}</p>
      <p style="color:#aaa;font-size:12px;margin:16px 0 0">If you didn't request this, you can safely ignore this email.</p>
    </div>`,
  };
  await emailProvider().send(msg);
}
