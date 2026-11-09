import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { PALETTE } from '../materials/palette.js';

/**
 * Lighting — un plató de estudio, no una escena "iluminada".
 *
 * El esquema es el de una sesión de producto real:
 *
 *   AMBIENT  — casi nada. Subirla es la tentación cuando algo se ve oscuro,
 *              y es también lo que aplana la escena y mata el contraste.
 *   KEY      — una sola luz dura arriba-delante que define la forma.
 *   RIM ×2   — dos paneles neón DETRÁS del sujeto. No iluminan: dibujan el
 *              contorno. Son los responsables de que el objeto se despegue
 *              del fondo negro en lugar de fundirse con él.
 *
 * Las RectAreaLight son caras y tienen dos limitaciones que conviene tener
 * presentes: no proyectan sombras y sólo afectan a MeshStandard/Physical.
 * A cambio, son las únicas que producen un reflejo especular con FORMA
 * rectangular, que es justo lo que hace que el cromo parezca fotografiado.
 */
export class Lighting {
  constructor(scene, quality) {
    this.scene = scene;
    this.quality = quality;
    this.group = new THREE.Group();
    this.group.name = 'lighting';
    scene.add(this.group);

    RectAreaLightUniformsLib.init();

    this._buildAmbient();
    this._buildKey();
    this._buildRims();
    this._buildShadowCatcher();

    this._unsub = quality.onChange((q) => this.applyQuality(q));
  }

  _buildAmbient() {
    // Tinte frío y muy bajo: sólo evita que las sombras sean negro absoluto.
    this.ambient = new THREE.AmbientLight(0x2a2a44, 0.28);
    this.group.add(this.ambient);

    // Hemisphere sutil: cielo violeta arriba, rebote azulado abajo. Da
    // dirección al relleno sin necesidad de una segunda luz direccional.
    this.hemi = new THREE.HemisphereLight(PALETTE.violetDeep, 0x0a1220, 0.45);
    this.group.add(this.hemi);
  }

  _buildKey() {
    // Intensidad moderada a propósito. Una DirectionalLight es una fuente
    // puntual sin tamaño angular, así que sobre un metal de roughness ~0
    // produce un especular diminuto e infinitamente brillante que no
    // existe en ninguna fotografía real. En una escena dominada por cromo,
    // el modelado lo tiene que hacer el envMap —que sí tiene superficies
    // con forma— y la key sólo aporta dirección y sombra.
    this.key = new THREE.DirectionalLight(0xffffff, 2.0);
    this.key.position.set(4.2, 7.5, 5.0);
    this.key.castShadow = this.quality.shadows;

    const s = this.key.shadow;
    s.mapSize.set(this.quality.shadowMapSize, this.quality.shadowMapSize);
    // Frustum ajustado al sujeto. Un frustum enorme reparte la misma
    // resolución de mapa sobre más área y produce sombras dentadas.
    s.camera.near = 1;
    s.camera.far = 24;
    s.camera.left = -4.5;
    s.camera.right = 4.5;
    s.camera.top = 4.5;
    s.camera.bottom = -4.5;
    s.bias = -0.0006;
    s.normalBias = 0.028;
    s.radius = 5; // PCF: el "suavizado" de la luz de estudio
    s.blurSamples = 12;

    this.key.target.position.set(0, 0.1, 0);
    this.group.add(this.key, this.key.target);
  }

  _buildRims() {
    const rim = (color, intensity, pos) => {
      const l = new THREE.RectAreaLight(color, intensity, 2.6, 4.2);
      l.position.copy(pos);
      l.lookAt(0, 0.3, 0);
      this.group.add(l);
      return l;
    };

    // Violeta detrás a la izquierda, cian detrás a la derecha: el contraste
    // cromático entre los dos bordes es lo que da volumen sin luz frontal.
    //
    // Las intensidades están deliberadamente por debajo de lo que "se ve
    // bien" en aislado: una rim light debe dibujar un filo, y en cuanto
    // ilumina la cara del objeto deja de separarlo del fondo y lo funde
    // en una masa de color.
    this.rimViolet = rim(PALETTE.violet, 7.5, new THREE.Vector3(-3.4, 1.5, -3.2));
    this.rimCyan = rim(PALETTE.cyan, 6, new THREE.Vector3(3.4, 1.3, -3.0));

    // Kicker inferior muy tenue: separa la suela del suelo.
    this.kicker = new THREE.RectAreaLight(0x3a6bff, 2.4, 5, 1.6);
    this.kicker.position.set(0, -1.6, 2.2);
    this.kicker.lookAt(0, 0.2, 0);
    this.group.add(this.kicker);

    this._rimBase = {
      violet: this.rimViolet.intensity,
      cyan: this.rimCyan.intensity,
    };
  }

