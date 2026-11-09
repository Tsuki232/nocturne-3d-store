/**
 * Paleta única de la experiencia. Un solo sitio donde tocar el color.
 *
 * La dirección de arte se sostiene sobre un contraste extremo: un fondo casi
 * negro y dos acentos saturados que sólo aparecen como LUZ (emissive, rim
 * lights, bordes), nunca como color base de una superficie grande. Ese es el
 * motivo de que la escena lea como neón y no como un póster morado.
 */

export const PALETTE = {
  obsidian: 0x0a0a0c,
  violetDeep: 0x1a0033,
  violet: 0x8a2be2,
  cyan: 0x00ffff,

  chrome: 0xf2f4f8,
  matte: 0x0e0e12,
  bone: 0xe8e8ef,
  dim: 0x6a6a7a,
};

/** Colorways del configurador. */
export const COLORWAYS = [
  {
    id: 'cyan',
    name: 'Volta Cian',
    price: 289,
    accent: 0x00ffff,
    upper: 0x14161c,
    sole: 0x0d0d10,
    plate: 0xf2f4f8,
    plateMetal: 1.0,
    plateRough: 0.04,
  },
  {
    id: 'violet',
    name: 'Volta Violeta',
    price: 289,
    accent: 0x8a2be2,
    upper: 0x17121f,
    sole: 0x100c16,
    plate: 0xd8d2e6,
    plateMetal: 1.0,
    plateRough: 0.08,
  },
  {
    id: 'chrome',
    name: 'Volta Lux',
    price: 349,
    accent: 0xbfe9ff,
    upper: 0x2a2d34,
    sole: 0x1a1c22,
    plate: 0xffffff,
    plateMetal: 1.0,
    plateRough: 0.015,
  },
  {
    id: 'mono',
    name: 'Volta Mono',
    price: 259,
    accent: 0x8a8fa0,
    upper: 0x0b0b0e,
    sole: 0x08080a,
    plate: 0x1c1e24,
    plateMetal: 0.35,
    plateRough: 0.72,
  },
];

export const getColorway = (id) => COLORWAYS.find((c) => c.id === id) || COLORWAYS[0];
