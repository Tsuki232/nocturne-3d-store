import { clamp, damp } from '../utils/math.js';

/**
 * Scroll — scroll nativo con amortiguación.
 *
 * No secuestramos el evento wheel. El navegador sigue gestionando la
 * inercia del trackpad, el arrastre táctil, las teclas y la barra lateral;
 * nosotros solo leemos scrollY y lo suavizamos con un damper por dt. Así la
 * página sigue siendo navegable con teclado y no rompemos el scroll de
 * accesibilidad, que es el precio habitual de los "smooth scroll" caseros.
 */
export class Scroll {
  /**
   * @param {HTMLElement} proxy    div que da altura real al documento
   * @param {number} sections      nº de pantallas (altura = sections * 100vh)
   */
  constructor(proxy, sections = 5) {
    this.proxy = proxy;
    this.sections = sections;

    this.raw = 0;        // progreso crudo 0..1
    this.smooth = 0;     // progreso amortiguado 0..1
    this.velocity = 0;   // delta por segundo, útil para efectos de motion
    this.lambda = 6.5;

    this._prevSmooth = 0;
    this._max = 1;
    this._listeners = new Set();
    this._section = 0;

    this._onScroll = this._onScroll.bind(this);
    this.resize();

    window.addEventListener('scroll', this._onScroll, { passive: true });
  }

  resize() {
    this.proxy.style.height = `${this.sections * 100}vh`;
    this._max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    this._onScroll();
  }

  _onScroll() {
    this.raw = clamp(window.scrollY / this._max, 0, 1);
  }

  update(dt) {
    this._prevSmooth = this.smooth;
    this.smooth = damp(this.smooth, this.raw, this.lambda, dt);
    this.velocity = dt > 0 ? (this.smooth - this._prevSmooth) / dt : 0;

    // Índice de sección con histéresis: cambiamos al cruzar el centro de la
    // pantalla, no el borde, para que un micro-scroll en la frontera no
    // dispare la transición dos veces.
    const idx = clamp(Math.floor(this.smooth * this.sections + 0.5), 0, this.sections - 1);
    if (idx !== this._section) {
      const prev = this._section;
      this._section = idx;
      this._listeners.forEach((fn) => fn(idx, prev));
    }
  }

  /** Progreso 0..1 dentro de la sección i (fuera de ella, recortado). */
  progressIn(i) {
    return clamp(this.smooth * this.sections - i, 0, 1);
  }

  /** Progreso -1..1 alrededor de la sección i (útil para entradas/salidas). */
  aroundSection(i) {
    return clamp(this.smooth * this.sections - i, -1, 1);
  }

  get section() {
    return this._section;
  }

  onSection(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** Lleva el scroll nativo a una sección concreta (CTA de navegación). */
  goTo(i, behavior = 'smooth') {
    window.scrollTo({ top: (i / this.sections) * this._max, behavior });
  }

  dispose() {
    window.removeEventListener('scroll', this._onScroll);
    this._listeners.clear();
  }
}
