import type { Frame, Profile } from '../shared/protocol';

export const xyFrame = (origin: Frame['origin'] = [0, 0, 0]): Frame => ({ origin, xDirection: [1, 0, 0], normal: [0, 0, 1] });
/** Two cubic Bezier spans with a rounded leading edge and a thin trailing edge. */
export const wingProfile = (): Profile => ({ type: 'path', start: [30, 0], segments: [
  { type: 'bezier', controls: [[-25, 12], [-30, 8]], to: [-30, 0] },
  { type: 'bezier', controls: [[-30, -8], [-20, -5]], to: [30, 0] },
] });
export const bodySections = () => [
  { profile: { type: 'ellipse' as const, radiusX: 8, radiusY: 5 }, frame: { origin: [-60, 0, 0] as Frame['origin'], xDirection: [0, 1, 0] as Frame['xDirection'], normal: [1, 0, 0] as Frame['normal'] } },
  { profile: { type: 'ellipse' as const, radiusX: 22, radiusY: 12 }, frame: { origin: [-15, 0, 0] as Frame['origin'], xDirection: [0, 1, 0] as Frame['xDirection'], normal: [1, 0, 0] as Frame['normal'] } },
  { profile: { type: 'ellipse' as const, radiusX: 17, radiusY: 10 }, frame: { origin: [30, 0, 0] as Frame['origin'], xDirection: [0, 1, 0] as Frame['xDirection'], normal: [1, 0, 0] as Frame['normal'] } },
  { profile: { type: 'ellipse' as const, radiusX: 5, radiusY: 4 }, frame: { origin: [65, 0, 0] as Frame['origin'], xDirection: [0, 1, 0] as Frame['xDirection'], normal: [1, 0, 0] as Frame['normal'] } },
];
/** Smooth pitch variation across three exact airfoil sections. */
export const wingSections = () => [-1, 0, 1].map(i => ({ profile: wingProfile(), frame: {
  origin: [0, i * 50, 0] as Frame['origin'], normal: [0, 1, 0] as Frame['normal'],
  xDirection: [Math.cos(i * Math.PI / 12), 0, Math.sin(i * Math.PI / 12)] as Frame['xDirection'],
} }));
