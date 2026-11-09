import * as THREE from 'three';
import { toCreasedNormals, mergeVertices, mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp } from '../utils/math.js';

/**
 * Zapatilla Volta — geometría procedural, pieza a pieza.
 *
 * Por qué procedural y no un .glb: el despiece del blueprint exige que cada
 * componente sea una malla independiente con su propio eje local de
 * separación. Construyéndola aquí, esa descomposición es el punto de
 * partida en vez de un trabajo de reetiquetado sobre un modelo ajeno.
 * (Hero.js acepta un .glb real si lo dejas en /public/models/ — ver allí.)
 *
 * MÉTODO. Cada pieza nace como una silueta 2D vista de perfil, se extruye a
 * lo ancho y después se REMODELA por vértice: la coordenada Z se escala por
 * dos perfiles, uno a lo largo del pie y otro en altura. Ese segundo paso es
 * lo que convierte una galleta extruida en un volumen que se estrecha en el
 * talón, ensancha en el metatarso y afila hacia la puntera.
 *
 * Sistema de coordenadas local:
 *   X  −1.5 talón  →  +1.5 puntera
 *   Y  −0.58 suelo →  +0.58 collar
 *   Z  ancho, simétrico respecto a 0
 */

export const SHOE = {
  minX: -1.5,
  maxX: 1.5,
  minY: -0.58,
  maxY: 0.58,
  halfWidth: 0.44,
};

/* ── Perfiles de sección ─────────────────────────────────────── */

/** Anchura relativa a lo largo del pie. El máximo está en el metatarso. */
const WIDTH_LUT = [
  [0.0, 0.62],
  [0.08, 0.8],
  [0.2, 0.9],
  [0.38, 0.99],
  [0.55, 1.0],
  [0.7, 0.95],
  [0.84, 0.8],
  [0.94, 0.62],
  [1.0, 0.4],
];

/** Anchura relativa en altura: el empeine y el collar se cierran. */
const ROUND_LUT = [
  [0.0, 0.9],
  [0.18, 1.0],
  [0.45, 0.99],
  [0.7, 0.9],
  [0.88, 0.74],
  [1.0, 0.6],
];

function sampleLUT(lut, t) {
  const x = clamp(t, 0, 1);
  for (let i = 1; i < lut.length; i++) {
    if (x <= lut[i][0]) {
      const [x0, y0] = lut[i - 1];
      const [x1, y1] = lut[i];
      const k = (x - x0) / Math.max(x1 - x0, 1e-6);
      // Suavizado hermite: sin él se ven facetas donde cambia la pendiente.
      const s = k * k * (3 - 2 * k);
      return y0 + (y1 - y0) * s;
    }
  }
  return lut[lut.length - 1][1];
}

/**
 * Aplica los perfiles y arregla las normales.
 *
 * toCreasedNormals() en lugar de computeVertexNormals(): ExtrudeGeometry
 * devuelve geometría no indexada, y promediar sus normales sin más suaviza
 * TAMBIÉN las aristas de 90° entre la pared lateral y el bisel, dejando un
 * aspecto de jabón derretido. toCreasedNormals suaviza sólo por debajo del
 * ángulo de pliegue y conserva las aristas duras.
 */
function reshape(geo, { widthScale = 1, offset = 0, crease = Math.PI / 3.2 } = {}) {
  const pos = geo.attributes.position;
  const spanX = SHOE.maxX - SHOE.minX;
  const spanY = SHOE.maxY - SHOE.minY;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);

    const w =
      sampleLUT(WIDTH_LUT, (x - SHOE.minX) / spanX) *
      sampleLUT(ROUND_LUT, (y - SHOE.minY) / spanY) *
      widthScale;

    const sign = z >= 0 ? 1 : -1;
    pos.setZ(i, z * w + sign * offset);
  }
  pos.needsUpdate = true;

  const merged = mergeVertices(geo, 1e-4);
  geo.dispose();
  const creased = toCreasedNormals(merged, crease);
  merged.dispose();
  creased.computeBoundingBox();
  creased.computeBoundingSphere();
  return creased;
}

/** Extrusión centrada en Z + remodelado. */
function extrude(shape, { depth, bevelSize = 0.04, bevelThickness = 0.035, bevelSegments = 4, curveSegments = 16, widthScale = 1, offset = 0, crease }) {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelSize,
    bevelThickness,
    bevelSegments,
    bevelOffset: 0,
    curveSegments,
    steps: 1,
  });
  geo.translate(0, 0, -depth / 2); // la extrusión nace en z=0..depth
  return reshape(geo, { widthScale, offset, crease });
}

