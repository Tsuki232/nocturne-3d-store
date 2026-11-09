import * as THREE from 'three';
import { damp } from '../utils/math.js';

/**
 * Pointer — el cursor en tres espacios a la vez.
 *
 *   ndc     : coordenadas normalizadas (-1..1) para el raycaster
 *   world   : el cursor desproyectado sobre un plano de la escena, que es
 *             lo que necesita el campo de partículas para repeler
 *   hover   : el objeto interactivo bajo el cursor, si lo hay
 *
 * El raycast no se hace cada frame contra toda la escena: solo contra una
 * lista de objetos registrados explícitamente, y como mucho a 30 Hz. Un
 * raycast completo por frame con 50k partículas en escena es un suicidio
 * de CPU y no aporta nada perceptible.
 */
export class Pointer {
  constructor(domElement, camera) {
    this.dom = domElement;
    this.camera = camera;

    this.ndc = new THREE.Vector2();
    this.smoothNdc = new THREE.Vector2();
    this.world = new THREE.Vector3();
    this.smoothWorld = new THREE.Vector3();

    this.isDown = false;
    this.hasMoved = false;
    this.isTouch = false;

    this.raycaster = new THREE.Raycaster();
    // El plano sobre el que desproyectamos el cursor: z = 0, mirando a cámara.
    this.plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

    /** @type {Set<THREE.Object3D>} objetos que participan en el hit-test */
    this.targets = new Set();
    this.hover = null;

    this._rayAccum = 0;
    this._rayInterval = 1 / 30;
    this._hit = new THREE.Vector3();
    this._downPos = new THREE.Vector2();
    this._listeners = { hover: new Set(), click: new Set() };

    this._bind();
  }

  _bind() {
    this._onMove = (e) => {
      this.isTouch = e.pointerType === 'touch';
      const r = this.dom.getBoundingClientRect();
      this.ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      this.hasMoved = true;
    };
    this._onDown = (e) => {
      this.isDown = true;
      this._downPos.set(e.clientX, e.clientY);
      // En táctil no hay hover continuo, así que el toque tiene que
      // resolver el objetivo aquí mismo o el click posterior no encuentra
      // nada contra lo que dispararse.
      if (e.pointerType === 'touch') {
        const r = this.dom.getBoundingClientRect();
        this.ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
        this.ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
        this.raycaster.setFromCamera(this.ndc, this.camera);
        this._hitTest();
      }
    };
    this._onUp = (e) => {
      this.isDown = false;
      // Un "click" solo cuenta si el puntero apenas se movió: así un
      // arrastre para hacer scroll no dispara acciones por accidente.
      const moved = Math.hypot(e.clientX - this._downPos.x, e.clientY - this._downPos.y);
      if (moved < 8 && this.hover) {
        this._listeners.click.forEach((fn) => fn(this.hover));
      }
    };
    this._onLeave = () => {
      this.ndc.set(0, 0);
      this._setHover(null);
    };

    this.dom.addEventListener('pointermove', this._onMove, { passive: true });
    this.dom.addEventListener('pointerdown', this._onDown, { passive: true });
    window.addEventListener('pointerup', this._onUp, { passive: true });
    this.dom.addEventListener('pointerleave', this._onLeave, { passive: true });
  }

  register(obj) {
    if (obj) this.targets.add(obj);
    return () => this.targets.delete(obj);
  }

  unregister(obj) {
    this.targets.delete(obj);
    if (this.hover === obj) this._setHover(null);
  }

  onHover(fn) {
    this._listeners.hover.add(fn);
    return () => this._listeners.hover.delete(fn);
  }

  onClick(fn) {
    this._listeners.click.add(fn);
    return () => this._listeners.click.delete(fn);
  }

  _setHover(obj) {
    if (this.hover === obj) return;
    const prev = this.hover;
    this.hover = obj;
    document.body.classList.toggle('hovering-3d', !!obj);
    this._listeners.hover.forEach((fn) => fn(obj, prev));
  }

  /**
   * @param {number} dt
   * @param {number} planeZ  profundidad a la que se desproyecta el cursor
   */
  update(dt, planeZ = 0) {
    this.smoothNdc.x = damp(this.smoothNdc.x, this.ndc.x, 8, dt);
    this.smoothNdc.y = damp(this.smoothNdc.y, this.ndc.y, 8, dt);

    // Desproyección: el cursor deja de ser 2D y pasa a tener sitio en la escena.
    this.plane.constant = -planeZ;
    this.raycaster.setFromCamera(this.ndc, this.camera);
    if (this.raycaster.ray.intersectPlane(this.plane, this._hit)) {
      this.world.copy(this._hit);
    }
    this.smoothWorld.lerp(this.world, 1 - Math.exp(-9 * dt));

    // Hit-test limitado en frecuencia y en número de objetos.
    //
    // `hasMoved` no es una micro-optimización: sin él, ndc arranca en (0,0)
    // —el centro exacto de la pantalla— y el primer raycast reporta un
    // hover sobre lo que haya ahí. Como el protagonista está justo en el
    // centro, la escena se despiezaba sola antes de que el usuario tocara
    // nada. En táctil, donde no existe el hover, nunca debe dispararse.
    this._rayAccum += dt;
    if (this.hasMoved && !this.isTouch && this._rayAccum >= this._rayInterval && this.targets.size) {
      this._rayAccum = 0;
      this._hitTest();
    }
  }

  _hitTest() {
    const list = [];
    for (const t of this.targets) if (t.visible) list.push(t);
    if (!list.length) return;
    const hits = this.raycaster.intersectObjects(list, true);
    this._setHover(hits.length ? this._resolveTarget(hits[0].object) : null);
    this.lastHit = hits.length ? hits[0] : null;
  }

  /** Sube por el árbol hasta el objeto que se registró como interactivo. */
  _resolveTarget(obj) {
    let n = obj;
    while (n) {
      if (this.targets.has(n)) return n;
      n = n.parent;
    }
    return obj;
  }

  dispose() {
    this.dom.removeEventListener('pointermove', this._onMove);
    this.dom.removeEventListener('pointerdown', this._onDown);
    window.removeEventListener('pointerup', this._onUp);
    this.dom.removeEventListener('pointerleave', this._onLeave);
    this.targets.clear();
    this._listeners.hover.clear();
    this._listeners.click.clear();
  }
}
