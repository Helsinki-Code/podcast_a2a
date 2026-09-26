// Post-production emphasis for explainer scenes, expressed as ffmpeg filters on the raw recording
// (source timestamps, 1920x1080). `focus` is the target's box in recording pixels; `at` is the
// second in the recording when the click lands.
const ZOOM = 0.32;
const ZOOM_RAMP = 0.6;

export function focusFilters(focus, at, options = {}) {
  if (!focus || !Number.isFinite(Number(focus.x)) || !Number.isFinite(Number(focus.y))) return [];
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const width = clamp(Number(focus.width) || 0, 0, 1920), height = clamp(Number(focus.height) || 0, 0, 1080);
  const left = clamp(Number(focus.x), 0, 1919), top = clamp(Number(focus.y), 0, 1079);
  const cx = Math.round(clamp(left + width / 2, 0, 1919)), cy = Math.round(clamp(top + height / 2, 0, 1079));
  const clickAt = Math.max(0, Number(at) || 0);
  const filters = [];
  if (options.highlight !== false && width >= 8 && height >= 8) {
    const pad = 10;
    const x = Math.round(clamp(left - pad, 0, 1919)), y = Math.round(clamp(top - pad, 0, 1079));
    const w = Math.round(clamp(width + pad * 2, 12, 1920 - x)), h = Math.round(clamp(height + pad * 2, 12, 1080 - y));
    filters.push(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=0xffd24a@0.9:t=5:enable='between(t,${Math.max(0, clickAt - 0.45).toFixed(2)},${(clickAt + 0.9).toFixed(2)})'`);
  }
  if (options.zoom !== false) {
    const start = Math.max(0, clickAt - 0.9).toFixed(2);
    filters.push(`zoompan=z='1+${ZOOM}*min(1,max(0,(it-${start})/${ZOOM_RAMP}))':x='max(0,min(iw-iw/zoom,${cx}-iw/zoom/2))':y='max(0,min(ih-ih/zoom,${cy}-ih/zoom/2))':d=1:s=1920x1080:fps=30`);
  }
  return filters;
}

// Accept-or-dismiss overlays (cookie banners, newsletter modals) before recording. Only clicks
// buttons inside elements that look like overlays, and never anything that subscribes or pays.
export const DISMISS_OVERLAYS_SCRIPT = `(()=>{const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&s.opacity!=='0'};const overlay=e=>{for(let n=e;n&&n!==document.body;n=n.parentElement){const s=getComputedStyle(n),id=((n.id||'')+' '+(n.className&&n.className.baseVal!==undefined?n.className.baseVal:n.className||'')).toLowerCase();if(n.getAttribute('role')==='dialog'||n.getAttribute('aria-modal')==='true'||/cookie|consent|gdpr|modal|popup|newsletter|banner|overlay|dialog|interstitial/.test(id)||((s.position==='fixed'||s.position==='sticky')&&Number(s.zIndex)>=10))return true}return false};const safe=/^(accept( all)?( cookies)?|allow( all)?( cookies)?|agree|i agree|got it|ok(ay)?|continue|no,? thanks|no thank you|not now|maybe later|close|dismiss|reject( all)?|decline|skip|×|✕|x)$/i;const unsafe=/subscribe|sign ?up|buy|pay|purchase|delete|send|publish|log ?out/i;let clicked=0;for(const e of [...document.querySelectorAll('button,[role="button"],a,[aria-label]')]){if(clicked>=3)break;const label=((e.getAttribute('aria-label')||'')+' '+(e.innerText||e.textContent||'')).replace(/\\s+/g,' ').trim();if(!label||label.length>40||!visible(e)||!overlay(e))continue;const text=(e.innerText||e.textContent||'').trim()||(e.getAttribute('aria-label')||'').trim();if(unsafe.test(label)||!safe.test(text))continue;e.click();clicked++}return clicked})()`;
