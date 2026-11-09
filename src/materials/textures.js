import * as THREE from 'three';
import { mulberry32 } from '../utils/math.js';

/**
 * Texturas procedurales.
 *
 * Todo lo que aquí se genera existiría normalmente como un .ktx2 de 2K
 * descargado de la red. Generarlo en el cliente cuesta unos pocos ms al
 * arrancar y ahorra megas de transferencia; la contrapartida es que no
 * puedes pintar detalle "artístico" a mano.
 *
 * La regla que sí se mantiene: los mapas de datos (normal, roughness,
 * metalness) van SIEMPRE en LinearSRGBColorSpace. Marcarlos como sRGB es el
 * error clásico que hace que un normal map se vea "plano y mal iluminado":
 * el navegador les aplica una curva gamma que corrompe los vectores.
 */

/* ── Ruido base ──────────────────────────────────────────────── */

/** Value noise con lattice envolvente, así que la textura tilea sin costura. */
function makeNoiseSampler(seed, lattice = 16) {
  const rng = mulberry32(seed);
  const grid = new Float32Array(lattice * lattice);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();

  const at = (x, y) => grid[(((y % lattice) + lattice) % lattice) * lattice + (((x % lattice) + lattice) % lattice)];
  const fade = (t) => t * t * (3 - 2 * t);

  return (u, v) => {
    const x = u * lattice;
    const y = v * lattice;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const tx = fade(x - xi);
    const ty = fade(y - yi);
    const a = at(xi, yi);
    const b = at(xi + 1, yi);
    const c = at(xi, yi + 1);
    const d = at(xi + 1, yi + 1);
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
}

/** Heightfield fBm: varias octavas de value noise sumadas. */
function fbmHeightfield(size, { seed = 1, octaves = 4, lattice = 12, gain = 0.5, lacunarity = 2 } = {}) {
  const h = new Float32Array(size * size);
  let amp = 1;
  let total = 0;
  let lat = lattice;

  for (let o = 0; o < octaves; o++) {
    const sampler = makeNoiseSampler(seed + o * 977, Math.max(2, Math.round(lat)));
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        h[y * size + x] += sampler(x / size, y / size) * amp;
      }
    }
    total += amp;
    amp *= gain;
    lat *= lacunarity;
  }

  for (let i = 0; i < h.length; i++) h[i] /= total;
  return h;
}

/* ── Conversión heightfield → normal map ─────────────────────── */

/**
 * Sobel sobre el heightfield. El muestreo envuelve en los bordes (`& (size-1)`
 * exige potencia de dos) para que el normal map tile igual de bien que el
 * heightfield del que sale.
 */
