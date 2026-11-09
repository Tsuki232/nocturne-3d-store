import * as THREE from 'three';
import gsap from 'gsap';
import { PALETTE } from '../materials/palette.js';
import { PanelCanvas, cssColor } from './TextTexture.js';

/**
 * NeonButton — el CTA, dentro del canvas.
 *
 * Tres estados y una regla para cada uno:
 *
 *   IDLE   borde neón latiendo. El latido es lo que dice "esto se puede
 *          pulsar" sin necesidad de un cursor ni de un tooltip.
 *   HOVER  el interior se llena de luz de dentro hacia fuera. El relleno
 *          sale del centro porque así el botón parece cargarse, no
 *          encenderse de golpe.
 *   PRESS  destello corto y contracción. Feedback táctil traducido a luz.
 *
 * Igual que el panel, la forma es una SDF: eso permite bordes de grosor
 * constante en pantalla y esquinas perfectas sin geometría adicional.
 */

const BTN_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec4 vClip;
  void main() {
    vUv = uv;
    vClip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = vClip;
  }
`;

const BTN_FRAG = /* glsl */ `
  precision highp float;

  uniform sampler2D tBlur;
  uniform sampler2D tLabel;
  uniform bool  uHasBackdrop;

  uniform vec3  uColor;
  uniform float uAspect;
  uniform float uRadius;
  uniform float uPulse;     // latido idle, 0..1
  uniform float uFill;      // relleno de hover, 0..1
  uniform float uPress;     // destello de pulsación, 0..1
  uniform float uOpacity;
  uniform float uDisabled;

  varying vec2 vUv;
  varying vec4 vClip;

  float sdRoundBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
  }

  void main() {
    vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
    float d = sdRoundBox(p, vec2(uAspect, 1.0) * 0.5, uRadius);

    float aa = fwidth(d) * 0.9;
    float shape = 1.0 - smoothstep(-aa, aa, d);
    if (shape <= 0.001) discard;

    vec2 suv = vClip.xy / vClip.w * 0.5 + 0.5;
    vec3 bg = uHasBackdrop ? texture2D(tBlur, suv).rgb * 0.55 : vec3(0.03, 0.03, 0.05);

    // Relleno radial desde el centro. Se mide en la coordenada normalizada
    // del botón, así que crece igual en botones de cualquier proporción.
    float rad = length(p / vec2(uAspect, 1.0) * 2.0);
    float fill = smoothstep(uFill * 1.5 + 0.02, uFill * 1.5 - 0.35, rad);
    vec3 col = mix(bg, uColor * 0.55, fill * 0.85);

    // Borde: grosor fijo + latido.
    float w = 0.012 + uPulse * 0.006;
    float border = 1.0 - smoothstep(0.0, w, abs(d));
    float halo = 1.0 - smoothstep(0.0, w * 9.0, abs(d));

    float glow = 0.9 + uPulse * 0.9 + uFill * 1.2 + uPress * 4.0;
    col += uColor * border * glow;
    col += uColor * halo * (0.12 + uFill * 0.3);

    // Destello de pulsación: baña el botón entero un instante.
    col += uColor * uPress * 0.5;

    vec4 label = texture2D(tLabel, vUv);
    // El texto se aclara al rellenarse el fondo para no perder contraste.
    vec3 labelCol = mix(label.rgb, vec3(1.0), fill * 0.5);
    col = mix(col, labelCol, label.a);

    col = mix(col, vec3(dot(col, vec3(0.299, 0.587, 0.114))) * 0.4, uDisabled);

    gl_FragColor = vec4(col, shape * uOpacity);
  }
