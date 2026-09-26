import { castRoles, personaName, roleAccent, roleLabel } from './cast.mjs';

// Pure builders for the podcast render: stage markup and ffmpeg audio graphs. Kept separate from
// the workflow step so they can be unit tested without a sandbox.
const html = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const validHex = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value || '') ? value : fallback;

export const INTRO_SECONDS = 4.5;
export const OUTRO_SECONDS = 4.5;
export const INTERRUPTION_FADE_SECONDS = 0.22;

function stageStyles(item, { screen = false, count = 2 } = {}) {
  const settings = item.settings || {};
  const background = validHex(settings.background, '#101c24');
  const accent = roleAccent(settings, 'host');
  const size = screen ? (count <= 2 ? 250 : count === 3 ? 180 : 132) : (count <= 2 ? 330 : count === 3 ? 270 : 210);
  const columns = screen ? (count <= 3 ? '1fr' : '1fr 1fr') : `repeat(${count}, 1fr)`;
  return `*{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:${background};font-family:Arial,sans-serif;color:#f4faf7}body{background:radial-gradient(circle at 50% 38%,#26545066 0,${background} 62%)}header{height:150px;padding:42px 78px;background:#0b171cb8;display:flex;align-items:center;gap:28px}header img{height:66px;max-width:260px;object-fit:contain}header b{display:block;color:${accent};font-size:24px;letter-spacing:7px}header span{display:block;color:#bbd2cc;font-size:26px;margin-top:17px}.layout{height:770px;display:grid;grid-template-columns:${screen ? '620px 1fr' : '1fr'};align-items:center;gap:54px;padding:40px 70px}.people{display:grid;grid-template-columns:${columns};gap:${screen ? 20 : 28}px;align-items:center}.person{text-align:center;opacity:.58}.person.active{opacity:1}.avatar{width:${size}px;height:${size}px;border:6px solid var(--color);box-shadow:0 0 10px var(--color);margin:auto;overflow:hidden;border-radius:50%;background:var(--color);display:grid;place-items:center}.active .avatar{border-width:${Math.round(size / 24)}px;box-shadow:0 0 55px var(--color)}.avatar img{width:100%;height:100%;object-fit:cover}.avatar span{font-size:${Math.round(size * .45)}px;font-weight:800;color:#173038}.person strong{display:block;font-size:${count > 3 ? 24 : 34}px;margin-top:${count > 3 ? 12 : 24}px}.person small{display:block;color:var(--color);font-size:${count > 3 ? 14 : 18}px;font-weight:800;letter-spacing:5px;margin-top:8px}.screen{height:690px;border:5px solid #487068;border-radius:26px;background:#081216;padding:18px;display:grid;place-items:center}.screen img{max-width:100%;max-height:100%;object-fit:contain}.card{height:930px;display:grid;place-items:center;text-align:center;padding:0 160px}.card h1{font-size:76px;line-height:1.05;margin:0 0 34px;letter-spacing:-1px}.card p{font-size:30px;color:#bbd2cc;margin:0}.card small{display:block;margin-top:40px;color:${accent};font-size:22px;font-weight:800;letter-spacing:8px}`;
}

function header(item, images) {
  const brand = item.brand || {};
  return `<header>${images.logo ? `<img src="${images.logo}" alt="">` : ''}<div><b>${html(brand.name || 'THE SALES FORGE')}</b><span>${html(item.outline?.subject || 'AI PODCAST')}</span></div></header>`;
}

// images: { logo, roles: { host: dataUrl, guest: dataUrl, ... } }
export function stageHtml(item, entry, images = {}, screenImage = '') {
  const roles = castRoles(item);
  const avatar = role => {
    const person = item.personas?.[role];
    const image = images.roles?.[role];
    return `<section class="person ${entry?.role === role ? 'active' : ''}" style="--color:${roleAccent(item.settings, role)}"><div class="avatar">${image ? `<img src="${image}">` : `<span>${html(person?.name?.[0] || '?')}</span>`}</div><strong>${html(person?.name || role)}</strong><small>${roleLabel(role)}</small></section>`;
  };
  return `<!doctype html><meta charset="utf-8"><style>${stageStyles(item, { screen: Boolean(screenImage), count: roles.length })}</style>${header(item, images)}<main class="layout"><div class="people">${roles.map(avatar).join('')}</div>${screenImage ? `<div class="screen"><img src="${screenImage}"></div>` : ''}</main>`;
}

