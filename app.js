const { GEMINI, SEEDANCE, estimateCost, imageTypes, videoType, localUploadLimit, models, referenceLimit } =
  await import('./models.mjs').catch((error) => {
    const setup = document.getElementById('setup');
    setup.textContent = 'The studio could not load its model settings. Restart Omni Video, then refresh this page.';
    setup.hidden = false;
    throw error;
  });

const byId = (id) => document.getElementById(id);
const form = byId('generation');
const modelSelect = byId('model');
const mode = byId('input-mode');
const referenceKind = byId('reference-kind');
const referenceUrl = byId('reference-url');
const referenceList = byId('reference-list');
const referenceError = byId('reference-error');
const generate = byId('generate');
const stage = byId('stage');
const stageMessage = byId('stage-message');
const status = byId('job-status');
const retry = byId('retry');
const preview = byId('preview');
const download = byId('download');
const cost = byId('cost');
const jobStorageKey = 'omni-video.last-job';
const formatStorageKey = 'omni-video.last-format';
const modelStorageKey = 'omni-video.model';
const references = [];
const workflows = {
  none: ['Text to video', 'Describe the subject, action, camera movement, and lighting.'],
  frames: ['Start / end frames', 'Describe how the camera and subjects should move between the frames.'],
  references: ['Reference to video', 'Describe the scene and say what to take from each reference.'],
  edit: ['Edit a video', 'Describe what to change in the source clip and what to keep.'],
  extend: ['Extend a video', 'Describe what happens next. Specify what should stay consistent from the source clip.'],
};
let jobId = localStorage.getItem(jobStorageKey);
let jobFormat = localStorage.getItem(formatStorageKey);
let previewUrl;

function fillOptions(select, choices, fallback) {
  const old = select.value;
  select.replaceChildren(...choices.map(([value, label]) => new Option(label, value)));
  select.value = choices.some(([value]) => String(value) === old) ? old : String(fallback ?? choices[0][0]);
  select.disabled = false;
}

function activeReferences() {
  return references.filter(({ kind }) => models[modelSelect.value].referenceTypes.includes(kind));
}

function usesReferences() {
  return ['references', 'edit', 'extend'].includes(mode.value);
}

function formatSettings() {
  const duration = byId('duration').value;
  return `${duration === '-1' ? 'Auto duration' : `${duration}s`} · ${byId('resolution').value} · ${byId('aspect-ratio').value}`;
}

function updateEstimate() {
  const hasVideo = usesReferences() && activeReferences().some(({ kind }) => kind === 'video');
  const amount = estimateCost(modelSelect.value, Number(byId('duration').value), byId('resolution').value, byId('aspect-ratio').value);
  byId('estimate').textContent = !hasVideo && !['edit', 'extend'].includes(mode.value) && Number.isFinite(amount)
    ? `~$${amount.toFixed(2)}` : 'Calculated by OpenRouter';
  byId('format').textContent = jobFormat || formatSettings();
}

