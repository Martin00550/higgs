export const GEMINI = 'google/gemini-omni-1.2-flash';
export const SEEDANCE = 'bytedance/seedance-2.5';

export const models = {
  [GEMINI]: {
    name: 'Gemini Omni 1.2 Flash',
    provider: 'Google',
    durations: Array.from({ length: 13 }, (_, index) => index + 3),
    resolutions: ['360p', '720p', '1080p', '4K'],
    ratios: ['16:9', '9:16'],
    referenceTypes: ['image'],
  },
  [SEEDANCE]: {
    name: 'Seedance 2.5',
    provider: 'ByteDance',
    durations: [-1, ...Array.from({ length: 27 }, (_, index) => index + 4)],
    resolutions: ['480p', '720p', '1080p'],
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    referenceTypes: ['image', 'video', 'audio'],
  },
};

export const imageTypes = ['image/jpeg', 'image/png', 'image/webp'];
export const localUploadLimit = 10 * 1024 * 1024;
export const referenceLimit = 50;

const geminiRates = { '360p': 0.02317, '720p': 0.0695, '1080p': 0.1043, '4K': 0.2085 };
const seedanceSizes = {
  '480p': [[854, 480], [480, 854], [640, 640], [752, 560], [560, 752], [992, 432]],
  '720p': [[1280, 720], [720, 1280], [960, 960], [1112, 834], [834, 1112], [1470, 630]],
};

export function estimateCost(model, duration, resolution, ratio) {
  if (duration < 1) return undefined;
  if (model === GEMINI) return geminiRates[resolution] * duration;
  const size = seedanceSizes[resolution]?.[models[SEEDANCE].ratios.indexOf(ratio)];
  if (!size) return undefined;
  const [width, height] = size;
  return (width * height * 24 * duration / 1024) * 0.0000107;
}
