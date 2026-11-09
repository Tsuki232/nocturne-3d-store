import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * BackdropBlur — el `backdrop-filter: blur()` que CSS no puede darnos dentro
 * de WebGL.
 *
 * EL PROBLEMA. `MeshPhysicalMaterial` con transmission difumina lo que hay
 * detrás usando los mipmaps del target de transmisión. Funciona, pero el
 * radio de desenfoque está atado a la rugosidad del material: para
 * conseguir un cristal MUY esmerilado hay que subir tanto la roughness que
 * el panel deja de reflejar y se convierte en plástico lechoso.
 *
 * LA SOLUCIÓN. Separar las dos cosas. Renderizamos el fondo a un target
 * aparte, lo desenfocamos todo lo que queramos con un Kawase, y se lo damos
 * a los paneles como textura. El material conserva su rugosidad baja (y por
 * tanto sus reflejos nítidos) mientras el fondo va tan difuso como pidamos.
 *
 * POR QUÉ KAWASE Y NO GAUSSIANO. Un gaussiano separable de radio equivalente
 * necesita decenas de muestras por eje. El Kawase consigue un desenfoque
 * visualmente indistinguible con 4 muestras por iteración, aprovechando el
 * filtrado bilineal del hardware: cada tap ya promedia cuatro téxeles. A
 * media resolución y 4 iteraciones cuesta una fracción de milisegundo.
 */

const KAWASE_FRAG = /* glsl */ `
  precision mediump float;

  uniform sampler2D tDiffuse;
  uniform vec2  uTexel;
  uniform float uOffset;

  varying vec2 vUv;

  void main() {
    // El +0.5 coloca cada muestra justo entre cuatro téxeles, para que el
    // filtrado bilineal de la GPU haga la media gratis. Ese es el truco.
    vec2 o = uTexel * (uOffset + 0.5);

    vec4 sum  = texture2D(tDiffuse, vUv + vec2( o.x,  o.y));
    sum      += texture2D(tDiffuse, vUv + vec2(-o.x,  o.y));
    sum      += texture2D(tDiffuse, vUv + vec2( o.x, -o.y));
    sum      += texture2D(tDiffuse, vUv + vec2(-o.x, -o.y));

    gl_FragColor = sum * 0.25;
  }
`;

const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** Offsets crecientes. La progresión es la del paper original de Kawase. */
const OFFSETS = [0, 1, 2, 2, 3, 3];

export class BackdropBlur {
  /**
   * @param {number} scale  resolución relativa. 0.5 es indistinguible del
   *                        1.0 una vez desenfocado, y cuesta la cuarta parte.
   */
  constructor(renderer, { scale = 0.5, steps = 4 } = {}) {
    this.renderer = renderer;
    this.scale = scale;
    this.steps = steps;
    this.enabled = true;

    const opts = {
      type: THREE.HalfFloatType, // el fondo es HDR: los neones pasan de 1.0
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    };

    this.rtScene = new THREE.WebGLRenderTarget(1, 1, opts);
    this.rtA = new THREE.WebGLRenderTarget(1, 1, { ...opts, depthBuffer: false });
    this.rtB = new THREE.WebGLRenderTarget(1, 1, { ...opts, depthBuffer: false });

    this.material = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: KAWASE_FRAG,
      uniforms: {
        tDiffuse: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uOffset: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new FullScreenQuad(this.material);

    /** Textura resultante. Los paneles la leen en su shader. */
    this.texture = this.rtA.texture;

    this._size = new THREE.Vector2();
    this._prevTarget = null;
  }

  setSize(width, height, pixelRatio = 1) {
    const w = Math.max(2, Math.floor(width * pixelRatio * this.scale));
    const h = Math.max(2, Math.floor(height * pixelRatio * this.scale));
    this.rtScene.setSize(w, h);
    this.rtA.setSize(w, h);
    this.rtB.setSize(w, h);
    this.material.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  /**
   * Renderiza el fondo y lo desenfoca.
   *
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {THREE.Object3D[]} exclude  objetos que NO forman parte del fondo
   *        (los propios paneles: si se incluyeran a sí mismos tendríamos una
   *        realimentación de vídeo, con el panel mostrando su propia imagen
   *        difuminada en bucle).
   */
  render(scene, camera, exclude = []) {
    if (!this.enabled) return null;

    const hidden = [];
    for (const o of exclude) {
      if (o && o.visible) {
        o.visible = false;
        hidden.push(o);
      }
    }

    const r = this.renderer;
    const prevTarget = r.getRenderTarget();

    r.setRenderTarget(this.rtScene);
    r.clear();
    r.render(scene, camera);

    // Ping-pong. Cada iteración duplica aproximadamente el radio efectivo.
    let read = this.rtScene;
    let write = this.rtA;
    const n = Math.min(this.steps, OFFSETS.length);

    for (let i = 0; i < n; i++) {
      this.material.uniforms.tDiffuse.value = read.texture;
      this.material.uniforms.uOffset.value = OFFSETS[i];
      r.setRenderTarget(write);
      this.quad.render(r);

      read = write;
      write = write === this.rtA ? this.rtB : this.rtA;
    }

    this.texture = read.texture;

    r.setRenderTarget(prevTarget);
    for (const o of hidden) o.visible = true;

    return this.texture;
  }

  setSteps(n) {
    this.steps = THREE.MathUtils.clamp(n, 0, OFFSETS.length);
  }

  dispose() {
    this.rtScene.dispose();
    this.rtA.dispose();
    this.rtB.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
