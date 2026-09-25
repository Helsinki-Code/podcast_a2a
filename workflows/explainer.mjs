import { beginExplainer, explainerSceneBudget, planScene, renderScene, finishExplainer, failExplainer } from './explainer-steps.mjs';

export async function explainerWorkflow(explainerId) {
  'use workflow';
  try {
    let screen = await beginExplainer(explainerId);
    const timeline = [];
    const completed = [];
    const sceneBudget = await explainerSceneBudget(explainerId);
    let index = 0;
    let done = false;
    while (!done && index < sceneBudget) {
      const decision = await planScene(explainerId, screen, completed, index, index === sceneBudget - 1);
      const narration = String(decision.narration || '').trim();
      if (!narration) {
        if (decision.done) break;
        throw new Error('The explainer agent returned an empty scene.');
      }
      const result = await renderScene(explainerId, index, narration, decision.action || { type: 'wait' });
      timeline.push({ text: narration, duration: result.duration, video: result.video, audio: result.audio });
      completed.push(narration);
      screen = result.screen;
      done = decision.done === true;
      index++;
    }
    if (!timeline.length) throw new Error('The explainer agent produced no scenes.');
    await finishExplainer(explainerId, timeline);
  } catch (error) {
    await failExplainer(explainerId, error.message || 'Explainer generation failed.');
  }
}
