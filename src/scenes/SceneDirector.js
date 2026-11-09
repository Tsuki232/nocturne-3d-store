import * as THREE from 'three';
import gsap from 'gsap';

import { Hero } from '../world/Hero.js';
import { Hotspots } from '../world/Hotspots.js';
import { Catalog } from '../ui3d/Catalog.js';
import { GlassPanel } from '../ui3d/GlassPanel.js';
import { NeonButton } from '../ui3d/NeonButton.js';
import { PanelCanvas, cssColor } from '../ui3d/TextTexture.js';
import { COLORWAYS, getColorway, PALETTE } from '../materials/palette.js';

/**
 * SceneDirector — el guion.
 *
 * Cinco secciones que NO son cinco lugares del mundo: son cinco ESTADOS de
 * la misma escena. La cámara se desplaza poco; lo que cambia es dónde está
 * cada objeto, qué tamaño tiene y qué paneles están abiertos.
 *
 * Es la diferencia entre una web larga con 3D y una experiencia 3D: si cada
 * sección viviera a −8 unidades de la anterior, habría que replicar luces,
 * el campo de partículas tendría que ser cinco veces mayor y el objeto
 * héroe dejaría de ser un protagonista para convertirse en un decorado que
 * se abandona al hacer scroll.
 *
 *   0  HERO         producto centrado, ficha a un lado
 *   1  CATÁLOGO     el héroe se encoge a una esquina, sube la rejilla
 *   2  CONFIGURADOR selector de acabados con onda de color
 *   3  DETALLE      despiece + hotspots + planos cortos
 *   4  CIERRE       CTA final
 */

export const SECTIONS = ['hero', 'catalogo', 'configurador', 'detalle', 'cierre'];

export class SceneDirector {
  constructor({ scene, camera, cameraRig, quality, pointer, scroll, lighting, environment, trail, composer, envMap }) {
    this.scene = scene;
    this.camera = camera;
    this.rig = cameraRig;
    this.quality = quality;
    this.pointer = pointer;
    this.scroll = scroll;
    this.lighting = lighting;
    this.environment = environment;
    this.trail = trail;
    this.composer = composer;
    this.envMap = envMap;

    this.section = -1;
    this.cart = 0;
    this.portrait = false;
    this._tmp = new THREE.Vector3();
    this._disposers = [];

    this.hero = new Hero(scene, quality, { envMap, pointer });
    this.uiGroup = new THREE.Group();
    this.uiGroup.name = 'ui3d';
    scene.add(this.uiGroup);
  }

  /* ═══════════════════════════════════════════════════════════
     Montaje
     ═══════════════════════════════════════════════════════════ */

  async build(renderer, onProgress) {
    const source = await this.hero.load(renderer, onProgress);
    onProgress?.(0.8);

    this.hotspots = new Hotspots(this.hero.model, {
      pointer: this.pointer,
      envMap: this.envMap,
      accent: PALETTE.cyan,
    });

    this.catalog = new Catalog(this.scene, this.quality, {
      pointer: this.pointer,
      envMap: this.envMap,
    });

    this._buildPanels();
    this._buildHUD();
    this._wireInteraction();

    this.layout(window.innerWidth / window.innerHeight);
    onProgress?.(1);
    return source;
  }

