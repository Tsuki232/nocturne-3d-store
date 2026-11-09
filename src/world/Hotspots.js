import * as THREE from 'three';
import gsap from 'gsap';
import { HOTSPOTS } from './SneakerGeometry.js';
import { createGlass, createNeon, applyEdgeGlow } from '../materials/index.js';
import { disposeHierarchy } from '../utils/dispose.js';

/**
 * Hotspots — puntos de interés flotantes sobre el modelo.
 *
 * Cada uno son tres objetos con funciones distintas:
 *
 *   core   — esfera de cristal. Es lo que se ve.
 *   ring   — anillo neón orientado siempre a cámara. Da legibilidad desde
 *            cualquier ángulo; una esfera sola se pierde sobre el modelo.
 *   hit    — esfera invisible bastante mayor. El objetivo real del ratón:
 *            pedirle al usuario que acierte en 5 px de cristal es hostil.
 *
 * Van colgados de `model` para heredar rotación idle y flotación sin tener
 * que sincronizar nada a mano.
 */
export class Hotspots {
  constructor(parent, { pointer, envMap, accent = 0x00ffff } = {}) {
    this.pointer = pointer;
    this.group = new THREE.Group();
    this.group.name = 'hotspots';
    this.group.visible = false;
    parent.add(this.group);

    this.items = [];
    this.active = null;
    this._listeners = new Set();
    this._camPos = new THREE.Vector3();

    /* Recursos compartidos: una geometría y un material por tipo, no por
       hotspot. Cuatro esferas de cristal con cuatro materiales distintos
       serían cuatro programas de shader para el mismo resultado. */
    // El marcador tiene que leerse por su FORMA (esfera + anillo), no por
    // su brillo. Con un exponente de Fresnel bajo y mucha fuerza, una
    // esfera de 5 cm se convierte en una bengala que tapa justo la pieza
    // que pretende señalar. Radio algo mayor y resplandor mucho menor.
    this._coreGeo = new THREE.IcosahedronGeometry(0.07, 3);
    this._ringGeo = new THREE.RingGeometry(0.105, 0.122, 40);
    this._hitGeo = new THREE.SphereGeometry(0.17, 10, 8);

    // Una esfera de cristal pulido es, literalmente, una lente: concentra
    // la key light en un punto y el bloom la convierte en una estrella que
    // eclipsa el modelo. Subimos rugosidad y quitamos el clearcoat para que
    // difunda; sigue siendo vidrio, pero vidrio esmerilado.
    this._coreMat = createGlass({
      roughness: 0.28,
      ior: 1.48,
      thickness: 0.08,
      transmission: 0.7,
      attenuationColor: accent,
      attenuationDistance: 0.5,
      iridescence: 0.2,
    });
    this._coreMat.clearcoat = 0;
    applyEdgeGlow(this._coreMat, { color: accent, power: 5.0, strength: 0.9 });

    this._ringMat = createNeon({ color: accent, intensity: 1.3 });
    this._ringMat.side = THREE.DoubleSide;
    this._ringMat.depthWrite = false;

    this._hitMat = new THREE.MeshBasicMaterial({ visible: false });

    this._build();
  }

  _build() {
    for (const spec of HOTSPOTS) {
      const node = new THREE.Group();
      node.position.copy(spec.position);
      node.scale.setScalar(0.001);
      node.userData.spec = spec;

      const core = new THREE.Mesh(this._coreGeo, this._coreMat);
      core.renderOrder = 5;

      const ring = new THREE.Mesh(this._ringGeo, this._ringMat.clone());
      ring.renderOrder = 6;

      const hit = new THREE.Mesh(this._hitGeo, this._hitMat);
      hit.userData.hotspotId = spec.id;

      node.add(core, ring, hit);
      this.group.add(node);

      const item = { spec, node, core, ring, hit, phase: Math.random() * Math.PI * 2 };
      this.items.push(item);

      // El objeto registrado en el Pointer es el nodo entero: el raycaster
      // sube por el árbol hasta encontrarlo (ver Pointer._resolveTarget).
      this.pointer?.register(node);
    }

    this._offClick = this.pointer?.onClick((obj) => {
      const item = this.items.find((it) => it.node === obj);
      if (item) this.select(item.spec.id);
    });
  }