/* ── Siluetas ────────────────────────────────────────────────── */

function outsoleShape() {
  const s = new THREE.Shape();
  s.moveTo(-1.44, -0.36);
  s.quadraticCurveTo(-1.5, -0.56, -1.3, -0.57); // redondeo del talón
  s.lineTo(0.92, -0.57);
  s.quadraticCurveTo(1.34, -0.56, 1.5, -0.42);  // toe spring: la punta sube
  s.quadraticCurveTo(1.54, -0.34, 1.42, -0.3);
  s.lineTo(1.2, -0.33);
  s.quadraticCurveTo(0.2, -0.4, -0.9, -0.36);
  s.quadraticCurveTo(-1.3, -0.34, -1.44, -0.36);
  return s;
}

function midsoleShape() {
  const s = new THREE.Shape();
  s.moveTo(-1.42, -0.33);
  s.quadraticCurveTo(-1.28, -0.38, -0.9, -0.37);
  s.quadraticCurveTo(0.2, -0.41, 1.22, -0.34);
  s.quadraticCurveTo(1.44, -0.31, 1.42, -0.19); // frente de la entresuela
  s.quadraticCurveTo(0.7, -0.15, 0.05, -0.11);  // cara superior…
  s.quadraticCurveTo(-0.75, -0.06, -1.2, 0.08); // …que trepa por el talón
  s.quadraticCurveTo(-1.44, 0.12, -1.46, -0.06);
  s.quadraticCurveTo(-1.47, -0.22, -1.42, -0.33);
  return s;
}

function upperShape() {
  const s = new THREE.Shape();
  // Talón: sube por detrás
  s.moveTo(-1.3, -0.02);
  s.quadraticCurveTo(-1.42, 0.2, -1.28, 0.38);
  // Collar: cresta y caída hacia delante
  s.quadraticCurveTo(-1.2, 0.5, -1.02, 0.5);
  s.bezierCurveTo(-0.82, 0.5, -0.6, 0.38, -0.34, 0.29);
  // Garganta (línea de cordones) bajando hacia la puntera
  s.quadraticCurveTo(-0.02, 0.19, 0.34, 0.12);
  s.quadraticCurveTo(0.72, 0.04, 1.0, -0.05);
  // Caja de la puntera
  s.quadraticCurveTo(1.26, -0.12, 1.36, -0.24);
  // Base: sigue la cara superior de la entresuela, solapando un poco
  s.quadraticCurveTo(1.38, -0.3, 1.2, -0.3);
  s.quadraticCurveTo(0.4, -0.22, -0.3, -0.17);
  s.quadraticCurveTo(-0.9, -0.12, -1.16, -0.06);
  s.quadraticCurveTo(-1.26, -0.04, -1.3, -0.02);
  return s;
}

function heelCounterShape() {
  const s = new THREE.Shape();
  s.moveTo(-1.3, -0.02);
  s.quadraticCurveTo(-1.42, 0.2, -1.28, 0.38);
  s.quadraticCurveTo(-1.18, 0.48, -1.0, 0.48);
  s.quadraticCurveTo(-0.86, 0.42, -0.82, 0.3);
  s.quadraticCurveTo(-0.94, 0.24, -1.02, 0.1);
  s.quadraticCurveTo(-1.08, -0.02, -1.06, -0.12);
  s.quadraticCurveTo(-1.2, -0.08, -1.3, -0.02);
  return s;
}

/** Placa lateral: la pieza de cromo que lleva el logo grabado. */
function sidePlateShape() {
  const s = new THREE.Shape();
  s.moveTo(-0.72, -0.12);
  s.bezierCurveTo(-0.5, 0.06, -0.1, 0.12, 0.3, 0.04);
  s.quadraticCurveTo(0.62, -0.02, 0.8, -0.14);
  s.quadraticCurveTo(0.72, -0.24, 0.5, -0.22);
  s.bezierCurveTo(0.1, -0.14, -0.28, -0.12, -0.56, -0.24);
  s.quadraticCurveTo(-0.7, -0.22, -0.72, -0.12);
  return s;
}

function toeCapShape() {
  const s = new THREE.Shape();
  s.moveTo(0.92, -0.06);
  s.quadraticCurveTo(1.24, -0.12, 1.36, -0.24);
  s.quadraticCurveTo(1.38, -0.3, 1.2, -0.3);
  s.quadraticCurveTo(1.02, -0.28, 0.86, -0.24);
  s.quadraticCurveTo(0.84, -0.14, 0.92, -0.06);
  return s;
}