  _buildPanels() {
    /* ── Ficha de producto (sección 0) ───────────────────────── */
    this.infoPanel = new GlassPanel({
      width: 2.0, height: 1.5, radius: 0.1,
      accent: PALETTE.cyan, tint: 0x9fd8ff, tintAmount: 0.24,
      contentTexture: this._infoTexture(getColorway('cyan')),
      name: 'panel-info',
    });
    this.uiGroup.add(this.infoPanel.object3D);

    this.cta = new NeonButton({
      label: 'AÑADIR AL CARRITO',
      width: 1.5, height: 0.32,
      color: PALETTE.cyan,
      name: 'cta-add',
    });
    this.uiGroup.add(this.cta.mesh);

    /* ── Configurador (sección 2) ────────────────────────────── */
    this.configPanel = new GlassPanel({
      width: 1.9, height: 1.26, radius: 0.1,
      accent: PALETTE.cyan, tint: 0xb4a8e8, tintAmount: 0.22,
      contentTexture: this._configTexture(),
      name: 'panel-config',
    });
    this.uiGroup.add(this.configPanel.object3D);

    this.swatches = COLORWAYS.map((cw, i) => {
      const b = new NeonButton({
        label: cw.name.replace('Volta ', ''),
        width: 0.78, height: 0.26, radius: 0.13,
        color: cw.accent,
        name: `swatch-${cw.id}`,
      });
      b.mesh.userData.colorwayId = cw.id;
      b.mesh.userData.swatchIndex = i;
      this.uiGroup.add(b.mesh);
      return b;
    });

    /* ── Detalle: panel que describe el hotspot activo ───────── */
    this.detailPanel = new GlassPanel({
      width: 1.75, height: 0.95, radius: 0.09,
      accent: PALETTE.cyan, tint: 0x9fd8ff, tintAmount: 0.26,
      contentTexture: this._detailTexture(null),
      name: 'panel-detail',
    });
    this.uiGroup.add(this.detailPanel.object3D);

    /* ── Cierre ──────────────────────────────────────────────── */
    this.outroPanel = new GlassPanel({
      width: 2.3, height: 1.15, radius: 0.11,
      accent: PALETTE.violet, tint: 0xc8b4f0, tintAmount: 0.2,
      contentTexture: this._outroTexture(),
      name: 'panel-outro',
    });
    this.uiGroup.add(this.outroPanel.object3D);

    this.outroCta = new NeonButton({
      label: 'FINALIZAR COMPRA',
      width: 1.7, height: 0.34,
      color: PALETTE.violet,
      name: 'cta-checkout',
    });
    this.uiGroup.add(this.outroCta.mesh);

    this.panels = [this.infoPanel, this.configPanel, this.detailPanel, this.outroPanel];
    this.buttons = [this.cta, this.outroCta, ...this.swatches];

    for (const b of this.buttons) this.pointer?.register(b.mesh);
    for (const p of this.panels) this.pointer?.register(p.mesh);
  }

  /**
   * HUD del carrito.
   *
   * Va colgado de la cámara, no de la escena: así permanece anclado a la
   * esquina de la pantalla mientras todo lo demás se mueve. Es el único
   * elemento de la experiencia que no vive en el espacio del mundo, y tiene
   * su motivo: un contador de carrito que se aleja al hacer scroll deja de
   * ser un indicador de estado.
   */
  _buildHUD() {
    this.hud = new THREE.Group();
    this.hud.name = 'hud';

    this.cartPanel = new GlassPanel({
      width: 0.44, height: 0.17, radius: 0.05,
      accent: PALETTE.cyan, tint: 0x9fd8ff, tintAmount: 0.3,
      edgeGlow: 0.6,
      contentTexture: this._cartTexture(0),
      shadow: false,
      name: 'hud-cart',
    });
    this.hud.add(this.cartPanel.object3D);

    // Colocación en espacio de vista: a 1.2 de la cámara, esquina superior
    // derecha. Recalculado cada frame para seguir los cambios de focal.
    this.hud.position.set(0, 0, -1.2);
    this.camera.add(this.hud);

    // A diferencia del resto de paneles, el carrito no pertenece a ninguna
    // sección: está siempre. Como GlassPanel nace oculto, hay que abrirlo
    // explícitamente una vez.
    this.cartPanel.reveal({ duration: 0.9, delay: 0.35 });
  }

  /* ═══════════════════════════════════════════════════════════
     Contenido de los paneles
     ═══════════════════════════════════════════════════════════ */

  /*
   * ESCALA TIPOGRÁFICA.
   *
   * El espacio virtual de PanelCanvas mide 1000 de alto y representa la
   * altura del panel. Un panel de 1.5 unidades de mundo ocupa unos 190 px
   * en pantalla, así que un cuerpo de texto de "27" acaba midiendo 5 px:
   * ilegible. La regla práctica en una UI dentro del canvas es que el
   * cuerpo no baje de ~40 (4 % de la altura del panel) y que haya la
   * mitad de palabras que en su equivalente web.
   */

