import { beginExplainer, explainerSceneBudget, planScene, renderScene, finishExplainer, failExplainer, actionFingerprint, actionIsCompatible } from './explainer-steps.mjs';

export async function explainerWorkflow(explainerId) {
  'use workflow';
  try {
    let screen = await beginExplainer(explainerId);
    const timeline = [];
    const history = [];
    const completedActions = [];
    const sceneBudget = await explainerSceneBudget(explainerId);
    let index = 0;
    let done = false;
    while (!done && index < sceneBudget) {
      let decision;
      let fingerprint;
      for (let attempt = 0; attempt < 3; attempt++) {
        decision = await planScene(explainerId, screen, history, index, index === sceneBudget - 1);
        fingerprint = actionFingerprint(decision.action);
        const repeated = completedActions.includes(fingerprint);
        if (!actionIsCompatible(decision.action, screen)) history.push({ rejected: `Invalid target for ${fingerprint}. Choose a visible interactive element of the correct type.` });
        else if (!repeated) break;
        else history.push({ rejected: `Repeated action ${fingerprint}. The prior scene already showed it. Choose a different visible interaction or set done true.` });
      }
      const narration = String(decision.narration || '').trim();
      if (!narration) {
        if (decision.done) break;
        throw new Error('The explainer agent returned an empty scene.');
      }
      if (!actionIsCompatible(decision.action, screen) || completedActions.includes(fingerprint)) {
        if (decision.done === true || timeline.length) break;
        throw new Error(`The explainer director could not choose a new compatible action after three replans (${fingerprint}).`);
      }
      const before = screen;
      const action = decision.action || { type: 'wait' };
      const result = await renderScene(explainerId, index, narration, action);
      const semanticChanged = before.title !== result.screen.title || before.content !== result.screen.content;
      const visualChanged = before.visualHash && result.screen.visualHash ? before.visualHash !== result.screen.visualHash : semanticChanged;
      const screenChanged = action.type === 'scroll' || action.type === 'drag' ? visualChanged : ['wait'].includes(action.type) ? true : semanticChanged;
      completedActions.push(fingerprint);
      history.push({ narration, action, from: before.title, to: result.screen.title, screenChanged });
      screen = result.screen;
      if (!screenChanged && !['wait','key'].includes(action.type)) {
        history.push({ rejected: `The ${fingerprint} scene did not visibly change the desktop and was omitted from the finished video.` });
        done = decision.done === true;
        index++;
        continue;
      }
      timeline.push({ text: narration, duration: result.duration, captionDuration: result.captionDuration, video: result.video, audio: result.audio, action });
      done = decision.done === true;
      index++;
    }
    if (!timeline.length) throw new Error('The explainer agent produced no scenes.');
    await finishExplainer(explainerId, timeline);
  } catch (error) {
    await failExplainer(explainerId, error.message || 'Explainer generation failed.');
  }
}
