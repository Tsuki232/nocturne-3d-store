import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { anodizedNormal, meshNormal, roughnessBreakup, etchedLogoNormal } from './textures.js';

/**
 * Materiales core de la dirección de arte.
 *
 * Tres familias, y el contraste entre ellas es lo que sostiene el look:
 *
 *   CRISTAL  — casi todo lo que ves a través de él. Transmission 0.95.
 *   CROMO    — no tiene color propio; es 100% reflejo del entorno.
 *   MATE     — absorbe. Son las zonas de descanso visual, sin ellas la
 *              escena se convierte en una sopa de brillos sin jerarquía.
 *
 * Sobre esas bases se inyectan dos efectos por shader (ver más abajo):
 * el borde emissive y la onda de cambio de color.
 */

/* ═══════════════════════════════════════════════════════════════
   1. CRISTAL
   ═══════════════════════════════════════════════════════════════ */

/**
 * @param {object} o
 * @param {number} o.roughness  0.05 pulido espejo · 0.15 con "agarre"
 * @param {number} o.ior        1.45 acrílico · 1.52 cristal óptico
 * @param {number} o.thickness  grosor aparente; alimenta la absorción
 */
export function createGlass({
  color = 0xffffff,
  roughness = 0.08,
  ior = 1.48,
  thickness = 0.55,
  transmission = 0.95,
  attenuationColor = PALETTE.cyan,
  attenuationDistance = 2.4,
  iridescence = 0.18,
  reflectivity = 0.55,
  side = THREE.FrontSide,
} = {}) {
  const m = new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0,
    roughness,
    transmission,
    ior,
    thickness,
    reflectivity,
    // La atenuación es lo que tiñe el interior del vidrio según su grosor:
    // un canto fino sale casi incoloro y una masa gruesa, cian intenso.
    attenuationColor: new THREE.Color(attenuationColor),
    attenuationDistance,
    // Un toque de iridiscencia rompe el aspecto "plástico transparente" y
    // sugiere un recubrimiento óptico. Por encima de 0.3 parece pompa de jabón.
    iridescence,
    iridescenceIOR: 1.3,
    iridescenceThicknessRange: [100, 420],
    clearcoat: 1.0,
    clearcoatRoughness: 0.03,
    envMapIntensity: 1.2,
    side,
    // Ojo: NO ponemos transparent:true. Con transmission > 0 el renderer ya
    // encola el objeto en su propia pasada; marcarlo transparente además lo
    // saca del depth-write y provoca ordenaciones erráticas.
    transparent: false,
    depthWrite: true,
  });
  m.name = 'glass';
  return m;
}

/** Variante helada para los paneles de UI: más rugosa, menos transmisiva. */
export function createFrostedGlass({ tint = 0x9fd8ff, opacity = 0.16 } = {}) {
  const m = createGlass({
    roughness: 0.34,
    transmission: 0.88,
    thickness: 0.14,
    ior: 1.45,
    attenuationColor: tint,
    attenuationDistance: 1.1,
    iridescence: 0.08,
  });
  m.color = new THREE.Color(tint);
  m.envMapIntensity = 0.7;
  m.userData.baseOpacity = opacity;
  return m;
}

/* ═══════════════════════════════════════════════════════════════
   2. METALES
   ═══════════════════════════════════════════════════════════════ */

/** Cromo pulido. Sin envMap es negro: depende por completo del entorno. */
export function createChrome({ color = PALETTE.chrome, roughness = 0.03, anisotropyMap = true } = {}) {
  const m = new THREE.MeshPhysicalMaterial({
    color,
    metalness: 1.0,
    roughness,
    envMapIntensity: 1.55,
    clearcoat: 0.6,
    clearcoatRoughness: 0.02,
  });
  if (anisotropyMap) {
    // Rugosidad no uniforme: incluso en un cromo "perfecto", el pulido real
    // deja zonas microscópicamente distintas. Es un detalle que no se ve
    // conscientemente pero que separa el render del render fotorrealista.
    m.roughnessMap = roughnessBreakup(256);
    m.roughnessMap.repeat.set(3, 3);
    m.roughness = Math.max(roughness, 0.02);
  }
  m.name = 'chrome';
  return m;
}