  _infoTexture(cw) {
    const c = new PanelCanvas(2.0 / 1.5, 900, 1);
    c.clear();
    c.pill('Nuevo · 2026', { x: 62, y: 62, size: 30, color: cssColor(cw.accent), bg: 'rgba(0,255,255,0.08)' });

    c.text('VOLTA ONE', { x: 62, y: 268, size: 116, weight: 700, color: '#ffffff', tracking: -2 });
    c.text('Edición Nocturne', { x: 62, y: 330, size: 42, weight: 400, color: 'rgba(232,232,239,0.58)' });

    c.rule({ x: 62, y: 386, width: c.vw - 124 });

    c.paragraph('Entresuela translúcida sobre cámara de aire presurizada. Chasis de aluminio grabado a láser.', {
      x: 62, y: 462, size: 44, maxWidth: c.vw - 124, lineHeight: 1.5,
    });

    c.text('289 €', { x: 62, y: 806, size: 92, weight: 600, color: '#ffffff' });
    c.text('IVA incl. · Envío 48 h', { x: 62, y: 872, size: 34, color: 'rgba(232,232,239,0.45)' });

    c.text('EU 38—47', { x: c.vw - 62, y: 806, size: 40, weight: 500, color: cssColor(cw.accent, 0.9), align: 'right', tracking: 4 });
    return c.toTexture({ anisotropy: 8 });
  }

  _configTexture() {
    const c = new PanelCanvas(1.9 / 1.26, 800, 1);
    c.clear();
    c.text('ACABADO', { x: 60, y: 120, size: 40, weight: 600, color: 'rgba(255,255,255,0.55)', tracking: 16 });
    c.rule({ x: 60, y: 164, width: c.vw - 120 });
    c.paragraph('El cambio recorre la pieza de talón a puntera en medio segundo.', {
      x: 60, y: 268, size: 46, maxWidth: c.vw - 120, lineHeight: 1.5,
    });
    c.text('ELIGE ABAJO', { x: 60, y: c.vh - 90, size: 34, weight: 500, color: 'rgba(255,255,255,0.35)', tracking: 12 });
    return c.toTexture({ anisotropy: 8 });
  }

  _detailTexture(spec) {
    const c = new PanelCanvas(1.75 / 0.95, 700, 1);
    c.clear();
    if (!spec) {
      c.text('PUNTOS DE INTERÉS', { x: 56, y: 190, size: 62, weight: 600, color: 'rgba(255,255,255,0.92)', tracking: 3 });
      c.paragraph('Pulsa una esfera de cristal para acercarte.', {
        x: 56, y: 300, size: 46, maxWidth: c.vw - 112,
      });
    } else {
      c.text(spec.title.toUpperCase(), { x: 56, y: 160, size: 62, weight: 600, color: '#ffffff', tracking: 2 });
      c.rule({ x: 56, y: 210, width: c.vw - 112 });
      c.paragraph(spec.body, { x: 56, y: 300, size: 42, maxWidth: c.vw - 112, lineHeight: 1.45 });
    }
    return c.toTexture({ anisotropy: 8 });
  }

  _outroTexture() {
    const c = new PanelCanvas(2.3 / 1.15, 760, 1);
    c.clear();
    c.text('TU SELECCIÓN', { x: 60, y: 112, size: 36, weight: 600, color: 'rgba(255,255,255,0.5)', tracking: 14 });
    c.text('Volta One', { x: 60, y: 268, size: 116, weight: 700, color: '#ffffff' });
    c.rule({ x: 60, y: 326, width: c.vw - 120 });
    c.text('Acabado', { x: 60, y: 428, size: 42, color: 'rgba(232,232,239,0.5)' });
    c.text('Cian eléctrico', { x: c.vw - 60, y: 428, size: 42, color: '#ffffff', align: 'right' });
    c.text('Entrega', { x: 60, y: 508, size: 42, color: 'rgba(232,232,239,0.5)' });
    c.text('48 h · gratuita', { x: c.vw - 60, y: 508, size: 42, color: '#ffffff', align: 'right' });
    c.text('Total', { x: 60, y: 640, size: 46, weight: 600, color: 'rgba(232,232,239,0.72)' });
    c.text('289 €', { x: c.vw - 60, y: 648, size: 84, weight: 700, color: '#ffffff', align: 'right' });
    return c.toTexture({ anisotropy: 8 });
  }

