import * as THREE from 'three';
import type { Presentation } from '../shared/protocol';
import { configureStudioRenderer } from './scene';

/** Offline, deterministic frames using the same scene and renderer settings as the live Studio. */
export class StudioVideoPreviewRenderer {
  private renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  private scene?: THREE.Scene;
  private release?: (scene: THREE.Scene) => void;
  private key?: string;
  private lost = false;
  private closed = false;
  constructor() {
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.addEventListener('webglcontextlost', this.contextLost);
  }
  private contextLost = (event: Event) => { event.preventDefault(); this.lost = true; };
  async render(spec: { key: string; scene: () => THREE.Scene; release: (scene: THREE.Scene) => void; camera: THREE.Camera;
    width: number; height: number; presentation: Presentation }, signal: AbortSignal): Promise<Blob> {
    const check = () => {
      signal.throwIfAborted();
      if (this.closed) throw new DOMException('Render cancelled.', 'AbortError');
      if (this.lost) throw new Error('Graphics memory was lost while rendering video. Render again to retry.');
    };
    check();
    if (!this.scene || this.key !== spec.key) {
      const scene = spec.scene();
      if (this.scene) this.release!(this.scene);
      this.scene = scene; this.release = spec.release; this.key = spec.key;
    }
    const renderer = this.renderer;
    if (renderer.domElement.width !== spec.width || renderer.domElement.height !== spec.height) renderer.setSize(spec.width, spec.height, false);
    configureStudioRenderer(renderer, spec.presentation);
    renderer.render(this.scene, spec.camera);
    const blob = await new Promise<Blob | null>(resolve => renderer.domElement.toBlob(resolve, 'image/png'));
    check();
    if (!blob) throw new Error('The video frame could not be encoded as PNG.');
    return blob;
  }
  dispose() {
    this.closed = true;
    if (this.scene) this.release!(this.scene);
    this.scene = undefined;
    this.renderer.domElement.removeEventListener('webglcontextlost', this.contextLost);
    this.renderer.dispose(); this.renderer.forceContextLoss();
  }
}
