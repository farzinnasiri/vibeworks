import {Select} from './Select';
import {useRef} from 'react';
import {createPortal} from 'react-dom';
import {useModalFocus} from './useModalFocus';
import {AppearanceControl} from './AppearanceControl';
import noticesUrl from './third-party-notices.txt?url';
import type {StudioNavigation} from './studio-navigation';
export function WorkspaceSettings({navigation,onNavigation,detail,onDetail,onClose,onHelp}:{navigation:StudioNavigation;onNavigation:(value:StudioNavigation)=>void;detail:'auto'|'fine'|'coarse';onDetail:(value:'auto'|'fine'|'coarse')=>void;onClose:()=>void;onHelp:()=>void}){
 const ref=useRef<HTMLDivElement>(null);useModalFocus(ref);
 return createPortal(<div className="palette-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}>
  <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="workspace-settings-title" className="dialog workspace-settings" onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();onClose();}}}>
   <h2 id="workspace-settings-title">Settings</h2><p className="field-hint">Personal workspace preferences. Model materials and Studio lighting are unchanged.</p>
   <div className="settings-choice"><span>Appearance</span><AppearanceControl/></div>
   <label className="settings-choice"><span>Navigation device</span><Select aria-label="Navigation device" value={navigation} onChange={e=>onNavigation(e.target.value as StudioNavigation)}><option value="trackpad">Trackpad</option><option value="mouse">Mouse</option></Select></label>
   <label className="settings-choice"><span>Display detail</span><Select aria-label="Display detail" value={detail} onChange={e=>onDetail(e.target.value as typeof detail)}><option value="auto">Automatic</option><option value="fine">Fine</option><option value="coarse">Coarse</option></Select></label>
   <details><summary>Navigation and shortcuts</summary><p className="field-hint">F fits the model. Shift-click selects several objects. On a trackpad, two fingers pan, pinch zooms, and Shift plus two fingers orbits. Use the command search for modeling actions.</p></details>
   <details><summary>Help and about</summary><button type="button" className="link-button" onClick={onHelp}>Keyboard shortcuts</button><p className="field-hint">Vibeworks · local CAD workspace</p><a href={noticesUrl} target="_blank" rel="noreferrer">Third-party notices</a></details>
   <div className="dialog-actions"><button className="primary-button" type="button" onClick={onClose}>Done</button></div>
  </div>
 </div>,document.body);
}
