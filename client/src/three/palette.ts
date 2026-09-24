// Reading colours out of pictures. Deliberately free of Three.js, so the rest
// of the app can use it without pulling WebGL into the first download.

export type RGB = [r: number, g: number, b: number]; // 0..1
export type EdgeColors = [top: RGB, right: RGB, bottom: RGB, left: RGB];

export function hexToRgb(hex: string): RGB {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const sampler = typeof document !== 'undefined' ? document.createElement('canvas') : null;

/**
 * Average colour of each edge band of an image or video frame.
 * Returns null when the pixels are not readable (a cross-origin video without CORS).
 */
export function edgeColors(source: CanvasImageSource, width: number, height: number): EdgeColors | null {
  if (!sampler || !width || !height) return null;
  const W = 24;
  const H = 14;
  sampler.width = W;
  sampler.height = H;
  const ctx = sampler.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  let data: Uint8ClampedArray;
  try {
    ctx.drawImage(source, 0, 0, W, H);
    data = ctx.getImageData(0, 0, W, H).data;
  } catch {
    return null;
  }
  const band = (x0: number, y0: number, x1: number, y1: number): RGB => {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * W + x) * 4;
        r += data[i]!;
        g += data[i + 1]!;
        b += data[i + 2]!;
        n++;
      }
    return tame([r / n / 255, g / n / 255, b / n / 255]);
  };
  return [band(0, 0, W, 3), band(W - 4, 0, W, H), band(0, H - 3, W, H), band(0, 0, 4, H)];
}

/** Lift saturation a little and cap lightness, so white scenes glow instead of glaring. */
function tame([r, g, b]: RGB): RGB {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return hslToRgb(h, Math.min(1, s * 1.25), Math.min(0.5, l * 0.9));
}

function hslToRgb(h: number, s: number, l: number): RGB {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)];
}

export function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