  _cartTexture(n) {
    const c = new PanelCanvas(0.44 / 0.17, 260, 2);
    c.clear();
    c.text('CARRITO', { x: 60, y: 1000 / 2 + 60, size: 150, weight: 600, color: 'rgba(255,255,255,0.7)', tracking: 14 });
    c.text(String(n), {
      x: c.vw - 60, y: 1000 / 2 + 66, size: 180, weight: 700,
      color: n > 0 ? cssColor(PALETTE.cyan) : 'rgba(255,255,255,0.38)',
      align: 'right',
    });
    return c.toTexture({ anisotropy: 8 });
  }

  /* ═══════════════════════════════════════════════════════════
     Interacción
     ═══════════════════════════════════════════════════════════ */

  _wireInteraction() {
    // CTA principal
    this._disposers.push(this.cta.onClick(() => this.addToCart()));
    this._disposers.push(this.outroCta.onClick(() => this.checkout()));

    // Selector de acabado
    for (const b of this.swatches) {
      this._disposers.push(
        b.onClick(() => {
          const id = b.mesh.userData.colorwayId;
          this.applyColorway(id);
        })
      );
    }

    // Hover y clic genérico: el Pointer entrega el objeto, aquí se decide
    // qué significa según a quién pertenezca.
    this._disposers.push(
      this.pointer.onHover((obj, prev) => {
        const btn = obj?.userData?.button;
        const prevBtn = prev?.userData?.button;
        if (prevBtn && prevBtn !== btn) prevBtn.setHover(false);
        if (btn) btn.setHover(true);

        // Mouse-over sobre el héroe: se detiene el giro y se despieza.
        const overHero = this._isHeroPart(obj);
        const wasOverHero = this._isHeroPart(prev);
        if (overHero && !wasOverHero && this.section <= 3) this._onHeroEnter();
        if (!overHero && wasOverHero) this._onHeroLeave();
      })
    );

    this._disposers.push(
      this.pointer.onClick((obj) => {
        const btn = obj?.userData?.button;
        if (btn) btn.press();
      })
    );

    // Hotspot seleccionado → plano detalle + texto.
    this._disposers.push(
      this.hotspots.onSelect((spec) => {
        this.detailPanel.setContent(this._detailTexture(spec));
        if (spec) {
          this.hero.getHotspotWorld(spec.id, this._tmp);
          this.rig.pushCloseUp(this._tmp, { distance: 1.5, height: 0.22 });
          this.environment.setIntensity(0.45);
          this.lighting.setExposure(0.8);
        } else {
          this.rig.popCloseUp({ focal: this._shot(this.section).focal });
          this.environment.setIntensity(1);
          this.lighting.setExposure(1);
        }
      })
    );

    // El héroe también responde al puntero: lo registramos entero.
    this.pointer.register(this.hero.model);
  }

  _isHeroPart(obj) {
    if (!obj) return false;
    let n = obj;
    while (n) {
      if (n === this.hero.model) return true;
      n = n.parent;
    }
    return false;
  }

  _onHeroEnter() {
    if (this.section === 1) return; // en el catálogo el héroe es decorado
    this.hero.setSpinning(false);
    this.hero.setExploded(true, { amount: this.section === 3 ? 1.25 : 0.75 });
    this.hotspots.show();
  }

  _onHeroLeave() {
    if (this.section === 3) return; // en detalle el despiece es permanente
    this.hero.setExploded(false);
    this.hero.setSpinning(true);
    this.hotspots.hide();
    this.hotspots.clear();
  }

  /* ── Acciones ──────────────────────────────────────────────── */

