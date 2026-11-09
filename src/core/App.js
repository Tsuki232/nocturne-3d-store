import * as THREE from 'three';
import gsap from 'gsap';

import { Quality } from './Quality.js';
import { Renderer } from './Renderer.js';
import { CameraRig } from './CameraRig.js';
import { Composer } from './Composer.js';
import { Scroll } from './Scroll.js';
import { Pointer } from './Pointer.js';

import { Environment } from '../world/Environment.js';
import { Lighting } from '../world/Lighting.js';
import { ParticleField, ParticleTrail } from '../world/Particles.js';
import { BackdropBlur } from '../postfx/BackdropBlur.js';
import { SceneDirector, SECTIONS } from '../scenes/SceneDirector.js';
import { disposeTextureCache } from '../materials/textures.js';

/**
 * App — el bucle y el orden de las pasadas.
 *
 * Un frame completo de esta escena son TRES renderizados, y el orden entre
 * ellos no es negociable:
 *
 *   1. Transmisión  (implícito, lo lanza three al encontrar cristal)
 *   2. Backdrop     escena sin UI → desenfoque Kawase → textura
 *   3. Composer     escena completa; los paneles leen la textura de (2)
 *
 * Si (3) fuera antes que (2), los paneles mostrarían el fondo del frame
 * anterior. Con la cámara en movimiento constante eso se traduce en un
 * desfase de un frame entre el cristal y lo que hay detrás: sutil, pero es
 * exactamente la clase de error que hace que algo "no acabe de estar bien"
 * sin que se sepa decir por qué.
 */
export class App {
  constructor(canvas) {
    this.canvas = canvas;
    // Timer sustituye a Clock (deprecado en r185). connect(document) le
    // engancha la Page Visibility API: con la pestaña oculta devuelve
    // delta 0 y al volver se reinicia solo, sin el salto de varios
    // segundos que daba Clock.
    this.timer = new THREE.Timer();
    this.timer.connect(document);
    this.time = 0;
    this.frame = 0;
    this.running = false;
    this.disposed = false;

    this.sizes = {
      width: window.innerWidth,
      height: window.innerHeight,
      get aspect() {
        return this.width / this.height;
      },
    };

    /* ── Núcleo ─────────────────────────────────────────────── */
    this.quality = new Quality();
    this.renderer = new Renderer(canvas, this.quality);

    this.scene = new THREE.Scene();
    this.rig = new CameraRig(this.quality, this.sizes);
    this.camera = this.rig.camera;
    // La cámara entra en el grafo: el HUD del carrito cuelga de ella.
    this.scene.add(this.camera);

    this.pointer = new Pointer(canvas, this.camera);
    this.scroll = new Scroll(document.getElementById('scroll-proxy'), SECTIONS.length);

    /* ── Mundo ──────────────────────────────────────────────── */
    this.environment = new Environment(this.scene, this.renderer.instance, this.quality);
    this.lighting = new Lighting(this.scene, this.quality);
    this.particles = new ParticleField(this.scene, this.quality);
    this.trail = new ParticleTrail(this.scene, { count: this.quality.name === 'low' ? 400 : 900 });

    /* ── Post ───────────────────────────────────────────────── */
    this.composer = new Composer(
      this.renderer.instance,
      this.scene,
      this.camera,
      this.quality,
      this.sizes
    );

    this.backdrop = new BackdropBlur(this.renderer.instance, {
      scale: this.quality.name === 'high' ? 0.5 : 0.4,
      steps: this.quality.kawaseSteps,
    });
    this.backdrop.enabled = this.quality.kawaseBackdrop;
    this.backdrop.setSize(this.sizes.width, this.sizes.height, this.quality.dpr);
    // A 30 Hz el desenfoque es indistinguible y ahorra un render completo
    // en los dispositivos que peor lo llevan.
    this.backdropInterval = this.quality.name === 'high' ? 1 : 2;

    /* ── Guion ──────────────────────────────────────────────── */
    this.director = new SceneDirector({
      scene: this.scene,
      camera: this.camera,
      cameraRig: this.rig,
      quality: this.quality,
      pointer: this.pointer,
      scroll: this.scroll,
      lighting: this.lighting,
      environment: this.environment,
      trail: this.trail,
      composer: this.composer,
      envMap: this.environment.envMap,
    });

    this._bind();
  }

