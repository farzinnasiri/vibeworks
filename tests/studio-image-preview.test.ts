import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('Studio product views show live raster previews, keep labels optional, and support native radio keyboard navigation', { timeout: 30000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const bundle = await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React,{useState} from 'react'; import{createRoot}from'react-dom/client'; import * as THREE from 'three';
    import{StudioImageOptions,StudioImagePreview}from'./src/web/StudioImageOptions';
    import{VIEW_DIRECTIONS}from'./src/shared/protocol';
    import{renderStudioImages}from'./src/web/studio-image-output';
    const box=new THREE.BoxGeometry(60,30,15), mesh={featureId:'body',vertices:[...box.attributes.position.array],normals:[...box.attributes.normal.array],triangles:[...box.index.array],lines:[],appearance:{material:'aluminum',color:'#a15b36'}};
    const evaluation={geometry:[{featureId:'body',bounds:{min:[-30,-15,-7.5],max:[30,15,7.5],size:[60,30,15]}}],visibleFeatureIds:['body'],meshes:[mesh]};
    const settings={environmentPreset:'dark_studio',floor:'none',background:'#556677',shadows:false};
    function Harness(){const[views,onViews]=useState(['isometric','front','right']),[scope,onScope]=useState('views'),[layout,onLayout]=useState('sheet'),[labels,onLabels]=useState(false),[rendering,onRendering]=useState('fast');
      return <div style={{display:'grid',gridTemplateColumns:'320px 640px',height:500}}><StudioImageOptions {...{views,onViews,scope,onScope,layout,onLayout,labels,onLabels,rendering,onRendering}}/><StudioImagePreview {...{evaluation,settings,views,layout,labels,aspect:16/9,projection:'perspective',fov:35,width:320,height:180}}/></div>}
    window.checkImageOutput=async()=>{const camera=new THREE.PerspectiveCamera(35,16/9,.01,1000);camera.position.set(100,-100,100);camera.lookAt(0,0,0);
      const capture={evaluation,settings,documentId:'fixture',revision:0,output:{size:'hd',quality:'draft',denoise:true},width:320,height:180,camera,shot:{projection:'perspective',position:camera.position.toArray(),target:[0,0,0],up:[0,0,1],fov:35,zoom:1}};
      const result=[];for(const labels of[false,true]){let image;await renderStudioImages(capture,{rendering:'fast',views:['isometric','front','right'],layout:'sheet',labels},undefined,()=>{},value=>{image=value},new AbortController().signal);
        const bitmap=await createImageBitmap(image.blob),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();
        result.push({labels,width:canvas.width,height:canvas.height,bottom:[...ctx.getImageData(5,179,1,1).data],views:image.views});}
      return result;};
    window.checkTransparentViews=async()=>{
      const camera=new THREE.PerspectiveCamera(35,16/9,.01,1000);camera.position.set(100,-100,100);camera.lookAt(0,0,0);
      const capture={evaluation,settings:{...settings,backgroundMode:'transparent'},documentId:'fixture',revision:0,output:{size:'hd',quality:'draft',denoise:false},width:320,height:240,camera,shot:{projection:'perspective',position:camera.position.toArray(),target:[0,0,0],up:[0,0,1],fov:35,zoom:1}};
      let image;await renderStudioImages(capture,{rendering:'fast',views:Object.keys(VIEW_DIRECTIONS),layout:'sheet'},undefined,()=>{},value=>{image=value},new AbortController().signal);
      const bitmap=await createImageBitmap(image.blob),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();
      const data=ctx.getImageData(0,0,320,240).data;let clear=0,solid=0;for(let i=3;i<data.length;i+=4){if(data[i]===0)clear++;if(data[i]===255)solid++;}
      return {views:image.views.length,clear,solid};
    };
    createRoot(document.getElementById('root')).render(<Harness/>);
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent' });
  const css = (await Promise.all(['styles.css', 'experience.css', 'studio-image-options.css'].map(name => readFile(`${root}/src/web/${name}`, 'utf8')))).join('\n');
  const browser = await chromium.launch({ headless: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } }), errors: string[] = [];
    page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
    await page.route('https://image.test/**', route => route.fulfill({ contentType: 'text/html', body: `<style>${css}</style><div id="root"></div><script>${bundle.outputFiles[0].text}</script>` }));
    await page.goto('https://image.test/');
    await page.getByRole('region', { name: 'Product view preview' }).getByRole('status').filter({ hasText: 'Live preview' }).waitFor().catch(async error=>{ console.log(await page.locator('body').innerText()); throw error; });
    assert.equal(await page.locator('.studio-product-preview img').count(), 1);
    assert.equal(await page.getByRole('checkbox', { name: 'Show view labels' }).isChecked(), false);
    const original = await page.locator('.studio-product-preview img').getAttribute('src');
    await page.getByRole('checkbox', { name: 'Show view labels' }).check();
    await page.waitForFunction(url => document.querySelector('.studio-product-preview img')?.getAttribute('src') !== url && document.querySelector('.studio-product-preview img')?.getAttribute('alt')?.includes('with view labels'), original);
    const sheet = page.getByRole('radio', { name: 'One image', exact: true });
    await sheet.focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('radio', { name: 'Separate PNGs' }).isChecked(), true);
    await page.waitForFunction(() => document.querySelectorAll('.studio-product-preview img').length === 3);
    await page.getByRole('checkbox', { name: 'Front', exact: true }).uncheck();
    await page.waitForFunction(() => document.querySelectorAll('.studio-product-preview img').length === 2);
    for (const name of ['Isometric (above front right)', 'Right']) await page.getByRole('checkbox', { name, exact: true }).uncheck();
    await page.getByText('Choose views in Output to compose your image.', { exact: true }).waitFor();
    const result = await page.evaluate(() => (window as any).checkImageOutput());
    assert.deepEqual(result.map((r: any) => [r.width, r.height, r.views]), [[320, 180, ['isometric', 'front', 'right']], [320, 180, ['isometric', 'front', 'right']]]);
    assert.deepEqual(result[1].bottom, [245, 244, 240, 255], 'Labels reserve a plain strip only when enabled.');
    assert.notDeepEqual(result[0].bottom, result[1].bottom, 'The clean image fills the former label strip with the rendered scene.');
    const transparent = await page.evaluate(() => (window as any).checkTransparentViews());
    assert.equal(transparent.views, 16); assert.ok(transparent.clear > 1000); assert.ok(transparent.solid > 1000);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
