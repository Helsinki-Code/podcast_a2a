import { beginExplainer, explainerSceneBudget, explainerRequirements, planScene, renderScene, finishExplainer, failExplainer, draftExplainerPlan, failExplainerPlan, rerenderExplainer, failExplainerRerender, actionFingerprint, actionIsCompatible, resolveActionTarget, fallbackSceneAction, compatibleTargets, explainerActionKind, buildExplainerDirectorState } from './explainer-steps.mjs';

export async function explainerWorkflow(explainerId) {
  'use workflow';
  try {
    let screen = await beginExplainer(explainerId);
    const timeline = [];
    const history = [];
    const completedActions = [];
    const sceneBudget = await explainerSceneBudget(explainerId);
    const requiredKinds = await explainerRequirements(explainerId);
    const safetyLimit = Math.min(30, Math.max(sceneBudget + 8, sceneBudget * 2));
    let index = 0;
    let done = false;
    let consecutiveFallbacks = 0;
    let milestoneNudged = false;
    while (!done && index < safetyLimit) {
      let decision;
      let fingerprint;
      let invalidReason = '';
      let acceptable = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const directorState = buildExplainerDirectorState(requiredKinds, timeline, history, screen, index, sceneBudget);
        decision = await planScene(explainerId, directorState);
        if (decision?.observedScreen) {
          screen = decision.observedScreen;
          decision = { ...decision };
          delete decision.observedScreen;
        }
        if (decision?.action) decision.action = resolveActionTarget(decision.action, screen);
        fingerprint = actionFingerprint(decision.action);
        const repeated = completedActions.includes(fingerprint);
        const missingKindRequiredNow = directorState.scene.estimatedBudgetReached && directorState.remainingMilestones.length && !directorState.remainingMilestones.includes(explainerActionKind(decision.action));
        const usable = actionIsCompatible(decision.action, screen) && !repeated;
        if (usable && !acceptable) acceptable = { decision, fingerprint };
        if (missingKindRequiredNow && usable) invalidReason = `The next scene should perform one of the remaining requested actions: ${directorState.remainingMilestones.join(', ')}.`;
        else if (!actionIsCompatible(decision.action, screen)) {
          const targets = compatibleTargets(decision.action?.type, screen);
          invalidReason = `Invalid target for ${fingerprint}. Use the exact @eN ref of a visible interactive element of the correct type${targets.length ? `, for example: ${targets.join('; ')}` : ''}.`;
        } else if (repeated) invalidReason = `Repeated action ${fingerprint}. The prior scene already showed it. Choose a different visible interaction or finish only when every milestone is complete.`;
        else { invalidReason = ''; break; }
        history.push({ rejected: invalidReason });
      }
      // Milestones are guidance: a valid action that skips one is better than a failed video.
      if (invalidReason && acceptable) {
        ({ decision, fingerprint } = acceptable);
        invalidReason = '';
      }
      let narration = String(decision?.narration || '').trim();
      if (!narration && (decision?.done || timeline.length)) break;
      if (!narration) throw new Error('The explainer agent returned an empty scene.');
      if (invalidReason) {
        // Three replans failed: keep the narration and show something safe instead of failing the video.
        consecutiveFallbacks++;
        if (consecutiveFallbacks > 2 && timeline.length >= 2) break;
        const fallback = fallbackSceneAction(screen, completedActions);
        history.push({ rejected: `Replaced with ${actionFingerprint(fallback)} after three invalid choices: ${invalidReason}` });
        decision = { ...decision, action: fallback, done: false };
        fingerprint = actionFingerprint(fallback);
        if (fallback.type === 'scroll') narration = narration || 'Let us look further down the page.';
      } else consecutiveFallbacks = 0;
      const before = screen;
      const action = decision.action || { type: 'wait' };
      const result = await renderScene(explainerId, index, narration, action);
      const semanticChanged = before.title !== result.screen.title || before.content !== result.screen.content;
      const visualChanged = before.visualHash && result.screen.visualHash ? before.visualHash !== result.screen.visualHash : semanticChanged;
      const screenChanged = action.type === 'scroll' || action.type === 'drag' ? visualChanged : ['wait'].includes(action.type) ? true : semanticChanged;
      history.push({ narration, action, from: before.title, to: result.screen.title, screenChanged });
      screen = result.screen;
      if (!screenChanged && !['wait','key'].includes(action.type)) {
        history.push({ rejected: `The ${fingerprint} scene did not visibly change the desktop and was omitted from the finished video.` });
        done = decision.done === true && timeline.length > 0;
        index++;
        continue;
      }
      completedActions.push(fingerprint);
      timeline.push({ text: narration, title: String(decision.title || '').slice(0, 60), duration: result.duration, captionDuration: result.captionDuration, video: result.video, audio: result.audio, sceneAsset: result.sceneAsset, action, screenChanged, metrics: result.metrics, usedScreenshotFallback: result.usedScreenshotFallback });
      done = decision.done === true;
      if (done) {
        const kinds = new Set(timeline.map(part => explainerActionKind(part.action)));
        const missing = requiredKinds.filter(kind => !kinds.has(kind));
        // Ask for the missing milestones once; if the director still says done, respect it.
        if (missing.length && !milestoneNudged) {
          milestoneNudged = true;
          done = false;
          history.push({ rejected: `The walkthrough cannot finish yet. The brief still requires: ${missing.join(', ')}.` });
        }
      }
      index++;
    }
    if (!timeline.length) throw new Error('The explainer agent produced no scenes.');
    // Missing milestones or hitting the scene limit still yields a video of what was recorded.
    const interactive = timeline.filter(part => !['wait'].includes(part.action?.type));
    if (!interactive.length) throw new Error('The explainer completed without a real browser interaction.');
    if (!interactive.some(part => part.usedScreenshotFallback !== true)) throw new Error('The explainer contains no valid live browser recording.');
    await finishExplainer(explainerId, timeline);
  } catch (error) {
    await failExplainer(explainerId, error.message || 'Explainer generation failed.');
  }
}

export async function explainerPlanWorkflow(explainerId) {
  'use workflow';
  try { await draftExplainerPlan(explainerId); }
  catch (error) { await failExplainerPlan(explainerId, error.message || 'Planning failed.'); }
}

export async function explainerRerenderWorkflow(explainerId) {
  'use workflow';
  try { await rerenderExplainer(explainerId); }
  catch (error) { await failExplainerRerender(explainerId, error.message || 'Re-render failed.'); }
}
