import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GEMINI, imageTypes, models, referenceLimit, videoType } from './models.mjs';

try {
  process.loadEnvFile(new URL('.env', import.meta.url));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const key = process.env.OPENROUTER_API_KEY?.trim();
const host = '127.0.0.1';
const port = Number(process.env.OMNI_PORT || 8793);
let origin;
const videos = 'https://openrouter.ai/api/v1/videos';
const submissions = new Map();
const submissionIdPattern = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const submissionIdRegex = new RegExp(`^${submissionIdPattern}$`);
const submissionPath = new RegExp(`^/api/submissions/(${submissionIdPattern})$`);
const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/models.mjs', ['models.mjs', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
]);

class RequestError extends Error {
  constructor(status, message, uncertain = false) {
    super(message);
    this.status = status;
    this.uncertain = uncertain;
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function errorMessage(value, depth = 0) {
  if (!value || depth > 5) return undefined;
  if (typeof value === 'string') {
    const message = value.trim();
    if (message.startsWith('{') || message.startsWith('[')) {
      try { return errorMessage(JSON.parse(message), depth + 1); } catch { return undefined; }
    }
    return message.replace(/data:[\w.+/-]+;base64,[\w+/=]+/gi, '[media]')
      .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]')
      .replace(/sk-or-[\w-]+/g, '[key]').slice(0, 1500) || undefined;
  }
  if (typeof value !== 'object') return undefined;
  const fields = Array.isArray(value) ? value : [value.metadata?.raw, value.error, value.detail, value.message, value.msg];
  const messages = new Set(fields.map(field => errorMessage(field, depth + 1)).filter(Boolean));
  return [...messages].join(' · ').slice(0, 2000) || undefined;
}

async function parseBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 15 * 1024 * 1024) {
      req.resume();
      throw new RequestError(413, 'The request is too large. Use smaller files or direct HTTPS links.');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks));
  } catch {
    throw new RequestError(400, 'Invalid request.');
  }
}

function mediaReference(kind, url) {
  if (typeof url !== 'string') throw new RequestError(400, 'Add a valid reference.');
  const https = url.length <= 8192 ? URL.parse(url) : null;
  const isHttps = https?.protocol === 'https:' && !https.username && !https.password;
  const uploadTypes = kind === 'image' ? imageTypes : kind === 'video' ? [videoType] : [];
  const isUpload = uploadTypes.some((type) => url.startsWith(`data:${type};base64,`)) &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(url.slice(url.indexOf(',') + 1));
  if (!isHttps && !isUpload) {
    throw new RequestError(400, 'Use a direct HTTPS media link or upload a supported image or MP4.');
  }
  const field = `${kind}_url`;
  return { type: field, [field]: { url } };
}

function generationPayload(body) {
  const { model = GEMINI, prompt, duration, resolution, aspectRatio, audio,
    references, firstFrame, lastFrame, seed, workflow } = body ?? {};
  if (!Object.hasOwn(models, model)) throw new RequestError(400, 'Choose a supported model.');
  const config = models[model];
  if (typeof prompt !== 'string' || prompt.length > 10000 || (!prompt.trim() && !firstFrame && !lastFrame)) {
    throw new RequestError(400, 'Enter a prompt of up to 10,000 characters or upload a frame.');
  }
  if (!config.durations.includes(duration) || !config.resolutions.includes(resolution) ||
      !config.ratios.includes(aspectRatio) || typeof audio !== 'boolean') {
    throw new RequestError(400, 'Check the video settings.');
  }
  if (!Array.isArray(references) || (references.length && (firstFrame || lastFrame))) {
    throw new RequestError(400, 'Choose references or start/end frames.');
  }
  if (references.length > referenceLimit) throw new RequestError(400, `Use up to ${referenceLimit} references.`);
  if (lastFrame && !firstFrame && model !== GEMINI) {
    throw new RequestError(400, 'Seedance needs a start frame when you set an end frame.');
  }
  if (seed !== undefined && !Number.isSafeInteger(seed)) {
    throw new RequestError(400, 'Use a whole number for the seed.');
  }

  const payload = {
    model,
    duration, resolution, aspect_ratio: aspectRatio, generate_audio: audio,
  };
  if (prompt.trim()) payload.prompt = prompt.trim();
  if (seed !== undefined) payload.seed = seed;
  if (references.length) {
    payload.input_references = references.map((reference) => {
      const { kind, url } = typeof reference === 'string' ? { kind: 'image', url: reference } : reference ?? {};
      if (!config.referenceTypes.includes(kind)) {
        throw new RequestError(400, `${config.name} accepts these reference types: ${config.referenceTypes.join(', ')}.`);
      }
      return mediaReference(kind, url);
    });
  }

  const frames = [];
  if (firstFrame) frames.push({ ...mediaReference('image', firstFrame), frame_type: 'first_frame' });
  if (lastFrame) frames.push({ ...mediaReference('image', lastFrame), frame_type: 'last_frame' });
  if (frames.length) payload.frame_images = frames;

  const hasVideo = payload.input_references?.some(({ type }) => type === 'video_url');
  const sourceWorkflow = workflow === 'edit' || workflow === 'extend';
  if (sourceWorkflow && !hasVideo) throw new RequestError(400, 'Add a source video to edit or extend.');
  if (model === GEMINI && hasVideo) {
    const task = sourceWorkflow ? workflow : 'reference_to_video';
    payload.provider = { options: { 'google-ai-studio': { task } } };
  }
  return payload;
}

