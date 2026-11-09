import * as THREE from 'three';
import gsap from 'gsap';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

import { buildSneakerParts, laceAnchors, SHOE, HOTSPOTS } from './SneakerGeometry.js';
import {
  createGlass,
  createChrome,
  createMatteBlack,
  createTechnicalMesh,
  createEtchedPlate,
  createNeon,
  applyEdgeGlow,
  applyColorWave,
} from '../materials/index.js';
import { getColorway, PALETTE } from '../materials/palette.js';
import { disposeHierarchy } from '../utils/dispose.js';
import { damp } from '../utils/math.js';

/**
 * Hero — el protagonista.
 *
 * JERARQUÍA. Cada transformación vive en su propio nivel para que ninguna
 * pise a otra. Es la diferencia entre poder combinar cuatro animaciones y
 * pasarte la tarde peleando con matrices:
 *
 *   root   → posición y escala de sección (SceneDirector / scroll)
 *     float  → flotación sinusoidal en Y (ingravidez)
 *       tilt   → inclinación reactiva al cursor
 *         spin   → rotación idle continua en Y
 *           model  → las piezas, cada una con su offset de despiece
 *
 * Si el spin viviera en el root, la flotación giraría con él y el objeto
 * describiría un cono en vez de subir y bajar.
 */

const IDLE_SPIN = 0.01 * Math.PI * 2; // ~0.063 rad/s — la "rotación lenta" del brief
const FLOAT_AMPLITUDE = 0.055;
const FLOAT_PERIOD = 4.6;

/** Dirección de separación de cada pieza, en el espacio local del modelo. */
const EXPLODE = {
  outsole: [0, -1.0, 0],
  midsole: [0, -0.42, 0],
  airHeel: [-0.75, -0.62, 0],
  airForefoot: [0.62, -0.6, 0],
  upper: [0, 0.46, 0],
  heelCounter: [-1.0, 0.22, 0],
  toeCap: [0.95, 0.1, 0],
  tongue: [-0.12, 0.92, 0],
  plateL: [0, 0.12, 1.0],
  plateR: [0, 0.12, -1.0],
  laces: [0, 1.25, 0],
};

export class Hero {
  constructor(scene, quality, { envMap, pointer } = {}) {
    this.scene = scene;
    this.quality = quality;
    this.envMap = envMap;
    this.pointer = pointer;

    this.root = new THREE.Group();
    this.root.name = 'hero';
    this.float = new THREE.Group();
    this.tilt = new THREE.Group();
    this.spin = new THREE.Group();
    this.model = new THREE.Group();

    this.root.add(this.float);
    this.float.add(this.tilt);
    this.tilt.add(this.spin);
    this.spin.add(this.model);
    scene.add(this.root);

    this.parts = new Map();     // nombre → Mesh
    this.materials = new Map(); // nombre → Material
    this._geometries = [];

    this.spinSpeed = IDLE_SPIN;
    this.targetSpinSpeed = IDLE_SPIN;
    this.exploded = false;
    this.interactive = true;
    this.colorwayId = 'cyan';

    this._floatPhase = Math.random() * Math.PI * 2;
    this._tiltTarget = new THREE.Vector2();
    this._loaders = null;
  }

  /* ═════════════════════════════════════════════════════════════
     Carga
     ═══════════════════════════════════════════════════════════ */

  /**
   * Intenta cargar un modelo real; si no existe, construye el procedural.
   *
   * Deja un archivo en `public/models/volta.glb` con las mallas nombradas
   * como las claves de EXPLODE (outsole, midsole, upper, …) y sustituye al
   * procedural sin tocar una línea. Los decodificadores Draco y KTX2 se
   * sirven en local desde /public, no desde un CDN externo.
   */
  async load(renderer, onProgress) {
    const url = 'models/volta.glb';
    try {
      const head = await fetch(url, { method: 'HEAD' });
      if (head.ok) {
        await this._loadGLB(url, renderer, onProgress);
        this._afterBuild();
        return 'glb';
      }
    } catch {
      /* sin red o sin archivo: seguimos con el procedural */
    }

    this._buildProcedural(onProgress);
    this._afterBuild();
    return 'procedural';
  }

  async _loadGLB(url, renderer, onProgress) {
    // Sin setDecoderPath / setTranscoderPath a propósito. Desde r185 ambos
    // loaders resuelven sus decodificadores con `new URL(..., import.meta
    // .url)`, así que el bundler los emite y versiona por su cuenta. Fijar
    // una ruta relativa a mano los sacaría de ese mecanismo y rompería en
    // cuanto la app no se sirva desde la raíz del dominio.
    const draco = new DRACOLoader();
    const ktx2 = new KTX2Loader().detectSupport(renderer);
    const loader = new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx2);
    this._loaders = { draco, ktx2 };

