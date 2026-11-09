import * as THREE from 'three';
import gsap from 'gsap';
import { buildCatalogGeometry } from '../world/SneakerGeometry.js';
import { instanceNormalArray } from '../materials/textures.js';
import { PALETTE, COLORWAYS } from '../materials/palette.js';
import { GlassPanel } from './GlassPanel.js';
import { PanelCanvas, cssColor } from './TextTexture.js';
import { clamp } from '../utils/math.js';

/**
 * Catalog — la rejilla de producto.
 *
 * Aquí se concentran las dos optimizaciones de la sección 6 del blueprint,
 * y conviene ser preciso sobre qué resuelve cada una:
 *
 * ── INSTANCING ────────────────────────────────────────────────
 * Veinte variantes del mismo producto no son veinte modelos. Es UNA
 * geometría dibujada veinte veces con veinte matrices. La ganancia no está
 * en la VRAM (que también) sino en las draw calls: veinte mallas son veinte
 * viajes de ida y vuelta CPU→GPU por frame, y ese coste no depende del
 * número de polígonos, sólo de la cantidad de objetos.
 *
 * Las «diferentes texturas» del brief se resuelven con `sampler2DArray`:
 * un atributo por instancia elige capa. Ver materials/textures.js.
 *
 * ── LOD ───────────────────────────────────────────────────────
 * `THREE.LOD` funciona por objeto y aquí no hay objetos, hay instancias.
 * La técnica correcta es mantener DOS InstancedMesh —geometría densa y
 * geometría ligera— y repartir las instancias entre ellas según distancia,
 * ajustando `.count` de cada una. La GPU nunca ve una instancia dos veces.
 */

const PRODUCTS = [
  { name: 'Volta One', price: 289, accent: 0x00ffff, body: 0x161a22 },
  { name: 'Volta Lux', price: 349, accent: 0xbfe9ff, body: 0x2a2f38 },
  { name: 'Volta Mono', price: 259, accent: 0x8a8fa0, body: 0x0b0b0e },
  { name: 'Volta Flux', price: 309, accent: 0x8a2be2, body: 0x1b1424 },
  { name: 'Volta Arc', price: 279, accent: 0x00ff9d, body: 0x0d1a16 },
  { name: 'Volta Ion', price: 329, accent: 0xff3d81, body: 0x210f18 },
  { name: 'Volta Halo', price: 299, accent: 0xffc857, body: 0x211a0d },
  { name: 'Volta Nadir', price: 269, accent: 0x4d7cff, body: 0x0f1424 },
  { name: 'Volta Prism', price: 359, accent: 0x64ffda, body: 0x102420 },
  { name: 'Volta Echo', price: 249, accent: 0xb0b6c4, body: 0x14161b },
  { name: 'Volta Onyx', price: 319, accent: 0x9d4edd, body: 0x160f20 },
  { name: 'Volta Zenit', price: 379, accent: 0x00d4ff, body: 0x0a1a24 },
  { name: 'Volta Vega', price: 289, accent: 0xff6b35, body: 0x241209 },
  { name: 'Volta Kilo', price: 259, accent: 0x7cffcb, body: 0x0c1f1a },
  { name: 'Volta Rho', price: 339, accent: 0xe0aaff, body: 0x1c1424 },
  { name: 'Volta Sigma', price: 299, accent: 0x48cae4, body: 0x0d1c22 },
  { name: 'Volta Tau', price: 269, accent: 0xf72585, body: 0x240d1a },
  { name: 'Volta Umbra', price: 349, accent: 0x5a189a, body: 0x120c1c },
  { name: 'Volta Vertex', price: 309, accent: 0x06ffa5, body: 0x08221a },
  { name: 'Volta Wave', price: 279, accent: 0x4cc9f0, body: 0x0b1a26 },
];

const LOD_DISTANCE = 11.5; // más allá de esto, geometría ligera

export class Catalog {
  constructor(scene, quality, { pointer, envMap } = {}) {
    this.scene = scene;
    this.quality = quality;
    this.pointer = pointer;
    this.count = Math.min(quality.catalogCount, PRODUCTS.length);

    this.group = new THREE.Group();
    this.group.name = 'catalog';
    this.group.visible = false;
    scene.add(this.group);

    this.items = [];
    this.panels = [];
    this.revealed = false;
    this.hoverIndex = -1;

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._color = new THREE.Color();

    this._buildInstances(envMap);
    this._buildPanels();
    this.layout(window.innerWidth / window.innerHeight);
  }

  /* ═══════════════════════════════════════════════════════════
     Instancias
     ═══════════════════════════════════════════════════════════ */

