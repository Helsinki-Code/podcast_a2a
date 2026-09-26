import { listExplainers, explainer, saveExplainer, setExplainerFields, stamp, uid, reserveCredits, copyExplainerForRestart, brandKit, deleteExplainer } from '../lib/store.mjs';
import { costs } from '../lib/billing.mjs';
import { supportedVoice } from '../lib/providers.mjs';
import { assertPublicHttpUrl } from '../lib/url-security.mjs';
import { json, error, body } from '../lib/http.mjs';

export async function handle({ req, res, url, parts, auth, userAccount }) {
  if (parts[0] === 'api' && parts[1] === 'explainers' && parts[2] && parts.length === 3 && req.method === 'DELETE') {
    const item = await explainer(parts[2]);
    if (!item || item.ownerId !== auth.userId) return error(res, 404, 'Not found');
    if (['queued','running','planning','rendering'].includes(item.status) || item.videoStatus === 'processing') return error(res, 409, 'Stop it or wait for it to finish before deleting it.');
    return json(res, 200, { ok: true, filesRemoved: await deleteExplainer(item.id) });
  }
  if (url.pathname === '/api/explainers' && req.method === 'GET') return json(res, 200, await listExplainers(auth.userId));
  if (url.pathname === '/api/explainers' && req.method === 'POST') {
    const input = await body(req, 20_000);
    const targetUrl = String(input.url || '').trim().slice(0, 1200);
    const brief = String(input.brief || '').trim().slice(0, 3000);
    const loginUrl = String(input.loginUrl || '').trim().slice(0, 1200);
    try { await assertPublicHttpUrl(targetUrl); if (loginUrl) await assertPublicHttpUrl(loginUrl); }
    catch (cause) { return error(res, 400, cause.message); }
    if (brief.length < 20) return error(res, 400, 'Describe the workflow the video should explain.');
    const captionInput = input.captionOptions || {};
    const captionColor = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value || '') ? value : fallback;
    const item = {
      id: uid(), ownerId: auth.userId, createdAt: stamp(), status: 'draft', url: targetUrl, brief,
      title: String(input.title || new URL(targetUrl).hostname).trim().slice(0, 120),
      authRequired: !!input.authRequired,
      loginUrl,
      usernameSelector: String(input.usernameSelector || 'input[type="email"], input[autocomplete="username"], input[autocomplete="email"], input[name*="email" i], input[name*="user" i], input[id*="email" i], input[id*="user" i]').slice(0, 600),
      passwordSelector: String(input.passwordSelector || 'input[type="password"], input[autocomplete="current-password"]').slice(0, 400),
      submitSelector: String(input.submitSelector || 'button[type="submit"], input[type="submit"], button[name*="login" i], button[name*="sign" i]').slice(0, 400),
      speechProvider: 'gateway', voice: supportedVoice('gateway', String(input.voice || ''), 'coral'),
      captionStyle: ['studio','minimal','editorial','bold'].includes(input.captionStyle) ? input.captionStyle : 'studio',
      captionOptions: {
        enabled: captionInput.enabled !== false,
        font: ['sans','serif','mono'].includes(captionInput.font) ? captionInput.font : 'sans',
        size: Math.max(14, Math.min(32, Number(captionInput.size) || 18)),
        textColor: captionColor(captionInput.textColor, '#ffffff'),
        backgroundColor: captionColor(captionInput.backgroundColor, '#000000'),
        position: ['bottom','center','top'].includes(captionInput.position) ? captionInput.position : 'bottom',
        wordsPerCue: Math.max(3, Math.min(10, Number(captionInput.wordsPerCue) || 7))
      },
      effects: { zoom: input.effects?.zoom !== false, highlight: input.effects?.highlight !== false },
      branding: { intro: !!input.branding?.intro, outro: !!input.branding?.outro },
      reviewPlan: input.reviewPlan !== false
    };
    if (item.branding.intro || item.branding.outro) item.brand = await brandKit(auth.userId) || { name: '' };
    await saveExplainer(item); return json(res, 201, item);
  }
  if (parts[0] === 'api' && parts[1] === 'explainers' && parts[2]) {
    const item = await explainer(parts[2]);
    if (!item || item.ownerId !== auth.userId) return error(res, 404, 'Explainer not found');
    if (parts.length === 3 && req.method === 'GET') return json(res, 200, item);
    if (parts.length === 3 && req.method === 'PATCH') {
      const title = String((await body(req, 4000)).title ?? '').trim().slice(0, 120);
      if (!title) return error(res, 400, 'Enter a title.');
      await setExplainerFields(item.id, { title });
      return json(res, 200, { ok: true, title });
    }
    if (parts[3] === 'duplicate' && req.method === 'POST') {
      if (['queued','running','planning','rendering'].includes(item.status)) return error(res, 409, 'Wait for this explainer to finish before duplicating it.');
      return json(res, 201, await copyExplainerForRestart({ ...item, title: `${item.title} (copy)` }));
    }
    if (parts[3] === 'restart' && req.method === 'POST') {
      if (!['complete','failed'].includes(item.status)) return error(res, 409, 'Wait for this explainer to finish before restarting it.');
      const restarted = await copyExplainerForRestart(item);
      return json(res, 201, restarted);
    }
    if (parts[3] === 'prepare' && req.method === 'POST') {
      if (item.status !== 'draft') return error(res, 409, 'Only a draft explainer can prepare its browser.');
      if (!item.authRequired) return json(res, 200, { ok: true });
      const input = await body(req, 12_000);
      const credentials = { username: String(input.username || '').slice(0, 500), password: String(input.password || '').slice(0, 2000) };
      if (!credentials.username || !credentials.password) return error(res, 400, 'Login username and password are required.');
      const loginUrl = String(input.loginUrl || item.loginUrl || '').trim().slice(0, 1200);
      if (loginUrl) try { await assertPublicHttpUrl(loginUrl); } catch (cause) { return error(res, 400, cause.message); }
      const login = {
        url: item.url,
        loginUrl,
        authRequired: true,
        usernameSelector: String(input.usernameSelector || item.usernameSelector || '').slice(0, 600),
        passwordSelector: String(input.passwordSelector || item.passwordSelector || '').slice(0, 400),
        submitSelector: String(input.submitSelector || item.submitSelector || '').slice(0, 400)
      };
      const { VercelEpisodeSandbox } = await import('../lib/vercel-sandbox.mjs');
      await new VercelEpisodeSandbox(item.id, () => {}).login(login, credentials);
      await setExplainerFields(item.id, { ...login, browserPrepared: true, progress: 'Secure browser prepared', error: null });
      return json(res, 200, { ok: true });
    }
    if (parts[3] === 'desktop' && req.method === 'GET') {
      if (item.status !== 'draft') return error(res, 409, 'The secure desktop is available while the explainer is a draft.');
      const { VercelEpisodeSandbox } = await import('../lib/vercel-sandbox.mjs');
      const liveUrl = await new VercelEpisodeSandbox(item.id, () => {}).interactiveDesktop(item.loginUrl || item.url);
      if (!liveUrl) return error(res, 409, 'The visible Computer Use desktop is not configured.');
      return json(res, 200, { liveUrl });
    }
    if (parts[3] === 'desktop-ready' && req.method === 'POST') {
      if (item.status !== 'draft' || !item.authRequired) return error(res, 409, 'This explainer does not need manual browser preparation.');
      const { VercelEpisodeSandbox } = await import('../lib/vercel-sandbox.mjs');
      const screen = await new VercelEpisodeSandbox(item.id, () => {}).capture(null, item.url);
      await setExplainerFields(item.id, { browserPrepared: true, manualDesktopPrepared: true, progress: 'Secure browser prepared', error: null });
      return json(res, 200, { ok: true, screen: { title: screen.title, image: screen.image } });
    }
    if (parts[3] === 'plan' && req.method === 'POST') {
      if (!['draft','awaiting_approval'].includes(item.status)) return error(res, 409, 'The scene plan can only be drafted before recording.');
      if (item.authRequired && !item.browserPrepared) return error(res, 409, 'Prepare the authenticated browser first.');
      await setExplainerFields(item.id, { status: 'planning', progress: 'Drafting the scene plan', error: null });
      const { explainerPlanWorkflow } = await import('../workflows/explainer.mjs');
      if (process.env.VERCEL) {
        const { start } = await import('workflow/api');
        const run = await start(explainerPlanWorkflow, [item.id]);
        return json(res, 202, { ok: true, runId: run.runId });
      }
      json(res, 202, { ok: true });
      setImmediate(() => explainerPlanWorkflow(item.id));
      return true;
    }
    if (parts[3] === 'plan' && req.method === 'PUT') {
      if (item.status !== 'awaiting_approval') return error(res, 409, 'There is no scene plan waiting for review.');
      const { normalizePlan } = await import('../workflows/explainer-steps.mjs');
      const scenes = normalizePlan(await body(req, 60_000), 20);
      if (!scenes.length) return error(res, 400, 'Keep at least one scene with narration.');
      await setExplainerFields(item.id, { plan: { ...item.plan, scenes, approved: false, editedAt: stamp() } });
      return json(res, 200, { scenes });
    }
    if (parts[3] === 'rerender' && req.method === 'POST') {
      if (item.status !== 'complete' || !item.scenes?.length) return error(res, 409, 'Only a finished explainer with saved scenes can be re-rendered.');
      const input = await body(req, 60_000);
      const edits = Array.isArray(input.scenes) ? input.scenes : [];
      const scenes = item.scenes.map((scene, index) => ({ ...scene, text: String(edits[index]?.text ?? scene.text).replace(/\s+/g, ' ').trim().slice(0, 400) || scene.text }));
      const captionInput = input.captionOptions || item.captionOptions || {};
      const captionColor = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value || '') ? value : fallback;
      const attempt = (Number(item.renderVersion) || 0) + 1;
      const reference = `${item.id}:rerender-${attempt}`;
      if (!await reserveCredits(auth.userId, costs.explainerRerender, 'explainer', reference)) return error(res, 402, `A re-render needs ${costs.explainerRerender} credits.`);
      await setExplainerFields(item.id, {
        status: 'rendering', progress: 'Queued for re-render', scenes, rerenderError: null, rerenderCredits: costs.explainerRerender, rerenderReference: reference,
        voice: input.voice ? supportedVoice(item.speechProvider || 'gateway', String(input.voice), item.voice) : item.voice,
        captionStyle: ['studio','minimal','editorial','bold'].includes(input.captionStyle) ? input.captionStyle : item.captionStyle,
        captionOptions: {
          enabled: captionInput.enabled !== false, font: ['sans','serif','mono'].includes(captionInput.font) ? captionInput.font : 'sans',
          size: Math.max(14, Math.min(32, Number(captionInput.size) || 18)), textColor: captionColor(captionInput.textColor, '#ffffff'),
          backgroundColor: captionColor(captionInput.backgroundColor, '#000000'), position: ['bottom','center','top'].includes(captionInput.position) ? captionInput.position : 'bottom',
          wordsPerCue: Math.max(3, Math.min(10, Number(captionInput.wordsPerCue) || 7))
        }
      });
      const { explainerRerenderWorkflow } = await import('../workflows/explainer.mjs');
      if (process.env.VERCEL) {
        const { start } = await import('workflow/api');
        const run = await start(explainerRerenderWorkflow, [item.id]);
        return json(res, 202, { ok: true, runId: run.runId });
      }
      json(res, 202, { ok: true });
      setImmediate(() => explainerRerenderWorkflow(item.id));
      return true;
    }
    if (parts[3] === 'start' && req.method === 'POST') {
      if (!['draft','awaiting_approval'].includes(item.status)) return error(res, 409, 'This explainer has already started.');
      if (item.status === 'awaiting_approval') await setExplainerFields(item.id, { plan: { ...item.plan, approved: true, approvedAt: stamp() } });
      if (item.authRequired && !item.browserPrepared) return error(res, 409, 'Prepare the authenticated browser first.');
      if (!await reserveCredits(auth.userId, costs.explainer, 'explainer', item.id)) return error(res, 402, `This explainer needs ${costs.explainer} credits.`);
      await setExplainerFields(item.id, { status: 'queued', progress: 'Queued', creditsCharged: costs.explainer });
      const { explainerWorkflow } = await import('../workflows/explainer.mjs');
      if (process.env.VERCEL) {
        const { start } = await import('workflow/api');
        const run = await start(explainerWorkflow, [item.id]);
        await setExplainerFields(item.id, { workflowRunId: run.runId });
        return json(res, 202, { ok: true, runId: run.runId });
      }
      json(res, 202, { ok: true });
      setImmediate(() => explainerWorkflow(item.id));
      return true;
    }
  }
  return false;
}
