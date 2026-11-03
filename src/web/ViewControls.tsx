import type { ViewName, Vector3 } from '../shared/protocol';
import type { Section } from './Viewport';
import { ViewOrientation } from './ViewOrientation';
import { Icon } from './icons';
import { Menu, MenuItem } from './Menu';
import { fmt } from './modeling';
import { views } from './views';
import { studioNavigationHelp, type StudioNavigation } from './studio-navigation';

interface ViewControlsProps {
  matchStudio?:boolean;onMatchStudio?:()=>void;
  navigationTool?: 'select' | 'pan' | 'orbit' | 'zoom'; onNavigationTool?: (tool: 'select' | 'pan' | 'orbit' | 'zoom') => void;
  navigation: StudioNavigation; onNavigation: (value: StudioNavigation) => void;
  detail?: 'auto'|'fine'|'coarse'; onDetail?: (value:'auto'|'fine'|'coarse')=>void;
  edges: boolean; onEdges: () => void; orbiting: boolean; onOrbit: () => void; orbitDisabled: boolean;
  view: ViewName;
  setCamera: (view: ViewName) => void;
  menu: string | null;
  setMenu: (id: string | null) => void;
  section: Section | null;
  setSection: (section: Section | null) => void;
  sectionAxis: (axis: 0 | 1 | 2) => void;
  sectionRange: { min: Vector3; max: Vector3 };
  toggleSection: () => void;
  measuring: boolean;
  snap: boolean;
  onNormalTo?: () => void;
  onFit: () => void;
  onMeasure: () => void;
  onSnap: () => void;
}

export function ViewControls({
  matchStudio,onMatchStudio,
  navigation, onNavigation, navigationTool = 'select', onNavigationTool,
  detail='auto', onDetail,
  edges, onEdges, orbiting, onOrbit, orbitDisabled,
  view,
  setCamera,
  menu,
  setMenu,
  section,
  setSection,
  sectionAxis,
  sectionRange,
  toggleSection,
  measuring,
  snap,
  onNormalTo,
  onFit,
  onMeasure,
  onSnap,
}: ViewControlsProps) {
  return (
    <div className="view-controls" data-inset="top">
      <div className="view-bar" role="toolbar" aria-label="Camera">
        {onNavigationTool && <div className="navigation-tools">{([['select','select','Select'],['pan','hand','Pan'],['orbit','rotate','Orbit'],['zoom','search','Zoom']] as const).map(([id, icon, label]) => <button key={id} type="button" className="icon-button" aria-label={`${label} navigation`} title={`${label} navigation`} aria-pressed={navigationTool === id} onClick={() => onNavigationTool(id)}><Icon name={icon} size={16}/></button>)}</div>}
        <div className="segmented views">
          {views.slice(0, 4).map((v, i) => (
            <button
              key={v.view}
              type="button"
              aria-pressed={view === v.view}
              aria-label={`${v.label} view`}
              title={`${v.label} view · ${i + 1}`}
              onClick={() => setCamera(v.view)}
            >
              <ViewOrientation view={v.view} size={23}/><span className="view-label">{v.label}</span>
            </button>
          ))}
          <Menu
            id="views"
            open={menu === 'views'}
            onToggle={setMenu}
            label={<span className="sr-only">More views</span>}
            icon="chevron"
            align="start"
            className="views-more"
          >
            {onNormalTo && <MenuItem label="Normal To surface…" icon="orthographic" onClick={onNormalTo} />}
            <div className="orientation-picker">{views.slice(4).map(v=><button key={v.view} type="button" role="menuitem" className={view===v.view?'selected':''} onClick={()=>{setCamera(v.view);setMenu(null);}}><ViewOrientation view={v.view} size={36}/><span>{v.label}</span></button>)}</div>

          </Menu>
        </div>
        <button type="button" className="icon-button" aria-label="Fit model" title="Fit · F" onClick={onFit}>
          <Icon name="fit" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-pressed={!!section}
          aria-label="Section view"
          title="Section view · Q — display only"
          onClick={toggleSection}
        >
          <Icon name="section" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-pressed={measuring}
          aria-label="Measure"
          title="Measure between two points · G"
          onClick={onMeasure}
        >
          <Icon name="ruler" />
        </button>
        {orbiting && <button type="button" className="icon-button" aria-label="Stop turntable orbit" aria-pressed={true} title="Stop turntable orbit" onClick={onOrbit}><Icon name="pause" /></button>}
        <Menu id="view-options" open={menu === 'view-options'} onToggle={setMenu} align="start" className="view-options"
          label={<><span className="view-options-label">View options</span>{(edges || snap) && <span className="view-options-dot" aria-hidden="true" />}</>}
          ariaLabel="View options" title="Edges, snapping and turntable orbit">
          <div className="view-options-menu">
            {onMatchStudio&&<button type="button" role="menuitemcheckbox" aria-checked={!!matchStudio} onClick={onMatchStudio}><Icon name="camera" size={16}/><span>Match Studio looks<small>Display only, in this tab</small></span>{matchStudio&&<Icon name="check" size={15}/>}</button>}
            <button type="button" role="menuitemcheckbox" aria-checked={edges} onClick={onEdges}>
              <Icon name="box" size={16} /><span>Show edges<small>Outline every face boundary</small></span>{edges && <Icon name="check" size={15} />}
            </button>
            <button type="button" role="menuitemcheckbox" aria-checked={snap} onClick={onSnap}>
              <Icon name="snap" size={16} /><span>Snap while moving<small>1 mm, 15°, 0.1× · S</small></span>{snap && <Icon name="check" size={15} />}
            </button>
            <button type="button" role="menuitemcheckbox" aria-label="Turntable orbit" aria-checked={orbiting} disabled={orbitDisabled && !orbiting} onClick={onOrbit}>
              <Icon name="rotate" size={16} /><span>Turntable orbit<small>Drag or choose a view to stop</small></span>{orbiting && <Icon name="check" size={15} />}
            </button>
          </div>
        </Menu>
      </div>

      {section && (
        <div className="section-bar" role="group" aria-label="Section view">
          <span className="section-label">
            <Icon name="section" size={15} />
            Section
          </span>
          <div className="segmented">
            {(['X', 'Y', 'Z'] as const).map((label, axis) => (
              <button
                key={label}
                type="button"
                aria-pressed={section.axis === axis}
                onClick={() => sectionAxis(axis as 0 | 1 | 2)}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            type="range"
            aria-label={`Section offset along ${'XYZ'[section.axis]}`}
            min={sectionRange.min[section.axis]}
            max={sectionRange.max[section.axis]}
            step={Math.max((sectionRange.max[section.axis] - sectionRange.min[section.axis]) / 400, 0.01)}
            value={section.offset}
            onChange={(event) => setSection({ ...section, offset: Number(event.target.value) })}
          />
          <code className="section-offset">
            {'XYZ'[section.axis]} {fmt(section.offset, 2)}
          </code>
          <button
            type="button"
            className="icon-button quiet"
            aria-pressed={section.flip}
            aria-label="Keep the other side"
            title="Keep the other side"
            onClick={() => setSection({ ...section, flip: !section.flip })}
          >
            <Icon name="mirror" size={16} />
          </button>
          <button
            type="button"
            className="icon-button quiet"
            aria-label="Close section view"
            title="Close · Q"
            onClick={() => setSection(null)}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