  _buildInstances(envMap) {
    this.geoHigh = buildCatalogGeometry('high');
    this.geoLow = buildCatalogGeometry('low');

    const normalArray = instanceNormalArray(4, 256);

    // Un único material para los dos niveles de LOD. Compartirlo significa
    // un solo programa compilado y un solo conjunto de uniforms.
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true, // el color de cada pieza viene horneado
      metalness: 0.55,
      roughness: 0.42,
      envMap: envMap || null,
      envMapIntensity: 1.1,
      // normalMap debe estar definido para que three declare USE_NORMALMAP
      // y genere la TBN; luego sustituimos el muestreo por el del array.
      normalMap: new THREE.Texture(),
      normalScale: new THREE.Vector2(0.7, 0.7),
    });
    this.material.normalMap.needsUpdate = false;

    this._injectInstanceShader(this.material, normalArray);

    this.lodHigh = new THREE.InstancedMesh(this.geoHigh, this.material, this.count);
    this.lodLow = new THREE.InstancedMesh(this.geoLow, this.material, this.count);

    for (const mesh of [this.lodHigh, this.lodLow]) {
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false; // las matrices cambian cada frame
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      this.group.add(mesh);
    }

    // Atributos por instancia. `aLayer` elige la capa del array de normales
    // y `aAccent` el color del borde emissive: dos productos consecutivos
    // no comparten ni acabado ni luz.
    for (const mesh of [this.lodHigh, this.lodLow]) {
      mesh.geometry.setAttribute(
        'aLayer',
        new THREE.InstancedBufferAttribute(new Float32Array(this.count), 1)
      );
      mesh.geometry.setAttribute(
        'aAccent',
        new THREE.InstancedBufferAttribute(new Float32Array(this.count * 3), 3)
      );
    }

    const colorHigh = new THREE.Color();
    for (let i = 0; i < this.count; i++) {
      const p = PRODUCTS[i];
      colorHigh.set(p.body);
      this.lodHigh.setColorAt(i, colorHigh);
      this.lodLow.setColorAt(i, colorHigh);

      const accent = new THREE.Color(p.accent);
      for (const mesh of [this.lodHigh, this.lodLow]) {
        mesh.geometry.attributes.aLayer.setX(i, i % 4);
        mesh.geometry.attributes.aAccent.setXYZ(i, accent.r, accent.g, accent.b);
      }

      this.items.push({
        index: i,
        product: p,
        home: new THREE.Vector3(),
        offset: new THREE.Vector3(),
        rotation: 0,
        scale: 0,
        progress: 0,
        hover: 0,
        phase: Math.random() * Math.PI * 2,
      });
    }

    for (const mesh of [this.lodHigh, this.lodLow]) {
      mesh.instanceColor.needsUpdate = true;
      mesh.geometry.attributes.aLayer.needsUpdate = true;
      mesh.geometry.attributes.aAccent.needsUpdate = true;
    }
  }

  /**
   * Inyección para leer el normal map desde un `sampler2DArray` y añadir el
   * borde emissive por instancia.
   */
  _injectInstanceShader(material, normalArray) {
    material.userData.arrayUniform = { value: normalArray };

    material.onBeforeCompile = (shader) => {
      shader.uniforms.tNormalArray = material.userData.arrayUniform;

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute float aLayer;
           attribute vec3 aAccent;
           varying float vLayer;
           varying vec3 vAccent;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vLayer = aLayer;
           vAccent = aAccent;`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           precision highp sampler2DArray;
           uniform sampler2DArray tNormalArray;
           varying float vLayer;
           varying vec3 vAccent;`
        )
        // Sustituimos el muestreo del normalMap por el de la capa que toca.
        // La TBN ya la ha construido <normal_fragment_begin>.
        .replace(
          '#include <normal_fragment_maps>',
          `vec3 mapN = texture( tNormalArray, vec3( vNormalMapUv * 3.0, vLayer ) ).xyz * 2.0 - 1.0;
           mapN.xy *= normalScale;
           normal = normalize( tbn * mapN );`
        )
        .replace(
          '#include <opaque_fragment>',
          `{
             vec3 vd = normalize( vViewPosition );
             float fres = pow( 1.0 - saturate( dot( normal, vd ) ), 3.0 );
             outgoingLight += vAccent * fres * 1.1;
           }
           #include <opaque_fragment>`
        );
    };

    material.customProgramCacheKey = () => 'catalog-instanced-v1';
  }

  /* ═══════════════════════════════════════════════════════════
     Tarjetas
     ═══════════════════════════════════════════════════════════ */

  _buildPanels() {
    for (let i = 0; i < this.count; i++) {
      const p = PRODUCTS[i];
      const panel = new GlassPanel({
        width: 1.16,
        height: 1.52,
        radius: 0.07,
        accent: p.accent,
        tint: 0xa8c8e8,
        tintAmount: 0.2,
        edgeGlow: 0.7,
        contentTexture: this._cardTexture(p),
        shadow: true,
        name: `card-${i}`,
      });
      panel.mesh.userData.catalogIndex = i;
      this.group.add(panel.object3D);
      this.panels.push(panel);
      this.pointer?.register(panel.mesh);
    }
  }

  _cardTexture(product) {
    const c = new PanelCanvas(1.16 / 1.52, 900, 1);
    c.clear();

    // Reserva superior: ahí flota la zapatilla 3D, el canvas no debe pintar.
    const top = 500;

    c.text(product.name.toUpperCase(), {
      x: 56, y: top + 86, size: 68, weight: 600,
      color: 'rgba(255,255,255,0.96)', tracking: 2,
    });

    c.rule({ x: 56, y: top + 132, width: c.vw - 112, color: 'rgba(255,255,255,0.14)' });

    c.text('SERIE VOLTA', {
      x: 56, y: top + 214, size: 36, weight: 500,
      color: cssColor(product.accent, 0.85), tracking: 8,
    });

    c.text(`${product.price} €`, {
      x: c.vw - 56, y: top + 214, size: 58, weight: 600,
      color: 'rgba(255,255,255,0.92)', align: 'right',
    });

    // Muestras de color: las tres variantes disponibles de cada modelo.
    const swY = top + 288;
    [product.accent, 0xf2f4f8, 0x14161c].forEach((col, i) => {
      c.roundRect(56 + i * 62, swY, 44, 44, 22, {
        fill: cssColor(col, 0.85),
        stroke: 'rgba(255,255,255,0.22)',
        lineWidth: 2,
      });
    });

    return c.toTexture({ anisotropy: 8 });
  }

  /* ═══════════════════════════════════════════════════════════
     Layout
     ═══════════════════════════════════════════════════════════ */

  /**
   * Rejilla responsiva.
   *
   * El número de columnas sale de igualar la proporción de la REJILLA a la
   * de la pantalla, no del aspect ratio a secas: con 20 productos, «2.1 ×
   * aspect» devuelve 2 columnas y 10 filas, una tira vertical de 18 unidades
   * que obliga a la cámara a retroceder hasta que las tarjetas son ilegibles.
   *
   *   (cols·gapX) / (rows·gapY) ≈ aspect,  con rows = n/cols
   *   →  cols ≈ √(n · aspect · gapY / gapX)
   */
  layout(aspect) {
    const gapX = 1.42;
    const gapY = 1.86;
    const ideal = Math.sqrt((this.count * aspect * gapY) / gapX);
    const cols = clamp(Math.round(ideal), 2, 5);
    const rows = Math.ceil(this.count / cols);

    const w = (cols - 1) * gapX;
    const h = (rows - 1) * gapY;

    this.items.forEach((item, i) => {
      const cx = i % cols;
      const cy = Math.floor(i / cols);
      item.home.set(cx * gapX - w / 2, -(cy * gapY) + h / 2, 0);
      // Retardo diagonal: la ola de entrada recorre la rejilla en diagonal,
      // que se lee mucho mejor que fila a fila.
      item.delay = (cx + cy) * 0.075;
    });

    this.rows = rows;
    this.cols = cols;

    this.panels.forEach((panel, i) => {
      panel.object3D.position.copy(this.items[i].home);
    });
  }

  /* ═══════════════════════════════════════════════════════════
     Entrada / salida
     ═══════════════════════════════════════════════════════════ */

  /**
   * Las tarjetas suben desde abajo con rotación y escala escalonadas.
   * La animación no toca matrices: mueve `progress` por instancia, y el
   * update() del frame las compone. Así el LOD y la entrada no se pelean
   * por escribir en el mismo buffer.
   */
  reveal() {
    if (this.revealed) return null;
    this.revealed = true;
    this.group.visible = true;
    this.lodHigh.count = this.count;

    const tl = gsap.timeline();
    this.items.forEach((item) => {
      tl.fromTo(
        item,
        { progress: 0 },
        { progress: 1, duration: 1.15, ease: 'power3.out' },
        item.delay
      );
    });

    this.panels.forEach((panel, i) => {
      tl.add(panel.reveal({ duration: 0.95 }), this.items[i].delay);
    });

    return tl;
  }

  conceal() {
    if (!this.revealed) return null;
    this.revealed = false;

    const tl = gsap.timeline({
      onComplete: () => {
        this.group.visible = false;
        this.lodHigh.count = 0;
        this.lodLow.count = 0;
      },
    });

    this.items.forEach((item, i) => {
      tl.to(item, { progress: 0, duration: 0.55, ease: 'power2.in' }, i * 0.02);
    });
    this.panels.forEach((panel, i) => {
      const t = panel.conceal({ duration: 0.45 });
      if (t) tl.add(t, i * 0.02);
    });

    return tl;
  }

  /* ═══════════════════════════════════════════════════════════
     Bucle
     ═══════════════════════════════════════════════════════════ */

  update(dt, time, camera) {
    if (!this.group.visible) return;

    camera.getWorldPosition(this._camPos);
    const hoverMesh = this.pointer?.hover;
    const hoverIdx = hoverMesh?.userData?.catalogIndex ?? -1;

    let nHigh = 0;
    let nLow = 0;
    const attrHigh = this.lodHigh.geometry.attributes;
    const attrLow = this.lodLow.geometry.attributes;

    for (const item of this.items) {
      const p = item.progress;

      // Amortiguación del hover, por instancia.
      const target = item.index === hoverIdx ? 1 : 0;
      item.hover += (target - item.hover) * Math.min(1, dt * 9);

      // Entrada: sube desde abajo girando y creciendo.
      const rise = (1 - p) * -3.4;
      const spinIn = (1 - p) * Math.PI * 0.9;
      const float = Math.sin(time * 0.9 + item.phase) * 0.045;

      this._v.set(
        item.home.x,
        item.home.y + rise + float + 0.34 + item.hover * 0.08,
        item.home.z + 0.42 + item.hover * 0.22
      );

      // Rotación: giro continuo lento + el resto del giro de entrada.
      this._e.set(
        0.14 + item.hover * -0.1,
        time * 0.22 + item.phase + spinIn,
        (1 - p) * 0.5
      );
      this._q.setFromEuler(this._e);

      const s = 0.4 * (0.4 + 0.6 * p) * (1 + item.hover * 0.12);
      this._s.setScalar(s);
      this._m.compose(this._v, this._q, this._s);

      // Reparto por LOD. Cada instancia va a UNA de las dos mallas.
      const dist = this._camPos.distanceTo(this._v);
      const threshold = LOD_DISTANCE * this.quality.lodBias;

      // El color se reutiliza: instanciar un THREE.Color por instancia y por
      // frame genera basura constante y acaba en pausas del recolector.
      const accent = this._color.set(item.product.accent);
      const mesh = dist < threshold ? this.lodHigh : this.lodLow;
      const slot = dist < threshold ? nHigh++ : nLow++;
      const attr = dist < threshold ? attrHigh : attrLow;

      mesh.setMatrixAt(slot, this._m);
      attr.aLayer.setX(slot, item.index % 4);
      attr.aAccent.setXYZ(slot, accent.r, accent.g, accent.b);
      mesh.setColorAt(slot, this._color.set(item.product.body));

      // La tarjeta acompaña a su zapatilla.
      const panel = this.panels[item.index];
      panel.object3D.position.set(
        item.home.x,
        item.home.y + rise * 0.85 + item.hover * 0.05,
        item.home.z + item.hover * 0.12
      );
      panel.object3D.rotation.z = (1 - p) * 0.22;
    }

    this.lodHigh.count = nHigh;
    this.lodLow.count = nLow;
    this.lodHigh.instanceMatrix.needsUpdate = true;
    this.lodLow.instanceMatrix.needsUpdate = true;
    if (nHigh) {
      this.lodHigh.instanceColor.needsUpdate = true;
      attrHigh.aLayer.needsUpdate = true;
      attrHigh.aAccent.needsUpdate = true;
    }
    if (nLow) {
      this.lodLow.instanceColor.needsUpdate = true;
      attrLow.aLayer.needsUpdate = true;
      attrLow.aAccent.needsUpdate = true;
    }

    if (hoverIdx !== this.hoverIndex) {
      if (this.hoverIndex >= 0) this.panels[this.hoverIndex]?.setHover(false);
      if (hoverIdx >= 0) this.panels[hoverIdx]?.setHover(true);
      this.hoverIndex = hoverIdx;
    }

    for (const panel of this.panels) panel.update(dt, time);
  }

  setBackdrop(blurTex, sharpTex) {
    for (const panel of this.panels) panel.setBackdrop(blurTex, sharpTex);
  }

  /** Meshes que deben excluirse del pase de backdrop (evitan feedback). */
  get backdropExclusions() {
    return this.panels.map((p) => p.object3D);
  }

  getProduct(i) {
    return PRODUCTS[i];
  }

  /** Posición mundial de una tarjeta, para animaciones de "añadir". */
  getWorldPosition(i, out = new THREE.Vector3()) {
    return this.panels[i]?.object3D.getWorldPosition(out) || out.set(0, 0, 0);
  }

  dispose() {
    this.items.forEach((it) => gsap.killTweensOf(it));
    this.panels.forEach((p) => {
      this.pointer?.unregister(p.mesh);
      p.dispose();
    });
    this.geoHigh.dispose();
    this.geoLow.dispose();
    this.material.normalMap?.dispose();
    this.material.dispose();
    this.lodHigh.dispose();
    this.lodLow.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}

export { PRODUCTS };