`;

export class NeonButton {
  constructor({
    label = 'AÑADIR AL CARRITO',
    width = 1.35,
    height = 0.3,
    radius = 0.15,
    color = PALETTE.cyan,
    name = 'cta',
  } = {}) {
    this.width = width;
    this.height = height;
    this.color = new THREE.Color(color);
    this.enabled = true;
    this._label = label;

    this.geometry = new THREE.PlaneGeometry(width, height);
    this.labelTexture = this._makeLabel(label, color);

    this.uniforms = {
      tBlur: { value: null },
      tLabel: { value: this.labelTexture },
      uHasBackdrop: { value: false },
      uColor: { value: this.color },
      uAspect: { value: width / height },
      uRadius: { value: Math.min(radius, height * 0.5) / height },
      uPulse: { value: 0 },
      uFill: { value: 0 },
      uPress: { value: 0 },
      uOpacity: { value: 0 },
      uDisabled: { value: 0 },
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: BTN_VERT,
      fragmentShader: BTN_FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = name;
    this.mesh.renderOrder = 12;
    this.mesh.visible = false;
    this.mesh.userData.button = this;

    this._listeners = new Set();
    this._hover = false;
    this._phase = Math.random() * Math.PI * 2;
  }

  /**
   * El espacio virtual de PanelCanvas mide 1000 unidades de alto y equivale
   * a la ALTURA DEL BOTÓN. Un tamaño de 80 son el 8 % de esa altura: en un
   * botón de 0.26 unidades de mundo —unos 26 px en pantalla— eso da un
   * texto de 2 px. La tipografía de una UI 3D hay que dimensionarla contra
   * la pieza que la contiene, no contra las medidas de una hoja de estilos.
   */
  _makeLabel(text, color) {
    const c = new PanelCanvas(this.width / this.height, 220, 2);
    c.clear();
    // 26 % de la altura del botón deja aire arriba y abajo, y evita que las
    // primeras y últimas letras se metan bajo los extremos redondeados.
    const size = 260;
    c.text(text, {
      x: c.vw / 2,
      y: 1000 / 2 + size * 0.36,
      size,
      weight: 600,
      color: cssColor(color, 0.96),
      align: 'center',
      tracking: size * 0.12,
    });
    return c.toTexture({ anisotropy: 8 });
  }

  setLabel(text) {
    if (text === this._label) return;
    this._label = text;
    this.labelTexture.dispose();
    this.labelTexture = this._makeLabel(text, this.color.getHex());
    this.uniforms.tLabel.value = this.labelTexture;
  }

  setBackdrop(texture) {
    this.uniforms.tBlur.value = texture;
    this.uniforms.uHasBackdrop.value = !!texture;
  }

  /* ── Interacción ───────────────────────────────────────────── */

  setHover(on) {
    if (this._hover === on || !this.enabled) return;
    this._hover = on;
    gsap.to(this.uniforms.uFill, {
      value: on ? 1 : 0,
      duration: on ? 0.42 : 0.3,
      ease: on ? 'power2.out' : 'power2.in',
    });
  }

  /** Destello + rebote de escala. Se dispara al hacer clic. */
  press() {
    if (!this.enabled) return;
    gsap.killTweensOf(this.uniforms.uPress);
    gsap.fromTo(
      this.uniforms.uPress,
      { value: 1 },
      { value: 0, duration: 0.55, ease: 'power3.out' }
    );
    gsap.fromTo(
      this.mesh.scale,
      { x: 0.94, y: 0.88, z: 1 },
      { x: 1, y: 1, z: 1, duration: 0.5, ease: 'elastic.out(1, 0.45)' }
    );
    this._listeners.forEach((fn) => fn());
  }

  onClick(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  setEnabled(on) {
    this.enabled = on;
    gsap.to(this.uniforms.uDisabled, { value: on ? 0 : 1, duration: 0.3 });
  }

  /* ── Visibilidad ───────────────────────────────────────────── */

  /*
   * `_shown` no es redundante con `mesh.visible`.
   *
   * Al atravesar secciones deprisa —un scroll rápido dispara goTo(1) y
   * goTo(2) con décimas de diferencia— el `conceal` de la transición
   * anterior sigue vivo cuando el `reveal` de la siguiente ya ha puesto
   * visible = true. Su onComplete llega tarde y apaga el botón que
   * acabamos de encender. La bandera registra la INTENCIÓN, y el
   * onComplete sólo actúa si nadie la ha cambiado entretanto.
   */

  reveal({ delay = 0, duration = 0.6 } = {}) {
    this._shown = true;
    gsap.killTweensOf(this.uniforms.uOpacity);
    this.mesh.visible = true;
    return gsap.fromTo(
      this.uniforms.uOpacity,
      { value: 0 },
      { value: 1, duration, delay, ease: 'power2.out' }
    );
  }

  conceal({ duration = 0.35 } = {}) {
    this._shown = false;
    gsap.killTweensOf(this.uniforms.uOpacity);
    return gsap.to(this.uniforms.uOpacity, {
      value: 0,
      duration,
      onComplete: () => {
        if (!this._shown) this.mesh.visible = false;
      },
    });
  }

  update(dt, time) {
    if (!this.mesh.visible) return;
    // Latido rítmico. Curva |sin| en vez de sin: la subida es más rápida
    // que la bajada, que es como late un tubo de neón real al arrancar.
    this.uniforms.uPulse.value = Math.abs(Math.sin(time * 1.15 + this._phase)) * (this.enabled ? 1 : 0.2);
  }

  setColor(color) {
    const c = new THREE.Color(color);
    gsap.to(this.uniforms.uColor.value, { r: c.r, g: c.g, b: c.b, duration: 0.4 });
    this.color.copy(c);
  }

  dispose() {
    gsap.killTweensOf(this.uniforms.uFill);
    gsap.killTweensOf(this.uniforms.uPress);
    gsap.killTweensOf(this.uniforms.uOpacity);
    gsap.killTweensOf(this.uniforms.uDisabled);
    gsap.killTweensOf(this.mesh.scale);
    this.geometry.dispose();
    this.material.dispose();
    this.labelTexture.dispose();
    this.mesh.removeFromParent();
    this._listeners.clear();
  }
}
