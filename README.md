# NOCTURNE — Fully 3D animated e-commerce (WebGL)

A single-canvas storefront where the UI itself is 3D geometry (typography included), built with **Three.js r185 + GSAP 3 + Vite 8** — no React, no UI library.
Real-time glassmorphism, custom post-processing (bloom, chromatic aberration, backdrop blur), a procedural hero product, 50,000 particles and an adaptive quality tier system.

- Median frame time 13.3 ms on the high tier (74 draw calls, 96k triangles).
- Procedural textures generated client-side (zero texture downloads).
- Diagnostics overlay: press **D** (fps, draw calls, triangles, quality tier, active section).
- Built with AI-assisted development (Claude Code).

```bash
npm install
npm run dev
```

> The original documentation (Spanish) follows below.

---
# NOCTURNE — E-commerce 3D hiper-animado

Implementación del blueprint técnico y creativo: una tienda que no es una web
con objetos 3D, sino un espacio 3D donde la interfaz también es geometría.

Three.js r185 + GSAP 3 + Vite 8. Sin React, sin librerías de UI: todo lo que se
ve —tipografía incluida— se renderiza dentro de un único `<canvas>`.

```bash
npm install
npm run dev
```

Pulsa **D** en cualquier momento para el panel de diagnóstico (fps, draw calls,
triángulos, tier activo, sección).

---

## Estado

Las seis secciones del blueprint están implementadas y verificadas en
navegador. Medición en el tier alto, sección Hero, 961×910:

| Métrica | Valor |
|---|---|
| Frame time mediano / p95 | 13.3 ms / 13.9 ms |
| Draw calls | 74 |
| Triángulos | 96 000 |
| Partículas | 50 000 |
| Programas de shader | 50 |
| Bundle de aplicación | 108 kB (35 kB gzip) |

En el tier bajo la misma escena baja a **30 draw calls / 48 000 triángulos /
9 000 partículas**, sin bloom, sin aberración cromática, sin sombras y sin
desenfoque de fondo, conservando composición y legibilidad.

---

## Mapa: blueprint → código

### 1. Fundamentos de la escena WebGL

| Requisito | Dónde |
|---|---|
| Canvas único al 100 % del viewport | [index.html](index.html), [styles.css](src/styles.css) |
| Cámara perspectiva, lente de 50 mm | [CameraRig.js](src/core/CameraRig.js) |
| Fly-through de entrada con órbita de llegada | `CameraRig.flyIn()` |
| Parallax de scroll en Z + FOV | `CameraRig.applyScroll()` |
| Parallax de cursor con inercia | `CameraRig.update()` |
| Cúpula obsidiana con degradado violeta | [Environment.js](src/world/Environment.js) |

La lente es un 50 mm real: `filmGauge = 35` + `setFocalLength(50)` en lugar de
un `fov` en grados, así el encuadre se comporta como una cámara física al
cambiar el aspect ratio. La posición final de cada frame es la suma de cuatro
capas independientes (sección · scroll · cursor · impulso), y esa separación es
lo que permite que un tween de sección, el scroll y el ratón actúen a la vez
sin pisarse.

### 2. Dirección de arte y materiales

| Requisito | Dónde |
|---|---|
| Cristal: transmisión 95 %, roughness 0.05–0.15, IOR 1.45–1.52 | `createGlass()` en [materials/index.js](src/materials/index.js) |
| Cromo pulido con envMap HDRI | `createChrome()` + `Environment._buildEnvMap()` |
| Negro mate anodizado | `createMatteBlack()` |
| Bordes emissive de 1 px | `applyEdgeGlow()` — Fresnel por shader |
| Backdrop-filter (kawase blur) | [BackdropBlur.js](src/postfx/BackdropBlur.js) |
| Normal maps para micro-grabados | [textures.js](src/materials/textures.js) |

El borde brillante es un término de Fresnel inyectado con `onBeforeCompile`, no
geometría: se enciende donde la superficie se aleja de la cámara —que es donde
el vidrio real atrapa la luz— y cuesta tres instrucciones.

El HDRI se genera al arrancar: se monta un plató en miniatura (softbox, dos rim
lights neón, cinco barras de alta frecuencia) y se hornea con `PMREMGenerator`.
Sin envMap, `metalness: 1.0` + `roughness: 0.0` produce un objeto negro.

### 3. Héroe y objeto principal

| Requisito | Dónde |
|---|---|
| Modelo multi-pieza | [SneakerGeometry.js](src/world/SneakerGeometry.js) |
| Idle: rotación 0.01 rad/s + flotación sinusoidal | `Hero.update()` |
| Despiece por ejes locales | `Hero.setExploded()` |
| Hotspots de cristal + plano detalle | [Hotspots.js](src/world/Hotspots.js), `CameraRig.pushCloseUp()` |
| Onda de color en 0.5 s (texture lerping) | `applyColorWave()` + `Hero.setColorway()` |
| Carga `.glb` / Draco / KTX2 | `Hero.load()` |