  applyColorway(id) {
    const cw = getColorway(id);
    this.hero.setColorway(id);
    this.hotspots.setAccent(cw.accent);
    for (const p of this.panels) p.setAccent(cw.accent);
    this.cta.setColor(cw.accent);
    this.cartPanel.setAccent(cw.accent);
    this.infoPanel.setContent(this._infoTexture(cw));
    // Un pequeño empujón de bloom acompaña la onda: la escena "reacciona".
    gsap.fromTo(this.composer.bloomPass, { strength: 0.95 }, { strength: this._sectionBloom(), duration: 0.9, ease: 'power2.out' });
  }

  /**
   * Añadir al carrito: rastro de partículas del producto al HUD, impulso de
   * cámara y actualización del contador. Tres canales de feedback para una
   * sola acción, porque en una escena en movimiento constante un cambio
   * pequeño y estático pasa desapercibido.
   */
  addToCart() {
    this.cart += 1;
    this.cartPanel.setContent(this._cartTexture(this.cart));

    this.hero.root.getWorldPosition(this._tmp);
    const to = this.cartPanel.object3D.getWorldPosition(new THREE.Vector3());
    const cw = getColorway(this.hero.colorwayId);
    this.trail.fire(this._tmp, to, { color: cw.accent });

    this.rig.impulse(0.09);
    // La escala del carrito se anima sobre el valor que fija _layoutHUD
    // cada frame, así que animamos el grupo padre y no el panel.
    gsap.fromTo(
      this.hud.scale,
      { x: 1.22, y: 1.22, z: 1 },
      { x: 1, y: 1, z: 1, duration: 0.7, ease: 'elastic.out(1, 0.5)' }
    );
    gsap.fromTo(this.composer.bloomPass, { strength: 1.05 }, { strength: this._sectionBloom(), duration: 1.0, ease: 'power2.out' });
  }

  checkout() {
    this.rig.impulse(0.06);
    gsap.fromTo(this.composer.bloomPass, { strength: 1.3 }, { strength: this._sectionBloom(), duration: 1.4, ease: 'power2.out' });
  }

  /** Nivel de bloom de reposo de la sección actual. */
  _sectionBloom() {
    return [0.5, 0.42, 0.58, 0.46, 0.68][THREE.MathUtils.clamp(this.section, 0, 4)];
  }

  /* ═══════════════════════════════════════════════════════════
     Layout responsivo
     ═══════════════════════════════════════════════════════════ */

  layout(aspect) {
    this.aspect = aspect;
    this.portrait = aspect < 1.0;
    this.catalog?.layout(aspect);

    // Lado del panel: a la derecha en apaisado, debajo en vertical.
    //
    // El mínimo de 1.78 no es arbitrario. El héroe mide 3 unidades y se
    // sitúa en −side·0.52; el panel mide 2 y su borde izquierdo cae en
    // side−1. Por debajo de ese valor las dos cajas se solapan y la ficha
    // se come la puntera de la zapatilla.
    const side = this.portrait ? 0 : THREE.MathUtils.clamp(1.5 + aspect * 0.22, 1.78, 2.45);
    this._slots = this.portrait
      ? {
          heroHome: new THREE.Vector3(0, 0.72, 0),
          heroScale: 0.78,
          info: new THREE.Vector3(0, -1.05, 0.35),
          cta: new THREE.Vector3(0, -1.92, 0.4),
          config: new THREE.Vector3(0, -1.02, 0.35),
          swatchY: -1.78,
          detail: new THREE.Vector3(0, -1.32, 0.5),
          outro: new THREE.Vector3(0, -0.5, 0.9),
          outroCta: new THREE.Vector3(0, -1.35, 0.95),
          heroCorner: new THREE.Vector3(-1.5, 2.35, -1.1),
          heroOutro: new THREE.Vector3(0, 1.05, -0.9),
        }
      : {
          heroHome: new THREE.Vector3(-side * 0.52, 0, 0),
          heroScale: 1,
          info: new THREE.Vector3(side, 0.12, 0.25),
          cta: new THREE.Vector3(side, -0.92, 0.3),
          config: new THREE.Vector3(side, 0.24, 0.3),
          swatchY: -0.62,
          detail: new THREE.Vector3(side * 0.95, -0.05, 0.55),
          outro: new THREE.Vector3(0, -0.12, 1.35),
          outroCta: new THREE.Vector3(0, -0.95, 1.4),
          heroCorner: new THREE.Vector3(-side * 1.5, 1.9, -1.2),
          heroOutro: new THREE.Vector3(0, 1.15, -1.1),
        };

    const s = this._slots;
    this.infoPanel.object3D.position.copy(s.info);
    this.cta.mesh.position.copy(s.cta);
    this.configPanel.object3D.position.copy(s.config);
    this.detailPanel.object3D.position.copy(s.detail);
    this.outroPanel.object3D.position.copy(s.outro);
    this.outroCta.mesh.position.copy(s.outroCta);

    // Fila de acabados, centrada bajo el panel del configurador.
    const gap = 0.86;
    const total = (this.swatches.length - 1) * gap;
    this.swatches.forEach((b, i) => {
      b.mesh.position.set(s.config.x + i * gap - total / 2, s.swatchY, s.config.z + 0.05);
    });

    this._layoutHUD();

    // Los encuadres dependen de las cajas de contenido que acabamos de
    // recalcular, así que hay que reaplicar el de la sección actual.
    if (this.section >= 0) this.rig.snapShot(this._shot(this.section));
  }

