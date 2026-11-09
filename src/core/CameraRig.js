import * as THREE from 'three';
import gsap from 'gsap';
import { damp, clamp } from '../utils/math.js';

/**
 * CameraRig — la cámara como un dron con peso, no como una variable.
 *
 * La posición final de cada frame es la suma de cuatro capas independientes.
 * Separarlas es lo que permite que un tween de sección, el scroll y el ratón
 * actúen a la vez sin pisarse:
 *
 *   base         ← el "plano" de la sección actual. Lo mueve GSAP.
 *   scrollOffset ← desplazamiento continuo en Z durante el scroll.
 *   pointer      ← parallax de cursor, amortiguado (esto da el peso).
 *   shake        ← impulsos puntuales (añadir al carrito).
 *
 * La lente es un 50 mm de verdad: usamos filmGauge + setFocalLength en vez
 * de clavar un fov en grados, así que el encuadre se comporta como una
 * cámara real al cambiar el aspect ratio.
 */
export class CameraRig {
  constructor(quality, sizes) {
    this.quality = quality;
    this.sizes = sizes;

    this.camera = new THREE.PerspectiveCamera(30, sizes.aspect, 0.1, 600);
    this.camera.filmGauge = 35; // sensor full-frame 35 mm
    this.focal = 50;            // el 50 mm cinematográfico del blueprint
    this.camera.setFocalLength(this.focal);
    this._appliedFocal = this.focal;

    /* ── Capas de posición ─────────────────────────────────── */
    this.base = new THREE.Vector3(0, 0.9, 6.2);
    this.lookTarget = new THREE.Vector3(0, 0.05, 0);

    this.scrollOffset = new THREE.Vector3();
    this.scrollFocal = 0;

    this.pointer = new THREE.Vector2();       // valor amortiguado
    this.pointerTarget = new THREE.Vector2(); // objetivo crudo (-1..1)
    this.pointerAmount = new THREE.Vector2(0.42, 0.26); // amplitud en unidades
    this.pointerLambda = 2.6; // más bajo = más inercia, más "dron"

    this.shake = new THREE.Vector3();

    /* ── Estado ─────────────────────────────────────────────── */
    this.closeUp = null;      // { position, target } cuando hay plano detalle
    this.closeUpBlend = 0;    // 0 = plano de sección, 1 = plano detalle
    this.introDone = false;

    this._pos = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._curvePoint = new THREE.Vector3();

    // Objeto tweenable: GSAP no puede animar bien Vector3 anidados,
    // así que le damos escalares planos y los volcamos en el update.
    this._t = { flyProgress: 0 };
  }

  get position() {
    return this.camera.position;
  }

  /* ── Animación de entrada ────────────────────────────────── */

  /**
   * Fly-through desde el espacio profundo. La trayectoria es una
   * CatmullRomCurve3, no una interpolación lineal: los últimos puntos de
   * control rodean al héroe, lo que produce la órbita de llegada sin
   * necesidad de una segunda animación.
   */
  flyIn(onComplete) {
    if (this.quality.reducedMotion) {
      // Respetamos prefers-reduced-motion: sin viaje, solo un fundido de foco.
      this._t.flyProgress = 1;
      this.introDone = true;
      onComplete?.();
      return gsap.timeline();
    }

    this.flyCurve = new THREE.CatmullRomCurve3(
      [
        new THREE.Vector3(6, 46, -132), // espacio profundo: atrás y arriba
        new THREE.Vector3(-14, 26, -62),
        new THREE.Vector3(-16, 9, -16),
        new THREE.Vector3(-9.5, 3.2, 4.5), // entra en el plano del héroe
        new THREE.Vector3(-2.2, 1.5, 8.4), // órbita: pasa de largo…
        new THREE.Vector3(2.4, 1.05, 7.4), // …y vuelve
        this.base.clone(),
      ],
      false,
      'catmullrom',
      0.4
    );

    // El target arranca lejos y va cerrando sobre el héroe: el efecto es
    // que el sujeto "aparece" del vacío en lugar de estar ya centrado.
    this.flyLook = new THREE.Vector3(0, 6, -30);

    const tl = gsap.timeline({
      onComplete: () => {
        this.introDone = true;
        this.flyCurve = null;
        onComplete?.();
      },
    });

    tl.to(this._t, {
      flyProgress: 1,
      duration: 4.4,
      // Fuerte al principio (velocidad de crucero), frenada larga al llegar.
      ease: 'power3.inOut',
    })
      .to(this.flyLook, { x: 0, y: 0.05, z: 0, duration: 3.0, ease: 'power2.out' }, 0.6)
      // La lente se abre durante el viaje y se cierra al posarse: el clásico
      // efecto de "compresión" al terminar un travelling.
      .fromTo(this, { focal: 24 }, { focal: 50, duration: 4.4, ease: 'power2.inOut' }, 0)
      // El parallax del ratón no debe existir mientras la cámara vuela.
      .fromTo(this.pointerAmount, { x: 0, y: 0 }, { x: 0.42, y: 0.26, duration: 1.6 }, 3.2);

    return tl;
  }