async function openRouter(path = '', payload, signal = AbortSignal.timeout(45000)) {
  if (!key) throw new RequestError(503, 'Set OPENROUTER_API_KEY in the .env file and restart the app.');
  const headers = { Authorization: `Bearer ${key}`, 'X-Title': 'Omni Video Studio' };
  if (payload) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(`${videos}${path}`, {
      method: payload ? 'POST' : 'GET', headers, signal,
      body: payload ? JSON.stringify(payload) : undefined,
    });
  } catch (error) {
    const rawCode = error.cause?.code;
    const code = typeof rawCode === 'string' && /^[A-Z0-9_]+$/.test(rawCode) ? rawCode : undefined;
    const timedOut = signal.aborted || error.name === 'TimeoutError';
    const detail = timedOut ? 'OpenRouter timed out waiting for a response.'
      : `The connection to OpenRouter failed${code ? ` (${code})` : ''}.`;
    const beforeConnect = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
    throw new RequestError(timedOut ? 504 : 502, detail, Boolean(payload) && !beforeConnect);
  }
  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    let body;
    try { body = JSON.parse(raw); } catch {}
    const message = errorMessage(body) || (!body && !raw.trimStart().startsWith('<') && errorMessage(raw)) ||
      `OpenRouter returned HTTP ${response.status}.`;
    throw new RequestError(response.status, message, Boolean(payload) && [500, 502, 503, 504].includes(response.status));
  }
  return response;
}

async function submitVideo(payload) {
  const upload = payload.input_references?.some(({ video_url }) => video_url?.url.startsWith('data:'));
  const timeout = AbortSignal.timeout(upload ? 180000 : 90000);
  const response = await openRouter('', payload, timeout);
  const job = await response.json().catch(() => null);
  if (typeof job?.id !== 'string' || !/^[\w-]+$/.test(job.id)) {
    throw new RequestError(502, errorMessage(job) || 'OpenRouter returned no usable video job ID.', true);
  }
  const polling = typeof job.polling_url === 'string' ? URL.parse(job.polling_url, videos) : null;
  const pollMatch = polling?.origin === new URL(videos).origin &&
    /^\/api\/v1\/videos\/([\w-]+)$/.exec(polling.pathname);
  return { ...jobDetails(job, job.id), pollId: pollMatch?.[1] || job.id };
}

async function completeSubmission(id, payload) {
  try {
    submissions.set(id, { status: 'accepted', job: await submitVideo(payload) });
  } catch (error) {
    submissions.set(id, {
      status: error.uncertain ? 'unconfirmed' : 'failed',
      error: error.status ? error.message : 'The local server could not submit the video.',
    });
  } finally {
    setTimeout(() => submissions.delete(id), 15 * 60 * 1000).unref();
  }
}