  /**
   * Ancla el HUD a la esquina superior derecha, en espacio de vista.
   *
   * Se recalcula cada frame porque el FOV cambia continuamente: la focal se
   * anima entre secciones y el scroll la mueve además. Con un cálculo único
   * en el resize, el carrito se despegaría de la esquina en cuanto la lente
   * se abriera.
   */
  _layoutHUD() {
    const dist = 1.2;
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const h = 2 * Math.tan(vFov / 2) * dist;
    const w = h * this.camera.aspect;
    const k = THREE.MathUtils.clamp(h * 0.52, 0.42, 0.85);
    // Margen constante respecto al borde del encuadre, medido desde el
    // borde del propio panel: así el carrito queda anclado a la esquina
    // independientemente de cuánto se abra la lente.
    const margin = 0.055;
    this.hud.position.set(
      w / 2 - (0.44 * k) / 2 - margin,
      h / 2 - (0.17 * k) / 2 - margin,
      -dist
    );
    this.cartPanel.object3D.scale.setScalar(k);
  }

  /* ═══════════════════════════════════════════════════════════
     Transiciones de sección
     ═══════════════════════════════════════════════════════════ */

  /**
   * Distancia necesaria para que quepa una caja de contenido.
   *
   * Clavar `z` a mano funciona en el monitor donde se desarrolla y se rompe
   * en todos los demás: en 21:9 sobra aire por los lados y en un portátil
   * 16:10 el producto sale recortado. Aquí se invierte la relación —
   * primero decidimos QUÉ tiene que caber, y la distancia sale de la lente.
   *
   * Se replica el modelo de cámara de three: filmHeight = filmGauge /
   * max(aspect, 1), así que en apaisado el campo horizontal es constante y
   * en vertical lo es el vertical.
   */
  _fitDistance(halfW, halfH, focal, margin = 1.14) {
    const aspect = this.aspect || 1;
    const filmHeight = 35 / Math.max(aspect, 1);
    const vSlope = (0.5 * filmHeight) / focal;
    const hSlope = vSlope * aspect;
    return Math.max(halfH / vSlope, halfW / hSlope) * margin;
  }

  /** Caja de contenido de cada sección, en unidades de mundo. */
  _contentBox(i) {
    const s = this._slots;
    const p = this.portrait;

    switch (i) {
      case 1: {
        const c = this.catalog;
        return {
          halfW: ((c.cols - 1) * 1.42) / 2 + 0.75,
          halfH: ((c.rows - 1) * 1.86) / 2 + 1.05,
        };
      }
      case 2:
        return p
          ? { halfW: 1.5, halfH: Math.abs(s.swatchY) + 0.5 }
          : { halfW: s.config.x + 0.95 + 0.3, halfH: 1.15 };
      case 3:
        // El despiece ocupa bastante más que el modelo cerrado.
        return p ? { halfW: 1.7, halfH: 2.3 } : { halfW: s.detail.x + 0.88, halfH: 1.5 };
      case 4:
        // El contenido va de la puntera del producto retirado (y ≈ 1.5) al
        // borde inferior del CTA (y ≈ −1.1). Centro en 0.2, semialtura 1.35.
        return p ? { halfW: 1.35, halfH: 1.95 } : { halfW: 1.35, halfH: 1.5 };
      case 0:
      default:
        // En vertical manda el ancho: el producto mide 3 unidades de largo
        // y a escala 0.78 ocupa 1.17 de semiancho. Pedir más sólo aleja la
        // cámara y encoge todo sin ganar nada.
        return p
          ? { halfW: 1.25, halfH: Math.abs(s.cta.y) + 0.4 }
          : { halfW: s.info.x + 1.0, halfH: 1.2 };
    }
  }

