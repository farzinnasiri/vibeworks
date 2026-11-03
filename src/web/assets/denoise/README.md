# Final-image denoising

`rt_hdr_calb_cnrm.tza` is the standard Intel Open Image Denoise 2.3.0 HDR network for noise-free albedo and
normal guides. It is loaded only when final-image noise reduction is enabled, never by the live preview.
The network runs locally through `oidn-webgpu` on the path tracer's existing GPU device, in bounded tiles.

Upstream: https://github.com/RenderKit/oidn-weights/tree/28883d1769d5930e13cf7f1676dd852bd81ed9e7

- File size: 1,841,160 bytes.
- SHA-256: `d0057057bd76c64e3e67b449728ef8f4fd2f11ccfb74c1e59b9d50dafd50ee0e`.
- License: Apache 2.0, reproduced in `LICENSE.txt`.
- Runtime: https://github.com/pissang/oidn-webgpu, MIT license.

Color stays linear HDR until the renderer's normal output transform. Guides include material textures and
view-space surface normals, with lighting and background excluded. No geometry or generated image is synthesized.
