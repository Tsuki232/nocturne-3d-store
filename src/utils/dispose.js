/**
 * Liberación de VRAM.
 *
 * Three.js no tiene recolector de basura para recursos GPU: si sueltas la
 * referencia JS a una geometría, el buffer sigue vivo en la tarjeta hasta
 * que llamas a .dispose(). En una experiencia que carga y descarga escenas
 * eso se convierte en una fuga silenciosa que solo aparece como un cuelgue
 * a los diez minutos.
 *
 * Estas funciones recorren el árbol y liberan todo lo que tenga .dispose().
 */

/** Libera las texturas referenciadas por un material. */
export function disposeMaterial(material) {
  if (!material) return;

  for (const key of Object.keys(material)) {
    const value = material[key];
    if (value && typeof value === 'object' && value.isTexture) {
      value.dispose();
    }
  }

  // Las texturas que solo viven en uniforms de un ShaderMaterial no
  // aparecen como propiedades del material: hay que bucear en .uniforms.
  if (material.uniforms) {
    for (const name of Object.keys(material.uniforms)) {
      const v = material.uniforms[name]?.value;
      if (v && v.isTexture) v.dispose();
      else if (Array.isArray(v)) v.forEach((t) => t?.isTexture && t.dispose());
    }
  }

  material.dispose();
}

/** Libera geometría + material(es) de un único objeto. */
export function disposeObject(obj) {
  if (!obj) return;
  if (obj.geometry) obj.geometry.dispose();
  if (obj.material) {
    if (Array.isArray(obj.material)) obj.material.forEach(disposeMaterial);
    else disposeMaterial(obj.material);
  }
  if (obj.isInstancedMesh) obj.dispose?.();
  if (obj.isSkinnedMesh) obj.skeleton?.dispose?.();
}

/**
 * Recorre un subárbol completo liberando todo y lo desengancha del padre.
 * @param {THREE.Object3D} root
 * @param {boolean} detach  si true, hace root.removeFromParent()
 */
export function disposeHierarchy(root, detach = true) {
  if (!root) return;
  // traverse() sobre un árbol que estamos mutando es frágil: copiamos antes.
  const nodes = [];
  root.traverse((n) => nodes.push(n));
  for (const n of nodes) disposeObject(n);
  if (detach) root.removeFromParent();
  root.clear?.();
}

/** Libera un array/objeto de render targets. */
export function disposeTargets(targets) {
  const list = Array.isArray(targets) ? targets : Object.values(targets || {});
  for (const t of list) t?.dispose?.();
}
