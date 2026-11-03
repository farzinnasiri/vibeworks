import {worldMesh} from '../shared/display';
import {resolveFaces} from '../cad/surface-reference';
import { useCallback,useEffect,useRef,useState,type CSSProperties } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { RuntimeClient,RuntimeState } from '../cad/runtime';
import type { Evaluation } from '../cad/types';
import type { CadDocument,Shot,WorkspaceViewRequest } from '../shared/protocol';
import { effectiveAppearance } from '../cad/document';
import { createModelScene,configureRenderer,disposeScene } from './scene';
import { shotCamera,shotLabel } from './shots';
import { shotFrame } from './shot-frame';
import { StudioWorkspace } from './StudioWorkspace';
import './workspace-presentation.css';

function highlight(scene:THREE.Scene,selection:string[]){
  scene.traverse(object=>{
    const selected=selection.includes(object.userData.featureId);
    if(object instanceof THREE.Mesh)for(const material of Array.isArray(object.material)?object.material:[object.material]){
      if(material instanceof THREE.MeshStandardMaterial){material.emissive.setHex(0x6b2b0d);material.emissiveIntensity=selected?.25:0;}
    }
    if(object instanceof THREE.LineSegments)for(const material of Array.isArray(object.material)?object.material:[object.material]){
      if(material instanceof THREE.LineBasicMaterial)material.color.setHex(selected?0xd9480f:0x293b44);
    }
  });
}

function PreparedPane({evaluation,document,shot,index,selection,highlights,onSelect,onReady,onError}:{
  evaluation:Evaluation;document:CadDocument;shot:Shot;index:number;selection:string[];highlights?:import('../shared/protocol').WorkspaceViewState['highlight'];
  onSelect:(id?:string)=>void;onReady:()=>void;onError:(message:string)=>void;
}){
  const host=useRef<HTMLDivElement>(null),live=useRef(onSelect);live.current=onSelect;
  const view=useRef<{scene:THREE.Scene;draw:()=>void}|undefined>(undefined),selected=useRef(selection);selected.current=selection;
  useEffect(()=>{if(view.current){highlight(view.current.scene,selection);view.current.draw();}},[selection]);
  useEffect(()=>{
    const element=host.current!;
    let renderer:THREE.WebGLRenderer|undefined,scene:THREE.Scene|undefined,controls:OrbitControls|undefined;
    let observer:ResizeObserver|undefined;
    try{
      const framed=shotFrame(evaluation,shot);
      renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});configureRenderer(renderer);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));element.appendChild(renderer.domElement);
      const appearances=new Map(document.features.map(f=>[f.id,effectiveAppearance(document,f.id)]));
      scene=createModelScene(framed.evaluation,[],framed.evaluation.visibleFeatureIds,undefined,appearances);
      highlight(scene,selected.current);
      for(const target of highlights??[]){let matched=false;for(const original of framed.evaluation.meshes){if(original.featureId!==target.feature||JSON.stringify(original.occurrencePath?.slice(1)??[])!==JSON.stringify(target.path??[])||!original.topology)continue;
        const faces=new Set(resolveFaces(original.topology,target)),mesh=worldMesh(original),positions:number[]=[];
        for(let i=0;i<(mesh.faceRanges?.length??0);i+=4)if(faces.has(mesh.faceRanges![i+2]))for(let t=mesh.faceRanges![i]*3;t<(mesh.faceRanges![i]+mesh.faceRanges![i+1])*3;t++)positions.push(...mesh.vertices.slice(mesh.triangles[t]*3,mesh.triangles[t]*3+3));
        if(positions.length){matched=true;const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));const m=new THREE.MeshBasicMaterial({color:0x458df0,transparent:true,opacity:0.42,depthWrite:false,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2});const overlay=new THREE.Mesh(g,m);overlay.raycast=()=>{};scene.add(overlay);}}
        if(!matched)throw new Error(`Highlighted surface '${target.feature}' is unavailable. Inspect and present again.`);
      }
      const section=shot.section;
      if(section){
        const normal=new THREE.Vector3();normal.setComponent(['X','Y','Z'].indexOf(section.axis),section.flip?1:-1);
        const plane=new THREE.Plane(normal,section.flip?-section.offset:section.offset);renderer.localClippingEnabled=true;
        const bodies=scene.children.filter((object):object is THREE.Mesh=>object instanceof THREE.Mesh);
        for(const body of bodies){
          if(shot.ghost?.includes(body.userData.featureId))continue;
          const cap=new THREE.Mesh(body.geometry,new THREE.MeshBasicMaterial({color:0xe8743f,side:THREE.BackSide}));
          cap.applyMatrix4(body.matrix);cap.userData.featureId=body.userData.featureId;scene.add(cap);
        }
        scene.traverse(o=>{if(o instanceof THREE.Mesh||o instanceof THREE.LineSegments)for(const m of Array.isArray(o.material)?o.material:[o.material])m.clippingPlanes=[plane];});
      }
      if(shot.ghost?.length)scene.traverse(o=>{
        if((o instanceof THREE.Mesh||o instanceof THREE.LineSegments)&&shot.ghost!.includes(o.userData.featureId))
          for(const m of Array.isArray(o.material)?o.material:[o.material]){m.transparent=true;m.opacity=.2;m.depthWrite=false;}
      });
      let camera:THREE.Camera;
      const draw=()=>{if(renderer&&scene&&camera)renderer.render(scene,camera);};
      view.current={scene,draw};
      const resize=()=>{
        const width=Math.max(1,element.clientWidth),height=Math.max(1,element.clientHeight);
        renderer!.setSize(width,height);
        const fitted=shotCamera(shot,index,framed.frame,framed.bounds,width/height,height);
        camera=fitted.camera;controls?.dispose();controls=new OrbitControls(camera,renderer!.domElement);
        controls.target.fromArray(fitted.tile.target);controls.addEventListener('change',draw);controls.update();draw();
      };
      resize();observer=new ResizeObserver(resize);observer.observe(element);
      let down:{x:number;y:number}|undefined;
      renderer.domElement.addEventListener('pointerdown',event=>{down={x:event.clientX,y:event.clientY};});
      const pick=(event:MouseEvent)=>{
        if(!down||Math.hypot(event.clientX-down.x,event.clientY-down.y)>4)return;
        down=undefined;
        const rect=renderer!.domElement.getBoundingClientRect();
        const ray=new THREE.Raycaster();ray.setFromCamera(new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1),camera);
        live.current(ray.intersectObjects(scene!.children,true).find(h=>h.object.userData.featureId)?.object.userData.featureId);
      };
      renderer.domElement.addEventListener('click',pick);onReady();
    }catch(error){onError(error instanceof Error?error.message:String(error));}
    return()=>{view.current=undefined;observer?.disconnect();controls?.dispose();if(scene)disposeScene(scene);renderer?.dispose();renderer?.forceContextLoss();element.replaceChildren();};
  },[evaluation,document.features,shot,index,onReady,onError]);
  return <section className="prepared-pane" data-result-ids={evaluation.visibleFeatureIds.join(',')}><h3>{shotLabel(shot,index)}</h3><div ref={host}/></section>;
}

