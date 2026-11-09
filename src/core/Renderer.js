import * as THREE from 'three';

/**
 * Renderer — configuración del WebGLRenderer.
 *
 * Decisiones que importan:
 *
 *  · antialias: false. El MSAA del contexto no se aplica al resultado del
 *    EffectComposer (que renderiza a un target propio), así que activarlo
 *    solo cuesta memoria. El suavizado lo hace el pase FXAA.
 *
 *  · ACESFilmic + SRGB. La escena es de altísimo contraste (neón puro sobre
 *    negro). Sin tone mapping filmico, cada emissive se quema a blanco plano
 *    y el bloom pierde todo el color.
 *
 *  · transmissionResolutionScale. Cada material con transmission > 0 obliga
 *    al renderer a re-renderizar la escena opaca a un target aparte. Bajar
 *    su resolución es la palanca de rendimiento más rentable que existe en
 *    una escena de cristal, y como lo que se ve a través del vidrio va
 *    difuminado de todos modos, el coste visual es casi nulo.
 */
export class Renderer {
  constructor(canvas, quality) {
    this.quality = quality;

    this.instance = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });

    const r = this.instance;
    r.setPixelRatio(quality.dpr);
    r.setSize(window.innerWidth, window.innerHeight, false);

    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    // Ligeramente subexpuesto. La escena es negra con acentos de neón: dar
    // exposición de más no la hace más legible, sólo empuja el cristal por
    // encima del umbral de bloom en los ángulos rasantes y lo convierte en
    // una mancha. Lo que tiene que brillar ya emite por su cuenta.
    r.toneMappingExposure = 0.92;

    r.shadowMap.enabled = quality.shadows;
    // PCFSoftShadowMap está deprecado en r185 y el propio renderer lo
    // sustituye por PCFShadowMap avisando por consola. Lo pedimos directo;
    // el suavizado de luz de estudio lo aporta shadow.radius en Lighting.js.
    r.shadowMap.type = THREE.PCFShadowMap;
    // Las sombras de esta escena son de luz de estudio: casi estáticas.
    // autoUpdate off + needsUpdate manual ahorra un render pass por frame.
    r.shadowMap.autoUpdate = false;
    r.shadowMap.needsUpdate = true;

    if ('transmissionResolutionScale' in r) {
      r.transmissionResolutionScale = quality.transmissionScale;
    }

    r.info.autoReset = false;

    this.maxAnisotropy = Math.min(quality.anisotropy, r.capabilities.getMaxAnisotropy());

    this._onContextLost = this._onContextLost.bind(this);
    this._onContextRestored = this._onContextRestored.bind(this);
    canvas.addEventListener('webglcontextlost', this._onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this._onContextRestored, false);
    this.canvas = canvas;
    this.contextLost = false;

    this._unsubQuality = quality.onChange((q) => this.applyQuality(q));
  }

  applyQuality(q) {
    const r = this.instance;
    r.setPixelRatio(q.dpr);
    r.shadowMap.enabled = q.shadows;
    r.shadowMap.needsUpdate = true;
    if ('transmissionResolutionScale' in r) r.transmissionResolutionScale = q.transmissionScale;
    this.maxAnisotropy = Math.min(q.anisotropy, r.capabilities.getMaxAnisotropy());
  }

  setSize(width, height) {
    this.instance.setPixelRatio(this.quality.dpr);
    this.instance.setSize(width, height, false);
  }

  /** Fuerza un refresco del shadow map (tras mover luces o el héroe). */
  refreshShadows() {
    this.instance.shadowMap.needsUpdate = true;
  }

  _onContextLost(e) {
    // Sin preventDefault el navegador nunca dispara 'restored'.
    e.preventDefault();
    this.contextLost = true;
    console.warn('[Renderer] contexto WebGL perdido — render en pausa');
  }

  _onContextRestored() {
    this.contextLost = false;
    this.instance.shadowMap.needsUpdate = true;
    console.info('[Renderer] contexto WebGL restaurado');
  }

  dispose() {
    this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
    this._unsubQuality?.();
    this.instance.dispose();
    this.instance.forceContextLoss?.();
  }
}
