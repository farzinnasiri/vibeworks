import { graphicContentSchema, type Appearance, type CadDocument } from './protocol';
export type GraphicAsset=NonNullable<CadDocument['graphicAssets']>[string];
const error=(code:string,message:string)=>Object.assign(new Error(message),{code});
export async function normalizeGraphicAssets(document:CadDocument):Promise<void>{
 const assets={...document.graphicAssets};
 if(Object.keys(assets).length>256||Object.values(assets).reduce((n,a)=>n+a.bytes,0)>4*1024*1024)throw error('ASSET_LIMIT','A document may carry at most 256 graphic assets and four MiB of image bytes.');
 const hash=async(bytes:Uint8Array)=>'sha256:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>))).map(v=>v.toString(16).padStart(2,'0')).join('');
 const decode=(data:string)=>Uint8Array.from(atob(data),c=>c.charCodeAt(0));
 for(const [key,asset]of Object.entries(assets)){
  const bytes=decode(asset.base64);
  if(await hash(bytes)!==key)throw error('ASSET_HASH_MISMATCH',`Graphic asset '${key}' does not match its bytes.`);
  if(bytes.length!==asset.bytes)throw error('ASSET_HASH_MISMATCH','Asset byte count does not match.');
  graphicContentSchema.parse({type:'image',dataUrl:`data:${asset.mime};base64,${asset.base64}`});
 }
 for(const feature of document.features)for(const graphic of [...(feature.appearance?.graphics??[]),...(feature.graphicEdits?.upsert??[])])if(graphic.content.type==='image'){
  const content=graphic.content;
  if('dataUrl' in content){
   graphicContentSchema.parse({type:'image',dataUrl:content.dataUrl});
   const [header,base64]=content.dataUrl.split(','),bytes=decode(base64),key=await hash(bytes),mime=header.startsWith('data:image/png')?'image/png' as const:'image/svg+xml' as const;
   if(content.asset&&content.asset!==key)throw error('ASSET_HASH_MISMATCH','Inline graphic differs from its declared asset.');
   let width:number|undefined,height:number|undefined;
   if(mime==='image/png'){const view=new DataView(bytes.buffer);width=view.getUint32(16);height=view.getUint32(20);}
   else{const xml=atob(base64);width=Number(xml.match(/\bwidth=["']([0-9.]+)/)?.[1])||undefined;height=Number(xml.match(/\bheight=["']([0-9.]+)/)?.[1])||undefined;}
   assets[key]={mime,base64,bytes:bytes.length,...(width?{width}:{}),...(height?{height}:{})};
   graphic.content={type:'image',asset:key};
  }else if(!content.asset||!assets[content.asset])throw error('ASSET_NOT_FOUND',`Graphic '${graphic.id}' references an unavailable asset.`);
 }
 if(Object.keys(assets).length>256||Object.values(assets).reduce((n,a)=>n+a.bytes,0)>4*1024*1024)throw error('ASSET_LIMIT','A document exceeds the graphic asset budget.');
 if(Object.keys(assets).length){document.graphicAssets=assets;document.schemaVersion=2;}
}
/** Presentation deliveries hydrate only the graphics actually used by that piece. Definitions keep hashes. */
export function hydrateGraphics(appearance:Appearance|undefined,document:CadDocument):Appearance|undefined{
 if(!appearance?.graphics)return appearance;
 return {...appearance,graphics:appearance.graphics.map(g=>{if(g.content.type!=='image'||'dataUrl'in g.content||!g.content.asset)return g;const a=document.graphicAssets?.[g.content.asset];if(!a)throw error('ASSET_NOT_FOUND',`Graphic '${g.id}' has no resource.`);return {...g,content:{...g.content,dataUrl:`data:${a.mime};base64,${a.base64}`}};})};
}
