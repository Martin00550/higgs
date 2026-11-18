import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GEMINI, imageTypes, models, referenceLimit } from './models.mjs';

try {
  process.loadEnvFile(new URL('.env', import.meta.url));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const key = process.env.OPENROUTER_API_KEY?.trim();
const host = '127.0.0.1';
const port = Number(process.env.OMNI_PORT || 8793);
const origin = `http://${host}:${port}`;
const videos = 'https://openrouter.ai/api/v1/videos';
const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/models.mjs', ['models.mjs', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
]);

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function errorMessage(error) {
  const message = typeof error === 'string' ? error : error?.message;
  return typeof message === 'string' ? message.slice(0, 2000) : undefined;
}

async function parseBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 15 * 1024 * 1024) {
      req.resume();
      throw new RequestError(413, 'The request is too large. Use smaller images or HTTPS links.');
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
  const isImageUpload = kind === 'image' && imageTypes.some((type) => url.startsWith(`data:${type};base64,`)) &&
    /^[A-Za-z0-9+/]+=*$/.test(url.slice(url.indexOf(',') + 1));
  if (!isHttps && !isImageUpload) {
    throw new RequestError(400, 'Use a direct HTTPS media link or upload a PNG, JPEG, or WebP image.');
  }
  const field = `${kind}_url`;
  return { type: field, [field]: { url } };
}

function generationPayload(body) {
  const { model = GEMINI, prompt, duration, resolution, aspectRatio, audio,
    references, firstFrame, lastFrame, seed } = body ?? {};
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
      if (!config.referenceTypes.includes(kind)) throw new RequestError(400, 'This model cannot use that reference type.');
      return mediaReference(kind, url);
    });
  }

  const frames = [];
  if (firstFrame) frames.push({ ...mediaReference('image', firstFrame), frame_type: 'first_frame' });
  if (lastFrame) frames.push({ ...mediaReference('image', lastFrame), frame_type: 'last_frame' });
  if (frames.length) payload.frame_images = frames;
  return payload;
}

async function openRouter(path = '', payload, signal = AbortSignal.timeout(45000)) {
  if (!key) throw new RequestError(503, 'Set OPENROUTER_API_KEY in the .env file and restart the app.');
  const headers = { Authorization: `Bearer ${key}` };
  if (payload) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(`${videos}${path}`, {
      method: payload ? 'POST' : 'GET', headers, signal,
      body: payload ? JSON.stringify(payload) : undefined,
    });
  } catch {
    if (payload) {
      throw new RequestError(502, 'OpenRouter did not confirm submission. Check your OpenRouter activity before submitting again.');
    }
    throw new RequestError(502, 'Could not reach OpenRouter.');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new RequestError(response.status, errorMessage(body?.error) || `OpenRouter returned HTTP ${response.status}.`);
  }
  return response;
}

async function jobStatus(response) {
  const job = await response.json().catch(() => null);
  if (typeof job?.id !== 'string' || typeof job.status !== 'string') {
    throw new RequestError(502, 'OpenRouter returned an invalid job response.');
  }
  return { id: job.id, status: job.status, cost: job.usage?.cost, error: errorMessage(job.error) };
}

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; media-src 'self' blob:; frame-ancestors 'none'");

  try {
    if (req.headers.host !== `${host}:${port}`) throw new RequestError(403, 'Open the app at its local address.');
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
      json(res, 200, { configured: Boolean(key) });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/jobs') {
      if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') {
        throw new RequestError(403, 'Submit from the local app.');
      }
      const payload = generationPayload(await parseBody(req));
      json(res, 202, await jobStatus(await openRouter('', payload)));
      return;
    }
    const match = /^\/api\/jobs\/([a-zA-Z0-9_-]+)(\/content)?$/.exec(pathname);
    if (req.method === 'GET' && match) {
      const [, id, content] = match;
      if (!content) {
        json(res, 200, await jobStatus(await openRouter(`/${id}`)));
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

server.listen(port, host, () => console.log(`Omni Video is running at ${origin}`));