function heightToNormalTexture(height, size, strength = 2.0) {
  const data = new Uint8Array(size * size * 4);
  const w = size - 1;
  const at = (x, y) => height[(y & w) * size + (x & w)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;

      // n = normalize(-dx, -dy, 1)
      const len = Math.hypot(-dx, -dy, 1);
      const i = (y * size + x) * 4;
      data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      data[i + 2] = (1 / len) * 0.5 * 255 + 127.5;
      data[i + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.LinearSRGBColorSpace; // datos, no color
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/* ── Fábricas públicas ───────────────────────────────────────── */

const cache = new Map();
const memo = (key, fn) => {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
};

/**
 * Grano fino de aluminio anodizado. Frecuencia alta y amplitud baja: no se
 * "ve" como textura, pero rompe el reflejo especular y es la diferencia
 * entre una superficie que parece metal y una que parece plástico CGI.
 */
export const anodizedNormal = (size = 512) =>
  memo(`anod-${size}`, () => {
    const h = fbmHeightfield(size, { seed: 7, octaves: 5, lattice: 48, gain: 0.55 });
    return heightToNormalTexture(h, size, 1.4);
  });

/** Cuero técnico / mesh del upper: celdas más grandes y marcadas. */
export const meshNormal = (size = 512) =>
  memo(`mesh-${size}`, () => {
    const h = fbmHeightfield(size, { seed: 31, octaves: 3, lattice: 22, gain: 0.45 });
    // Endurecemos el contraste para que las celdas tengan borde.
    for (let i = 0; i < h.length; i++) h[i] = Math.pow(h[i], 1.7);
    return heightToNormalTexture(h, size, 3.2);
  });

/** Variación de rugosidad: manchas mates y brillos, nunca un valor plano. */
export const roughnessBreakup = (size = 256) =>
  memo(`rough-${size}`, () => {
    const h = fbmHeightfield(size, { seed: 91, octaves: 4, lattice: 9 });
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < h.length; i++) {
      const v = Math.round(120 + h[i] * 135);
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
      data[i * 4 + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  });

/**
 * Logotipo micro-grabado. Dibujamos la marca en un canvas, la desenfocamos
 * ligeramente y la tratamos como heightfield: el resultado es un relieve de
 * décimas de milímetro que sólo se revela cuando la luz lo roza. Exactamente
 * lo que hace un grabado láser real sobre metal.
 */
export const etchedLogoNormal = (text = 'NOCTURNE', size = 512) =>
  memo(`etch-${text}-${size}`, () => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d', { willReadFrequently: true });

    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, size, size);

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${size * 0.13}px Inter, Segoe UI, sans-serif`;
    ctx.letterSpacing = `${size * 0.02}px`;
    // Difuminar antes de derivar evita que el Sobel produzca un borde de
    // un solo téxel, que es lo que da ese aspecto de "calcomanía".
    ctx.filter = `blur(${size / 256}px)`;
    ctx.fillText(text, size / 2, size / 2);
    ctx.filter = 'none';

    const img = ctx.getImageData(0, 0, size, size).data;
    const h = new Float32Array(size * size);
    for (let i = 0; i < h.length; i++) h[i] = img[i * 4] / 255;

    const tex = heightToNormalTexture(h, size, 2.4);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  });

/**
 * Pila de normal maps para instancias.
 *
 * El blueprint pide que InstancedMesh renderice N copias «con diferentes
 * texturas». Un atlas 2×2 sería lo obvio, pero deja costuras: en el borde
 * de cada cuadrante las derivadas de UV se disparan y el hardware elige un
 * nivel de mipmap equivocado, dibujando una línea oscura.
 *
 * `DataArrayTexture` (WebGL2, `sampler2DArray`) resuelve eso de raíz: cada
 * capa es una textura independiente con sus propios mipmaps, y el shader
 * elige capa con un atributo por instancia. Una sola unidad de textura, una
 * sola draw call, N materiales distintos.
 */
export const instanceNormalArray = (layers = 4, size = 256) =>
  memo(`normarray-${layers}-${size}`, () => {
    const perLayer = size * size * 4;
    const data = new Uint8Array(perLayer * layers);

    for (let l = 0; l < layers; l++) {
      // Cada capa con su propia semilla y frecuencia: grano fino, celdas
      // medias, trama gruesa… variaciones legibles a tamaño de miniatura.
      const h = fbmHeightfield(size, {
        seed: 101 + l * 613,
        octaves: 4,
        lattice: [40, 18, 26, 10][l % 4],
        gain: 0.5 + (l % 3) * 0.08,
      });
      const strength = [1.2, 2.6, 1.8, 3.4][l % 4];

      const w = size - 1;
      const at = (x, y) => h[(y & w) * size + (x & w)];
      const base = l * perLayer;

      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
          const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
          const len = Math.hypot(-dx, -dy, 1);
          const i = base + (y * size + x) * 4;
          data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
          data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
          data[i + 2] = (1 / len) * 0.5 * 255 + 127.5;
          data[i + 3] = 255;
        }
      }
    }

    const tex = new THREE.DataArrayTexture(data, size, size, layers);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.UnsignedByteType;
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  });

/** Libera todas las texturas cacheadas (al desmontar la app). */
export function disposeTextureCache() {
  for (const tex of cache.values()) tex.dispose?.();
  cache.clear();
}
