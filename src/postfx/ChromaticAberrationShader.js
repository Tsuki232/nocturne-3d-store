/**
 * Aberración cromática radial + viñeta.
 *
 * Una lente real no enfoca las tres longitudes de onda en el mismo plano, y
 * el error crece hacia los bordes del círculo de imagen. Por eso el
 * desplazamiento va multiplicado por r²: en el centro de la pantalla es
 * exactamente cero, y sólo aparece en las esquinas.
 *
 * Aplicar un offset constante en toda la pantalla —el error habitual— no
 * parece una lente, parece un fallo de sincronización de vídeo.
 */
export const ChromaticAberrationShader = {
  name: 'ChromaticAberrationShader',

  uniforms: {
    tDiffuse: { value: null },
    uStrength: { value: 0.0035 },
    uVignette: { value: 0.18 },
    uBarrel: { value: 0.6 },
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    precision highp float;

    uniform sampler2D tDiffuse;
    uniform float uStrength;
    uniform float uVignette;
    uniform float uBarrel;

    varying vec2 vUv;

    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);

      // Dirección radial escalada por r²: cero en el eje óptico.
      vec2 dir = c * (r2 * uBarrel + 0.35) * uStrength;

      // El verde se queda en su sitio y actúa de referencia; rojo y azul se
      // separan en sentidos opuestos, igual que en un doblete no corregido.
      float r = texture2D(tDiffuse, vUv - dir).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv + dir).b;

      vec3 col = vec3(r, g, b);

      // Viñeta muy suave: cierra la composición hacia el centro sin que se
      // perciba como un marco oscuro.
      col *= 1.0 - uVignette * smoothstep(0.15, 0.75, r2);

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/** Helper: crea el pase ya configurado. */
export function createChromaticAberrationPass(ShaderPass, { strength = 0.0035, vignette = 0.18 } = {}) {
  const pass = new ShaderPass(ChromaticAberrationShader);
  pass.material.uniforms.uStrength.value = strength;
  pass.material.uniforms.uVignette.value = vignette;
  return pass;
}
