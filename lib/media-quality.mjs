const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;

export function parseProbeJson(input) {
  const parsed = typeof input === 'string' ? JSON.parse(input || '{}') : (input || {});
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find(stream => stream.codec_type === 'video') || null;
  const audio = streams.find(stream => stream.codec_type === 'audio') || null;
  const duration = Math.max(
    finite(parsed.format?.duration),
    finite(video?.duration),
    finite(audio?.duration)
  );
  return {
    duration,
    size: finite(parsed.format?.size),
    format: String(parsed.format?.format_name || ''),
    video: video ? {
      codec: String(video.codec_name || ''),
      width: finite(video.width),
      height: finite(video.height),
      frames: finite(video.nb_frames),
      frameRate: ratio(video.avg_frame_rate) || ratio(video.r_frame_rate)
    } : null,
    audio: audio ? {
      codec: String(audio.codec_name || ''),
      sampleRate: finite(audio.sample_rate),
      channels: finite(audio.channels)
    } : null,
    subtitleStreams: streams.filter(stream => stream.codec_type === 'subtitle').length
  };
}

function ratio(input) {
  const [numerator, denominator] = String(input || '').split('/').map(Number);
  if (!Number.isFinite(numerator)) return 0;
  return denominator ? numerator / denominator : numerator;
}

export function parseSilenceLog(input, duration = 0) {
  const starts = [...String(input || '').matchAll(/silence_start:\s*([\d.]+)/g)].map(match => Number(match[1]));
  const ends = [...String(input || '').matchAll(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g)].map(match => ({ end: Number(match[1]), duration: Number(match[2]) }));
  const periods = ends.map((entry, index) => ({
    start: starts[index] ?? Math.max(0, entry.end - entry.duration),
    end: entry.end,
    duration: entry.duration
  })).filter(period => Number.isFinite(period.duration) && period.duration > 0);
  if (starts.length > ends.length && duration > starts.at(-1)) periods.push({ start: starts.at(-1), end: duration, duration: duration - starts.at(-1) });
  const total = periods.reduce((sum, period) => sum + period.duration, 0);
  return { periods, total, percentage: duration > 0 ? total / duration * 100 : 0, longest: Math.max(0, ...periods.map(period => period.duration)) };
}

export function evaluateMediaQuality(metrics, requirements = {}) {
  const failures = [];
  const requireAudio = requirements.requireAudio !== false;
  const interactive = requirements.interactive === true;
  const minDuration = Math.max(0, Number(requirements.minDuration) || 0);
  const maxSilencePercent = Number(requirements.maxSilencePercent ?? 35);
  const maxSilenceSeconds = Number(requirements.maxSilenceSeconds ?? 2);
  if (!metrics?.video) failures.push('A video stream is required.');
  if (requireAudio && !metrics?.audio) failures.push('An audio stream is required.');
  if (!(metrics?.duration > 0)) failures.push('The media duration is missing or invalid.');
  if (metrics?.duration < minDuration) failures.push(`The media is ${metrics.duration.toFixed(2)}s; at least ${minDuration.toFixed(2)}s is required.`);
  if (interactive && Number(metrics?.sceneChanges || 0) < 1) failures.push('The interactive recording contains no meaningful visual changes.');
  if (interactive && Number(metrics?.uniqueFrames || 0) < 2) failures.push('The interactive recording is effectively a frozen frame.');
  if (metrics?.silence?.percentage > maxSilencePercent) failures.push(`Unintended silence is ${metrics.silence.percentage.toFixed(1)}%, above ${maxSilencePercent}%.`);
  if (metrics?.silence?.longest > maxSilenceSeconds) failures.push(`The longest unintended silence is ${metrics.silence.longest.toFixed(2)}s, above ${maxSilenceSeconds.toFixed(2)}s.`);
  if (metrics?.timestampErrors > 0) failures.push('The media contains non-monotonic or invalid timestamps.');
  return { passed: failures.length === 0, failures };
}

export async function inspectSandboxMedia(browser, filename, options = {}) {
  const probe = await browser.run('ffprobe', ['-v', 'error', '-count_frames', '-show_format', '-show_streams', '-of', 'json', filename], 120000);
  if (probe.exitCode) throw new Error(`Media probe failed for ${filename}: ${(await probe.stderr()).slice(-1000)}`);
  const metrics = parseProbeJson(await probe.stdout());
  if (metrics.video && !(metrics.duration > 0)) {
    const packets = await browser.run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', filename], 180000);
    if (!packets.exitCode) {
      const lines = (await packets.stdout()).trim().split('\n').filter(Boolean);
      const values = String(lines.at(-1) || '').split(',').map(Number);
      const recovered = values[0] + (Number.isFinite(values[1]) ? values[1] : 0);
      if (recovered > 0) metrics.duration = recovered;
    }
  }
  if (!metrics.video || !(metrics.duration > 0)) return { ...metrics, sceneChanges: 0, uniqueFrames: 0, silence: { periods: [], total: 0, percentage: 0, longest: 0 }, timestampErrors: 0 };
  const sceneThreshold = String(options.sceneThreshold ?? 0.025);
  const visualPrefix = options.ignoreCaptionBand === false ? '' : 'crop=iw:ih*0.65:0:0,';
  const [sceneResult, frameResult, silenceResult, decodeResult] = await Promise.all([
    browser.run('ffmpeg', ['-v', 'info', '-i', filename, '-vf', `${visualPrefix}select=gt(scene\\,${sceneThreshold}),showinfo`, '-an', '-f', 'null', '-'], 180000),
    browser.run('ffmpeg', ['-v', 'error', '-i', filename, '-vf', `${visualPrefix}fps=2,scale=160:-2`, '-an', '-f', 'framemd5', '-'], 180000),
    metrics.audio ? browser.run('ffmpeg', ['-v', 'info', '-i', filename, '-af', `silencedetect=noise=${options.silenceNoise || '-30dB'}:d=${options.silenceDuration || 0.25}`, '-vn', '-f', 'null', '-'], 180000) : null,
    browser.run('ffmpeg', ['-v', 'warning', '-xerror', '-i', filename, '-map', '0:v:0', ...(metrics.audio ? ['-map', '0:a:0'] : []), '-f', 'null', '-'], 180000)
  ]);
  if (decodeResult.exitCode) throw new Error(`Media decode failed for ${filename}: ${(await decodeResult.stderr()).slice(-1000)}`);
  const sceneLog = `${await sceneResult.stdout()}\n${await sceneResult.stderr()}`;
  const frameLines = (await frameResult.stdout()).split('\n').filter(line => /^\d+,/.test(line));
  const uniqueFrames = new Set(frameLines.map(line => line.split(',').at(-1)?.trim()).filter(Boolean)).size;
  const silenceLog = silenceResult ? `${await silenceResult.stdout()}\n${await silenceResult.stderr()}` : '';
  const decodeLog = `${await decodeResult.stdout()}\n${await decodeResult.stderr()}`;
  return {
    ...metrics,
    sceneChanges: (sceneLog.match(/showinfo.*pts_time/g) || []).length,
    uniqueFrames,
    silence: parseSilenceLog(silenceLog, metrics.duration),
    timestampErrors: (decodeLog.match(/non[- ]monoton|invalid.*timestamp|dts.*>=/gi) || []).length
  };
}
