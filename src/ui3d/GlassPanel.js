import * as THREE from 'three';
import gsap from 'gsap';
import { PALETTE } from '../materials/palette.js';

/**
 * GlassPanel — una tarjeta de UI que es geometría, no un div.
 *
 * ANATOMÍA
 *
 *   shadow  Mesh detrás, con una SDF muy difuminada. Es la sombra
 *           proyectada: sin ella el panel se pega al fondo y pierde la
 *           altura que justifica todo el efecto de cristal.
 *   mesh    El panel. Un PlaneGeometry con shader propio.
 *   content Textura de canvas con la tipografía, compuesta dentro del
 *           mismo shader para que la recorten las esquinas redondeadas.
 *
 * POR QUÉ UN ShaderMaterial Y NO MeshPhysicalMaterial. Necesitamos leer el
 * fondo ya desenfocado en espacio de pantalla (ver postfx/BackdropBlur.js).
 * Un material físico difumina en función de su rugosidad y no da acceso a
 * esa textura; aquí controlamos el desenfoque por separado y podemos
 * animarlo, que es justo lo que pide la entrada del panel.
 *
 * La UV de pantalla se deriva de la posición de clip, no de gl_FragCoord:
 * así el panel se dibuja igual de bien sea cual sea la resolución del
 * búfer activo —y hay varios en esta escena, con tamaños distintos.
 */

const PANEL_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec4 vClip;
  varying vec3 vNormalW;
  varying vec3 vViewDirW;

  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDirW = normalize(cameraPosition - wp.xyz);
    vClip = projectionMatrix * viewMatrix * wp;
    gl_Position = vClip;
  }
`;

const PANEL_FRAG = /* glsl */ `
  precision highp float;

  uniform sampler2D tBlur;
  uniform sampler2D tSharp;
  uniform sampler2D tContent;
  uniform bool  uHasContent;
  uniform bool  uHasBackdrop;

  uniform float uAspect;
  uniform float uRadius;
  uniform float uFrost;       // 0 = fondo nítido · 1 = totalmente esmerilado
  uniform float uDim;         // absorción del vidrio
  uniform float uRefraction;
  uniform vec3  uTint;
  uniform float uTintAmount;
  uniform float uFloor;
  uniform vec3  uEdgeColor;
  uniform float uEdgeWidth;
  uniform float uEdgeGlow;
  uniform float uOpacity;
  uniform float uHover;
  uniform float uTime;
  uniform float uStreak;

  varying vec2 vUv;
  varying vec4 vClip;
  varying vec3 vNormalW;
  varying vec3 vViewDirW;

  // SDF de rectángulo redondeado. Devuelve distancia con signo: negativa
  // dentro, cero en el borde, positiva fuera. Todo el panel —forma, borde
  // y refracción— sale de esta única función.
  float sdRoundBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
  }

  void main() {
    // Espacio local corregido por aspecto, para que las esquinas sean
    // circulares y no elípticas en paneles no cuadrados.
    vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
    vec2 halfSize = vec2(uAspect, 1.0) * 0.5;

    float d = sdRoundBox(p, halfSize, uRadius);

    // Antialiasing por derivada: un píxel de transición, sea cual sea la
    // distancia a cámara o la resolución del búfer.
    float aa = fwidth(d) * 0.9;
    float shape = 1.0 - smoothstep(-aa, aa, d);
    if (shape <= 0.001) discard;

    // ── Fondo ────────────────────────────────────────────────
    vec2 suv = vClip.xy / vClip.w * 0.5 + 0.5;

    // Refracción: cerca del borde, el "canto" del cristal desvía lo que
    // hay detrás. Usamos el gradiente de la SDF como normal 2D.
    float edgeProx = 1.0 - smoothstep(0.0, 0.08, abs(d));
    vec2 grad = vec2(dFdx(d), dFdy(d));
    float gl = length(grad);
    if (gl > 1e-6) suv += (grad / gl) * edgeProx * uRefraction;

    vec3 bg = vec3(0.02, 0.02, 0.03);
    if (uHasBackdrop) {
      vec3 blurred = texture2D(tBlur, suv).rgb;
      vec3 sharp   = texture2D(tSharp, suv).rgb;
      // uFrost anima el desenfoque durante la entrada del panel.
      bg = mix(sharp, blurred, uFrost);
    }
    // Atenuación del fondo. Un cristal esmerilado real absorbe: sin este
    // factor el panel queda más luminoso que la escena y el texto blanco
    // pierde todo el contraste contra su propio fondo.
    bg *= uDim;

    // Tinte del vidrio. Multiplicativo + un realce muy pequeño: el cristal
    // esmerilado aclara ligeramente lo que cubre, nunca lo oscurece.
    vec3 col = mix(bg, bg * uTint + uTint * 0.055, uTintAmount);

    // Suelo de sustancia. Un panel puramente sustractivo desaparece cuando
    // detrás no hay nada que difuminar —y en esta escena hay mucho vacío—.
    // Esta base mínima garantiza que la tarjeta exista como objeto físico
    // aunque flote sobre negro absoluto.
    col += uTint * uFloor;

    // ── Fresnel ──────────────────────────────────────────────
    // En la entrada, el panel llega girado 90°: casi de canto. Ahí este
    // término dispara y produce el destello de "lámina de vidrio" que hace
    // legible la rotación.
    float fres = pow(1.0 - abs(dot(normalize(vNormalW), normalize(vViewDirW))), 3.0);
    col += uEdgeColor * fres * 0.35;

    // ── Reflejo de barrido ───────────────────────────────────
    float band = abs((p.x * 0.45 + p.y * 0.89) - uStreak);
    col += vec3(1.0) * smoothstep(0.28, 0.0, band) * 0.035 * (1.0 + uHover);

    // ── Borde emissive ───────────────────────────────────────
    // Banda estrecha centrada en d = 0. El grosor se mide en la misma
    // unidad que la SDF, así que se mantiene constante en pantalla.
    float border = 1.0 - smoothstep(0.0, uEdgeWidth, abs(d));
    float halo   = 1.0 - smoothstep(0.0, uEdgeWidth * 7.0, abs(d));
    col += uEdgeColor * border * uEdgeGlow * (1.0 + uHover * 1.4);
    col += uEdgeColor * halo * 0.09 * uEdgeGlow;

    // ── Contenido ────────────────────────────────────────────
    if (uHasContent) {
      vec4 c = texture2D(tContent, vUv);
      col = mix(col, c.rgb, c.a);
    }

    gl_FragColor = vec4(col, shape * uOpacity);
  }