La jerarquía del héroe es `root → float → tilt → spin → model`, un nivel por
transformación. Si el spin viviera en el root, la flotación giraría con él y el
objeto describiría un cono en vez de subir y bajar.

La onda de color no hace un crossfade entre dos materiales: interpola **por
fragmento** según la posición a lo largo del eje X, y aplica el color destino
como *ratio* sobre el color ya calculado, de modo que el albedo, el AO y el
vertex color siguen modulando el resultado.

### 4. Partículas e iluminación

| Requisito | Dónde |
|---|---|
| 50 000 partículas con deriva | [Particles.js](src/world/Particles.js) |
| Repulsión de cursor en el espacio 3D | vertex shader de `ParticleField` |
| Rastro al añadir al carrito | `ParticleTrail.fire()` |
| Key light + rim lights neón | [Lighting.js](src/world/Lighting.js) |
| Bloom + aberración cromática + FXAA | [Composer.js](src/core/Composer.js) |

**Ni una sola posición de partícula se recalcula en JavaScript.** Recorrer
50 000 posiciones por frame y resubir el buffer cuesta 8–12 ms, es decir, el
presupuesto completo de 60 fps gastado en mover puntos. Aquí el buffer se sube
una vez: la deriva es `position + drift * uTime` con envoltura por `mod`, y la
repulsión es una función pura del vértice y de un uniform. Coste en CPU:
actualizar tres uniforms.

El orden del post-procesado es deliberado y está documentado en `Composer.js`.
En particular, **FXAA va después de `OutputPass`**: busca bordes por contraste
percibido y necesita luminancia en sRGB.

### 5. UI 3D y transiciones

| Requisito | Dónde |
|---|---|
| Paneles de cristal como `Mesh` | [GlassPanel.js](src/ui3d/GlassPanel.js) |
| Entrada rotando en X de 90° a 0° con aumento de desenfoque | `GlassPanel.reveal()` |
| Sombra proyectada sobre el fondo | SDF difuminada en el mismo componente |
| Botón neón pulsante con relleno en hover | [NeonButton.js](src/ui3d/NeonButton.js) |
| Hero → Catálogo con staggered animation | [SceneDirector.js](src/scenes/SceneDirector.js) |
| Tipografía dentro del canvas | [TextTexture.js](src/ui3d/TextTexture.js) |

Los paneles usan `ShaderMaterial` y no `MeshPhysicalMaterial` porque necesitan
leer el fondo ya desenfocado en espacio de pantalla. Un material físico
difumina en función de su rugosidad, y para conseguir un cristal muy
esmerilado habría que subirla tanto que el panel dejaría de reflejar. Al
separar las dos cosas, el material conserva reflejos nítidos mientras el fondo
va tan difuso como haga falta —y ese desenfoque se puede **animar**, que es lo
que pide la entrada del panel.

La UV de pantalla se deriva de la posición de clip y no de `gl_FragCoord`, para
que el panel se dibuje igual en cualquiera de los búferes de la escena, que
tienen tamaños distintos.

Las cinco secciones no son cinco lugares del mundo: son cinco **estados** de la
misma escena. La cámara se desplaza poco y lo que cambia es dónde está cada
objeto. Si cada sección viviera a ocho unidades de la anterior habría que
replicar luces, el campo de partículas tendría que ser cinco veces mayor y el
héroe dejaría de ser protagonista para convertirse en un decorado que se
abandona al hacer scroll.

### 6. Optimización

| Requisito | Dónde |
|---|---|
| `InstancedMesh` para el catálogo | [Catalog.js](src/ui3d/Catalog.js) |
| Texturas distintas por instancia | `sampler2DArray` + `instanceNormalArray()` |
| LOD | dos `InstancedMesh` con reparto por distancia |
| Escala de post-proceso (0.6–1.0×) | `Quality` + `Composer` |
| Desactivación selectiva en móvil | [Quality.js](src/core/Quality.js) |
| `dispose()` completo | [dispose.js](src/utils/dispose.js) + `App.dispose()` |

`THREE.LOD` funciona por objeto, y en el catálogo no hay objetos sino
instancias. La técnica correcta —la implementada— es mantener dos
`InstancedMesh` (geometría densa y ligera) y repartir las instancias entre
ellas según la distancia ajustando `.count` de cada una.

Para las «diferentes texturas» del brief se usa `DataArrayTexture` en vez de un
atlas: un atlas 2×2 deja costuras porque en el borde de cada cuadrante las
derivadas de UV se disparan y el hardware elige un mipmap equivocado. Con un
array, cada capa es independiente y el shader elige capa con un atributo por
instancia. Una unidad de textura, una draw call, N acabados.

