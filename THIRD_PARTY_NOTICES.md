# Third-party notices

Tagmony includes or distributes the following third-party software. Versions are pinned in
`deno.json`, `deno.lock`, `.gitmodules` (Harmony commit) and the Docker base image.

## Bundled source

### Harmony — MIT

Vendored as a git submodule at `vendor/harmony`, pinned to commit
`094d904c3cbc15392d8042d8e6924e2478e8669d`. Tagmony uses its provider, harmonizer
and MusicBrainz seeding modules through `server/providers/harmony_adapter.ts`.
Recorded API responses in `tests/fixtures/snaps/api.deezer.com/` come from Harmony's `testdata/`.

```text
MIT License

Copyright (c) 2022-2024 David Kellner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Space Grotesk — SIL Open Font License 1.1

Self-hosted in `web/public/fonts/`; the license text ships alongside as `web/public/fonts/OFL.txt`.

## Runtime dependencies in the Docker image

| Component                                            | License                                 | Use                                                                 |
| ---------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------- |
| Deno                                                 | MIT                                     | Runtime (base image `denoland/deno`)                                |
| Hono                                                 | MIT                                     | HTTP framework                                                      |
| Zod                                                  | MIT                                     | Runtime schema validation                                           |
| Preact                                               | MIT                                     | Web UI (bundled into `web/dist`)                                    |
| mutagen (Debian `python3-mutagen`)                   | GPL-2.0-or-later                        | Tag reading/writing via the TagIO sidecar (Tagmony is GPL-3.0, D17) |
| Python 3 (Debian `python3`)                          | PSF-2.0                                 | Runs the TagIO sidecar                                              |
| Chromaprint `fpcalc` (Debian `libchromaprint-tools`) | LGPL-2.1-or-later (binary links FFmpeg) | Audio fingerprints                                                  |

Debian packages carry their full license texts under `/usr/share/doc/<package>/copyright`
in the image; corresponding source is available from Debian.

## Development and test only (not in the image)

| Component                                    | License                           | Use                                                                 |
| -------------------------------------------- | --------------------------------- | ------------------------------------------------------------------- |
| Vite, @preact/preset-vite                    | MIT                               | SPA build                                                           |
| @std/assert                                  | MIT                               | Tests                                                               |
| taglib-wasm (TagLib compiled to WebAssembly) | MIT; TagLib is LGPL-2.1 / MPL-1.1 | TagIO spike implementation kept for re-evaluation (Decision log D7) |
| FFmpeg                                       | LGPL/GPL                          | Generates test audio fixtures                                       |
