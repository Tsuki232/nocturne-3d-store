import { App } from './core/App.js';

/**
 * Punto de entrada.
 *
 * Responsabilidades, y sólo estas tres: comprobar que el navegador puede
 * ejecutar la experiencia, gestionar el preloader y arrancar la App. Toda
 * la lógica vive dentro del canvas.
 */

const canvas = document.getElementById('gl');
const preloader = document.getElementById('preloader');
const bar = preloader.querySelector('.pre-bar i');
const pct = preloader.querySelector('.pre-pct');

/** WebGL2 es requisito real, no una preferencia: el `sampler2DArray` del
 *  catálogo instanciado y los render targets HalfFloat no existen en WebGL1. */
function supportsWebGL2() {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

function fail(message) {
  preloader.innerHTML = `
    <div class="pre-inner">
      <div class="pre-mark">NOCTURNE</div>
      <p style="max-width:36ch;text-align:center;font-size:14px;line-height:1.7;color:rgba(232,232,239,.6)">
        ${message}
      </p>
    </div>`;
}

let shown = 0;
function setProgress(v) {
  // Monótono: una barra que retrocede destruye la confianza en la carga,
  // aunque el número de debajo sea más honesto.
  shown = Math.max(shown, Math.min(1, v));
  bar.style.width = `${(shown * 100).toFixed(0)}%`;
  pct.textContent = `${Math.round(shown * 100)}%`;
}

async function boot() {
  if (!supportsWebGL2()) {
    fail('Esta experiencia necesita WebGL2. Prueba con una versión reciente de Chrome, Edge, Firefox o Safari.');
    return;
  }

  let app;
  try {
    setProgress(0.06);
    app = new App(canvas);
    setProgress(0.25);

    const source = await app.start((p) => setProgress(0.25 + p * 0.7));
    setProgress(1);

    console.info(
      `%c NOCTURNE %c modelo: ${source} · tier: ${app.quality.tierName} · pulsa D para diagnóstico `,
      'background:#00ffff;color:#0a0a0c;font-weight:700',
      'background:#1a0033;color:#e8e8ef'
    );

    // Margen de un frame para que la primera imagen esté ya compuesta
    // detrás del preloader antes de destaparla.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        preloader.classList.add('done');
        setTimeout(() => preloader.remove(), 900);
      });
    });

    window.__nocturne = app; // asidero para depurar desde la consola
  } catch (err) {
    console.error('[NOCTURNE] fallo al arrancar', err);
    fail('No se ha podido iniciar la escena 3D. Revisa la consola para ver el detalle del error.');
    app?.dispose();
    return;
  }

  // Vite HMR: sin esto, cada guardado deja una App entera con su contexto
  // WebGL colgando en memoria hasta que el navegador se rinde.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => app.dispose());
  }
}

boot();
