/** Utilidades numéricas compartidas. Nada aquí depende de Three.js. */

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const lerp = (a, b, t) => a + (b - a) * t;

export const inverseLerp = (a, b, v) => (b - a === 0 ? 0 : (v - a) / (b - a));

export const smoothstep = (a, b, v) => {
  const t = clamp(inverseLerp(a, b, v), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Mapea v del rango [a1,b1] al rango [a2,b2], sin recortar. */
export const remap = (v, a1, b1, a2, b2) => a2 + ((v - a1) / (b1 - a1)) * (b2 - a2);

/**
 * Amortiguación exponencial independiente del framerate.
 *
 * El clásico `x += (target - x) * 0.1` cambia de comportamiento según los
 * FPS: a 120 fps converge el doble de rápido que a 60. Esta versión usa dt,
 * así que el "peso" del movimiento se siente igual en cualquier monitor.
 *
 * @param {number} lambda  velocidad de convergencia (mayor = más rígido)
 */
export const damp = (current, target, lambda, dt) =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));

/** Igual que damp pero para objetos con .x/.y/.z (Vector2/Vector3). */
export const dampVec = (current, target, lambda, dt) => {
  const t = 1 - Math.exp(-lambda * dt);
  current.x = lerp(current.x, target.x, t);
  current.y = lerp(current.y, target.y, t);
  if ('z' in current && 'z' in target) current.z = lerp(current.z, target.z, t);
  return current;
};

/** Ruido pseudoaleatorio determinista: misma semilla, misma escena. */
export const mulberry32 = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Punto en una esfera con distribución uniforme (no sesgada a los polos). */
export const randomInSphere = (rng, radius, out) => {
  const u = rng();
  const v = rng();
  const theta = u * Math.PI * 2;
  const phi = Math.acos(2 * v - 1);
  const r = Math.cbrt(rng()) * radius;
  const s = Math.sin(phi);
  out.x = r * s * Math.cos(theta);
  out.y = r * s * Math.sin(theta);
  out.z = r * Math.cos(phi);
  return out;
};
