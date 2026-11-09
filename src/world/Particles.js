import * as THREE from 'three';
import gsap from 'gsap';
import { PALETTE } from '../materials/palette.js';
import { mulberry32 } from '../utils/math.js';

/**
 * Sistemas de partículas.
 *
 * DECISIÓN CENTRAL: ni una sola posición se recalcula en JavaScript.
 *
 * El enfoque ingenuo —recorrer 50.000 posiciones cada frame para aplicar
 * deriva y repulsión, y subir el buffer entero a la GPU— cuesta unos 8-12 ms
 * por frame en un portátil decente. Es decir: el presupuesto completo de
 * 60 fps gastado en mover puntos.
 *
 * En su lugar, el buffer de posiciones se sube UNA vez y no se toca nunca
 * más. La deriva es `position + drift * uTime` con envoltura por `mod`, y la
 * repulsión del cursor es una función del vértice y de un uniform. Ambas son
 * sin estado: no acumulan, así que se pueden evaluar desde cero en cada
 * frame dentro del vertex shader. Coste en CPU: actualizar tres uniforms.
 */

/* ═══════════════════════════════════════════════════════════════
   Campo estelar
   ═══════════════════════════════════════════════════════════════ */

const FIELD_VERT = /* glsl */ `
  uniform float uTime;
  uniform vec3  uBounds;
  uniform vec3  uDrift;
  uniform vec3  uMouse;
  uniform float uRepelRadius;
  uniform float uRepelStrength;
  uniform float uSize;
  uniform float uPixelRatio;
  uniform float uScrollBoost;

  attribute float aSeed;
  attribute float aTint;
  attribute float aScale;

  varying float vTint;
  varying float vTwinkle;
  varying float vDepth;

  void main() {
    vec3 p = position;

    // ── Deriva con envoltura ──────────────────────────────────
    // Cada partícula avanza a su propio ritmo (aSeed) y al salir de la
    // caja reaparece por el lado opuesto. mod() en GLSL usa floor, así
    // que funciona igual con coordenadas negativas.
    p += uDrift * uTime * (0.55 + aSeed * 0.9);
    p = mod(p + uBounds, 2.0 * uBounds) - uBounds;

    // ── Repulsión del cursor ──────────────────────────────────
    // Campo radial con caída suave. Al ser función pura de la posición
    // y del uniform, no hace falta guardar velocidad por partícula.
    vec3 toMouse = p - uMouse;
    float dist = length(toMouse);
    float falloff = 1.0 - smoothstep(0.0, uRepelRadius, dist);
    // pow() concentra el empuje cerca del cursor en vez de repartirlo por
    // toda la esfera, que es lo que hace que se lea como "presión".
    p += normalize(toMouse + 1e-5) * pow(falloff, 2.0) * uRepelStrength;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    // Centelleo desincronizado por semilla.
    vTwinkle = 0.55 + 0.45 * sin(uTime * (0.8 + aSeed * 2.2) + aSeed * 31.4);
    vTint = aTint;
    vDepth = -mv.z;

    // Atenuación por perspectiva. La distancia de referencia (90) y el
    // techo del clamp son los dos números que deciden si esto parece un
    // campo estelar o una tormenta de nieve: una partícula que llega a
    // ocupar 40 px es una mancha, y 50.000 manchas aditivas son un velo
    // blanco que se come la escena entera.
    float size = uSize * aScale * (1.0 + uScrollBoost);
    gl_PointSize = size * uPixelRatio * (90.0 / max(-mv.z, 1.0));
    gl_PointSize = clamp(gl_PointSize, 1.0, 7.0);
  }
`;

const FIELD_FRAG = /* glsl */ `
  precision mediump float;

  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform vec3  uColorC;
  uniform float uOpacity;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uNearFade;

  varying float vTint;
  varying float vTwinkle;
  varying float vDepth;

  void main() {
    // Disco suave calculado, no muestreado de una textura: sin sprite que
    // cargar, sin filtrado y con un borde perfecto a cualquier tamaño.
    vec2 uv = gl_PointCoord - 0.5;
    float d = dot(uv, uv);
    if (d > 0.25) discard;

    float alpha = smoothstep(0.25, 0.0, d);
    alpha *= alpha; // núcleo más denso, halo más tenue

    // Tres tintes: la mayoría blancas, las minoritarias cian y violeta.
    vec3 col = mix(uColorA, uColorB, smoothstep(0.45, 0.8, vTint));
    col = mix(col, uColorC, smoothstep(0.85, 1.0, vTint));

    // Niebla de profundidad: sin ella el campo se ve como una lámina plana
    // de ruido y desaparece toda la sensación de volumen.
    float fog = 1.0 - smoothstep(uFogNear, uFogFar, vDepth);

    // Desvanecido de cercanía. La cámara vive DENTRO del volumen de
    // partículas, así que siempre hay unas cuantas a medio metro. Sin este
    // corte se convierten en discos gigantes delante del objetivo.
    float near = smoothstep(0.0, uNearFade, vDepth);

    gl_FragColor = vec4(col * vTwinkle, alpha * uOpacity * fog * near * vTwinkle);
  }
`;