  /* ── Planos de sección ───────────────────────────────────── */

  /**
   * Mueve la cámara a un nuevo encuadre. Lo usa SceneDirector en cada
   * cambio de sección; los tweens se solapan y GSAP resuelve el conflicto
   * matando el anterior sobre las mismas propiedades.
   */
  setShot({ position, target, focal, duration = 1.6, ease = 'power2.inOut', delay = 0 } = {}) {
    const tl = gsap.timeline({ delay });
    if (position) tl.to(this.base, { x: position.x, y: position.y, z: position.z, duration, ease }, 0);
    if (target) tl.to(this.lookTarget, { x: target.x, y: target.y, z: target.z, duration, ease }, 0);
    if (focal != null) tl.to(this, { focal, duration, ease }, 0);
    return tl;
  }

  /** Fija el encuadre sin animación (resize, restauración de estado). */
  snapShot({ position, target, focal }) {
    if (position) this.base.copy(position);
    if (target) this.lookTarget.copy(target);
    if (focal != null) this.focal = focal;
  }

  /* ── Plano detalle (hotspots) ────────────────────────────── */

  /**
   * Acerca la cámara a un punto de interés del modelo. En vez de mover
   * `base` (lo que rompería el estado de la sección), interpolamos hacia un
   * encuadre paralelo con closeUpBlend. Salir es tan simple como devolver
   * ese blend a 0.
   */
  pushCloseUp(worldPoint, { distance = 1.35, height = 0.28, duration = 1.0 } = {}) {
    // Nos acercamos por el mismo lado desde el que ya mira la cámara, para
    // que el corte no salte al otro hemisferio del objeto.
    const dir = this._pos.copy(this.camera.position).sub(worldPoint).setY(0);
    if (dir.lengthSq() < 1e-5) dir.set(0, 0, 1);
    dir.normalize();

    this.closeUp = {
      position: worldPoint.clone().addScaledVector(dir, distance).setY(worldPoint.y + height),
      target: worldPoint.clone(),
    };

    gsap.killTweensOf(this);
    return gsap.to(this, {
      closeUpBlend: 1,
      focal: 85, // teleobjetivo: aísla el detalle y comprime el fondo
      duration,
      ease: 'power3.inOut',
    });
  }

  popCloseUp({ duration = 0.9, focal = 50 } = {}) {
    if (!this.closeUp) return gsap.timeline();
    gsap.killTweensOf(this);
    return gsap.to(this, {
      closeUpBlend: 0,
      focal,
      duration,
      ease: 'power2.inOut',
      onComplete: () => {
        this.closeUp = null;
      },
    });
  }

  /* ── Scroll y puntero ────────────────────────────────────── */

  /**
   * Parallax de scroll. La cámara no solo baja: retrocede en Z y abre la
   * lente. Mover la cámara y el FOV en direcciones opuestas es lo que crea
   * la sensación de profundidad masiva (el "dolly zoom" de Vértigo, en
   * dosis pequeñas).
   *
   * @param {number} p  progreso global de scroll, 0..1
   */
  applyScroll(p) {
    const eased = p * p * (3 - 2 * p);
    this.scrollOffset.z = eased * 2.4;
    this.scrollOffset.y = -eased * 0.35;
    this.scrollFocal = -eased * 9; // 50 mm → 41 mm: se abre el encuadre
  }