function jobDetails(job, id) {
  const status = typeof job.status === 'string' ? job.status.trim().toLowerCase() : undefined;
  return { id, status: status || (job.error ? 'failed' : 'pending'), cost: job.usage?.cost,
    generationId: typeof job.generation_id === 'string' ? job.generation_id : undefined,
    error: errorMessage(job) };
}

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; frame-ancestors 'none'");

  try {
    if (req.headers.host !== new URL(origin).host) throw new RequestError(403, 'Open the app at its local address.');
    const { pathname } = new URL(req.url, origin);
    const asset = assets.get(pathname);
    if (req.method === 'GET' && asset) {
      const [name, type] = asset;
      const data = await readFile(new URL(name, import.meta.url));
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
      res.end(data);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/config') {
      const referenceTypes = Object.fromEntries(Object.entries(models).map(([id, model]) => [id, model.referenceTypes]));
      json(res, 200, { configured: Boolean(key), referenceTypes, trackedSubmissions: true });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/jobs') {
      if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') {
        throw new RequestError(403, 'Submit from the local app.');
      }
      const body = await parseBody(req);
      const id = body?.submissionId;
      if (id !== undefined && (typeof id !== 'string' || !submissionIdRegex.test(id))) {
        throw new RequestError(400, 'Invalid submission ID.');
      }
      if (id && submissions.has(id)) {
        json(res, 202, submissions.get(id));
        return;
      }
      const payload = generationPayload(body);
      if (id) {
        const entry = { status: 'submitting' };
        submissions.set(id, entry);
        void completeSubmission(id, payload);
        json(res, 202, entry);
        return;
      }
      json(res, 202, await submitVideo(payload));
      return;
    }
    const receipt = submissionPath.exec(pathname);
    if (req.method === 'GET' && receipt) {
      const entry = submissions.get(receipt[1]);
      if (!entry) throw new RequestError(404, 'The local submission record is no longer available.');
      json(res, 200, entry);
      return;
    }
    const match = /^\/api\/jobs\/([a-zA-Z0-9_-]+)(\/content)?$/.exec(pathname);
    if (req.method === 'GET' && match) {
      const [, id, content] = match;
      if (!content) {
        const upstream = await openRouter(`/${id}`);
        const job = await upstream.json().catch(() => null);
        if (typeof job?.status !== 'string' || !job.status.trim()) {
          throw new RequestError(502, errorMessage(job) || 'OpenRouter returned an invalid job response.');
        }
        json(res, 200, jobDetails(job, id));
        return;
      }
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60 * 1000)]);
      const upstream = await openRouter(`/${id}/content`, undefined, signal);
      const type = upstream.headers.get('content-type')?.split(';')[0];
      if (!upstream.body || !['video/mp4', 'application/octet-stream'].includes(type)) {
        await upstream.body?.cancel();
        throw new RequestError(502, 'OpenRouter did not return an MP4.');
      }
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      await pipeline(Readable.fromWeb(upstream.body), res);
      return;
    }
    throw new RequestError(404, 'Page not found.');
  } catch (error) {
    if (!res.headersSent && !res.destroyed) {
      json(res, error.status || 500, { error: error.status ? error.message : 'The local server encountered an error.' });
    }
  }
});

let usingFallbackPort = false;
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE' && !usingFallbackPort) {
    usingFallbackPort = true;
    console.log(`Port ${port} is busy. Starting Omni Video on a free port.`);
    server.listen(0, host);
    return;
  }
  console.error(`Could not start Omni Video: ${error.message}`);
  process.exitCode = 1;
});

server.once('listening', () => {
  origin = `http://${host}:${server.address().port}`;
  console.log(`Omni Video is running at ${origin}`);
  if (process.platform === 'win32' && process.argv.includes('--open')) {
    const browser = spawn('explorer.exe', [origin], { detached: true, stdio: 'ignore', windowsHide: true });
    browser.on('error', () => console.log(`Open ${origin} in your browser.`));
    browser.unref();
  }
});

if (Number.isInteger(port) && port >= 0 && port <= 65535) {
  server.listen(port, host);
} else {
  console.error('OMNI_PORT must be a whole number from 0 to 65535.');
  process.exitCode = 1;
}