  /* ═══════════════════════════════════════════════════════════
     Arranque
     ═══════════════════════════════════════════════════════════ */

  async start(onProgress) {
    const source = await this.director.build(this.renderer.instance, onProgress);

    // Precompilación: fuerza a que todos los shaders se enlacen ANTES del
    // primer frame visible. Sin esto, el primer plano de cada material se
    // congela unas décimas mientras el driver compila, justo cuando el
    // usuario está juzgando si la experiencia va fluida.
    this.renderer.instance.compile(this.scene, this.camera);

    this.renderer.refreshShadows();
    this.running = true;
    this.timer.reset();
    this._loop();

    // Coreografía de entrada.
    const tl = gsap.timeline();
    tl.add(this.particles.fadeIn(2.4), 0.2);
    tl.add(this.rig.flyIn(() => this._onIntroDone()), 0);

    return source;
  }

  _onIntroDone() {
    this.director.goTo(0);
    this._sectionUnsub = this.scroll.onSection((i) => this.director.goTo(i));
    // Si el usuario ya había hecho scroll durante la intro, saltamos donde toca.
    if (this.scroll.section !== 0) this.director.goTo(this.scroll.section);
  }

  /* ═══════════════════════════════════════════════════════════
     Bucle
     ═══════════════════════════════════════════════════════════ */

  _loop = (timestamp) => {
    if (this.disposed) return;
    this._raf = requestAnimationFrame(this._loop);
    if (!this.running || this.renderer.contextLost) return;

    // Delta acotado. Timer ya neutraliza el salto de la pestaña oculta,
    // pero un frame perdido por compilación de shader o por GC también
    // produce un dt largo, y todo lo que integramos por dt daría un tirón.
    this.timer.update(timestamp);
    const dt = Math.min(this.timer.getDelta(), 1 / 20);
    this.time += dt;
    this.frame++;

    this.renderer.instance.info.reset();

    /* 1 ── Entrada */
    this.scroll.update(dt);
    this.rig.applyScroll(this.scroll.smooth);
    // El cursor se desproyecta al plano del héroe: ahí es donde debe
    // sentirse la repulsión de las partículas.
    this.pointer.update(dt, this.director.hero?.root.position.z ?? 0);
    this.rig.update(dt);

    /* 2 ── Mundo */
    this.environment.update(this.time, this.camera.position);
    this.lighting.update(this.time);
    this.particles.update(dt, this.time, {
      mouseWorld: this.pointer.smoothWorld,
      scrollVelocity: this.scroll.velocity,
    });
    this.director.update(dt, this.time);

    /* 3 ── Backdrop (antes del render final: ver cabecera) */
    if (this.backdrop.enabled && this.frame % this.backdropInterval === 0) {
      const tex = this.backdrop.render(this.scene, this.camera, this.director.backdropExclusions);
      this.director.setBackdrop(tex, this.backdrop.rtScene.texture);
    }

    /* 4 ── Imagen final */
    this.composer.render(dt);

    /* 5 ── Vigilancia de rendimiento */
    this.quality.sample(dt);
    if (this._stats) this._updateStats(dt);
  };

  /* ═══════════════════════════════════════════════════════════
     Eventos
     ═══════════════════════════════════════════════════════════ */

