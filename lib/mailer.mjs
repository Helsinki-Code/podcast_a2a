// Transactional email through Resend when RESEND_API_KEY is set; otherwise callers fall back to
// showing a link in the app. Returns true only when the provider accepted the message.
export const emailConfigured = () => Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);

export async function sendEmail({ to, subject, text, html }) {
  if (!emailConfigured() || !to) return false;
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, text, ...(html ? { html } : {}) }),
      signal: AbortSignal.timeout(10000)
    });
    return response.ok;
  } catch { return false; }
}
