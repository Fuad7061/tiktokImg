import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32Hex(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff];
  return ((crc ^ -1) >>> 0).toString(16).padStart(8, '0');
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(parseInt(crc32Hex(body), 16), 0);
  return Buffer.concat([length, body, crc]);
}

export function makeSolidPng(width, height, color = [247, 247, 248]) {
  const [r, g, b] = color;
  const rowLength = 1 + width * 3;
  const raw = Buffer.alloc(rowLength * height);
  for (let y = 0; y < height; y += 1) {
    const offset = y * rowLength;
    raw[offset] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = offset + 1 + x * 3;
      raw[pixel] = r;
      raw[pixel + 1] = g;
      raw[pixel + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const RATIOS = {
  '1:1': [1024, 1024],
  '9:16': [864, 1536],
  '16:9': [1536, 864],
  '4:3': [1152, 864],
  '3:4': [864, 1152],
  '3:2': [1296, 864],
  '2:3': [864, 1296],
  '21:9': [1680, 720],
  '5:4': [1080, 864],
  '4:5': [864, 1080]
};

export function ratioDimensions(ratio) {
  return RATIOS[ratio] || RATIOS['1:1'];
}

export function nearestRatio(width, height) {
  const target = width / height;
  let best = '1:1';
  let distance = Infinity;
  for (const [label, [w, h]] of Object.entries(RATIOS)) {
    const delta = Math.abs(w / h - target);
    if (delta < distance) {
      distance = delta;
      best = label;
    }
  }
  return best;
}

export function resolveDimensions({ size = '', ratio = '' } = {}) {
  const sizeMatch = String(size || '').match(/^\s*(\d{2,4})\s*[x×]\s*(\d{2,4})\s*$/i);
  if (sizeMatch) {
    const width = Math.max(256, Math.min(2048, Math.trunc(Number(sizeMatch[1]) / 2) * 2));
    const height = Math.max(256, Math.min(2048, Math.trunc(Number(sizeMatch[2]) / 2) * 2));
    return { width, height, ratio: nearestRatio(width, height), label: `${width}x${height}` };
  }
  const wanted = String(ratio || '').trim();
  const [width, height] = ratioDimensions(wanted);
  return { width, height, ratio: RATIOS[wanted] ? wanted : '1:1', label: `${width}x${height}` };
}

const canvasCache = new Map();

export function canvasFor(dimensions) {
  const key = `${dimensions.width}x${dimensions.height}`;
  if (canvasCache.has(key)) return canvasCache.get(key);
  const buffer = makeSolidPng(dimensions.width, dimensions.height);
  if (canvasCache.size > 16) canvasCache.clear();
  canvasCache.set(key, buffer);
  return buffer;
}
