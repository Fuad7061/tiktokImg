export const MODELS = Object.freeze({
  gemini: {
    id: 'gemini',
    name: 'Nano Banana Pro',
    description: 'Google Gemini image model with strong prompt following and text rendering.',
    aliases: ['nano-banana-pro', 'nano-banana', 'nano_banana_pro', 'gemini-pro'],
    maxOutputs: 4,
    source: 'CreativeStudio/ImageGeneration/I2VImageGeneration'
  },
  'genai_seedream4.5': {
    id: 'genai_seedream4.5',
    name: 'Seedream 4.5',
    description: 'ByteDance Seedream 4.5 image model with expressive, high-detail results.',
    aliases: ['seedream-4.5', 'seedream4.5', 'seedream', 'seedream-4'],
    maxOutputs: 4,
    source: 'CreativeStudio/ImageGeneration/I2VImageGeneration'
  }
});

const index = new Map();
for (const model of Object.values(MODELS)) {
  index.set(model.id.toLowerCase(), model);
  for (const alias of model.aliases) index.set(alias.toLowerCase(), model);
}

export function resolveModel(value, fallback = 'gemini') {
  const key = String(value || '').trim().toLowerCase();
  return index.get(key) || MODELS[fallback] || MODELS.gemini;
}

export function modelOrDefault(value, defaultId) {
  const model = resolveModel(value || defaultId);
  return model;
}

export function listModels() {
  const created = 1735689600;
  return {
    object: 'list',
    data: Object.values(MODELS).map(model => ({
      id: model.id,
      object: 'model',
      created,
      owned_by: 'image-studio',
      name: model.name,
      description: model.description,
      max_images: model.maxOutputs,
      aliases: model.aliases
    }))
  };
}

export function modelInfo(model) {
  return {
    id: model.id,
    object: 'model',
    created: 1735689600,
    owned_by: 'image-studio',
    name: model.name,
    description: model.description,
    max_images: model.maxOutputs,
    aliases: model.aliases
  };
}