---

## Decisiones que se apartan del brief, y por qué

**El modelo héroe es procedural, no un `.glb` de artista.** El blueprint
especifica una zapatilla modelada con subdivision surface, comprimida con Draco
y texturizada con mapas de 2K. No hay ningún asset de ese tipo en el proyecto,
así que la zapatilla se construye en código: cada pieza nace como una silueta
2D, se extruye y se remodela por vértice con dos perfiles (uno a lo largo del
pie y otro en altura). Eso convierte una galleta extruida en un volumen que se
estrecha en el talón, ensancha en el metatarso y afila hacia la puntera.

La ventaja no es sólo no depender de un asset: el despiece del blueprint exige
que cada componente sea una malla independiente con su propio eje local, y
construyéndola así esa descomposición es el punto de partida.

**La ruta del `.glb` real está cableada y tiene prioridad.** Deja un archivo en
`public/models/volta.glb` con las mallas nombradas como las claves de `EXPLODE`
(`outsole`, `midsole`, `upper`, `heelCounter`, `toeCap`, `tongue`, `plateL`,
`plateR`, `laces`) y `Hero.load()` lo carga —con Draco y KTX2— en lugar del
procedural, reescalándolo automáticamente. No hay que tocar una línea.

**Las texturas se generan en cliente en vez de cargarse como `.ktx2`.** El
objetivo del brief con KTX2 es carga y descompresión rápidas; generar el ruido
en el cliente cuesta unos milisegundos al arrancar y transfiere cero bytes. La
contrapartida honesta: no puedes pintar detalle artístico a mano. El
`KTX2Loader` queda montado para cuando haya assets reales.

**Los 120 fps no están garantizados, sólo no están impedidos.** El bucle es un
`requestAnimationFrame` sin limitador, así que corre al refresco de la pantalla.
En la máquina de pruebas el vsync lo fija en 75 Hz y se cumple con holgura
(13.3 ms de mediana frente a los 13.3 ms disponibles).

**El campo de partículas es estático en el mundo.** Deriva y envuelve, pero no
sigue a la cámara: si lo hiciera desaparecería el parallax, que es justo lo que
da la profundidad.

---

## Estructura

```
src/
├── main.js                 arranque, preloader, comprobación de WebGL2
├── core/
│   ├── App.js              bucle y orden de las tres pasadas de render
│   ├── Quality.js          tiers de dispositivo + watchdog de fps
│   ├── Renderer.js         WebGLRenderer, tone mapping, pérdida de contexto
│   ├── CameraRig.js        lente 50 mm, fly-through, parallax
│   ├── Composer.js         cadena de post-procesado
│   ├── Scroll.js           scroll nativo amortiguado
│   └── Pointer.js          cursor en NDC / mundo / raycast
├── world/
│   ├── Environment.js      cúpula + HDRI procedural
│   ├── Lighting.js         key, rims neón, recolector de sombra
│   ├── Particles.js        campo estelar y rastro de acción
│   ├── SneakerGeometry.js  siluetas, extrusión, perfiles, LOD
│   ├── Hero.js             montaje, idle, despiece, colorways
│   └── Hotspots.js         puntos de interés
├── materials/
│   ├── palette.js          paleta y colorways
│   ├── textures.js         ruido, normal maps, array de instancias
│   └── index.js            cristal, cromo, mate + inyecciones de shader
├── postfx/
│   ├── BackdropBlur.js     kawase de doble filtro
│   └── ChromaticAberrationShader.js
├── ui3d/
│   ├── GlassPanel.js       panel de cristal con SDF
│   ├── NeonButton.js       CTA
│   ├── Catalog.js          instancing + LOD
│   └── TextTexture.js      tipografía a canvas
├── scenes/
│   └── SceneDirector.js    guion de las cinco secciones
└── utils/
    ├── math.js             damp por dt, ruido determinista
    └── dispose.js          liberación de VRAM
```

## Notas de mantenimiento

- **`damp()` en vez de `lerp()` con factor fijo.** El clásico
  `x += (target - x) * 0.1` converge el doble de rápido a 120 Hz que a 60. Todo
  el amortiguado de la experiencia usa `1 - exp(-lambda * dt)`.
- **Guardas contra transiciones solapadas.** Un scroll rápido dispara varias
  transiciones de sección con décimas de diferencia. Los `onComplete` que
  ocultan elementos comprueban una bandera de intención antes de actuar; sin
  eso, el `conceal` de una transición apaga lo que el `reveal` de la siguiente
  acaba de encender.
- **El pase de backdrop va antes del composer.** Si fuera después, los paneles
  mostrarían el fondo del frame anterior.
- **`renderer.info.autoReset = false`** y se resetea al inicio de cada frame,
  porque hay varios `render()` por frame y las estadísticas deben sumarlos.
