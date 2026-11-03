import {useEffect,useState} from 'react';
import * as THREE from 'three';
import type {Evaluation} from '../cad/types';
import type {ViewName} from '../shared/protocol';
import {createModelScene,configureRenderer,disposeScene} from './scene';
import {shotCamera} from './shots';
import {shotFrame} from './shot-frame';
/** Small raster previews of the actual Node mesh, using one short-lived display context for a view set. */
export function useModelThumbnails(evaluation:Evaluation|undefined,views:ViewName[]){
 const [result,setResult]=useState<{evaluation:Evaluation;key:string;images:Partial<Record<ViewName,string>>}>();
 const key=views.join(',');
 useEffect(()=>{
  if(!evaluation?.meshes.length||!views.length)return;
  let stopped=false,renderer:THREE.WebGLRenderer|undefined,scene:THREE.Scene|undefined;
  const run=async()=>{
   try{
    renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true});configureRenderer(renderer);renderer.setSize(168,112);renderer.setPixelRatio(1);
    scene=createModelScene(evaluation,[],evaluation.visibleFeatureIds,undefined,new Map());scene.background=new THREE.Color(0xe8ecef);
    const images:Partial<Record<ViewName,string>>={};
    for(const view of views){if(stopped)return;const framed=shotFrame(evaluation,{view});const shot=shotCamera({view},0,framed.frame,framed.bounds,1.5,112);renderer.render(scene,shot.camera);images[view]=renderer.domElement.toDataURL('image/png');await new Promise<void>(resolve=>setTimeout(resolve,0));}
    if(!stopped)setResult({evaluation,key,images});
   }catch{ /* The named view remains usable if a display thumbnail is unavailable. */ }
   finally{if(scene)disposeScene(scene);renderer?.dispose();renderer?.forceContextLoss();}
  };
  const timer=setTimeout(()=>void run(),120);return()=>{stopped=true;clearTimeout(timer);};
 },[evaluation,key]);
 return result&&result.evaluation===evaluation&&result.key===key?result.images:{};
}
