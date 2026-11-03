# Studio environments

Bundled 1k Radiance HDR files from Poly Haven, licensed CC0.

- https://polyhaven.com/a/studio_small_08
- https://polyhaven.com/a/empty_warehouse_01
- https://polyhaven.com/a/kloofendal_48d_partly_cloudy

License: https://polyhaven.com/license

`embedded.ts` contains the same bytes as base64 so the display-only headless renderer can load them without network or filesystem access. The application loads this module only when a Studio environment is requested. Regenerate by base64-encoding each HDR file; keys match STUDIO_ENVIRONMENTS in src/shared/studio.ts.
