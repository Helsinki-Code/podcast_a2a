import { castRoles, roleAccent, roleLabel } from './cast.js';

// Draws the podcast stage (people, screen share, captions) onto a 1280x720 logical canvas.
// Used live in the studio (and captured into the local recording) and as the wizard preview.
function rounded(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }

function wrap(ctx, text, x, y, maxWidth, lineHeight, maxLines = 12) {
  const words = String(text || '').split(/\s+/);
  let line = '', count = 0;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) { ctx.fillText(line, x, y + count * lineHeight); count++; line = word; if (count >= maxLines) break; }
    else line = test;
  }
  if (count < maxLines) ctx.fillText(line, x, y + count * lineHeight);
}

function captionLines(ctx, text, maxWidth, maxLines = 2) {
  const words = String(text || '').split(/\s+/), lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) { lines.push(line); line = word; if (lines.length === maxLines - 1) break; }
    else line = next;
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

function drawPersona(ctx, person, role, image, x, y, r, speaking, color, glow, amplitude) {
  const power = speaking ? Math.min(1, amplitude * 4 + .12) : 0;
  ctx.save();
  ctx.shadowColor = color; ctx.shadowBlur = speaking ? (26 + power * 90) * glow : 0;
  ctx.beginPath(); ctx.arc(x, y, r + 5 + power * 7, 0, Math.PI * 2);
  ctx.strokeStyle = color; ctx.globalAlpha = speaking ? .5 + power * .5 : .25; ctx.lineWidth = (speaking ? 5 + power * 7 : 3) * glow; ctx.stroke();
  ctx.restore();
  ctx.save(); ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.clip();
  if (image) ctx.drawImage(image, x - r, y - r, r * 2, r * 2);
  else { ctx.fillStyle = color; ctx.fillRect(x - r, y - r, r * 2, r * 2); ctx.fillStyle = '#173038'; ctx.font = `bold ${r}px Arial`; ctx.textAlign = 'center'; ctx.fillText((person?.name || '?')[0].toUpperCase(), x, y + r * .35); }
  ctx.restore();
  ctx.fillStyle = '#f1f5f1'; ctx.font = `bold ${r < 60 ? 14 : 19}px Arial`; ctx.textAlign = 'center';
  ctx.fillText((person?.name || role).slice(0, 24), x, y + r + (r < 60 ? 24 : 35));
  ctx.fillStyle = color; ctx.font = 'bold 10px Arial'; ctx.letterSpacing = '2px'; ctx.fillText(role, x, y + r + (r < 60 ? 40 : 54)); ctx.letterSpacing = '0px'; ctx.textAlign = 'left';
}

// options.captionOptions: { enabled, font, size (10-24, as in the render), position }.
function drawCaption(ctx, text, style, options = {}) {
  if (!text || options.enabled === false) return;
  const family = { serif: 'Georgia, serif', mono: '"Courier New", monospace' }[options.font] || 'Arial';
  const scale = (Number(options.size) || (style === 'bold' ? 16 : 13)) / 13;
  const px = Math.round((style === 'bold' ? 31 : style === 'minimal' ? 26 : 25) * scale / (style === 'bold' ? 16 / 13 : 1));
  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = `${style === 'bold' ? 800 : 600} ${px}px ${family}`;
  const lines = captionLines(ctx, text, style === 'bold' ? 920 : 1000, 2);
  const lineHeight = Math.round(px * 1.35), boxHeight = lines.length * lineHeight + 26;
  const y = options.position === 'top' ? 110 : options.position === 'center' ? 360 - boxHeight / 2 : 650 - boxHeight;
  if (style === 'studio' || !style) { ctx.fillStyle = '#061013dc'; rounded(ctx, 110, y, 1060, boxHeight, 12); ctx.fill(); }
  ctx.lineJoin = 'round'; ctx.lineWidth = style === 'bold' ? 8 : style === 'minimal' ? 5 : 0; ctx.strokeStyle = '#061013';
  ctx.fillStyle = style === 'bold' ? '#80ded1' : '#f4faf7';
  lines.forEach((line, index) => { const yy = y + 13 + px * .95 + index * lineHeight; if (ctx.lineWidth) ctx.strokeText(line, 640, yy); ctx.fillText(line, 640, yy); });
  ctx.restore();
}

