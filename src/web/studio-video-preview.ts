import * as THREE from 'three';
import type { Presentation } from '../shared/protocol';
import { configureStudioRenderer } from './scene';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { videoAperture,type VideoDepthOfField } from './studio-video-effects';

/** Offline, deterministic frames using the same scene and renderer settings as the live Studio. */
export class StudioVideoPreviewRenderer {
  private renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  private scene?: THREE.Scene;
  private release?: (scene: THREE.Scene) => void;
  private key?: string;
  private lost = false;
  private closed = false;
  private post?:{composer:EffectComposer;render:RenderPass;bokeh:BokehPass;output:OutputPass};
  constructor() {
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.addEventListener('webglcontextlost', this.contextLost);
  }
  private contextLost = (event: Event) => { event.preventDefault(); this.lost = true; };
  async render(spec: { key: string; scene: () => THREE.Scene; release: (scene: THREE.Scene) => void; camera: THREE.Camera;
    width: number; height: number; presentation: Presentation; update?: (scene:THREE.Scene)=>void; depthOfField?:VideoDepthOfField }, signal: AbortSignal): Promise<Blob> {
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
    spec.update?.(this.scene);
    if(spec.depthOfField){
      if(!(spec.camera instanceof THREE.PerspectiveCamera))throw new Error('Video depth of field requires a perspective camera.');
      if(!this.post){
        const target=new THREE.WebGLRenderTarget(spec.width,spec.height,{type:THREE.HalfFloatType,samples:spec.width*spec.height<=1920*1080?2:0});
        const composer=new EffectComposer(renderer,target),render=new RenderPass(this.scene,spec.camera),bokeh=new BokehPass(this.scene,spec.camera,{focus:1,aperture:0,maxblur:.02}),output=new OutputPass();
        composer.addPass(render);composer.addPass(bokeh);composer.addPass(output);this.post={composer,render,bokeh,output};
      }
      const {composer,render,bokeh}=this.post;render.scene=this.scene;render.camera=spec.camera;bokeh.scene=this.scene;bokeh.camera=spec.camera;
      composer.setSize(spec.width,spec.height);
      const uniforms=bokeh.materialBokeh.uniforms;
      uniforms.focus.value=spec.depthOfField.focusDistance;uniforms.aperture.value=videoAperture(spec.depthOfField);
      uniforms.nearClip.value=spec.camera.near;uniforms.farClip.value=spec.camera.far;uniforms.aspect.value=spec.camera.aspect;
      composer.render();
    }else renderer.render(this.scene, spec.camera);
    const blob = await new Promise<Blob | null>(resolve => renderer.domElement.toBlob(resolve, 'image/png'));
    check();
    if (!blob) throw new Error('The video frame could not be encoded as PNG.');
    return blob;
  }
  dispose() {
    this.closed = true;
    if(this.post){this.post.render.dispose();this.post.bokeh.dispose();this.post.output.dispose();this.post.composer.dispose();this.post=undefined;}
    if (this.scene) this.release!(this.scene);
    this.scene = undefined;
    this.renderer.domElement.removeEventListener('webglcontextlost', this.contextLost);
    this.renderer.dispose(); this.renderer.forceContextLoss();
  }
}
