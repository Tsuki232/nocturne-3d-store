import * as THREE from 'three';

/**
 * TextTexture — tipografía dentro del canvas WebGL.
 *
 * El blueprint es explícito: la interfaz no va SOBRE el 3D, es parte de él.
 * Eso descarta superponer HTML, y deja dos caminos para el texto:
 *
 *   a) Fuentes SDF (troika, MSDF). Nítidas a cualquier escala, pero añaden
 *      una dependencia y un pipeline de atlas.
 *   b) Canvas 2D → CanvasTexture. Es lo que hacemos aquí. Un panel de UI se
 *      mira desde una distancia razonablemente fija, así que basta con
 *      rasterizar a resolución suficiente una sola vez.
 *
 * Lo que sí hay que hacer bien es el DPI: rasterizar a 1× y dejar que la GPU
 * lo estire produce ese texto blando que delata al 3D barato.
 */

const FONT_STACK = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

export class PanelCanvas {
  /**
   * @param {number} aspect  ancho/alto del panel en unidades de mundo
   * @param {number} height  resolución vertical base en píxeles
   */
  constructor(aspect, height = 768, dpi = 1) {
    this.dpi = dpi;
    this.h = Math.round(height * dpi);
    this.w = Math.round(height * aspect * dpi);

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d');
    // Trabajamos en un espacio virtual de 1000 unidades de alto: así las
    // medidas del layout no cambian al tocar la resolución.
    this.unit = this.h / 1000;
    this.ctx.scale(this.unit, this.unit);
    this.vw = this.w / this.unit;
    this.vh = 1000;
  }

  clear() {
    this.ctx.clearRect(0, 0, this.vw, this.vh);
    return this;
  }

  /** @param {'left'|'center'|'right'} align */
  text(str, { x = 60, y = 100, size = 40, weight = 400, color = '#ffffff', align = 'left', tracking = 0, alpha = 1, transform } = {}) {
    const c = this.ctx;
    c.save();
    c.globalAlpha = alpha;
    c.fillStyle = color;
    c.textAlign = align;
    c.textBaseline = 'alphabetic';
    c.font = `${weight} ${size}px ${FONT_STACK}`;
    if (tracking) c.letterSpacing = `${tracking}px`;
    c.fillText(transform === 'upper' ? String(str).toUpperCase() : String(str), x, y);
    c.restore();
    return this;
  }

  /** Texto con salto de línea automático. Devuelve la Y final. */
  paragraph(str, { x = 60, y = 100, size = 30, lineHeight = 1.55, maxWidth = 500, color = 'rgba(232,232,239,0.72)', weight = 400 } = {}) {
    const c = this.ctx;
    c.save();
    c.fillStyle = color;
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
    c.font = `${weight} ${size}px ${FONT_STACK}`;

    const words = String(str).split(/\s+/);
    let line = '';
    let cy = y;
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (c.measureText(test).width > maxWidth && line) {
        c.fillText(line, x, cy);
        line = word;
        cy += size * lineHeight;
      } else {
        line = test;
      }
    }
    if (line) {
      c.fillText(line, x, cy);
      cy += size * lineHeight;
    }
    c.restore();
    return cy;
  }

  rule({ x = 60, y = 100, width = 480, color = 'rgba(255,255,255,0.14)', thickness = 1 } = {}) {
    const c = this.ctx;
    c.save();
    c.fillStyle = color;
    c.fillRect(x, y, width, thickness);
    c.restore();
    return this;
  }

  /** Rectángulo redondeado, relleno y/o contorno. */
  roundRect(x, y, w, h, r, { fill, stroke, lineWidth = 2, shadow } = {}) {
    const c = this.ctx;
    c.save();
    c.beginPath();
    c.roundRect(x, y, w, h, r);
    if (shadow) {
      c.shadowColor = shadow.color;
      c.shadowBlur = shadow.blur;
    }
    if (fill) {
      c.fillStyle = fill;
      c.fill();
    }
    c.shadowBlur = 0;
    if (stroke) {
      c.strokeStyle = stroke;
      c.lineWidth = lineWidth;
      c.stroke();
    }
    c.restore();
    return this;
  }

  /** Pastilla de etiqueta (categoría, estado, badge). */
  pill(str, { x = 60, y = 60, size = 22, color = '#00ffff', bg = 'rgba(0,255,255,0.10)' } = {}) {
    const c = this.ctx;
    c.save();
    c.font = `600 ${size}px ${FONT_STACK}`;
    c.letterSpacing = `${size * 0.18}px`;
    const label = String(str).toUpperCase();
    const w = c.measureText(label).width + size * 1.8;
    const h = size * 2.1;
    c.restore();

    this.roundRect(x, y, w, h, h / 2, { fill: bg, stroke: color.replace(')', ',0.35)').replace('rgb', 'rgba'), lineWidth: 1.5 });
    this.text(label, { x: x + size * 0.9, y: y + h / 2 + size * 0.36, size, weight: 600, color, tracking: size * 0.18 });
    return { width: w, height: h };
  }

  /** Gradiente lineal listo para usar como fill. */
  gradient(x0, y0, x1, y1, stops) {
    const g = this.ctx.createLinearGradient(x0, y0, x1, y1);
    for (const [offset, color] of stops) g.addColorStop(offset, color);
    return g;
  }

  /**
   * Convierte a textura.
   *
   * colorSpace = SRGB es obligatorio: en WebGL2 hace que three suba el
   * búfer como SRGB8_ALPHA8, y entonces es el propio hardware quien
   * linealiza al muestrear. Sin eso, el texto sale lavado en una cadena de
   * post-procesado que trabaja en lineal.
   */
  toTexture({ anisotropy = 4 } = {}) {
    const tex = new THREE.CanvasTexture(this.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = anisotropy;
    tex.needsUpdate = true;
    return tex;
  }

  /** Redibuja sobre una textura ya existente (evita reasignar uniforms). */
  updateTexture(tex) {
    tex.needsUpdate = true;
    return tex;
  }
}

/** Atajo: convierte un color hex de three en `rgba(...)` para canvas 2D. */
export function cssColor(hex, alpha = 1) {
  const c = new THREE.Color(hex);
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}
