import { account, workspaceSettings } from './store.mjs';
import { sendEmail } from './mailer.mjs';

// "Your video is ready" style emails to the workspace owner, unless turned off in settings.
export async function notifyOwner(ownerId, subject, text) {
  try {
    if (!ownerId) return false;
    const settings = await workspaceSettings(ownerId);
    if (settings.notifyEmail === false) return false;
    const owner = await account(ownerId);
    return sendEmail({ to: owner?.email, subject, text: `${text}\n\n${process.env.NEXT_PUBLIC_APP_URL || 'https://dsalesforge.online'}` });
  } catch { return false; }
}
