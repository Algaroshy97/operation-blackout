# Vendored engine

`three-bundle.min.js` is three.js **r186** plus `GLTFLoader`, bundled by esbuild as
a single IIFE that assigns the global `THREE`.

The game ships as one HTML file containing one classic `<script>`, and three.js
stopped publishing a UMD build after r159 (and the non-module `examples/js`
GLTFLoader after r147). Bundling to an IIFE ourselves is what keeps the project on
a current engine without turning it into an ES-module app.

To regenerate:

    npm install three esbuild
    printf "export * from 'three';\nexport { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';\n" > entry.js
    esbuild entry.js --bundle --format=iife --global-name=THREE \
      --minify --legal-comments=none --target=es2019 \
      --outfile=vendor/three-bundle.min.js

three.js is MIT licensed.
