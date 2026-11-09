import * as THREE from 'three';
import { PALETTE } from '../materials/palette.js';

/**
 * Environment — la cúpula de oscuridad y el HDRI que la acompaña.
 *
 * Dos cosas distintas que suelen confundirse:
 *
 *  1. El FONDO VISIBLE. Una SphereGeometry gigante invertida con un shader
 *     de degradado. Nunca un color plano: el negro liso mata la profundidad
 *     y hace que los objetos floten sobre un vacío sin escala.
 *
 *  2. El ENTORNO DE ILUMINACIÓN. Un HDRI generado en tiempo de carga —sin
 *     descargar un .hdr de 8 MB— renderizando una escena de estudio a un
 *     cubemap y pasándolo por PMREMGenerator. Sin esto, `metalness: 1.0` y
 *     `roughness: 0.0` producen un objeto negro: el cromo no tiene color
 *     propio, sólo refleja, y si no hay nada que reflejar no hay nada que ver.
 */

const DOME_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    // La cúpula viaja con la cámara: es un cielo, no un objeto de la escena.
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const DOME_FRAG = /* glsl */ `
  precision highp float;

  uniform vec3  uZenith;
  uniform vec3  uHorizon;
  uniform vec3  uViolet;
  uniform vec3  uCyan;
  uniform float uTime;
  uniform float uIntensity;

  varying vec3 vDir;

  // Hash barato para el dithering final.
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  void main() {
    vec3 d = normalize(vDir);

    // Degradado vertical principal: violeta profundo abajo, obsidiana arriba.
    float t = smoothstep(-0.5, 0.62, d.y);
    vec3 col = mix(uHorizon, uZenith, t);

    // Halo concentrado en la línea del horizonte.
    float band = exp(-abs(d.y) * 4.2);
    col += uHorizon * band * 0.45;

    // Dos focos azimutales que derivan muy despacio. Son los que hacen que
    // el fondo no se lea como una textura fija cuando la cámara orbita.
    float az = atan(d.z, d.x);
    float aV = uTime * 0.021;
    float aC = 3.14159 + uTime * -0.017;
    col += uViolet * exp(-abs(d.y) * 2.6) * pow(max(0.0, cos(az - aV)), 6.0) * 0.30;
    col += uCyan   * exp(-abs(d.y) * 3.1) * pow(max(0.0, cos(az - aC)), 8.0) * 0.16;

    // Caída hacia el cenit: el techo del mundo debe ser casi negro puro.
    col *= mix(1.0, 0.45, smoothstep(0.35, 1.0, d.y));

    col *= uIntensity;

    // Dithering. En un degradado tan oscuro y tan largo, 8 bits por canal
    // producen bandas visibles; un cuarto de LSB de ruido las disuelve.
    col += (hash(gl_FragCoord.xy) - 0.5) * (1.0 / 255.0);

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export class Environment {
  constructor(scene, renderer, quality) {
    this.scene = scene;
    this.renderer = renderer;
    this.quality = quality;

    scene.background = new THREE.Color(PALETTE.obsidian);

    this._buildDome();
    this._buildEnvMap();
  }

  /* ── 1. Fondo visible ──────────────────────────────────────── */

  _buildDome() {
    const geo = new THREE.SphereGeometry(260, 48, 32);

    this.domeMaterial = new THREE.ShaderMaterial({
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      uniforms: {
        uZenith: { value: new THREE.Color(PALETTE.obsidian) },
        uHorizon: { value: new THREE.Color(PALETTE.violetDeep) },
        uViolet: { value: new THREE.Color(PALETTE.violet) },
        uCyan: { value: new THREE.Color(PALETTE.cyan) },
        uTime: { value: 0 },
        uIntensity: { value: 1 },
      },
      side: THREE.BackSide,
      depthWrite: false, // nunca debe ocluir nada
      depthTest: false,
      fog: false,
      toneMapped: true,
    });

    this.dome = new THREE.Mesh(geo, this.domeMaterial);
    this.dome.renderOrder = -1000;
    this.dome.frustumCulled = false;
    this.dome.name = 'dome';
    this.scene.add(this.dome);
  }

  /* ── 2. HDRI procedural ────────────────────────────────────── */

  /**
   * Monta una escena de estudio en miniatura y la hornea a un envMap
   * prefiltrado. Los "softbox" son planos emissive: al pasar por PMREM se
   * convierten en reflejos con forma reconocible, que es justo lo que hace
   * que el cromo parezca cromo y no plástico gris.
   */
  _buildEnvMap() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();

    const envScene = new THREE.Scene();
    const disposables = [];

    // Cúpula del entorno: mismo degradado, para que el vidrio refracte el
    // mismo cielo que vemos de fondo.
    const domeGeo = new THREE.SphereGeometry(60, 32, 24);
    const domeMat = this.domeMaterial.clone();
    domeMat.uniforms = THREE.UniformsUtils.clone(this.domeMaterial.uniforms);
    domeMat.uniforms.uIntensity.value = 1.6;
    domeMat.depthTest = true;
    domeMat.depthWrite = true;
    const envDome = new THREE.Mesh(domeGeo, domeMat);
    envScene.add(envDome);
    disposables.push(domeGeo, domeMat);

    /** Panel emissive plano: un softbox de estudio. */
    const panel = (color, intensity, w, h, pos, lookAt) => {
      const g = new THREE.PlaneGeometry(w, h);
      const m = new THREE.MeshBasicMaterial({
        color: new THREE.Color(color).multiplyScalar(intensity),
        side: THREE.DoubleSide,
        toneMapped: false, // es una fuente de luz, no una superficie
      });
      const mesh = new THREE.Mesh(g, m);
      mesh.position.copy(pos);
      mesh.lookAt(lookAt || new THREE.Vector3(0, 0, 0));
      envScene.add(mesh);
      disposables.push(g, m);
      return mesh;
    };

    const O = new THREE.Vector3(0, 0, 0);

    // Key: softbox grande y blanco arriba-delante. Da el reflejo ancho
    // que define la forma general del objeto.
    panel(0xffffff, 1.8, 26, 16, new THREE.Vector3(-6, 20, 12), O);

    // Rim violeta detrás-izquierda / rim cian detrás-derecha. Son los que
    // dibujan el contorno neón sobre el fondo negro.
    panel(PALETTE.violet, 2.4, 14, 26, new THREE.Vector3(-22, 5, -16), O);
    panel(PALETTE.cyan, 2.0, 14, 26, new THREE.Vector3(22, 5, -16), O);

    // Fill frío y muy tenue desde abajo: separa la suela del suelo negro.
    panel(0x2a3550, 0.6, 30, 30, new THREE.Vector3(0, -14, 4), O);

    // Barras finas de alta frecuencia. En el cromo se leen como los tubos
    // fluorescentes de un plató; sin ellas los reflejos son masas suaves
    // sin información y el metal pierde todo el "punch".
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.4;
      panel(
        0xffffff,
        1.3 + (i % 2) * 0.9,
        0.9,
        30,
        new THREE.Vector3(Math.cos(a) * 24, 3 + (i % 3) * 4, Math.sin(a) * 24),
        O
      );
    }

    // sigma > 0 desenfoca ligeramente la base: evita el aliasing de reflejo
    // que producen los bordes duros de los planos al girar el objeto.
    const rt = pmrem.fromScene(envScene, 0.035, 0.1, 120);
    this.envMap = rt.texture;
    this.envRT = rt;

    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = 0.85;

    // El PMREM ya está horneado: todo lo demás sobra en VRAM.
    disposables.forEach((d) => d.dispose());
    envScene.clear();
    pmrem.dispose();
  }

  /* ── Ciclo ─────────────────────────────────────────────────── */

  update(time, cameraPosition) {
    this.domeMaterial.uniforms.uTime.value = time;
    // La cúpula sigue a la cámara para que nunca se pueda "salir" del mundo.
    if (cameraPosition) this.dome.position.copy(cameraPosition);
  }

  /** Atenúa el fondo (lo usa el plano detalle para aislar el producto). */
  setIntensity(v) {
    this.domeMaterial.uniforms.uIntensity.value = v;
  }

  dispose() {
    this.dome.geometry.dispose();
    this.domeMaterial.dispose();
    this.dome.removeFromParent();
    this.envRT?.dispose();
    this.scene.environment = null;
  }
}