export class ParticleField {
  constructor(scene, quality) {
    this.quality = quality;
    this.maxCount = quality.particles;
    this.count = quality.particles;

    const bounds = new THREE.Vector3(46, 26, 46);
    this.bounds = bounds;

    const geo = new THREE.BufferGeometry();
    const rng = mulberry32(20260808);

    const pos = new Float32Array(this.maxCount * 3);
    const seed = new Float32Array(this.maxCount);
    const tint = new Float32Array(this.maxCount);
    const scale = new Float32Array(this.maxCount);

    for (let i = 0; i < this.maxCount; i++) {
      // Distribución uniforme en caja, no en esfera: queremos densidad
      // constante en todo el volumen navegable, no un cúmulo central.
      pos[i * 3] = (rng() * 2 - 1) * bounds.x;
      pos[i * 3 + 1] = (rng() * 2 - 1) * bounds.y;
      pos[i * 3 + 2] = (rng() * 2 - 1) * bounds.z;

      seed[i] = rng();
      tint[i] = rng();
      // Distribución sesgada: muchas diminutas, unas pocas grandes. Es lo
      // que da variedad de escala sin que el campo parezca sucio.
      scale[i] = 0.3 + Math.pow(rng(), 3.2) * 1.5;
    }

    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 1));
    geo.setAttribute('aScale', new THREE.BufferAttribute(scale, 1));
    geo.setDrawRange(0, this.count);
    // El frustum culling sobre un campo que envuelve la cámara sólo puede
    // equivocarse: la caja envolvente es el mundo entero.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), bounds.length());

    this.uniforms = {
      uTime: { value: 0 },
      uBounds: { value: bounds },
      uDrift: { value: new THREE.Vector3(0.06, 0.13, -0.05) },
      uMouse: { value: new THREE.Vector3(0, 0, 999) },
      uRepelRadius: { value: 2.1 },
      uRepelStrength: { value: 0.85 },
      uSize: { value: 1.9 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, quality.dpr) },
      uScrollBoost: { value: 0 },
      // Base fría y desaturada. Un blanco puro sumado 50.000 veces deja de
      // ser blanco y pasa a ser sobreexposición.
      uColorA: { value: new THREE.Color(0x7f8dad) },
      uColorB: { value: new THREE.Color(0x2fb6c4) },
      uColorC: { value: new THREE.Color(PALETTE.violet) },
      uOpacity: { value: 0 }, // entra con fundido tras la carga
      uFogNear: { value: 10 },
      uFogFar: { value: 52 },
      uNearFade: { value: 4.5 },
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: FIELD_VERT,
      fragmentShader: FIELD_FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false, // puntos aditivos que no deben ocluirse entre sí
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.name = 'starfield';
    this.points.frustumCulled = false;
    this.points.renderOrder = -10;
    scene.add(this.points);

    this._unsub = quality.onChange((q) => this.applyQuality(q));
  }

  /** Fundido de entrada tras el preloader. */
  fadeIn(duration = 2.2) {
    return gsap.to(this.uniforms.uOpacity, { value: 0.62, duration, ease: 'power2.out' });
  }

  update(dt, time, { mouseWorld, scrollVelocity = 0 } = {}) {
    this.uniforms.uTime.value = time;
    if (mouseWorld) this.uniforms.uMouse.value.copy(mouseWorld);
    // Un scroll rápido estira las partículas: refuerzo de velocidad barato.
    this.uniforms.uScrollBoost.value +=
      (Math.min(Math.abs(scrollVelocity) * 1.6, 0.7) - this.uniforms.uScrollBoost.value) * Math.min(1, dt * 4);
  }

  applyQuality(q) {
    this.count = Math.min(this.maxCount, q.particles);
    this.points.geometry.setDrawRange(0, this.count);
    this.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio, q.dpr);
  }

  resize(dpr) {
    this.uniforms.uPixelRatio.value = dpr;
  }

  dispose() {
    this._unsub?.();
    gsap.killTweensOf(this.uniforms.uOpacity);
    this.points.geometry.dispose();
    this.material.dispose();
    this.points.removeFromParent();
  }
}

/* ═══════════════════════════════════════════════════════════════
   Rastro de acción
   ═══════════════════════════════════════════════════════════════ */