/** One-shot presentation. Acknowledgment follows actual model loading and camera application. */
export function WorkspacePresentation({runtime,state,request,onClose}:{runtime:RuntimeClient;state:RuntimeState;request:WorkspaceViewRequest;onClose:()=>void}){
  const [evaluation,setEvaluation]=useState<Evaluation>(),[error,setError]=useState('');
  const acknowledged=useRef(false),ready=useRef(new Set<number>());
  const finish=useCallback((message?:string)=>{
    if(message)setError(message);
    if(acknowledged.current)return;acknowledged.current=true;
    void runtime.acknowledgeWorkspaceView?.(request.requestId,message).catch(e=>setError(String(e)));
  },[runtime,request.requestId]);
  useEffect(()=>{
    let cancelled=false;setEvaluation(undefined);
    const load=async()=>{
      if(request.state.isolate?.length){
        const outcome=await runtime.replay({type:'inspect_model',params:{documentId:state.document.documentId,
          display:{expectedRevision:state.document.revision,expectedStorageVersion:state.storageVersion!,featureIds:request.state.isolate}}});
        if(outcome.result.status==='error'||!outcome.evaluation)throw new Error(outcome.result.error?.message??'Cannot display these results.');
        if(!cancelled){
          const ids=request.state.isolate;
          setEvaluation({...outcome.evaluation,visibleFeatureIds:ids,
            meshes:outcome.evaluation.meshes.filter(mesh=>ids.includes(mesh.featureId))});
        }
      }else if(!cancelled)setEvaluation(state.evaluation);
    };
    void load().catch(e=>{if(!cancelled)finish(e instanceof Error?e.message:String(e));});
    return()=>{cancelled=true;};
  },[runtime,request,state.document.documentId,state.document.revision,state.storageVersion,state.evaluation,finish]);
  const callbacks=useRef(new Map<number,()=>void>());
  const paneReady=(index:number)=>{
    if(!callbacks.current.has(index))callbacks.current.set(index,()=>{ready.current.add(index);if(ready.current.size===request.state.panes.length)finish();});
    return callbacks.current.get(index)!;
  };
  const viewState=evaluation?{...state,evaluation:request.state.mode==='studio'?{
    ...evaluation,visibleFeatureIds:evaluation.visibleFeatureIds.filter(id=>!request.state.panes[0].hide?.includes(id)),
    meshes:evaluation.meshes.filter(mesh=>!request.state.panes[0].hide?.includes(mesh.featureId)),
  }:evaluation}:state;
  const studioPrepared={...request.state,panes:request.state.panes.map(({hide:_,...shot})=>shot)};
  return <section className="workspace-presentation" aria-label="Prepared workspace view" data-view-request={request.requestId}>
    <header><span>Prepared view · {state.document.name}</span><button type="button" className="link-button" onClick={onClose}>Return to personal view</button></header>
    {error?<p role="alert">{error}</p>:!evaluation?<p role="status">Preparing view…</p>:request.state.mode==='studio'
      ?<StudioWorkspace runtime={runtime} state={viewState} disabled={false} prepared={studioPrepared} onPrepared={finish}/>
      :<div className={`prepared-panes ${request.state.layout}`} style={{'--panes':request.state.panes.length} as CSSProperties}>{request.state.panes.map((shot,index)=><PreparedPane key={index}
        evaluation={evaluation} document={state.document} shot={shot} index={index} highlights={request.state.highlight} selection={state.document.selectedFeatureIds}
        onSelect={id=>{void runtime.select(id?[id]:[]);}} onReady={paneReady(index)} onError={finish}/>)}</div>}
  </section>;
}
