/**
 * Quality — detección de tier de dispositivo y presupuesto de render.
 *
 * Una experiencia con 50k partículas, transmisión física y tres passes de
 * post no cabe en un móvil de gama media. En vez de degradar a ciegas,
 * clasificamos el dispositivo una vez al arrancar y dejamos que cada
 * subsistema lea su propio presupuesto de aquí. Después, un watchdog de
 * FPS puede bajar el tier en caliente si la realidad no acompaña.
 *
 * Tiers:  'low' | 'mid' | 'high'
 */

const TIERS = {
  low: {
    name: 'low',
    dpr: 1.0,
    postScale: 0.6,        // resolución del composer respecto a la nativa
    particles: 9000,
    bloom: false,
    chromatic: false,
    fxaa: true,
    shadows: false,
    shadowMapSize: 512,
    kawaseBackdrop: false, // los paneles caen a transmisión simple
    kawaseSteps: 0,
    transmissionScale: 0.35,
    envMapSize: 128,
    anisotropy: 1,
    catalogCount: 8,
    lodBias: 1.35,
  },
  mid: {
    name: 'mid',
    dpr: 1.5,
    postScale: 0.75,
    particles: 26000,
    bloom: true,
    chromatic: true,
    fxaa: true,
    shadows: true,
    shadowMapSize: 1024,
    kawaseBackdrop: true,
    kawaseSteps: 3,
    transmissionScale: 0.5,
    envMapSize: 256,
    anisotropy: 4,
    catalogCount: 12,
    lodBias: 1.0,
  },
  high: {
    name: 'high',
    dpr: 2.0,
    postScale: 1.0,
    particles: 50000,
    bloom: true,
    chromatic: true,
    fxaa: true,
    shadows: true,
    shadowMapSize: 2048,
    kawaseBackdrop: true,
    kawaseSteps: 4,
    transmissionScale: 1.0,
    envMapSize: 512,
    anisotropy: 8,
    catalogCount: 20,
    lodBias: 0.85,
  },
};

const ORDER = ['low', 'mid', 'high'];

export class Quality {
  constructor() {
    this.isMobile = this._detectMobile();
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.gpu = this._probeGPU();

    this.tierName = this._classify();
    Object.assign(this, TIERS[this.tierName]);

    // Presupuesto real de píxeles: no sirve de nada pedir dpr 2 en un 4K.
    this.dpr = Math.min(window.devicePixelRatio || 1, this.dpr);

    this._listeners = new Set();
    this._samples = [];
    this._lastDowngrade = 0;
    this.frozen = false; // congela el watchdog (útil durante transiciones)
  }

  /* ── Detección ─────────────────────────────────────────────── */

  _detectMobile() {
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const narrow = Math.min(window.innerWidth, window.innerHeight) < 700;
    const ua = /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(navigator.userAgent);
    return (coarse && narrow) || ua;
  }

  /**
   * WEBGL_debug_renderer_info está capado en varios navegadores por privacidad,
   * así que lo tratamos como una pista más, no como la verdad.
   */
  _probeGPU() {
    const out = { renderer: '', vendor: '', maxTexture: 2048, webgl2: false };
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return out;
      out.webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
      out.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        out.renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
        out.vendor = String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || '');
      }
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    } catch {
      /* sin datos: nos quedamos con los valores por defecto */
    }
    return out;
  }

  _classify() {
    if (this.isMobile) {
      // Los iPhone recientes mueven esto bien; el Android de gama media no.
      const strongIOS = /iPhone|iPad/.test(navigator.userAgent) && this.gpu.maxTexture >= 8192;
      return strongIOS ? 'mid' : 'low';
    }

    const cores = navigator.hardwareConcurrency || 4;
    const mem = navigator.deviceMemory || 4;
    const r = this.gpu.renderer.toLowerCase();

    const weakGPU = /(intel).*(hd|uhd) graphics (5|6|61|62|3000|4000)/.test(r) || /swiftshader|llvmpipe|software/.test(r);
    if (weakGPU || cores <= 2 || mem <= 2) return 'low';

    const strongGPU = /(rtx|radeon rx|geforce gtx 1[0-9]|apple m[1-9]|arc a)/.test(r);
    if (strongGPU || (cores >= 8 && mem >= 8)) return 'high';

    return 'mid';
  }

  /* ── Watchdog de FPS ───────────────────────────────────────── */

  /**
   * Alimentado desde el bucle de render. Si la media de 90 frames cae por
   * debajo de 45 fps sostenidos, bajamos un tier. Solo hacia abajo y como
   * mucho una vez cada 6 s: subir de nuevo provocaría oscilación visible.
   */
  sample(dt) {
    if (this.frozen || this.tierName === 'low') return;
    this._samples.push(dt);
    if (this._samples.length < 90) return;

    const avg = this._samples.reduce((a, b) => a + b, 0) / this._samples.length;
    this._samples.length = 0;

    const now = performance.now();
    if (avg > 1 / 45 && now - this._lastDowngrade > 6000) {
      this._lastDowngrade = now;
      this.downgrade();
    }
  }

  downgrade() {
    const i = ORDER.indexOf(this.tierName);
    if (i <= 0) return;
    this.setTier(ORDER[i - 1]);
  }

  setTier(name) {
    if (!TIERS[name] || name === this.tierName) return;
    this.tierName = name;
    const preset = TIERS[name];
    Object.assign(this, preset);
    this.dpr = Math.min(window.devicePixelRatio || 1, preset.dpr);
    console.info(`[Quality] tier → ${name}`);
    this._listeners.forEach((fn) => fn(this));
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  dispose() {
    this._listeners.clear();
    this._samples.length = 0;
  }
}
