import type { IconName } from './icons';
import type { ViewName } from '../shared/protocol';

export const views: { view: ViewName; label: string; icon: IconName }[] = [
  { view: 'isometric', icon: 'view-isometric', label: 'Iso' },
  { view: 'top', icon: 'view-top', label: 'Top' },
  { view: 'front', icon: 'view-front', label: 'Front' },
  { view: 'right', icon: 'view-right', label: 'Right' },
  { view: 'back', icon: 'view-back', label: 'Back' },
  { view: 'left', icon: 'view-left', label: 'Left' },
  { view: 'bottom', icon: 'view-bottom', label: 'Bottom' },
  { view: 'isometric_front_left', icon: 'view-isometric', label: 'Above front left' },
  { view: 'isometric_back_right', icon: 'view-isometric', label: 'Above back right' },
  { view: 'isometric_back_left', icon: 'view-isometric', label: 'Above back left' },
  { view: 'isometric_bottom_front_right', icon: 'view-isometric', label: 'Below front right' },
  { view: 'isometric_bottom_front_left', icon: 'view-isometric', label: 'Below front left' },
  { view: 'isometric_bottom_back_right', icon: 'view-isometric', label: 'Below back right' },
  { view: 'isometric_bottom_back_left', icon: 'view-isometric', label: 'Below back left' },
  { view: 'dimetric', icon: 'view-isometric', label: 'Dimetric' },
  { view: 'trimetric', icon: 'view-isometric', label: 'Trimetric' },
];

export const viewLabel = (view: ViewName) => view === 'isometric' ? 'Isometric (above front right)' : views.find(v => v.view === view)!.label;
