export const MODELS = Object.freeze({
  'nano-banana-pro': {
    id: 'nano-banana-pro',
    name: 'Nano Banana Pro',
    description: 'Strong prompt following and text rendering.',
    // Value TikTok expects in the generation request — do not expose publicly.
    providerModel: 'gemini',
    aliases: ['gemini', 'nano-banana', 'nano_banana_pro', 'gemini-pro'],
    maxOutputs: 4,
    source: 'CreativeStudio/ImageGeneration/I2VImageGeneration'
  },
  'seedream4.5': {
    id: 'seedream4.5',
    name: 'Seedream 4.5',
    description: 'Expressive, high-detail results.',
    providerModel: 'genai_seedream4.5',
    aliases: ['genai_seedream4.5', 'seedream-4.5', 'seedream', 'seedream-4'],
    maxOutputs: 4,
    source: 'CreativeStudio/ImageGeneration/I2VImageGeneration'
  }
});

const index = new Map();
for (const model of Object.values(MODELS)) {
  index.set(model.id.toLowerCase(), model);
  for (const alias of model.aliases) index.set(alias.toLowerCase(), model);
}

export function resolveModel(value, fallback = 'nano-banana-pro') {
  const key = String(value || '').trim().toLowerCase();
  return index.get(key) || MODELS[fallback] || MODELS['nano-banana-pro'];
}

export function modelOrDefault(value, defaultId) {
  return resolveModel(value || defaultId);
}

function publicModel(model) {
  return {
    id: model.id,
    object: 'model',
    created: 1735689600,
    owned_by: 'image-studio',
    name: model.name,
    description: model.description,
    max_images: model.maxOutputs
  };
}

export function listModels() {
  return {
    object: 'list',
    data: Object.values(MODELS).map(publicModel)
  };
}

export function modelInfo(model) {
  return publicModel(model);
}
