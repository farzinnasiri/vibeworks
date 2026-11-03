import type { Camera, Scene, Texture } from 'three';
import { Color, NoToneMapping, RenderPipeline, RenderTarget, UnsignedByteType, type WebGPURenderer } from 'three/webgpu';
import { diffuseColor, mrt, normalView, texture, vec4 } from 'three/tsl';
import { OIDNDenoiser } from 'three-gpu-pathtracer/webgpu';
import { initUNetFromURL } from 'oidn-webgpu';

import weights from './assets/denoise/rt_hdr_calb_cnrm.tza?url';

/** OIDN uses the same GPU device and noise-free material/normal guides. No color readback or spatial blur. */
export async function denoiseStudioImage(renderer: WebGPURenderer, color: Texture, scene: Scene, camera: Camera, signal: AbortSignal) {
  let complete!: () => void, fail!: (error: unknown) => void;
  const finished = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
  // The adapter starts tile execution asynchronously. Observe errors and cancellation as part of this job.
  void finished.catch(() => {});
  const denoiser = new OIDNDenoiser({ auxWeightsUrl: weights, maxTileSize: 256, dynamicTile: false,
    initUNetFromURL: async (...args: Parameters<typeof initUNetFromURL>) => {
      const network = await initUNetFromURL(...args), execute = network.tileExecute.bind(network);
      network.tileExecute = input => execute({ ...input,
        done: output => { Promise.resolve(input.done(output)).then(complete, fail); },
        error: fail, scheduling: 'event-loop',
      });
      return network;
    },
  });
  denoiser.init(renderer);
  const image = color.image as { width: number; height: number };
  const guide = new RenderTarget(image.width, image.height, { count: 2, type: UnsignedByteType, samples: 4 });
  guide.textures[0].name = 'output'; guide.textures[1].name = 'normal';
  const pipeline = new RenderPipeline(renderer);
  const abort = () => { denoiser.reset(); fail(new DOMException('Render cancelled.', 'AbortError')); };
  signal.addEventListener('abort', abort);
  try {
    if (signal.aborted) { abort(); await finished; }
    const target = renderer.getRenderTarget(), previousMRT = renderer.getMRT(), tone = renderer.toneMapping;
    const background = scene.background, clear = renderer.getClearColor(Object.assign(new Color(), { a: 1 })).clone(), alpha = renderer.getClearAlpha();
    const lights: { visible: boolean }[] = [];
    scene.traverse(o => { if ('isLight' in o && o.visible) { lights.push(o); o.visible = false; } });
    try {
      // Only material color and perturbed normals belong in the guides, never studio light or HDR background.
      scene.background = null; renderer.setClearColor(new Color(0.5, 0.5, 0.5), 1);
      renderer.toneMapping = NoToneMapping; renderer.setRenderTarget(guide);
      renderer.setMRT(mrt({ output: diffuseColor, normal: vec4(normalView.mul(0.5).add(0.5), 1) }));
      renderer.render(scene, camera);
    } finally {
      scene.background = background; for (const light of lights) light.visible = true;
      renderer.setRenderTarget(target); renderer.setMRT(previousMRT); renderer.toneMapping = tone; renderer.setClearColor(clear, alpha);
    }
    await denoiser.denoise(color, guide.textures[0], guide.textures[1]);
    if (signal.aborted) abort();
    await finished;
    pipeline.outputNode = vec4(texture(denoiser.texture!).rgb, texture(color).a); pipeline.render();
    await (renderer.backend as typeof renderer.backend & { device: GPUDevice }).device.queue.onSubmittedWorkDone();
  } finally {
    signal.removeEventListener('abort', abort); pipeline.dispose(); denoiser.dispose(); guide.dispose();
  }
}
