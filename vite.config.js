import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5173, open: false },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        // Vite 8 usa Rolldown, que sólo acepta manualChunks como función
        // (la forma de objeto `{ three: ['three'] }` de Rollup da error).
        // Separar three y gsap del código de la app permite que el
        // navegador los cachee entre despliegues: son ~700 kB que no
        // cambian cuando tocamos un shader.
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('node_modules/gsap')) return 'gsap';
          return null;
        },
      },
    },
  },
  // Los .glsl se importan como string crudo
  assetsInclude: ['**/*.glsl', '**/*.hdr', '**/*.ktx2'],
});
