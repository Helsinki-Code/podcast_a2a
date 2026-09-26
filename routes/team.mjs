import { ensureTeam, teamForOwner, teamById, teamMembers, addTeamMember, setTeamMemberRole, removeTeamMember, createTeamInvite, teamInvites, teamInvite, deleteTeamInvite, renameTeam, membershipFor } from '../lib/store.mjs';
import { primaryEmail } from '../lib/auth.mjs';
import { sendEmail, emailConfigured } from '../lib/mailer.mjs';
import { json, error, body } from '../lib/http.mjs';

// Team management. Runs before the paywall so invitees can accept without their own plan.
// auth.userId is the workspace (team owner) scope; auth.actorId is the signed-in person.
export const ROLES = ['admin', 'editor', 'viewer'];
const appUrl = req => process.env.NEXT_PUBLIC_APP_URL || `${String(req.headers['x-forwarded-proto'] || 'http').split(',')[0]}://${req.headers.host}`;
const canManage = auth => ['owner', 'admin'].includes(auth.role);

export async function handle({ req, res, url, parts, auth }) {
  if (parts[0] !== 'api' || parts[1] !== 'team') return false;
  if (url.pathname === '/api/team' && req.method === 'GET') {
    const team = await teamForOwner(auth.userId);
    const members = team ? await teamMembers(team.id) : [];
    return json(res, 200, { team, role: auth.role, actorId: auth.actorId, ownerId: auth.userId, members, invites: team && canManage(auth) ? await teamInvites(team.id) : [], emailInvites: emailConfigured() });
  }
  if (url.pathname === '/api/team' && req.method === 'PUT') {
    if (auth.role !== 'owner') return error(res, 403, 'Only the workspace owner can rename the team.');
    const team = await ensureTeam(auth.userId);
    await renameTeam(team.id, String((await body(req, 2000)).name || '').trim().slice(0, 80) || team.name);
    return json(res, 200, await teamForOwner(auth.userId));
  }
  if (url.pathname === '/api/team/invites' && req.method === 'POST') {
    if (!canManage(auth)) return error(res, 403, 'Only owners and admins can invite people.');
    const input = await body(req, 2000);
    const email = String(input.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error(res, 400, 'Enter a valid email address.');
    const role = ROLES.includes(input.role) ? input.role : 'editor';
    if (role === 'admin' && auth.role !== 'owner') return error(res, 403, 'Only the owner can invite admins.');
    const team = await ensureTeam(auth.userId);
    const invite = await createTeamInvite(team.id, email, role);
    const link = `${appUrl(req)}/?invite=${invite.token}`;
    const emailed = await sendEmail({ to: email, subject: `You're invited to ${team.name} on The Sales Forge`, text: `You've been invited to join ${team.name} as ${role}.\n\nAccept the invitation: ${link}\n\nThis link expires in 7 days and only works for ${email}.` });
    return json(res, 201, { invite, link, emailed });
  }
  if (parts[2] === 'invites' && parts[3] && req.method === 'DELETE') {
    if (!canManage(auth)) return error(res, 403, 'Only owners and admins can cancel invitations.');
    const invite = await teamInvite(parts[3]);
    const team = await teamForOwner(auth.userId);
    if (!invite || !team || invite.teamId !== team.id) return error(res, 404, 'Invitation not found.');
    await deleteTeamInvite(invite.token);
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/team/accept' && req.method === 'POST') {
    const invite = await teamInvite(String((await body(req, 2000)).token || ''));
    if (!invite || invite.expiresAt < new Date().toISOString()) return error(res, 404, 'This invitation is invalid or has expired. Ask for a new one.');
    const email = String(await primaryEmail(auth.actorId)).toLowerCase();
    if (email !== invite.email) return error(res, 403, `This invitation is for ${invite.email}. Sign in with that email to accept it.`);
    const team = await teamById(invite.teamId);
    if (!team) return error(res, 404, 'That team no longer exists.');
    if (team.ownerId === auth.actorId) return error(res, 409, 'You already own this workspace.');
    if (await membershipFor(auth.actorId)) return error(res, 409, 'Leave your current team before joining another.');
    const ownTeam = await teamForOwner(auth.actorId);
    if (ownTeam && (await teamMembers(ownTeam.id)).length) return error(res, 409, 'Remove the members of your own team before joining another.');
    await addTeamMember(team.id, auth.actorId, email, invite.role);
    await deleteTeamInvite(invite.token);
    return json(res, 200, { team, role: invite.role });
  }
  if (url.pathname === '/api/team/leave' && req.method === 'POST') {
    const membership = await membershipFor(auth.actorId);
    if (!membership) return error(res, 409, 'You are not a member of another workspace.');
    await removeTeamMember(membership.teamId, auth.actorId);
    return json(res, 200, { ok: true });
  }
  if (parts[2] === 'members' && parts[3]) {
    if (!canManage(auth)) return error(res, 403, 'Only owners and admins can manage members.');
    const team = await teamForOwner(auth.userId);
    const target = team && (await teamMembers(team.id)).find(member => member.userId === parts[3]);
    if (!target) return error(res, 404, 'Member not found.');
    if (target.role === 'admin' && auth.role !== 'owner') return error(res, 403, 'Only the owner can change or remove admins.');
    if (req.method === 'PATCH') {
      const role = String((await body(req, 1000)).role || '');
      if (!ROLES.includes(role) || (role === 'admin' && auth.role !== 'owner')) return error(res, 400, 'Choose a valid role.');
      await setTeamMemberRole(team.id, target.userId, role);
      return json(res, 200, { ok: true, role });
    }
    if (req.method === 'DELETE') { await removeTeamMember(team.id, target.userId); return json(res, 200, { ok: true }); }
  }
  return false;
}