// scene: { episode, screen, speaker, amplitude, roleImages, captionText, screenVisual, brandName }
export function drawStageScene(canvas, scene) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const episode = scene.episode || {};
  const settings = episode.settings || {};
  const s = canvas.width / 1280;
  ctx.save(); ctx.scale(s, s);
  const bg = settings.background || '#101c24', accent = roleAccent(settings, 'host');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, 1280, 720);
  const gradient = ctx.createRadialGradient(640, 350, 10, 640, 350, 800);
  gradient.addColorStop(0, '#26545044'); gradient.addColorStop(1, '#00000000');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1280, 720);
  ctx.fillStyle = accent; ctx.font = 'bold 13px Arial'; ctx.letterSpacing = '3px'; ctx.fillText(String(scene.brandName || 'THE SALES FORGE').toUpperCase().slice(0, 40), 51, 48); ctx.letterSpacing = '0px';
  ctx.fillStyle = '#bbd2cc'; ctx.font = '14px Arial'; ctx.fillText(String(episode.title || episode.outline?.subject || 'LIVE PODCAST').slice(0, 105), 51, 81);
  const screen = scene.screen || { type: 'idle' };
  const active = screen.type !== 'idle';
  const stage = settings.layout === 'stage';
  const glow = settings.glowStrength || 1;
  const roles = castRoles(episode);
  const n = roles.length;
  roles.forEach((role, i) => {
    let x, y, r;
    if (!active) { r = n <= 2 ? 150 : n === 3 ? 112 : n === 4 ? 92 : 78; x = n <= 2 ? (i === 0 ? 390 : 890) : 1280 / (n + 1) * (i + 1); y = 310; }
    else if (stage) { r = Math.min(93, Math.floor(470 / n / 2.7)); x = 180; y = n <= 2 ? (i === 0 ? 252 : 485) : 130 + (470 / (n - 1 || 1)) * i; }
    else { r = n <= 2 ? 100 : Math.min(80, Math.floor(1280 / (n + 1) / 2.8)); x = n <= 2 ? (i === 0 ? 320 : 960) : 1280 / (n + 1) * (i + 1); y = 225; }
    drawPersona(ctx, episode.personas?.[role], roleLabel(role), scene.roleImages?.[role], x, y, r, scene.speaker === role, roleAccent(settings, role), glow, scene.amplitude || 0);
  });
  if (active) {
    const w = Math.round(1280 * (settings.paneWidth || 66) / 100), x = stage ? 1280 - w - 55 : (1280 - w) / 2, y = stage ? 116 : 405, h = stage ? 500 : 235;
    ctx.fillStyle = '#10242b'; rounded(ctx, x, y, w, h, 16); ctx.fill(); ctx.strokeStyle = '#487068'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = accent; ctx.font = 'bold 13px Arial'; ctx.fillText(String(screen.title || 'SANDBOX').slice(0, 70), x + 22, y + 31);
    ctx.fillStyle = '#a9c8c2'; ctx.font = '13px Arial';
    const visual = scene.screenVisual;
    if (visual) {
      try {
        const maxW = w - 40, maxH = h - 67, vw = visual.videoWidth || visual.width, vh = visual.videoHeight || visual.height;
        const scale = Math.min(maxW / vw, maxH / vh), iw = vw * scale, ih = vh * scale;
        ctx.drawImage(visual, x + 20 + (maxW - iw) / 2, y + 49 + (maxH - ih) / 2, iw, ih);
      } catch {}
    } else wrap(ctx, screen.content || 'Working…', x + 22, y + 67, w - 44, 21, Math.floor((h - 65) / 21));
  }
  drawCaption(ctx, scene.captionText, settings.captionStyle || 'studio', settings.captionOptions || {});
  ctx.fillStyle = '#789b97'; ctx.font = '11px Arial'; ctx.fillText('UNSCRIPTED · ONE CONTINUOUS TAKE', 52, 678);
  ctx.fillStyle = '#ef8074'; ctx.beginPath(); ctx.arc(1179, 44, 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#b8d7cf'; ctx.fillText('REC', 1193, 48);
  ctx.restore();
}

export function loadImage(url) {
  return new Promise(resolve => { if (!url) return resolve(null); const img = new Image(); img.onload = () => resolve(img); img.onerror = () => resolve(null); img.src = url; });
}