  _bind() {
    this._onResize = () => {
      clearTimeout(this._resizeTimer);
      // Debounce: en un arrastre de ventana esto se dispara decenas de
      // veces por segundo, y cada una reasigna todos los render targets.
      this._resizeTimer = setTimeout(() => this.resize(), 120);
    };

    // Detenemos el rAF con la pestaña oculta: Timer ya se encarga del
    // delta, pero seguir renderizando en segundo plano es gastar batería
    // dibujando para nadie.
    this._onVisibility = () => {
      this.running = !document.hidden;
    };

    this._onKey = (e) => {
      if (e.key === 'd' || e.key === 'D') this.toggleStats();
    };

    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);
    document.addEventListener('visibilitychange', this._onVisibility);
    window.addEventListener('keydown', this._onKey);

    this._qualityUnsub = this.quality.onChange((q) => {
      this.backdrop.enabled = q.kawaseBackdrop;
      this.backdrop.setSteps(q.kawaseSteps);
      this.backdropInterval = q.name === 'high' ? 1 : 2;
      this.particles.resize(q.dpr);
    });
  }

  resize() {
    this.sizes.width = window.innerWidth;
    this.sizes.height = window.innerHeight;

    this.renderer.setSize(this.sizes.width, this.sizes.height);
    this.rig.resize(this.sizes);
    this.composer.setSize(this.sizes.width, this.sizes.height);
    this.backdrop.setSize(this.sizes.width, this.sizes.height, this.quality.dpr);
    this.particles.resize(this.quality.dpr);
    this.scroll.resize();
    this.director.layout(this.sizes.aspect);
    this.renderer.refreshShadows();
  }

  /* ═══════════════════════════════════════════════════════════
     Diagnóstico
     ═══════════════════════════════════════════════════════════ */

  toggleStats() {
    if (this._stats) {
      this._stats.remove();
      this._stats = null;
      return;
    }
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;left:12px;bottom:12px;z-index:90;font:11px/1.6 ui-monospace,monospace;' +
      'color:#7ef;background:rgba(6,6,10,.72);padding:8px 11px;border:1px solid rgba(126,238,255,.2);' +
      'border-radius:6px;pointer-events:none;white-space:pre;backdrop-filter:blur(8px)';
    document.body.appendChild(el);
    this._stats = el;
    this._fpsAvg = 60;
  }

  _updateStats(dt) {
    this._fpsAvg += (1 / dt - this._fpsAvg) * 0.06;
    if (this.frame % 12) return;
    const info = this.renderer.instance.info;
    this._stats.textContent = [
      `${this._fpsAvg.toFixed(0)} fps   tier ${this.quality.tierName}`,
      `draw calls  ${info.render.calls}`,
      `triángulos  ${(info.render.triangles / 1000).toFixed(1)}k`,
      `programas   ${info.programs?.length ?? 0}`,
      `texturas    ${info.memory.textures}`,
      `geometrías  ${info.memory.geometries}`,
      `partículas  ${this.particles.count.toLocaleString('es')}`,
      `sección     ${SECTIONS[this.director.section] ?? '—'}`,
      `dpr ${this.quality.dpr} · post ${this.quality.postScale}x`,
    ].join('\n');
  }

  /* ═══════════════════════════════════════════════════════════
     Desmontaje
     ═══════════════════════════════════════════════════════════ */

  dispose() {
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this._raf);
    clearTimeout(this._resizeTimer);

    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    document.removeEventListener('visibilitychange', this._onVisibility);
    window.removeEventListener('keydown', this._onKey);
    this._sectionUnsub?.();
    this._qualityUnsub?.();
    this._stats?.remove();

    gsap.globalTimeline.clear();

    this.director.dispose();
    this.backdrop.dispose();
    this.composer.dispose();
    this.particles.dispose();
    this.trail.dispose();
    this.lighting.dispose();
    this.environment.dispose();
    this.pointer.dispose();
    this.scroll.dispose();
    this.rig.dispose();
    this.quality.dispose();
    this.timer.dispose();
    disposeTextureCache();
    this.renderer.dispose();

    this.scene.clear();
  }
}
