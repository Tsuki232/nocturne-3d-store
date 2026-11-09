import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';
import { ChromaticAberrationShader } from '../postfx/ChromaticAberrationShader.js';

/**
 * Composer — la cadena de post-procesado.
 *
 * ORDEN, y por qué es ese y no otro:
 *
 *   1. RenderPass    escena → buffer HDR (HalfFloat). Aquí NO hay tone
 *                    mapping: al renderizar a un target, three desactiva la
 *                    curva automáticamente, así que los neones conservan
 *                    valores por encima de 1.0.
 *   2. Bloom         necesita ese HDR. Si la imagen ya viniera comprimida a
 *                    0-1, el umbral de luminancia no distinguiría un neón
 *                    de una superficie blanca y todo florecería por igual.
 *   3. Aberración    simula la lente. Va sobre la imagen ya "fotografiada",
 *                    incluido el bloom: el halo también se descompone.
 *   4. OutputPass    tone mapping ACES + conversión a sRGB. El único punto
 *                    de la cadena donde se sale del espacio lineal.
 *   5. FXAA          el último, obligatoriamente. Es un algoritmo que busca
 *                    bordes por contraste percibido, y necesita luminancia
 *                    en sRGB. Puesto antes del OutputPass, suaviza donde no
 *                    debe y se salta bordes evidentes.
 *
 * La escala de resolución (postScale) se aplica vía setPixelRatio, así que
 * afecta a los buffers internos pero no al blit final a pantalla.
 */
export class Composer {
  constructor(renderer, scene, camera, quality, sizes) {
    this.renderer = renderer;
    this.quality = quality;
    this.sizes = sizes;
    this.enabled = true;

    this.composer = new EffectComposer(renderer);
    this.composer.setPixelRatio(quality.dpr * quality.postScale);
    this.composer.setSize(sizes.width, sizes.height);

    /* 1 ── Escena */
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    /* 2 ── Bloom */
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(sizes.width, sizes.height),
      0.5,  // strength
      0.35, // radius
      // UMBRAL POR ENCIMA DE 1.0, y es la decisión que sostiene todo el
      // look. El pase opera sobre valores HDR lineales, antes del tone
      // mapping. Con umbral 0.9, una superficie de cristal bien iluminada
      // ya lo supera y florece entera: el producto se convierte en una
      // mancha de luz. Por encima de 1.0 sólo pasan las fuentes que
      // realmente emiten —neón, bordes emissive, especulares duros— que
      // es exactamente lo que el brief quiere ver resplandecer.
      1.1
    );
    this.bloomPass.enabled = quality.bloom;
    this.composer.addPass(this.bloomPass);

    /* 3 ── Aberración cromática */
    this.chromaticPass = new ShaderPass(ChromaticAberrationShader);
    this.chromaticPass.enabled = quality.chromatic;
    this.composer.addPass(this.chromaticPass);

    /* 4 ── Tone mapping + sRGB */
    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    /* 5 ── Antialiasing */
    this.fxaaPass = new FXAAPass();
    this.fxaaPass.enabled = quality.fxaa;
    this.composer.addPass(this.fxaaPass);

    this._syncRenderToScreen();
    this._unsub = quality.onChange((q) => this.applyQuality(q));
  }

  /**
   * El último pase habilitado debe pintar a pantalla. EffectComposer marca
   * `renderToScreen` sólo en el último de la lista, sin mirar si está
   * activo; si desactivamos FXAA en móvil sin esto, el resultado va a un
   * buffer que nadie lee y la pantalla se queda negra.
   */
  _syncRenderToScreen() {
    const passes = this.composer.passes;
    let last = null;
    for (const p of passes) {
      p.renderToScreen = false;
      if (p.enabled) last = p;
    }
    if (last) last.renderToScreen = true;
  }

  setCamera(camera) {
    this.renderPass.camera = camera;
  }

  render(dt) {
    if (this.enabled) {
      this.composer.render(dt);
    } else {
      // Salida directa: útil para depurar y como red de seguridad si el
      // post-procesado falla en un driver concreto.
      this.renderer.render(this.renderPass.scene, this.renderPass.camera);
    }
  }

  setSize(width, height) {
    this.composer.setPixelRatio(this.quality.dpr * this.quality.postScale);
    this.composer.setSize(width, height);
    this.bloomPass.setSize(width, height);
  }

  /** Intensidad global del bloom (lo modula el director de escena). */
  setBloom(strength, radius) {
    this.bloomPass.strength = strength;
    if (radius != null) this.bloomPass.radius = radius;
  }

  setChromatic(strength) {
    this.chromaticPass.material.uniforms.uStrength.value = strength;
  }

  applyQuality(q) {
    this.bloomPass.enabled = q.bloom;
    this.chromaticPass.enabled = q.chromatic;
    this.fxaaPass.enabled = q.fxaa;
    this._syncRenderToScreen();
    this.setSize(this.sizes.width, this.sizes.height);
  }

  dispose() {
    this._unsub?.();
    this.composer.passes.forEach((p) => p.dispose?.());
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();
  }
}