function tongueShape() {
  const s = new THREE.Shape();
  s.moveTo(-0.44, 0.26);
  s.quadraticCurveTo(-0.2, 0.3, 0.06, 0.24);
  s.quadraticCurveTo(0.3, 0.18, 0.42, 0.1);
  s.quadraticCurveTo(0.3, 0.02, 0.06, 0.08);
  s.quadraticCurveTo(-0.2, 0.14, -0.46, 0.14);
  s.quadraticCurveTo(-0.5, 0.2, -0.44, 0.26);
  return s;
}

/* ── Construcción ────────────────────────────────────────────── */

/**
 * Devuelve un mapa de geometrías por nombre de pieza. Ninguna comparte
 * buffers, así que cada una puede llevar su propio material y moverse por
 * su cuenta durante el despiece.
 */
export function buildSneakerParts() {
  const W = SHOE.halfWidth * 2;

  const parts = {
    outsole: extrude(outsoleShape(), {
      depth: W * 1.0,
      bevelSize: 0.035,
      bevelThickness: 0.03,
      widthScale: 1.0,
    }),

    midsole: extrude(midsoleShape(), {
      depth: W * 0.98,
      bevelSize: 0.045,
      bevelThickness: 0.04,
      widthScale: 0.99,
      crease: Math.PI / 2.6, // más suave: es cristal, queremos reflejos limpios
    }),

    upper: extrude(upperShape(), {
      depth: W * 0.92,
      bevelSize: 0.06,
      bevelThickness: 0.05,
      bevelSegments: 5,
      curveSegments: 20,
      widthScale: 0.95,
    }),

    heelCounter: extrude(heelCounterShape(), {
      depth: W * 0.9,
      bevelSize: 0.02,
      bevelThickness: 0.018,
      widthScale: 0.98,
      offset: 0.012, // se apoya justo por fuera del upper
    }),

    toeCap: extrude(toeCapShape(), {
      depth: W * 0.9,
      bevelSize: 0.022,
      bevelThickness: 0.02,
      widthScale: 0.98,
      offset: 0.01,
    }),

    tongue: extrude(tongueShape(), {
      depth: W * 0.62,
      bevelSize: 0.03,
      bevelThickness: 0.028,
      widthScale: 0.86,
    }),
  };

  /* Placas laterales: no se remodelan con el perfil general porque son
     apliques planos. Se colocan a mano en cada flanco. */
  const plateGeo = new THREE.ExtrudeGeometry(sidePlateShape(), {
    depth: 0.04,
    bevelEnabled: true,
    bevelSize: 0.012,
    bevelThickness: 0.012,
    bevelSegments: 3,
    curveSegments: 18,
    steps: 1,
  });
  plateGeo.translate(0, 0, -0.02);
  parts.sidePlate = toCreasedNormals(mergeVertices(plateGeo, 1e-4), Math.PI / 3);
  plateGeo.dispose();

  /* Cámara de aire: dos lentes transversales dentro de la entresuela. Un
     cilindro tumbado sobre Z es la forma más honesta de leerlo como una
     cápsula que atraviesa la suela de lado a lado. */
  const air = new THREE.CylinderGeometry(0.115, 0.115, W * 0.86, 28, 1);
  air.rotateX(Math.PI / 2);
  parts.airHeel = air;

  const airF = new THREE.CylinderGeometry(0.075, 0.075, W * 0.78, 24, 1);
  airF.rotateX(Math.PI / 2);
  parts.airForefoot = airF;

  /* Cordones: cápsulas cruzando la garganta. Se generan en Hero.js porque
     necesitan una por par de ojales y comparten geometría vía InstancedMesh. */
  parts.lace = new THREE.CapsuleGeometry(0.022, 0.5, 6, 12);

  /* Ojales */
  parts.eyelet = new THREE.TorusGeometry(0.032, 0.011, 8, 20);

  return parts;
}

/**
 * Puntos de anclaje de los cordones sobre la línea de garganta, en local.
 * Se derivan de la misma curva que dibuja `upperShape`, así que si mueves la
 * silueta los cordones la siguen.
 */