/** Negro anodizado: metalness intermedia y mucha rugosidad. Absorbe. */
export function createMatteBlack({ color = PALETTE.matte, roughness = 0.8, metalness = 0.3, normalScale = 0.55, repeat = 4 } = {}) {
  const m = new THREE.MeshStandardMaterial({
    color,
    metalness,
    roughness,
    envMapIntensity: 0.5,
  });
  m.normalMap = anodizedNormal(512);
  m.normalMap.repeat.set(repeat, repeat);
  m.normalScale = new THREE.Vector2(normalScale, normalScale);
  m.name = 'matte';
  return m;
}

/** Upper técnico: normal map de celdas + rugosidad variable. */
export function createTechnicalMesh({ color = 0x14161c, repeat = 5 } = {}) {
  const m = new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0.15,
    roughness: 0.62,
    sheen: 0.35,
    sheenColor: new THREE.Color(0x6a7ba8),
    sheenRoughness: 0.8,
    envMapIntensity: 0.6,
  });
  m.normalMap = meshNormal(512);
  m.normalMap.repeat.set(repeat, repeat);
  m.normalScale = new THREE.Vector2(0.85, 0.85);
  m.roughnessMap = roughnessBreakup(256);
  m.roughnessMap.repeat.set(repeat * 0.6, repeat * 0.6);
  m.name = 'technical';
  return m;
}

/** Placa metálica con el logotipo grabado por láser. */
export function createEtchedPlate({ color = PALETTE.chrome, text = 'NOCTURNE' } = {}) {
  const m = createChrome({ color, roughness: 0.12, anisotropyMap: false });
  m.normalMap = etchedLogoNormal(text, 512);
  m.normalScale = new THREE.Vector2(0.4, 0.4);
  m.name = 'plate-etched';
  return m;
}

/** Emissive puro para neones y bordes. No recibe luz: la emite. */
export function createNeon({ color = PALETTE.cyan, intensity = 2.2 } = {}) {
  const m = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color).multiplyScalar(intensity),
    toneMapped: false, // sin esto, ACES aplasta el neón a blanco sucio
    transparent: true,
    opacity: 1,
  });
  m.name = 'neon';
  return m;
}

/* ═══════════════════════════════════════════════════════════════
   3. INYECCIONES DE SHADER
   ═══════════════════════════════════════════════════════════════ */

/**
 * Borde brillante por Fresnel.
 *
 * El blueprint pide "un emissive sutil de 1px en las aristas". Hacerlo con
 * geometría (wireframe, EdgesGeometry) da una línea muerta que no reacciona
 * a la luz ni al ángulo de visión. Un término de Fresnel sí: se enciende
 * justo donde la superficie se aleja de la cámara, que es exactamente donde
 * el vidrio real atrapa la luz. Y cuesta tres instrucciones.
 *
 * `dot(normal, viewDir) → 0` en la silueta, `→ 1` de frente.
 */
