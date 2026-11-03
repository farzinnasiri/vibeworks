import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('Studio video frames reuse their scene, follow the captured camera, and release resources on cancellation', { timeout: 20000 }, async () => {
  const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL('../', import.meta.url)), contents: `
    import * as THREE from 'three';
    import {StudioVideoPreviewRenderer} from './src/web/studio-video-preview';
    window.checkVideo = async () => {
      const renderer = new StudioVideoPreviewRenderer(), camera = new THREE.PerspectiveCamera(35, 16/9, .01, 100);
      let created = 0, released = 0;
      const scene = () => { created++; const scene = new THREE.Scene(); scene.background = new THREE.Color('#dddddd');
        scene.add(new THREE.Mesh(new THREE.BoxGeometry(2,1,1), new THREE.MeshStandardMaterial({color:'#cc5511'})));
        scene.add(new THREE.HemisphereLight(0xffffff,0x333333,3));return scene; };
      const release = scene => { released++; scene.traverse(o=>{o.geometry?.dispose();o.material?.dispose()});scene.clear(); };
      const spec = {key:'capture',scene,release,camera,width:320,height:180,presentation:{shadows:false}};
      const signal = new AbortController().signal;
      try {
        camera.position.set(4,3,4);camera.lookAt(0,0,0);
        const a = await renderer.render(spec,signal);
        camera.position.set(-4,2,1);camera.lookAt(0,0,0);
        const b = await renderer.render(spec,signal);
        const different = String(new Uint8Array(await a.arrayBuffer())) !== String(new Uint8Array(await b.arrayBuffer()));
        const bitmap = await createImageBitmap(b), dimensions=[bitmap.width,bitmap.height];bitmap.close();
        await renderer.render({...spec,key:'new-look'},signal);
        const controller = new AbortController();controller.abort();let cancelled=false;
        try {await renderer.render(spec,controller.signal)}catch(e){cancelled=e.name==='AbortError'}
        return {created,releasedBeforeDispose:released,different,dimensions,cancelled};
      } finally {renderer.dispose();window.releasedScenes=released;}
    };` }, bundle: true, write: false, format: 'iife', platform: 'browser' });
  const browser = await chromium.launch({ headless: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] });
  try {
    const page = await browser.newPage(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('http://video.test/**', route => route.fulfill({ contentType: 'text/html', body: `<script>${bundle.outputFiles[0].text}</script>` }));
    await page.goto('http://video.test/');
    const result = await page.evaluate(() => (window as any).checkVideo());
    assert.deepEqual(result, { created: 2, releasedBeforeDispose: 1, different: true, dimensions: [320, 180], cancelled: true });
    assert.equal(await page.evaluate(() => (window as any).releasedScenes), 2);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