  /* ── Visibilidad ───────────────────────────────────────────── */

  show({ stagger = 0.07, duration = 0.55 } = {}) {
    if (this.visible) return;
    this.visible = true;
    this.group.visible = true;
    gsap.killTweensOf(this.items.map((i) => i.node.scale));
    this.items.forEach((item, i) => {
      gsap.to(item.node.scale, {
        x: 1, y: 1, z: 1,
        duration,
        delay: i * stagger,
        ease: 'back.out(2.4)', // sobrepasa y vuelve: pop mecánico
      });
    });
  }

  hide({ duration = 0.3 } = {}) {
    if (!this.visible) return;
    this.visible = false;
    gsap.killTweensOf(this.items.map((i) => i.node.scale));
    gsap.to(
      this.items.map((i) => i.node.scale),
      {
        x: 0.001, y: 0.001, z: 0.001,
        duration,
        ease: 'power2.in',
        onComplete: () => {
          this.group.visible = false;
        },
      }
    );
  }

  /* ── Selección ─────────────────────────────────────────────── */

  select(id) {
    const item = this.items.find((it) => it.spec.id === id);
    if (!item) return;
    this.active = this.active?.spec.id === id ? null : item;

    this.items.forEach((it) => {
      const on = this.active === it;
      gsap.to(it.node.scale, {
        x: on ? 1.5 : 1, y: on ? 1.5 : 1, z: on ? 1.5 : 1,
        duration: 0.4,
        ease: 'power2.out',
      });
    });

    this._listeners.forEach((fn) => fn(this.active ? item.spec : null));
  }

  clear() {
    if (!this.active) return;
    this.active = null;
    this.items.forEach((it) => gsap.to(it.node.scale, { x: 1, y: 1, z: 1, duration: 0.35 }));
    this._listeners.forEach((fn) => fn(null));
  }

  onSelect(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /* ── Bucle ─────────────────────────────────────────────────── */

  update(dt, time, camera) {
    if (!this.group.visible) return;
    camera.getWorldPosition(this._camPos);

    for (const item of this.items) {
      // El anillo mira a cámara SIEMPRE. Como el grupo padre rota con el
      // modelo, hay que orientarlo en mundo y dejar que Three deshaga la
      // transformación del padre; lookAt() sobre el hijo hace justo eso.
      item.ring.lookAt(this._camPos);

      const hovered = this.pointer?.hover === item.node;
      const pulse = 1 + Math.sin(time * 2.4 + item.phase) * 0.12;
      item.ring.scale.setScalar(pulse * (hovered ? 1.25 : 1));
      item.ring.material.opacity = 0.55 + Math.sin(time * 2.4 + item.phase) * 0.25 + (hovered ? 0.3 : 0);

      // Deriva propia: los hotspots no están soldados a la malla, flotan.
      item.core.position.y = Math.sin(time * 1.3 + item.phase) * 0.012;
    }
  }

  setAccent(color) {
    this._coreMat.userData.edgeUniforms?.uEdgeColor.value.set(color);
    this._coreMat.attenuationColor.set(color);
    for (const it of this.items) it.ring.material.color.set(color).multiplyScalar(2.6);
  }

  dispose() {
    this._offClick?.();
    for (const it of this.items) {
      this.pointer?.unregister(it.node);
      gsap.killTweensOf(it.node.scale);
      it.ring.material.dispose();
    }
    this._coreGeo.dispose();
    this._ringGeo.dispose();
    this._hitGeo.dispose();
    this._coreMat.dispose();
    this._ringMat.dispose();
    this._hitMat.dispose();
    disposeHierarchy(this.group);
    this._listeners.clear();
  }
}