export function laceAnchors(count = 5) {
  const out = [];
  const curve = new THREE.QuadraticBezierCurve(
    new THREE.Vector2(-0.34, 0.3),
    new THREE.Vector2(0.1, 0.19),
    new THREE.Vector2(0.62, 0.06)
  );
  for (let i = 0; i < count; i++) {
    const p = curve.getPoint(i / (count - 1));
    const xn = (p.x - SHOE.minX) / (SHOE.maxX - SHOE.minX);
    const yn = (p.y - SHOE.minY) / (SHOE.maxY - SHOE.minY);
    const halfZ = SHOE.halfWidth * sampleLUT(WIDTH_LUT, xn) * sampleLUT(ROUND_LUT, yn) * 0.9;
    out.push({ x: p.x, y: p.y, z: halfZ });
  }
  return out;
}

/* ── Geometría de catálogo (LOD) ─────────────────────────────── */

/**
 * Versión fusionada de la zapatilla para el catálogo.
 *
 * A tamaño de miniatura, ni el despiece ni los materiales por pieza aportan
 * nada: sólo cuestan draw calls. Así que fusionamos todo en UNA geometría y
 * horneamos el color de cada pieza en los vértices. Un solo material, un
 * solo buffer y —combinado con InstancedMesh— una única llamada de dibujo
 * para todo el catálogo.
 *
 * @param {'high'|'low'} detail  nivel de LOD
 */
export function buildCatalogGeometry(detail = 'high') {
  const hi = detail === 'high';
  const seg = hi ? { curve: 14, bevel: 3 } : { curve: 5, bevel: 1 };
  const W = SHOE.halfWidth * 2;

  const spec = [
    { shape: outsoleShape(), depth: W, color: 0x0c0c10, widthScale: 1.0 },
    { shape: midsoleShape(), depth: W * 0.98, color: 0x2e6f88, widthScale: 0.99 },
    { shape: upperShape(), depth: W * 0.92, color: 0x1a1d26, widthScale: 0.95 },
    { shape: heelCounterShape(), depth: W * 0.9, color: 0xb9c0cc, widthScale: 0.98, offset: 0.012 },
    { shape: toeCapShape(), depth: W * 0.9, color: 0xb9c0cc, widthScale: 0.98, offset: 0.01 },
  ];

  const pieces = spec.map(({ shape, depth, color, widthScale, offset = 0 }) => {
    const g = extrude(shape, {
      depth,
      bevelSize: hi ? 0.04 : 0.02,
      bevelThickness: hi ? 0.035 : 0.018,
      bevelSegments: seg.bevel,
      curveSegments: seg.curve,
      widthScale,
      offset,
    });

    // El color de la pieza va a los vértices: es lo que permite que un solo
    // material pinte suela negra, entresuela cian y placas cromadas.
    const c = new THREE.Color(color);
    const n = g.attributes.position.count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g;
  });

  // Las placas laterales, una por flanco.
  const plateSrc = new THREE.ExtrudeGeometry(sidePlateShape(), {
    depth: 0.04,
    bevelEnabled: true,
    bevelSize: 0.012,
    bevelThickness: 0.012,
    bevelSegments: seg.bevel,
    curveSegments: seg.curve,
    steps: 1,
  });
  plateSrc.translate(0, 0, -0.02);
  const plateBase = toCreasedNormals(mergeVertices(plateSrc, 1e-4), Math.PI / 3);
  plateSrc.dispose();

  for (const s of [1, -1]) {
    const g = plateBase.clone();
    g.translate(0, 0, s * SHOE.halfWidth * 0.93);
    const c = new THREE.Color(0xe6ebf2);
    const n = g.attributes.position.count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    pieces.push(g);
  }
  plateBase.dispose();

  const merged = mergeGeometries(pieces, false);
  pieces.forEach((g) => g.dispose());

  merged.center();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/** Puntos de interés para los hotspots, en espacio local del modelo. */
export const HOTSPOTS = [
  {
    id: 'air',
    position: new THREE.Vector3(-1.05, -0.18, 0.34),
    title: 'Cámara Volta',
    body: 'Lente de aire presurizado a 18 psi, visible a través de la entresuela de policarbonato.',
  },
  {
    id: 'plate',
    position: new THREE.Vector3(0.06, 0.02, 0.46),
    title: 'Placa lateral',
    body: 'Aleación de aluminio con logotipo grabado por láser a 40 µm de profundidad.',
  },
  {
    id: 'outsole',
    position: new THREE.Vector3(0.62, -0.52, 0.18),
    title: 'Tracción radial',
    body: 'Caucho de alta abrasión con patrón radial de 4 mm. Adherencia en seco y mojado.',
  },
  {
    id: 'collar',
    position: new THREE.Vector3(-1.05, 0.44, 0.2),
    title: 'Collar acolchado',
    body: 'Espuma de memoria de densidad variable envuelta en malla técnica sin costuras.',
  },
];
