# PNG Encoder Dependencies

- UPNG.js: Photopea, commit `88f504b6577b726975f593caa38ba85d327c7c1f`, MIT license in `LICENSE`.
- pako: version `2.1.0`, browser bundle in `../pako/pako.min.js`, license in `../pako/LICENSE`.

Upstream sources:

- https://github.com/photopea/UPNG.js
- https://github.com/nodeca/pako

Both libraries are vendored without source changes. UPNG creates actual grayscale
PNG channels and quantizes indexed PNG palettes; pako supplies its zlib codec.
The index setting limits palette size to `2 ** bits`. PNG chooses a legal storage
depth (1, 2, 4, or 8 bits) from the actual palette size.