  /**
   * Plano invisible que sólo recoge sombra.
   *
   * Con un plano rectangular normal, la sombra se corta en seco en el borde
   * de la geometría y delata que hay un suelo invisible: aparece una losa
   * oscura flotando en mitad del espacio. Como aquí no hay suelo —el objeto
   * levita— el receptor tiene que desvanecerse radialmente. Inyectamos esa
   * caída en el ShadowMaterial para que la sombra se disuelva en la nada.
   */
  _buildShadowCatcher() {
    const geo = new THREE.PlaneGeometry(11, 11);
    const mat = new THREE.ShadowMaterial({ opacity: 0.34, transparent: true });

    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vFadeUv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFadeUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vFadeUv;')
        // shadow.glsl no incluye <opaque_fragment>: su main escribe
        // gl_FragColor directamente y pasa a <tonemapping_fragment>. Ese
        // es el primer punto de anclaje válido después de la asignación.
        .replace(
          '#include <tonemapping_fragment>',
          `gl_FragColor.a *= 1.0 - smoothstep(0.14, 0.48, length(vFadeUv - 0.5));
           #include <tonemapping_fragment>`
        );
    };
    mat.customProgramCacheKey = () => 'shadow-radial-fade';
    // depthWrite: false es obligatorio aquí. ShadowMaterial es transparente
    // pero escribe profundidad por defecto, y este plano se extiende hacia
    // la cámara: cualquier panel de UI situado por debajo de y = −0.92
    // —todos los del layout vertical— quedaba cortado por una losa
    // invisible. renderOrder bajo lo manda a dibujarse antes que la UI.
    mat.depthWrite = false;

    this.catcher = new THREE.Mesh(geo, mat);
    this.catcher.rotation.x = -Math.PI / 2;
    this.catcher.position.y = -0.92;
    this.catcher.receiveShadow = true;
    this.catcher.visible = this.quality.shadows;
    this.catcher.renderOrder = -5;
    this.catcher.name = 'shadow-catcher';
    this.scene.add(this.catcher);
  }

  /* ── Ciclo ─────────────────────────────────────────────────── */

  /**
   * Respiración de los neones. Amplitud baja y dos frecuencias primas entre
   * sí para que el ciclo no se perciba como un bucle.
   */
  update(time) {
    const v = 1 + Math.sin(time * 0.63) * 0.09;
    const c = 1 + Math.sin(time * 0.41 + 2.1) * 0.11;
    this.rimViolet.intensity = this._rimBase.violet * v;
    this.rimCyan.intensity = this._rimBase.cyan * c;
  }

  /** Atenúa las luces de escena (transición a plano detalle). */
  setExposure(k) {
    this.key.intensity = 2.0 * k;
    this.ambient.intensity = 0.28 * k;
    this.hemi.intensity = 0.45 * k;
  }

  applyQuality(q) {
    this.key.castShadow = q.shadows;
    this.key.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
    this.key.shadow.map?.dispose();
    this.key.shadow.map = null;
    this.catcher.visible = q.shadows;

    // En el tier bajo el kicker es el primero en caer: es la luz que menos
    // aporta a la lectura de la forma y una RectAreaLight nunca es barata.
    this.kicker.visible = q.name !== 'low';
  }

  dispose() {
    this._unsub?.();
    this.catcher.geometry.dispose();
    this.catcher.material.dispose();
    this.catcher.removeFromParent();
    this.key.shadow.map?.dispose();
    this.group.clear();
    this.group.removeFromParent();
  }
}