  _shot(i) {
    const idx = THREE.MathUtils.clamp(i, 0, 4);
    const focal = [50, 34, 52, 55, 44][idx];
    const box = this._contentBox(idx);
    const z = this._fitDistance(box.halfW, box.halfH, focal);

    // Encuadres ligeramente descentrados: una composición con el sujeto
    // exactamente en el centro geométrico se lee como un catálogo, no como
    // una fotografía de producto.
    const offsets = [
      { x: 0, y: 0.22, tx: 0, ty: 0.02 },
      { x: 0, y: 0.0, tx: 0, ty: 0 },
      { x: 0.2, y: 0.18, tx: 0, ty: 0 },
      { x: 0.45, y: 0.3, tx: 0, ty: 0.05 },
      { x: 0, y: 0.2, tx: 0, ty: 0.18 },
    ][idx];

    return {
      position: new THREE.Vector3(offsets.x, offsets.y, z),
      target: new THREE.Vector3(offsets.tx, offsets.ty, 0),
      focal,
    };
  }

  /** Cambia de sección. Idempotente: llamarlo con la sección actual no hace nada. */
  goTo(index) {
    const i = THREE.MathUtils.clamp(index, 0, SECTIONS.length - 1);
    if (i === this.section) return;
    const prev = this.section;
    this.section = i;

    // Salir del plano detalle antes de cualquier otra cosa: si no, el
    // encuadre de la sección nueva se mezclaría con el close-up.
    if (this.rig.closeUp) {
      this.hotspots.clear();
      this.rig.popCloseUp({ focal: this._shot(i).focal });
      this.environment.setIntensity(1);
      this.lighting.setExposure(1);
    }

    this.rig.setShot({ ...this._shot(i), duration: 1.5 });

    const s = this._slots;
    const tl = gsap.timeline();

    /* ── Héroe ─────────────────────────────────────────────────
       En el cierre el protagonista pasa a ser el resumen de compra, así
       que el producto se retira detrás del panel y baja de escala: sigue
       presente, deja de competir. */
    const heroTarget = i === 1 ? s.heroCorner : i === 4 ? s.heroOutro : s.heroHome;
    const heroScale =
      i === 1 ? s.heroScale * 0.38 : i === 3 ? s.heroScale * 1.05 : i === 4 ? s.heroScale * 0.62 : s.heroScale;

    tl.to(this.hero.root.position, {
      x: heroTarget.x, y: heroTarget.y, z: heroTarget.z,
      duration: 1.4, ease: 'power3.inOut',
    }, 0);
    tl.to(this.hero.root.scale, {
      x: heroScale, y: heroScale, z: heroScale,
      duration: 1.4, ease: 'power3.inOut',
    }, 0);

    this.hero.interactive = i !== 1;

    /* ── Paneles: primero se van los que sobran, luego entran los nuevos ── */
    const wanted = {
      0: [this.infoPanel],
      1: [],
      2: [this.configPanel],
      3: [this.detailPanel],
      4: [this.outroPanel],
    }[i] || [];

    for (const p of this.panels) {
      if (!wanted.includes(p)) {
        const t = p.conceal({ duration: 0.45 });
        if (t) tl.add(t, 0);
      }
    }
    wanted.forEach((p, k) => {
      const t = p.reveal({ duration: 1.0 });
      if (t) tl.add(t, 0.5 + k * 0.1);
    });

    /* ── Botones ─────────────────────────────────────────────── */
    const showCta = i === 0;
    const showSwatches = i === 2;
    const showOutro = i === 4;

    tl.add(showCta ? this.cta.reveal({ duration: 0.5 }) : this.cta.conceal(), showCta ? 1.0 : 0);
    tl.add(showOutro ? this.outroCta.reveal({ duration: 0.5 }) : this.outroCta.conceal(), showOutro ? 1.1 : 0);
    this.swatches.forEach((b, k) => {
      tl.add(
        showSwatches ? b.reveal({ duration: 0.45 }) : b.conceal(),
        showSwatches ? 1.0 + k * 0.07 : 0
      );
    });

    /* ── Catálogo ────────────────────────────────────────────── */
    if (i === 1) {
      const t = this.catalog.reveal();
      if (t) tl.add(t, 0.45);
    } else if (prev === 1) {
      const t = this.catalog.conceal();
      if (t) tl.add(t, 0);
    }

    /* ── Detalle: despiece permanente + hotspots ─────────────────
       El guardián `this.section === 3` no sobra. El despiece va diferido
       0.8 s para que arranque cuando la cámara ya está encuadrando; si el
       usuario sigue haciendo scroll antes de eso, la llamada pendiente se
       ejecuta cuando ya estamos en la sección 4 y despieza el producto en
       mitad del resumen de compra. La salida de la 3, mientras tanto, ve
       exploded === false y no hace nada. */
    if (i === 3) {
      tl.call(() => {
        if (this.section !== 3) return;
        this.hero.setSpinning(false);
        this.hero.setExploded(true, { amount: 1.25, duration: 1.1 });
        this.hotspots.show({ stagger: 0.1 });
      }, null, 0.8);
    } else if (prev === 3 || this.hero.exploded) {
      this.hero.setExploded(false);
      this.hero.setSpinning(true);
      this.hotspots.hide();
      this.hotspots.clear();
    }

    /* ── Atmósfera por sección ───────────────────────────────── */
    tl.to(this.composer.bloomPass, { strength: this._sectionBloom(), duration: 1.2, ease: 'power2.inOut' }, 0);

    return tl;
  }