  /** @param {number} nx,ny  cursor normalizado -1..1 */
  setPointer(nx, ny) {
    this.pointerTarget.set(clamp(nx, -1, 1), clamp(ny, -1, 1));
  }

  /** Impulso puntual de cámara (feedback de acción). */
  impulse(strength = 0.12) {
    if (this.quality.reducedMotion) return;
    const s = { v: strength };
    gsap.to(s, {
      v: 0,
      duration: 0.7,
      ease: 'power2.out',
      onUpdate: () => {
        this.shake.set(
          (Math.random() - 0.5) * s.v,
          (Math.random() - 0.5) * s.v,
          (Math.random() - 0.5) * s.v * 0.5
        );
      },
      onComplete: () => this.shake.set(0, 0, 0),
    });
  }

  /* ── Bucle ───────────────────────────────────────────────── */

  update(dt) {
    // 1. Puntero amortiguado. damp() usa dt, así que el peso del movimiento
    //    se siente idéntico a 60 y a 144 Hz.
    this.pointer.x = damp(this.pointer.x, this.pointerTarget.x, this.pointerLambda, dt);
    this.pointer.y = damp(this.pointer.y, this.pointerTarget.y, this.pointerLambda, dt);

    // 2. Posición base: durante el vuelo la dicta la curva.
    if (this.flyCurve) {
      this.flyCurve.getPointAt(clamp(this._t.flyProgress, 0, 1), this._curvePoint);
      this._pos.copy(this._curvePoint);
      this._look.copy(this.flyLook);
    } else {
      this._pos.copy(this.base).add(this.scrollOffset);
      this._look.copy(this.lookTarget);
    }

    // 3. Plano detalle: se mezcla por encima de todo lo anterior.
    if (this.closeUp && this.closeUpBlend > 0) {
      this._pos.lerp(this.closeUp.position, this.closeUpBlend);
      this._look.lerp(this.closeUp.target, this.closeUpBlend);
    }

    // 4. Parallax de cursor. Se atenúa en el plano detalle: ahí queremos
    //    una cámara quieta, no un pulso tembloroso sobre el producto.
    const pw = 1 - this.closeUpBlend * 0.8;
    this._pos.x += this.pointer.x * this.pointerAmount.x * pw;
    this._pos.y += this.pointer.y * this.pointerAmount.y * pw;
    // El target se mueve en sentido contrario y con menos amplitud: eso
    // convierte un desplazamiento plano en una rotación sutil de cabeza.
    this._look.x -= this.pointer.x * this.pointerAmount.x * 0.22 * pw;
    this._look.y -= this.pointer.y * this.pointerAmount.y * 0.22 * pw;

    this._pos.add(this.shake);

    this.camera.position.copy(this._pos);
    this.camera.lookAt(this._look);

    // 5. Lente. setFocalLength ya llama a updateProjectionMatrix, así que
    //    solo lo tocamos si el valor cambió de verdad.
    const focal = Math.max(12, this.focal + this.scrollFocal);
    if (Math.abs(focal - this._appliedFocal) > 1e-3) {
      this.camera.setFocalLength(focal);
      this._appliedFocal = focal;
    }
  }

  resize(sizes) {
    this.sizes = sizes;
    this.camera.aspect = sizes.aspect;
    // El aspect cambia getFilmHeight(), así que hay que reaplicar la focal
    // para que un 50 mm siga siendo un 50 mm.
    this.camera.setFocalLength(Math.max(12, this.focal + this.scrollFocal));
    this._appliedFocal = this.focal + this.scrollFocal;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    gsap.killTweensOf(this);
    gsap.killTweensOf(this.base);
    gsap.killTweensOf(this.lookTarget);
    gsap.killTweensOf(this._t);
    gsap.killTweensOf(this.pointerAmount);
    this.flyCurve = null;
  }
}