export function titleCardHtml(item, images = {}, kind = 'intro') {
  const names = castRoles(item).map(role => personaName(item, role)).join(' · ');
  const title = kind === 'intro' ? html(item.outline?.subject || 'Podcast') : 'Thanks for listening';
  const line = kind === 'intro' ? html(names) : html(item.brand?.outroText || `${names}`);
  return `<!doctype html><meta charset="utf-8"><style>${stageStyles(item, { count: castRoles(item).length })}</style>${header(item, images)}<div class="card"><div><h1>${title}</h1><p>${line}</p><small>${kind === 'intro' ? 'NOW PLAYING' : html(item.brand?.callToAction || 'SUBSCRIBE FOR MORE')}</small></div></div>`;
}

// A soft generated pad used when no music track was uploaded.
export function generatedMusicSource(seconds) {
  const length = Math.max(1, Number(seconds) || 1).toFixed(2);
  return `aevalsrc='0.10*sin(2*PI*220*t)*(0.65+0.35*sin(2*PI*0.2*t))+0.08*sin(2*PI*277.18*t)*(0.6+0.4*sin(2*PI*0.13*t))+0.07*sin(2*PI*329.63*t)+0.05*sin(2*PI*110*t)':s=48000:d=${length}`;
}

// Audio for a title card: music with fades, stereo 48 kHz.
export function titleMusicFilter(seconds) {
  const fadeOut = Math.max(0, seconds - 1.4).toFixed(2);
  return `atrim=0:${seconds.toFixed(2)},asetpts=PTS-STARTPTS,lowpass=f=2400,afade=t=in:d=0.8,afade=t=out:st=${fadeOut}:d=1.4,aformat=sample_rates=48000:channel_layouts=stereo,volume=0.9`;
}

// Final mix: optional music bed under the conversation (ducked by the voices), then loudness
// normalisation to the -16 LUFS podcast target. Input 0 is the assembled programme; input 1 the bed.
export function finalAudioGraph({ bed = false, volume = 0.08, bedStart = 0, bedDuration = 0 } = {}) {
  const loudness = 'loudnorm=I=-16:TP=-1.5:LRA=11,aformat=sample_rates=48000:channel_layouts=stereo';
  if (!bed || bedDuration <= 0) return `[0:a]${loudness}[aout]`;
  const delay = Math.round(bedStart * 1000);
  return `[0:a]asplit=2[voice][key];[1:a]atrim=0:${bedDuration.toFixed(2)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,volume=${Number(volume).toFixed(3)},afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, bedDuration - 2).toFixed(2)}:d=2,adelay=${delay}|${delay}[music];[music][key]sidechaincompress=threshold=0.015:ratio=10:attack=15:release=450[ducked];[voice][ducked]amix=inputs=2:duration=first:normalize=0,${loudness}[aout]`;
}

// Trims boundary silence from each voiced line.
export const SPEECH_TRIM_FILTER = 'silenceremove=start_periods=1:start_duration=0.03:start_threshold=-42dB:start_silence=0.01,areverse,silenceremove=start_periods=1:start_duration=0.03:start_threshold=-42dB:start_silence=0.02,areverse';

// A line that was cut off fades out quickly, so the interruption sounds like a real cut-in.
export function interruptionFadeFilter(duration) {
  if (!(duration > INTERRUPTION_FADE_SECONDS * 2)) return '';
  return `afade=t=out:st=${(duration - INTERRUPTION_FADE_SECONDS).toFixed(3)}:d=${INTERRUPTION_FADE_SECONDS}`;
}