  /* ═══════════════════════════════════════════════════════════
     Bucle
     ═══════════════════════════════════════════════════════════ */

  update(dt, time) {
    this._layoutHUD();
    this.hero.update(dt, time);
    this.hotspots.update(dt, time, this.camera);
    this.catalog.update(dt, time, this.camera);

    for (const p of this.panels) p.update(dt, time);
    for (const b of this.buttons) b.update(dt, time);
    this.cartPanel.update(dt, time);

    // Los paneles miran a cámara sólo en el eje Y y con amortiguación: un
    // billboard completo se siente robótico, y sin ninguna orientación los
    // paneles laterales se ven demasiado escorzados.
    const yaw = Math.atan2(
      this.camera.position.x - this.hero.root.position.x,
      this.camera.position.z - this.hero.root.position.z
    );
    for (const p of this.panels) {
      if (!p.mesh.visible) continue;
      p.object3D.rotation.y += (yaw * 0.35 - p.object3D.rotation.y) * Math.min(1, dt * 2.2);
    }
  }

  /** Objetos que no forman parte del fondo desenfocado. */
  get backdropExclusions() {
    return [this.uiGroup, this.hud, ...(this.catalog?.backdropExclusions || [])];
  }

  setBackdrop(blurTex, sharpTex) {
    for (const p of this.panels) p.setBackdrop(blurTex, sharpTex);
    this.cartPanel.setBackdrop(blurTex, sharpTex);
    for (const b of this.buttons) b.setBackdrop(blurTex);
    this.catalog?.setBackdrop(blurTex, sharpTex);
  }

  dispose() {
    this._disposers.forEach((fn) => fn?.());
    this.hotspots?.dispose();
    this.catalog?.dispose();
    for (const p of this.panels) p.dispose();
    for (const b of this.buttons) b.dispose();
    this.cartPanel.dispose();
    this.hud.removeFromParent();
    this.hero.dispose();
    this.uiGroup.removeFromParent();
  }
}