export function applyEdgeGlow(material, { color = PALETTE.cyan, power = 3.2, strength = 0.9, pulse = 0 } = {}) {
  const uniforms = {
    uEdgeColor: { value: new THREE.Color(color) },
    uEdgePower: { value: power },
    uEdgeStrength: { value: strength },
    uEdgePulse: { value: pulse },
    uEdgeTime: { value: 0 },
  };

  material.userData.edgeUniforms = uniforms;

  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    Object.assign(shader.uniforms, uniforms);

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        uniform vec3  uEdgeColor;
        uniform float uEdgePower;
        uniform float uEdgeStrength;
        uniform float uEdgePulse;
        uniform float uEdgeTime;
        `
      )
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `
        {
          // vViewPosition apunta del fragmento a la cámara (espacio de vista).
          // La variable normal ya viene perturbada por el normal map, así que
          // el borde sigue el relieve real y no la malla base.
          vec3 vDirEdge = normalize( vViewPosition );
          float fres = pow( 1.0 - saturate( dot( normal, vDirEdge ) ), uEdgePower );
          float pulse = 1.0 + uEdgePulse * sin( uEdgeTime * 3.0 );
          outgoingLight += uEdgeColor * fres * uEdgeStrength * pulse;
        }
        #include <opaque_fragment>
        `
      );
  };

  // Sin esto, three reutiliza el programa compilado de un material "igual"
  // pero sin nuestra inyección, y el efecto desaparece de forma aleatoria.
  material.customProgramCacheKey = () => `edgeglow-${power}-${material.name}`;
  material.needsUpdate = true;
  return material;
}

/**
 * Onda de cambio de material.
 *
 * Al elegir un colorway, una banda de luz recorre el modelo de la base a la
 * punta y deja el color nuevo tras de sí. El truco es que no hay dos
 * materiales ni un crossfade global: se interpola POR FRAGMENTO según su
 * posición a lo largo del eje del objeto.
 *
 * El color destino se aplica como RATIO sobre el color ya calculado, no
 * como sustitución. Así el `map` de albedo, el AO y el vertex color siguen
 * modulando el resultado: es un lerp de material, no un cubo de pintura.
 */
export function applyColorWave(material, { axis = 'x', min = -1, max = 1, waveColor = PALETTE.cyan } = {}) {
  const uniforms = {
    uWave: { value: 1.0 },          // posición del frente, 0..1 (1 = terminado)
    uWaveWidth: { value: 0.13 },
    uWaveColor: { value: new THREE.Color(waveColor) },
    uWaveIntensity: { value: 0.0 },
    uAxisMin: { value: min },
    uAxisMax: { value: max },
    uColorFrom: { value: new THREE.Color(material.color?.getHex?.() ?? 0xffffff) },
    uColorTo: { value: new THREE.Color(material.color?.getHex?.() ?? 0xffffff) },
    uRoughTo: { value: material.roughness ?? 0.5 },
    uMetalTo: { value: material.metalness ?? 0 },
  };

  material.userData.waveUniforms = uniforms;

  const comp = { x: 'x', y: 'y', z: 'z' }[axis] || 'x';
  const prev = material.onBeforeCompile;

  material.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying float vWaveAxis;\nuniform float uAxisMin;\nuniform float uAxisMax;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\nvWaveAxis = clamp((position.${comp} - uAxisMin) / max(uAxisMax - uAxisMin, 1e-4), 0.0, 1.0);`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying float vWaveAxis;
        uniform float uWave;
        uniform float uWaveWidth;
        uniform vec3  uWaveColor;
        uniform float uWaveIntensity;
        uniform vec3  uColorFrom;
        uniform vec3  uColorTo;
        uniform float uRoughTo;
        uniform float uMetalTo;
        `
      )
      // Tras <color_fragment> ya existe diffuseColor con map y vertexColor aplicados.
      .replace(
        '#include <color_fragment>',
        /* glsl */ `
        #include <color_fragment>
        float wMix = 1.0 - smoothstep( uWave - uWaveWidth, uWave + uWaveWidth, vWaveAxis );
        {
          // Ratio acotado: un color de origen casi negro dispararía el
          // cociente a valores absurdos y quemaría la pieza en blanco.
          vec3 ratio = clamp( uColorTo / max( uColorFrom, vec3( 1e-3 ) ), vec3( 0.0 ), vec3( 12.0 ) );
          diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * ratio, wMix );
        }
        `
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>\nroughnessFactor = mix( roughnessFactor, uRoughTo, wMix );`
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>\nmetalnessFactor = mix( metalnessFactor, uMetalTo, wMix );`
      )
      // La cresta luminosa: una gaussiana centrada en el frente de onda.
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `
        {
          float d = ( vWaveAxis - uWave ) / max( uWaveWidth, 1e-4 );
          outgoingLight += uWaveColor * exp( -d * d * 2.0 ) * uWaveIntensity;
        }
        #include <opaque_fragment>
        `
      );
  };

  // La clave anterior se invoca con .call(material): el customProgramCacheKey
  // por defecto de three lee this.onBeforeCompile, así que extraerlo sin
  // enlazar y llamarlo suelto revienta.
  const prevKey = material.customProgramCacheKey;
  material.customProgramCacheKey = () => `${prevKey.call(material)}-wave-${comp}`;
  material.needsUpdate = true;
  return material;
}

/** Aplica el envMap de la escena a un material y refresca su programa. */
export function bindEnvMap(material, envMap) {
  if (!material || !('envMap' in material)) return;
  material.envMap = envMap;
  material.needsUpdate = true;
}