const TRAIL_VERT = /* glsl */ `
  uniform float uProgress;
  uniform vec3  uStart;
  uniform vec3  uCtrl;
  uniform vec3  uEnd;
  uniform float uSize;
  uniform float uPixelRatio;

  attribute float aDelay;
  attribute float aSeed;
  attribute vec3  aOffset;

  varying float vLife;

  void main() {
    // Cada partícula arranca con retardo propio: eso es lo que convierte
    // un enjambre en un rastro con cabeza y cola.
    float t = clamp((uProgress - aDelay) / max(1.0 - aDelay, 1e-3), 0.0, 1.0);
    vLife = t;

    // Bézier cuadrática: el rastro describe un arco, no una recta.
    float mt = 1.0 - t;
    vec3 p = mt * mt * uStart + 2.0 * mt * t * uCtrl + t * t * uEnd;

    // Dispersión en espiral que se cierra al llegar: sale desordenado y
    // converge en el destino.
    float spread = (1.0 - t) * (1.0 - t);
    float ang = aSeed * 6.2831 + t * 9.0;
    p += aOffset * spread;
    p += vec3(cos(ang), sin(ang), 0.0) * spread * 0.35;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * uPixelRatio * (300.0 / max(-mv.z, 1.0)) * (0.4 + (1.0 - t) * 0.9);
  }
`;

const TRAIL_FRAG = /* glsl */ `
  precision mediump float;
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vLife;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = dot(uv, uv);
    if (d > 0.25) discard;
    float alpha = smoothstep(0.25, 0.0, d);
    // Nace, brilla y se apaga antes de tocar el destino.
    float life = sin(vLife * 3.14159);
    gl_FragColor = vec4(uColor, alpha * life * uOpacity);
  }
`;

/**
 * ParticleTrail — el rastro que acompaña una acción importante.
 *
 * Se dispara al añadir al carrito: un grupo de partículas sale del producto,
 * acelera y converge en el icono del carrito. Su función no es decorar, es
 * responder a la pregunta "¿ha pasado algo?" sin escribir una sola palabra.
 */
export class ParticleTrail {
  constructor(scene, { count = 900, color = PALETTE.cyan } = {}) {
    const geo = new THREE.BufferGeometry();
    const rng = mulberry32(4242);

    const pos = new Float32Array(count * 3); // ignorado: la posición la calcula el shader
    const delay = new Float32Array(count);
    const seed = new Float32Array(count);
    const offset = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      delay[i] = Math.pow(rng(), 1.6) * 0.55;
      seed[i] = rng();
      const r = 0.22 + rng() * 0.5;
      const th = rng() * Math.PI * 2;
      const ph = Math.acos(2 * rng() - 1);
      offset[i * 3] = r * Math.sin(ph) * Math.cos(th);
      offset[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
      offset[i * 3 + 2] = r * Math.cos(ph);
    }

    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aDelay', new THREE.BufferAttribute(delay, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aOffset', new THREE.BufferAttribute(offset, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 40);

    this.uniforms = {
      uProgress: { value: 0 },
      uStart: { value: new THREE.Vector3() },
      uCtrl: { value: new THREE.Vector3() },
      uEnd: { value: new THREE.Vector3() },
      uSize: { value: 3.4 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: 0 },
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.name = 'trail';
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.points.renderOrder = 20;
    scene.add(this.points);
  }

  /**
   * @param {THREE.Vector3} from  origen (el producto)
   * @param {THREE.Vector3} to    destino (el carrito)
   */
  fire(from, to, { duration = 1.15, color } = {}) {
    if (color) this.uniforms.uColor.value.set(color);
    this.uniforms.uStart.value.copy(from);
    this.uniforms.uEnd.value.copy(to);
    // Punto de control por encima de la cuerda: el arco se eleva antes de
    // caer sobre el destino.
    this.uniforms.uCtrl.value
      .addVectors(from, to)
      .multiplyScalar(0.5)
      .add(new THREE.Vector3(0, 1.5, 0.8));

    this.points.visible = true;

    // Matar sólo los tweens hijos deja viva la timeline padre: al quedarse
    // vacía se da por completada al instante y su onComplete apaga el
    // rastro que acabamos de encender. Hay que matar la timeline entera.
    this._tl?.kill();
    gsap.killTweensOf(this.uniforms.uProgress);
    gsap.killTweensOf(this.uniforms.uOpacity);

    const tl = gsap.timeline({
      onComplete: () => {
        this.points.visible = false;
      },
    });
    this._tl = tl;
    tl.fromTo(this.uniforms.uProgress, { value: 0 }, { value: 1, duration, ease: 'power2.in' }, 0);
    tl.fromTo(this.uniforms.uOpacity, { value: 0 }, { value: 1, duration: 0.15 }, 0);
    tl.to(this.uniforms.uOpacity, { value: 0, duration: 0.3 }, duration - 0.3);
    return tl;
  }

  dispose() {
    this._tl?.kill();
    gsap.killTweensOf(this.uniforms.uProgress);
    gsap.killTweensOf(this.uniforms.uOpacity);
    this.points.geometry.dispose();
    this.material.dispose();
    this.points.removeFromParent();
  }
}