function renderReferences() {
  const visible = activeReferences();
  referenceList.hidden = visible.length === 0;
  referenceList.replaceChildren(...visible.map((reference, index) => {
    const item = document.createElement('li');
    if (reference.thumbnail) {
      const image = document.createElement('img');
      image.alt = '';
      image.className = 'reference-thumb';
      image.src = reference.thumbnail;
      item.append(image);
    }
    const kind = document.createElement('span');
    kind.className = 'reference-kind';
    kind.textContent = `${index + 1}. ${reference.kind}`;
    const name = document.createElement('span');
    name.className = 'reference-name';
    name.textContent = reference.file?.name ?? reference.url;
    name.title = name.textContent;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${reference.kind} reference ${index + 1}`);
    remove.addEventListener('click', () => {
      if (reference.thumbnail) URL.revokeObjectURL(reference.thumbnail);
      references.splice(references.indexOf(reference), 1);
      renderReferences();
    });
    item.append(kind, name, remove);
    return item;
  }));
  updateEstimate();
}

function updateMode() {
  byId('references-fields').hidden = !usesReferences();
  const usesFrames = mode.value === 'frames';
  byId('frames-fields').hidden = !usesFrames;
  byId('prompt-optional').hidden = !usesFrames;
  byId('prompt').required = !usesFrames;
  byId('prompt').placeholder = workflows[mode.value][1];
  byId('frame-hint').textContent = modelSelect.value === SEEDANCE
    ? 'Start with an image. Add an end frame to guide the transition.' : 'Upload a start frame, an end frame, or both.';
  const needsVideo = ['edit', 'extend'].includes(mode.value);
  fillOptions(referenceKind, models[modelSelect.value].referenceTypes.map((kind) => [kind, kind[0].toUpperCase() + kind.slice(1)]));
  if (needsVideo) referenceKind.value = 'video';
  byId('reference-hint').textContent = needsVideo
    ? 'Upload the source MP4, or add a direct HTTPS link to the video.'
    : 'Paste a direct media link that OpenRouter can access.';
  display(referenceError, '');
  renderReferences();
}

function updateModel() {
  const model = models[modelSelect.value];
  const isSeedance = modelSelect.value === SEEDANCE;
  const choices = Object.keys(workflows);
  fillOptions(mode, choices.map((value) => [value, workflows[value][0]]));
  fillOptions(byId('duration'), model.durations.map((seconds) => [seconds, seconds === -1 ? 'Auto' : `${seconds} s`]), 5);
  fillOptions(byId('resolution'), model.resolutions.map((resolution) => [resolution, resolution]), '720p');
  fillOptions(byId('aspect-ratio'), model.ratios.map((ratio) => [ratio, ratio]));
  byId('model-info').textContent = isSeedance ? '4–30 seconds · image, video, and audio references' : '3–15 seconds · image and video references · up to 4K';
  localStorage.setItem(modelStorageKey, modelSelect.value);
  updateMode();
}

function display(element, message, isError = false) {
  element.textContent = message;
  element.hidden = !message;
  element.classList.toggle('error', isError);
}

async function request(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || `Request failed (HTTP ${response.status}).`);
  }
  return response;
}

function readUpload(file, kind = 'image') {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result;
      resolve(kind === 'video' ? `data:${videoType};base64,${url.slice(url.indexOf(',') + 1)}` : url);
    };
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

function addReferenceLink() {
  const value = referenceUrl.value.trim();
  const link = URL.parse(value);
  if (value.length > 8192 || link?.protocol !== 'https:' || link.username || link.password) {
    throw new Error('Enter a direct HTTPS link to a media file.');
  }
  if (references.length >= referenceLimit) throw new Error(`Use up to ${referenceLimit} references.`);
  references.push({ kind: referenceKind.value, url: link.href });
  referenceUrl.value = '';
  renderReferences();
}

function addLinkFromField() {
  display(referenceError, '');
  try {
    addReferenceLink();
  } catch (error) {
    display(referenceError, error.message, true);
  }
}

byId('add-reference').addEventListener('click', addLinkFromField);
referenceUrl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addLinkFromField();
  }
});

for (const [id, kind] of [['references', 'image'], ['video-references', 'video']]) {
  const input = byId(id);
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    display(referenceError, '');
    try {
      if (kind === 'image') validateImages(files);
      else if (files.some((file) => !file.size || (file.type !== videoType && (file.type || !/\.mp4$/i.test(file.name))))) {
        throw new Error('Select a nonempty MP4 video.');
      }
      validateUploadSize([...references.map(({ file }) => file).filter(Boolean), ...files]);
      if (references.length + files.length > referenceLimit) throw new Error(`Use up to ${referenceLimit} references.`);
      references.push(...files.map((file) => ({
        kind, file, thumbnail: kind === 'image' ? URL.createObjectURL(file) : undefined,
      })));
      renderReferences();
    } catch (error) {
      display(referenceError, error.message, true);
    }
  });
}

function validateImages(files) {
  if (files.some((file) => !imageTypes.includes(file.type) || !file.size)) {
    throw new Error('Select valid PNG, JPEG, or WebP images.');
  }
  validateUploadSize(files);
}

function validateUploadSize(files) {
  if (files.reduce((total, file) => total + file.size, 0) > localUploadLimit) {
    throw new Error('Use up to 10 MB of uploads per generation. For a larger clip, use a direct HTTPS link.');
  }
}

async function getSettings() {
  const prompt = byId('prompt').value.trim();
  if (usesReferences() && referenceUrl.value.trim()) addReferenceLink();
  const selected = usesReferences() ? activeReferences() : [];
  const first = mode.value === 'frames' ? byId('first-frame').files[0] : undefined;
  const last = mode.value === 'frames' ? byId('last-frame').files[0] : undefined;
  if (!prompt && !first && !last) throw new Error('Enter a prompt or upload a frame.');
  if (mode.value === 'references' && !selected.length) throw new Error('Add at least one reference.');
  if (['edit', 'extend'].includes(mode.value) && !selected.some(({ kind }) => kind === 'video')) {
    throw new Error('Upload the source MP4 or add a direct HTTPS video link.');
  }
  if (mode.value === 'frames' && !first && !last) throw new Error('Select a start or end frame.');
  if (last && !first && modelSelect.value === SEEDANCE) {
    throw new Error('Add a start frame to use the end frame with Seedance.');
  }
  validateImages([first, last].filter(Boolean));
  const seedInput = byId('seed').value;
  const seed = seedInput === '' ? undefined : Number(seedInput);
  if (seed !== undefined && !Number.isSafeInteger(seed)) throw new Error('Use a whole number for the seed.');
  const settings = {
    prompt, model: modelSelect.value, seed, workflow: mode.value,
    duration: Number(byId('duration').value),
    aspectRatio: byId('aspect-ratio').value,
    resolution: byId('resolution').value,
    audio: byId('audio').checked,
  };
  const [media, firstFrame, lastFrame] = await Promise.all([
    Promise.all(selected.map(async ({ kind, url, file }) => ({ kind, url: file ? await readUpload(file, kind) : url }))),
    first && readUpload(first), last && readUpload(last),
  ]);
  return { ...settings, references: media, firstFrame, lastFrame };
}

function setBusy(busy) {
  generate.disabled = busy;
  retry.hidden = true;
  stage.setAttribute('aria-busy', String(busy));
}

function resetPreview() {
  preview.hidden = true;
  preview.removeAttribute('src');
  preview.load();
  download.hidden = true;
  download.removeAttribute('href');
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = undefined;
  byId('screen').hidden = false;
}

async function watchJob(id, job) {
  resetPreview();
  display(cost, '');
  setBusy(true);
  const path = `/api/jobs/${encodeURIComponent(id)}`;
  try {
    stageMessage.textContent = 'Checking your video…';
    display(status, '');
    job ??= await (await request(path)).json();
    let pollFailures = 0;
    while (job.status === 'pending' || job.status === 'in_progress') {
      stageMessage.textContent = job.status === 'pending' ? 'Queued at OpenRouter…' : 'Generating video…';
      await new Promise((resolve) => setTimeout(resolve, 5000 * (pollFailures + 1)));
      try {
        job = await (await request(path)).json();
        pollFailures = 0;
        display(status, '');
      } catch (error) {
        if (++pollFailures >= 3) throw error;
        display(status, `Status check interrupted. Retrying… ${error.message}`, true);
      }
    }

    if (job.status === 'completed') {
      stageMessage.textContent = 'Loading MP4…';
      if (Number.isFinite(job.cost)) display(cost, `OpenRouter cost $${job.cost.toFixed(4)}`);
      const video = await (await request(`${path}/content`)).blob();
      if (!video.size) throw new Error('OpenRouter returned an empty video file.');
      previewUrl = URL.createObjectURL(video);
      preview.src = previewUrl;
      download.href = previewUrl;
      download.download = `omni-${id}.mp4`;
      preview.hidden = false;
      download.hidden = false;
      byId('screen').hidden = true;
      display(status, 'Video ready.');
      return;
    }
    if (!['failed', 'cancelled', 'expired'].includes(job.status)) throw new Error(`Unexpected job status: ${job.status}`);
    stageMessage.textContent = `Generation ${job.status}.`;
    display(status, job.error || `OpenRouter marked the job ${job.status}.`, true);
    localStorage.removeItem(jobStorageKey);
    localStorage.removeItem(formatStorageKey);
    jobFormat = undefined;
    updateEstimate();
  } catch (error) {
    stageMessage.textContent = 'Video unavailable.';
    display(status, `${error.message} Job ID ${id}`, true);
    retry.hidden = false;
  } finally {
    generate.disabled = false;
    stage.setAttribute('aria-busy', 'false');
  }
}

retry.addEventListener('click', () => watchJob(jobId));
preview.addEventListener('error', () => {
  if (previewUrl) display(status, 'The browser could not play the preview. You can still download the MP4.', true);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (generate.disabled) return;
  generate.disabled = true;
  retry.disabled = true;
  generate.textContent = 'Submitting…';
  display(byId('form-error'), '');
  try {
    const format = formatSettings();
    const settings = await getSettings();
    const response = await request('/api/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings),
    });
    const job = await response.json();
    jobId = job.id;
    jobFormat = format;
    localStorage.setItem(jobStorageKey, jobId);
    localStorage.setItem(formatStorageKey, jobFormat);
    updateEstimate();
    generate.textContent = 'Generate video';
    await watchJob(jobId, job);
  } catch (error) {
    display(byId('form-error'), error.message, true);
  } finally {
    generate.textContent = 'Generate video';
    generate.disabled = false;
    retry.disabled = false;
  }
});

async function initialize() {
  try {
    const { configured } = await (await request('/api/config')).json();
    if (!configured) {
      display(byId('setup'), 'Set OPENROUTER_API_KEY in the .env file next to server.mjs, then restart the app.');
      return;
    }
    document.querySelector('.connection').classList.add('ready');
    if (jobId) await watchJob(jobId);
    generate.disabled = false;
  } catch (error) {
    display(byId('setup'), error.message, true);
  }
}

fillOptions(modelSelect, Object.entries(models).map(([id, model]) => [id, `${model.name} · ${model.provider}`]));
const savedModel = localStorage.getItem(modelStorageKey);
modelSelect.value = Object.hasOwn(models, savedModel) ? savedModel : GEMINI;
modelSelect.addEventListener('change', updateModel);
mode.addEventListener('change', updateMode);
for (const id of ['duration', 'resolution', 'aspect-ratio']) byId(id).addEventListener('change', updateEstimate);
updateModel();
initialize();