`;

const SHADOW_FRAG = /* glsl */ `
  precision mediump float;

  uniform float uAspect;
  uniform float uRadius;
  uniform float uSoftness;
  uniform float uOpacity;

  varying vec2 vUv;

  float sdRoundBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
  }

  void main() {
    vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
    float d = sdRoundBox(p, vec2(uAspect, 1.0) * 0.5 - uSoftness, uRadius);
    // Caída cuadrática: se parece mucho más a un desenfoque gaussiano real
    // que un smoothstep lineal, y sigue siendo una sola instrucción.
    float a = 1.0 - smoothstep(0.0, uSoftness, d);
    gl_FragColor = vec4(0.0, 0.0, 0.0, a * a * uOpacity);
  }
`;

const SHADOW_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

let PANEL_ID = 0;

export class GlassPanel {
  constructor({
    width = 2.2,
    height = 1.4,
    radius = 0.09,
    accent = PALETTE.cyan,
    tint = 0x9fd8ff,
    tintAmount = 0.22,
    dim = 0.38,
    floor = 0.028,
    edgeGlow = 0.85,
    contentTexture = null,
    shadow = true,
    interactive = false,
    name = `panel-${PANEL_ID++}`,
  } = {}) {
    this.width = width;
    this.height = height;
    this.interactive = interactive;

    this.group = new THREE.Group();
    this.group.name = name;

    /* ── Panel ──────────────────────────────────────────────── */
    this.geometry = new THREE.PlaneGeometry(width, height, 1, 1);

    this.uniforms = {
      tBlur: { value: null },
      tSharp: { value: null },
      tContent: { value: contentTexture },
      uHasContent: { value: !!contentTexture },
      uHasBackdrop: { value: false },
      uAspect: { value: width / height },
      // El radio se expresa en la misma unidad normalizada que la SDF
      // (altura = 1), así que hay que convertirlo desde unidades de mundo.
      uRadius: { value: radius / height },
      uFrost: { value: 1 },
      uDim: { value: dim },
      uRefraction: { value: 0.012 },
      uTint: { value: new THREE.Color(tint) },
      uTintAmount: { value: tintAmount },
      uFloor: { value: floor },
      uEdgeColor: { value: new THREE.Color(accent) },
      uEdgeWidth: { value: 0.004 },
      uEdgeGlow: { value: edgeGlow },
      uOpacity: { value: 0 },
      uHover: { value: 0 },
      uTime: { value: 0 },
      uStreak: { value: -1 },
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: PANEL_VERT,
      fragmentShader: PANEL_FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false, // objeto transparente: no debe escribir profundidad
      depthTest: true,
      side: THREE.DoubleSide, // visible durante el giro de entrada
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = `${name}-face`;
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
    this.group.add(this.mesh);

    /* ── Sombra proyectada ──────────────────────────────────── */
    if (shadow) {
      const pad = 0.5;
      this.shadowGeometry = new THREE.PlaneGeometry(width + pad, height + pad);
      this.shadowUniforms = {
        uAspect: { value: (width + pad) / (height + pad) },
        uRadius: { value: radius / height },
        uSoftness: { value: 0.16 },
        uOpacity: { value: 0 },
      };
      this.shadowMaterial = new THREE.ShaderMaterial({
        vertexShader: SHADOW_VERT,
        fragmentShader: SHADOW_FRAG,
        uniforms: this.shadowUniforms,
        transparent: true,
        depthWrite: false,
      });
      this.shadowMesh = new THREE.Mesh(this.shadowGeometry, this.shadowMaterial);
      // Separación en Z: es la distancia lo que se lee como altura.
      this.shadowMesh.position.set(0.06, -0.09, -0.2);
      this.shadowMesh.renderOrder = 9;
      this.shadowMesh.visible = false;
      this.group.add(this.shadowMesh);
    }

    this._revealed = false;
    this._streakTween = null;
  }

  /* ── Backdrop ──────────────────────────────────────────────── */

  setBackdrop(blurTexture, sharpTexture) {
    this.uniforms.tBlur.value = blurTexture;
    this.uniforms.tSharp.value = sharpTexture || blurTexture;
    this.uniforms.uHasBackdrop.value = !!blurTexture;
  }

  setContent(texture) {
    this.uniforms.tContent.value?.dispose?.();
    this.uniforms.tContent.value = texture;
    this.uniforms.uHasContent.value = !!texture;
  }

  /* ── Entrada y salida ──────────────────────────────────────── */

  /**
   * Aparición: el panel gira sobre X desde 90° (de canto, invisible) hasta
   * 0°, mientras el desenfoque del fondo sube de 0 a 1.
   *
   * El giro arranca en −90° y no en +90° para que el borde superior caiga
   * hacia el espectador: la lámina se "abate" en lugar de brotar del suelo,
   * que es como se lee un panel que se acerca.
   */
  reveal({ delay = 0, duration = 1.05 } = {}) {
    if (this._revealed) return null;
    this._revealed = true;
    this.mesh.visible = true;
    if (this.shadowMesh) this.shadowMesh.visible = true;

    this.mesh.rotation.x = -Math.PI / 2;
    this.uniforms.uOpacity.value = 0;
    this.uniforms.uFrost.value = 0;

    const tl = gsap.timeline({ delay });
    tl.to(this.mesh.rotation, { x: 0, duration, ease: 'power3.out' }, 0)
      .to(this.uniforms.uOpacity, { value: 1, duration: duration * 0.5, ease: 'power2.out' }, 0.06)
      // El fondo se congela a la vez que el panel se asienta.
      .to(this.uniforms.uFrost, { value: 1, duration: duration * 0.85, ease: 'power2.inOut' }, 0.1)
      .fromTo(
        this.group.position,
        { z: this.group.position.z - 0.35 },
        { z: this.group.position.z, duration, ease: 'power3.out' },
        0
      );

    if (this.shadowUniforms) {
      tl.fromTo(this.shadowUniforms.uOpacity, { value: 0 }, { value: 0.46, duration, ease: 'power2.out' }, 0.15);
    }

    // Barrido de luz que cruza el panel una vez, al final de la entrada.
    tl.fromTo(this.uniforms.uStreak, { value: -1.2 }, { value: 1.2, duration: 0.9, ease: 'power1.inOut' }, duration * 0.55);

    return tl;
  }

  conceal({ duration = 0.5 } = {}) {
    if (!this._revealed) return null;
    this._revealed = false;
    const tl = gsap.timeline({
      onComplete: () => {
        // Guarda contra transiciones solapadas: si un reveal posterior ya
        // ha vuelto a marcar el panel, este onComplete llega tarde y no
        // debe apagar lo que otro acaba de encender.
        if (this._revealed) return;
        this.mesh.visible = false;
        if (this.shadowMesh) this.shadowMesh.visible = false;
      },
    });
    tl.to(this.mesh.rotation, { x: Math.PI / 2.6, duration, ease: 'power2.in' }, 0)
      .to(this.uniforms.uOpacity, { value: 0, duration: duration * 0.8, ease: 'power2.in' }, 0);
    if (this.shadowUniforms) tl.to(this.shadowUniforms.uOpacity, { value: 0, duration: duration * 0.6 }, 0);
    return tl;
  }

  /* ── Estado ────────────────────────────────────────────────── */

  setHover(on) {
    gsap.to(this.uniforms.uHover, { value: on ? 1 : 0, duration: 0.35, ease: 'power2.out' });
    if (on && !this._streakTween?.isActive()) {
      this._streakTween = gsap.fromTo(
        this.uniforms.uStreak,
        { value: -1.2 },
        { value: 1.2, duration: 0.75, ease: 'power1.inOut' }
      );
    }
  }

  setAccent(color) {
    const c = new THREE.Color(color);
    gsap.to(this.uniforms.uEdgeColor.value, {
      r: c.r, g: c.g, b: c.b,
      duration: 0.45,
      ease: 'power2.out',
    });
  }

  update(dt, time) {
    this.uniforms.uTime.value = time;
  }

  get object3D() {
    return this.group;
  }

  dispose() {
    gsap.killTweensOf(this.uniforms.uOpacity);
    gsap.killTweensOf(this.uniforms.uFrost);
    gsap.killTweensOf(this.uniforms.uStreak);
    gsap.killTweensOf(this.uniforms.uHover);
    gsap.killTweensOf(this.mesh.rotation);
    gsap.killTweensOf(this.group.position);

    this.geometry.dispose();
    this.material.dispose();
    this.uniforms.tContent.value?.dispose?.();
    this.shadowGeometry?.dispose();
    this.shadowMaterial?.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}