    const gltf = await loader.loadAsync(url, (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    });

    gltf.scene.traverse((n) => {
      if (!n.isMesh) return;
      n.castShadow = true;
      n.receiveShadow = true;
      if (n.material && 'envMap' in n.material) {
        n.material.envMapIntensity = 1.1;
      }
      const key = n.name.replace(/[^a-zA-Z]/g, '');
      this.parts.set(key, n);
      this.materials.set(key, n.material);
    });

    this.model.add(gltf.scene);
    this._normalizeScale(gltf.scene);
  }

  /** Reescala un GLB desconocido al mismo volumen que el procedural. */
  _normalizeScale(obj) {
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3();
    box.getSize(size);
    const target = SHOE.maxX - SHOE.minX;
    const k = size.x > 1e-4 ? target / size.x : 1;
    obj.scale.setScalar(k);
    box.setFromObject(obj);
    const center = new THREE.Vector3();
    box.getCenter(center);
    obj.position.sub(center);
  }

  /* ═════════════════════════════════════════════════════════════
     Construcción procedural
     ═══════════════════════════════════════════════════════════ */

  _buildProcedural(onProgress) {
    const cw = getColorway(this.colorwayId);
    const geo = buildSneakerParts();
    this._geometries = Object.values(geo);
    onProgress?.(0.4);

    const add = (name, geometry, material, { cast = true, receive = true } = {}) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = name;
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      mesh.userData.home = mesh.position.clone();
      mesh.userData.explode = new THREE.Vector3(...(EXPLODE[name] || [0, 0, 0]));
      this.model.add(mesh);
      this.parts.set(name, mesh);
      this.materials.set(name, material);
      return mesh;
    };

    /* ── Suela: caucho mate. Es la masa oscura que ancla la silueta. ── */
    const outsoleMat = createMatteBlack({ color: cw.sole, roughness: 0.88, metalness: 0.12, repeat: 6 });
    add('outsole', geo.outsole, outsoleMat);

    /* ── Entresuela: la pieza de cristal. Aquí vive el look. ────────── */
    const midsoleMat = createGlass({
      // 0.15 es el tope del rango del brief (0.05–0.15). La entresuela es
      // la superficie de cristal más grande de la escena y la que más
      // ángulos rasantes ofrece al girar; con 0.05 el especular es un punto
      // ciego que sobreexpone en cuanto el modelo se pone de frente.
      roughness: 0.15,
      ior: 1.5,
      thickness: 0.7,
      iridescence: 0.1,
      attenuationColor: cw.accent,
      attenuationDistance: 1.6,
    });
    // power alto = filo estrecho. Con exponentes bajos el término de
    // Fresnel enciende toda la cara vista en escorzo, y en una entresuela
    // eso es una superficie grande: deja de ser una arista brillante y se
    // convierte en una pieza autoiluminada que el bloom vuelve una bola de
    // fuego. El brief pide 1 px de arista, no un panel de luz.
    applyEdgeGlow(midsoleMat, { color: cw.accent, power: 7.5, strength: 0.65 });
    const midsole = add('midsole', geo.midsole, midsoleMat, { receive: false });
    midsole.renderOrder = 2;

    /* ── Cámaras de aire ────────────────────────────────────────────
       Un cilindro de cristal pulido dentro de la suela se comporta como
       lo que ópticamente es: una LENTE. Concentraba la key light en un
       punto y el bloom lo convertía en un fogonazo que se comía la
       puntera. La solución no es bajar el bloom —eso mataría el resto de
       la escena— sino que la pieza difunda en vez de enfocar: más
       rugosidad, menos transmisión y una emisión propia muy tenue que la
       hace legible como cámara presurizada sin depender de reflejos. */
    const airMat = createGlass({
      roughness: 0.24,
      ior: 1.42,
      thickness: 0.18,
      transmission: 0.55,
      attenuationColor: cw.accent,
      attenuationDistance: 0.55,
      iridescence: 0.22,
    });
    airMat.emissive = new THREE.Color(cw.accent);
    airMat.emissiveIntensity = 0.1;
    airMat.clearcoat = 0.25;
    airMat.iridescence = 0;
    applyEdgeGlow(airMat, { color: cw.accent, power: 6.0, strength: 0.4 });
    const airH = add('airHeel', geo.airHeel, airMat, { cast: false, receive: false });
    airH.position.set(-1.02, -0.2, 0);
    airH.userData.home.copy(airH.position);
    const airF = add('airForefoot', geo.airForefoot, airMat, { cast: false, receive: false });
    airF.position.set(0.72, -0.24, 0);
    airF.userData.home.copy(airF.position);

    /* ── Upper: malla técnica. Recibe la onda de color del configurador. ── */
    const upperMat = createTechnicalMesh({ color: cw.upper, repeat: 5 });
    applyColorWave(upperMat, { axis: 'x', min: SHOE.minX, max: SHOE.maxX, waveColor: cw.accent });
    add('upper', geo.upper, upperMat);

    /* ── Cromo: contrafuerte y puntera. ─────────────────────────────── */
    const chromeMat = createChrome({ color: cw.plate, roughness: cw.plateRough });
    chromeMat.metalness = cw.plateMetal;
    applyColorWave(chromeMat, { axis: 'x', min: SHOE.minX, max: SHOE.maxX, waveColor: cw.accent });
    add('heelCounter', geo.heelCounter, chromeMat);
    add('toeCap', geo.toeCap, chromeMat);

    /* ── Lengüeta ───────────────────────────────────────────────────── */
    const tongueMat = createMatteBlack({ color: cw.upper, roughness: 0.72, metalness: 0.18, repeat: 3 });
    applyColorWave(tongueMat, { axis: 'x', min: SHOE.minX, max: SHOE.maxX, waveColor: cw.accent });
    add('tongue', geo.tongue, tongueMat);

    /* ── Placas laterales con logotipo grabado, una por flanco. ─────── */
    const plateMat = createEtchedPlate({ color: cw.plate, text: 'NOCTURNE' });
    plateMat.metalness = cw.plateMetal;
    plateMat.roughness = Math.max(cw.plateRough, 0.08);
    applyColorWave(plateMat, { axis: 'x', min: SHOE.minX, max: SHOE.maxX, waveColor: cw.accent });

    const zPlate = SHOE.halfWidth * 0.93;
    const pL = add('plateL', geo.sidePlate, plateMat);
    pL.position.z = zPlate;
    pL.userData.home.copy(pL.position);
    const pR = add('plateR', geo.sidePlate, plateMat);
    pR.position.z = -zPlate;
    pR.rotation.y = Math.PI;
    pR.userData.home.copy(pR.position);

    onProgress?.(0.75);

    /* ── Cordones: una sola InstancedMesh para los ocho tramos. ─────── */
    this._buildLaces(geo, cw);

    onProgress?.(0.95);
  }

  /**
   * Cordones cruzados. Ocho cápsulas idénticas con matrices distintas: un
   * InstancedMesh en vez de ocho meshes es una draw call en lugar de ocho,
   * y aquí la geometría es literalmente la misma.
   */
  _buildLaces(geo, cw) {
    const anchors = laceAnchors(5);
    const segments = [];
    for (let i = 0; i < anchors.length - 1; i++) {
      const a = anchors[i];
      const b = anchors[i + 1];
      // Cruzado en X: de un ojal al del lado contrario de la fila siguiente.
      segments.push([new THREE.Vector3(a.x, a.y, a.z), new THREE.Vector3(b.x, b.y, -b.z)]);
      segments.push([new THREE.Vector3(a.x, a.y, -a.z), new THREE.Vector3(b.x, b.y, b.z)]);
    }

    const laceMat = createMatteBlack({ color: 0x1b1d24, roughness: 0.9, metalness: 0.05, repeat: 2 });
    const mesh = new THREE.InstancedMesh(geo.lace, laceMat, segments.length);
    mesh.name = 'laces';
    mesh.castShadow = true;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const dir = new THREE.Vector3();
    const mid = new THREE.Vector3();
    const scale = new THREE.Vector3(1, 1, 1);
    const BASE_LEN = 0.5 + 0.022 * 2; // altura del cilindro + los dos casquetes

    segments.forEach(([a, b], i) => {
      dir.subVectors(b, a);
      const len = dir.length();
      mid.copy(a).addScaledVector(dir, 0.5);
      q.setFromUnitVectors(up, dir.normalize());
      scale.set(1, len / BASE_LEN, 1);
      m.compose(mid, q, scale);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();

    mesh.userData.home = new THREE.Vector3();
    mesh.userData.explode = new THREE.Vector3(...EXPLODE.laces);
    this.model.add(mesh);
    this.parts.set('laces', mesh);
    this.materials.set('laces', laceMat);

    /* Ojales metálicos sobre la línea de garganta. */
    const eyeMat = createChrome({ color: 0xc8ccd6, roughness: 0.18, anisotropyMap: false });
    const eyelets = new THREE.InstancedMesh(geo.eyelet, eyeMat, anchors.length * 2);
    eyelets.name = 'eyelets';
    let k = 0;
    for (const a of anchors) {
      for (const s of [1, -1]) {
        m.compose(
          new THREE.Vector3(a.x, a.y, a.z * s),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)),
          new THREE.Vector3(1, 1, 1)
        );
        eyelets.setMatrixAt(k++, m);
      }
    }
    eyelets.instanceMatrix.needsUpdate = true;
    eyelets.computeBoundingSphere();
    eyelets.userData.home = new THREE.Vector3();
    eyelets.userData.explode = new THREE.Vector3(0, 1.1, 0);
    this.model.add(eyelets);
    this.parts.set('eyelets', eyelets);
    this.materials.set('eyelets', eyeMat);
  }

  /* ═════════════════════════════════════════════════════════════
     Post-construcción
     ═══════════════════════════════════════════════════════════ */

  _afterBuild() {
    // El envMap debe llegar a todos los materiales: sin él, el cromo es negro.
    for (const mat of this.materials.values()) {
      if ('envMap' in mat) {
        mat.envMap = this.envMap || null;
        mat.needsUpdate = true;
      }
    }

    // Caja envolvente real del modelo montado; la usan el encuadre y el LOD.
    this.bounds = new THREE.Box3().setFromObject(this.model);
    this.radius = this.bounds.getBoundingSphere(new THREE.Sphere()).radius;

    // El modelo debe apoyar visualmente en y≈0 dentro de su grupo.
    this.model.position.y = -this.bounds.min.y * 0.35;
  }

  /* ═════════════════════════════════════════════════════════════
     Interacción
     ═══════════════════════════════════════════════════════════ */

  /**
   * Despiece. Cada pieza se separa por SU eje local, no radialmente desde
   * el centro: una suela se cae hacia abajo y una placa lateral se despega
   * de lado, y esa lógica es la que hace que el conjunto se lea como un
   * despiece técnico y no como una explosión.
   *
   * El stagger va de dentro hacia fuera para que la pieza grande arranque
   * primero y las pequeñas la persigan.
   */
  setExploded(on, { amount = 1, duration = 0.9 } = {}) {
    if (this.exploded === on) return;
    this.exploded = on;

    const order = [
      'upper', 'tongue', 'laces', 'eyelets',
      'plateL', 'plateR', 'heelCounter', 'toeCap',
      'midsole', 'airHeel', 'airForefoot', 'outsole',
    ];

    const tl = gsap.timeline();
    order.forEach((name, i) => {
      const p = this.parts.get(name);
      if (!p) return;
      const home = p.userData.home || new THREE.Vector3();
      const dir = p.userData.explode || new THREE.Vector3();
      const target = on
        ? { x: home.x + dir.x * amount * 0.55, y: home.y + dir.y * amount * 0.55, z: home.z + dir.z * amount * 0.55 }
        : { x: home.x, y: home.y, z: home.z };

      tl.to(
        p.position,
        {
          ...target,
          duration,
          ease: on ? 'power3.out' : 'power2.inOut',
        },
        i * 0.035
      );
    });

    // Al despiezar, la rotación se detiene: hay que poder LEER las piezas.
    this.targetSpinSpeed = on ? 0 : IDLE_SPIN;
    return tl;
  }

  /** Detiene / reanuda la rotación idle con suavidad (mouse-over). */
  setSpinning(on) {
    this.targetSpinSpeed = on ? IDLE_SPIN : 0;
  }

  /**
   * Cambio de colorway. La onda recorre el eje X (talón → puntera) en 0.5 s
   * dejando el material nuevo detrás. Ver applyColorWave() en materials/.
   */
  setColorway(id, { duration = 0.5 } = {}) {
    const cw = getColorway(id);
    if (cw.id === this.colorwayId) return null;
    this.colorwayId = cw.id;

    const tl = gsap.timeline();

    const targets = {
      upper: { color: cw.upper, rough: 0.62, metal: 0.15 },
      tongue: { color: cw.upper, rough: 0.72, metal: 0.18 },
      heelCounter: { color: cw.plate, rough: cw.plateRough, metal: cw.plateMetal },
      toeCap: { color: cw.plate, rough: cw.plateRough, metal: cw.plateMetal },
      plateL: { color: cw.plate, rough: Math.max(cw.plateRough, 0.08), metal: cw.plateMetal },
    };

    const seen = new Set();
    for (const [name, spec] of Object.entries(targets)) {
      const mat = this.materials.get(name);
      const u = mat?.userData?.waveUniforms;
      // heelCounter y toeCap COMPARTEN material: animarlo dos veces haría
      // que el segundo tween reiniciara el primero a mitad de recorrido.
      if (!u || seen.has(mat)) continue;
      seen.add(mat);

      u.uColorFrom.value.copy(mat.color);
      u.uColorTo.value.set(spec.color);
      u.uRoughTo.value = spec.rough;
      u.uMetalTo.value = spec.metal;
      u.uWaveColor.value.set(cw.accent);
      u.uWave.value = 0;

      tl.to(u.uWave, { value: 1, duration, ease: 'power1.inOut' }, 0);
      tl.fromTo(
        u.uWaveIntensity,
        { value: 0 },
        { value: 3.2, duration: duration * 0.35, ease: 'power2.out', yoyo: true, repeat: 1 },
        0
      );
      tl.set(
        u.uWaveIntensity,
        { value: 0 },
        duration
      );
      // Al terminar consolidamos el material: color real actualizado y
      // uColorFrom = uColorTo, con lo que el ratio del shader vuelve a 1.
      tl.call(
        () => {
          mat.color.set(spec.color);
          mat.roughness = spec.rough;
          if ('metalness' in mat) mat.metalness = spec.metal;
          u.uColorFrom.value.copy(mat.color);
        },
        null,
        duration
      );
    }

    // Los cristales y los bordes cambian de acento sin onda: son luz, no
    // superficie, y una transición dura ahí se lee como un parpadeo.
    const accent = new THREE.Color(cw.accent);
    const rgb = { r: accent.r, g: accent.g, b: accent.b, duration: 0.45, ease: 'power1.out' };
    const touched = new Set();
    for (const name of ['midsole', 'airHeel', 'airForefoot']) {
      const mat = this.materials.get(name);
      if (!mat || touched.has(mat)) continue;
      touched.add(mat);
      const eu = mat.userData?.edgeUniforms;
      // Tweenamos r/g/b explícitamente: THREE.Color lleva un flag isColor
      // que GSAP intentaría interpolar si le pasáramos el objeto entero.
      if (eu) tl.to(eu.uEdgeColor.value, rgb, 0);
      if (mat.attenuationColor) tl.to(mat.attenuationColor, rgb, 0);
    }

    return tl;
  }

  /** Posición mundial de un hotspot, para el encuadre de plano detalle. */
  getHotspotWorld(id, out = new THREE.Vector3()) {
    const spec = HOTSPOTS.find((h) => h.id === id);
    if (!spec) return out;
    return out.copy(spec.position).applyMatrix4(this.model.matrixWorld);
  }

  /* ═════════════════════════════════════════════════════════════
     Bucle
     ═══════════════════════════════════════════════════════════ */

  update(dt, time) {
    // Rotación idle: la velocidad se amortigua, no se corta. Un objeto con
    // masa no puede pasar de girar a estar quieto en un frame.
    this.spinSpeed = damp(this.spinSpeed, this.targetSpinSpeed, 3.2, dt);
    this.spin.rotation.y += this.spinSpeed * dt;

    // Flotación: seno puro en Y. Amplitud pequeña y periodo largo; si se
    // nota el ritmo, deja de leerse como ingravidez y parece un flotador.
    this.float.position.y = Math.sin(time * ((Math.PI * 2) / FLOAT_PERIOD) + this._floatPhase) * FLOAT_AMPLITUDE;

    // Inclinación reactiva al cursor: el objeto "mira" hacia el puntero.
    if (this.pointer && this.interactive) {
      this._tiltTarget.set(this.pointer.smoothNdc.y * 0.09, this.pointer.smoothNdc.x * 0.13);
      this.tilt.rotation.x = damp(this.tilt.rotation.x, this._tiltTarget.x, 3, dt);
      this.tilt.rotation.z = damp(this.tilt.rotation.z, -this._tiltTarget.y * 0.4, 3, dt);
    }

    // Pulso de los bordes emissive, ligado al reloj global.
    for (const mat of this.materials.values()) {
      const eu = mat.userData?.edgeUniforms;
      if (eu) eu.uEdgeTime.value = time;
    }
  }

  dispose() {
    gsap.killTweensOf(this.root.position);
    for (const p of this.parts.values()) gsap.killTweensOf(p.position);
    for (const mat of this.materials.values()) {
      const u = mat.userData?.waveUniforms;
      if (u) {
        gsap.killTweensOf(u.uWave);
        gsap.killTweensOf(u.uWaveIntensity);
      }
    }
    this._loaders?.draco?.dispose();
    this._loaders?.ktx2?.dispose();
    disposeHierarchy(this.root);
    this.parts.clear();
    this.materials.clear();
  }
}

export { HOTSPOTS };
