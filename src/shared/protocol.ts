import { z } from 'zod';
import { COATS, FINISHES, MATERIAL_IDS, STUDIO_FLOOR_IDS, SURFACE_DETAILS } from './materials';

export const PROTOCOL_VERSION = 1 as const;
export const BRIDGE_PORT = 4318;
export const WEB_ORIGIN = 'http://127.0.0.1:5173';
export const MAX_FEATURES = 250;
export const MAX_INSTANCE_DEPTH = 4;
export const MAX_REFERENCED_DOCUMENTS = 64;
export const MAX_ASSEMBLY_FEATURES = 2000;
export const COMMAND_TIMEOUT_MS = 60_000;

export const featureIdSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const dimension = z.number().finite().min(0.01).max(10_000);
const coordinate = z.number().finite().min(-100_000).max(100_000);
// Homogeneous arrays emit JSON Schema `items`, which agent clients handle more
// consistently than tuple `prefixItems`. Exact length establishes the tuple type.
const triplet = (item: z.ZodNumber) =>
  z.array(item).length(3) as unknown as z.ZodType<[number, number, number]>;
export const vectorSchema = triplet(coordinate);
const outputVectorSchema = triplet(z.number().finite());
export type Vector3 = z.infer<typeof vectorSchema>;
/** Right-handed local frame. Local Y = normal cross xDirection. */
const directionSchema = vectorSchema.refine(v => Math.hypot(...v) > 1e-8, 'Direction must be nonzero.');
const perpendicular = (f: { xDirection: Vector3; normal: Vector3 }) =>
  Math.abs(f.xDirection.reduce((sum, v, i) => sum + v * f.normal[i], 0)) /
    (Math.hypot(...f.xDirection) * Math.hypot(...f.normal)) < 1e-6;
export const planeDirectionsSchema = z.object({ xDirection: directionSchema, normal: directionSchema }).strict()
  .refine(perpendicular, 'Local X direction and normal must be perpendicular.');
export const frameSchema = z.object({ origin: vectorSchema, xDirection: directionSchema, normal: directionSchema }).strict()
  .refine(perpendicular, 'Local X direction and normal must be perpendicular.');
export type Frame = z.infer<typeof frameSchema>;
const mountNameSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const mountReferenceSchema = z.object({ featureId: featureIdSchema, name: z.string().min(1).max(512) }).strict();
export const mountSchema = z.object({ name: mountNameSchema, frame: frameSchema }).strict();
export type Mount = z.infer<typeof mountSchema>;
// Resolved geometry can lie beyond authored coordinate limits after placements.
const outputPoint = triplet(z.number().finite());
export const resolvedMountSchema = z.object({ name: z.string().min(1).max(512), frame: z.object({
  origin: outputPoint, xDirection: outputPoint, normal: outputPoint,
}).strict() }).strict();
export type ResolvedMount = z.infer<typeof resolvedMountSchema>;
const attachmentSchema = z.object({
  source: mountReferenceSchema,
  target: z.union([mountReferenceSchema, z.object({ frame: frameSchema }).strict()]),
  mode: z.enum(['align', 'mate']),
  offset: vectorSchema,
  twistDegrees: z.number().finite(),
}).strict();
export const boxParamsSchema = z
  .object({
    origin: vectorSchema,
    size: triplet(dimension),
  })
  .strict();
const cylinderParamsSchema = z
  .object({
    origin: vectorSchema,
    radius: dimension,
    height: dimension,
  })
  .strict();
const rodLengthValid = (p: { from: Vector3; to: Vector3 }) => {
  const length = Math.hypot(...p.to.map((v, i) => v - p.from[i]));
  return length >= 0.01 && length <= 10_000;
};
const rodParamsSchema = z
  .object({
    from: vectorSchema,
    to: vectorSchema,
    radius: dimension,
  })
  .strict()
  .refine(rodLengthValid, 'Rod endpoint distance must be 0.01–10000 mm.');
const subtractParamsSchema = z
  .object({
    target: featureIdSchema,
    tools: z.array(featureIdSchema).min(1).max(32),
  })
  .strict();
/**
 * Which edges a fillet or chamfer treats, re-resolved on every rebuild (never stored edge indices).
 * Every given criterion must hold. A viewport click on an edge adds a near point.
 */
export const edgeRefSchema = z.object({feature:featureIdSchema,name:z.string().min(1).max(512),signature:z.object({center:vectorSchema,lengthMm:z.number().positive()}).strict()}).strict();
export type EdgeRef = z.infer<typeof edgeRefSchema>;
const edgeQuerySchema = z
  .object({
    refs:z.array(edgeRefSchema).min(1).max(64).optional(),
    /** Straight edges parallel to this world axis. */
    parallel: z.enum(['X', 'Y', 'Z']).optional(),
    /** Edges lying in the plane where this axis equals value, e.g. {axis:'Z', value:5} for a top face at z = 5. */
    on: z
      .object({ axis: z.enum(['X', 'Y', 'Z']), value: coordinate })
      .strict()
      .optional(),
    /** Edges passing within toleranceMm of any of these points. */
    near: z.array(vectorSchema).min(1).max(64).optional(),
    /** The seam where two earlier inputs of the target meet, e.g. after a union: edges lying on both their surfaces. */
    between: z.array(featureIdSchema).length(2).refine(ids => ids[0] !== ids[1], 'between names two different features.').optional(),
    toleranceMm: z.number().finite().min(0.001).max(100).optional(),
    curve: z.enum(['line', 'circle', 'any']).optional(),
    minLengthMm: z.number().finite().min(0).max(100_000).optional(),
    maxLengthMm: z.number().finite().min(0).max(100_000).optional(),
  })
  .strict()
  .refine(
    (q) =>
      !!(
        q.refs || q.parallel ||
        q.on ||
        q.near ||
        q.between ||
        (q.curve && q.curve !== 'any') ||
        q.minLengthMm !== undefined ||
        q.maxLengthMm !== undefined
      ),
    'An edge query needs at least one criterion.'
  );
const edgeSelection = z.union([z.enum(['all', 'vertical']), edgeQuerySchema]);
const seamOutsideTarget = (p: { target: string; edges: z.infer<typeof edgeSelection> }) =>
  typeof p.edges === 'string' || !('between' in p.edges && p.edges.between?.includes(p.target));
const seamMessage = { message: 'between names the inputs that were joined, not the target being blended.', path: ['edges', 'between'] };
const filletParamsSchema = z
  .object({
    target: featureIdSchema,
    radius: z.union([dimension,z.object({stations:z.array(z.array(z.number().finite()).length(2)).min(2).max(16).refine(a=>a[0][0]===0&&a.at(-1)![0]===1&&a.every(([t,r],i)=>t>=0&&t<=1&&r>=0.01&&r<=10000&&(!i||t>a[i-1][0])), 'Stations must increase from 0 to 1 with radii 0.01–10000 mm.')}).strict()]),
    edges: edgeSelection,
  })
  .strict().refine(seamOutsideTarget, seamMessage);
const chamferParamsSchema = z
  .object({
    target: featureIdSchema,
    distance: dimension,
    edges: edgeSelection,
  })
  .strict().refine(seamOutsideTarget, seamMessage);
const combineParamsSchema = subtractParamsSchema;
const transformParamsSchema = z
  .object({
    target: featureIdSchema,
    translation: vectorSchema,
    rotationAxis: vectorSchema.refine((v) => Math.hypot(...v) > 1e-8, 'Rotation axis must be nonzero.'),
    angleDegrees: z.number().finite(),
    origin: vectorSchema,
    scale: z.number().finite().min(0.001).max(1000),
    copy: z.boolean(),
  })
  .strict();
export const instanceParamsSchema = z
  .object({
    document: z.string().uuid(),
    featureId: featureIdSchema.optional(),
    translation: vectorSchema,
    rotationAxis: transformParamsSchema.shape.rotationAxis,
    angleDegrees: transformParamsSchema.shape.angleDegrees,
    origin: vectorSchema,
    attachment: attachmentSchema.optional(),
  })
  .strict().refine(p => !p.attachment || (p.angleDegrees === 0 && p.translation.every(v => v === 0) && p.origin.every(v => v === 0)),
    'Attached instances require zero manual translation, angle and pivot. Use attachment offset and twist.');
const mirrorParamsSchema = z
  .object({
    target: featureIdSchema,
    plane: z.enum(['XY', 'XZ', 'YZ']),
    origin: vectorSchema,
    copy: z.boolean(),
  })
  .strict();
const point2 = z.array(coordinate).length(2) as unknown as z.ZodType<[number, number]>;
export const curveSegmentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('line'), id:featureIdSchema.optional(), to: point2 }).strict(),
  z.object({ type: z.literal('arc'), id:featureIdSchema.optional(), via: point2, to: point2 }).strict(),
  z.object({ type: z.literal('bezier'), id:featureIdSchema.optional(), controls: z.array(point2).min(1).max(2), to: point2 }).strict(),
]);
export const curvePathSchema = z.object({ start: point2, segments: z.array(curveSegmentSchema).min(1).max(32) }).strict();
export type CurvePath = z.infer<typeof curvePathSchema>;
export const profileSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rectangle'), width: dimension, height: dimension }).strict(),
  z.object({ type: z.literal('circle'), radius: dimension }).strict(),
  z.object({ type: z.literal('ellipse'), radiusX: dimension, radiusY: dimension }).strict(),
  z.object({ type: z.literal('polygon'), segmentIds:z.array(featureIdSchema).min(3).max(64).optional(), points: z.array(point2).min(3).max(64) }).strict(),
  z.object({ type: z.literal('path'), ...curvePathSchema.shape }).strict(),
]);
export type Profile = z.infer<typeof profileSchema>;
const extrudeParamsSchema = z.object({
  profile: profileSchema,
  plane: z.union([z.enum(['XY', 'XZ', 'YZ']), planeDirectionsSchema]),
  origin: vectorSchema,
  distance: dimension,
}).strict();
const loftParamsSchema = z.object({
  sections: z.array(z.object({ profile: profileSchema, frame: frameSchema, seam:z.number().min(0).lt(1).optional(), splitAt:z.array(z.number().min(0).lt(1)).max(64).optional(),reverse:z.boolean().optional(),mapping:z.array(z.string().min(1).max(128)).min(1).max(128).optional() }).strict()).min(2).max(12),
  ruled: z.boolean(), correspondence:z.enum(['automatic','authored']).optional(),smoothing:z.boolean().optional(),continuity:z.enum(['C1','C2']).optional(),maxDegree:z.number().int().min(2).max(14).optional(),
  guides:z.array(z.object({vertex:z.string().min(1).max(128),path:z.lazy(()=>sweepPathSchema)}).strict()).min(1).max(32).optional().describe('Guides bind to the start vertex of a named authored segment. Requires authored correspondence, ruled:false, 2–32 matching segments and one crossing per section plane. Guided patch seams are G0. toleranceMm defaults to 0.005, maximum 0.01. Exact validity, native tolerances and sampled section/rail residuals must pass.'),
  toleranceMm:z.number().min(0.000001).max(0.01).optional(),
}).strict();
/** A smooth 3D path: an exact interpolating B-spline through the points, in order. */
const spacePathSchema = z.object({ points: z.array(vectorSchema).min(2).max(64) }).strict()
  .refine(p => p.points.every((point, i) => i === 0 || Math.hypot(...point.map((v, k) => v - p.points[i - 1][k])) > 1e-3), 'Consecutive path points must be more than 0.001 mm apart.');
const sweepPathSchema = z.union([z.object({ ...curvePathSchema.shape, frame: frameSchema }).strict(), spacePathSchema]);
const sweepParamsSchema = z.object({
  profile: profileSchema,
  path: sweepPathSchema,
  sections:z.array(z.object({at:z.number().min(0).max(1),profile:profileSchema,rotationDegrees:z.number().finite().optional()}).strict()).min(2).max(12).optional(),
  guide:z.object({path:sweepPathSchema,curvilinear:z.boolean(),contact:z.enum(['none','contact','border'])}).strict().optional(),
  toleranceMm:z.number().min(0.000001).max(0.01).optional(),
  /** Profile U direction at the path start, made perpendicular to the path. Defaults to the frame normal of a planar path, world Z (X when starting along Z) for a points path. */
  profileX: directionSchema.optional(),
  /** The section scales linearly from 1 at the start to endScale at the end. */
  endScale: z.number().finite().min(0.05).max(20).optional(),
}).strict();
const shellParamsSchema = z.object({
  target: featureIdSchema,
  thickness: dimension,
  removeFaces: z.array(z.object({
    point: vectorSchema, normal: directionSchema,
    toleranceMm: z.number().finite().min(0.000001).max(0.1),
    expectedCount: z.number().int().min(1).max(16),
  }).strict()).min(1).max(8),
}).strict();
const revolveParamsSchema = z
  .object({
    points: z
      .array(point2)
      .min(3)
      .max(64)
      .refine((points) => points.every(([radius]) => radius >= 0), 'Profile radii must be nonnegative.'),
    origin: vectorSchema,
    angleDegrees: z.number().finite().min(0.1).max(360),
  })
  .strict();
const nonzeroVector = vectorSchema.refine((v) => Math.hypot(...v) > 1e-8, 'Vector must be nonzero.');
/** Copies of one solid along a line or around an axis, kept as one feature. The first copy is the target itself. */
const patternParamsSchema = z
  .object({
    target: featureIdSchema,
    layout: z.discriminatedUnion('type', [
      z
        .object({
          type: z.literal('linear'),
          direction: nonzeroVector,
          spacing: dimension,
          count: z.number().int().min(2).max(64),
        })
        .strict(),
      z
        .object({
          type: z.literal('circular'),
          axis: nonzeroVector,
          origin: vectorSchema,
          count: z.number().int().min(2).max(360),
          angleDegrees: z.number().finite().min(0.1).max(360),
        })
        .strict(),
    ]),
  })
  .strict();
/**
 * Letters as a solid. Without a target they are raised letters standing on origin. With a target, engrave cuts
 * them depth into it and emboss raises them depth out of it, both at the face through origin whose outward
 * normal is the plane normal: XY top (+Z), XZ front (-Y), YZ right (+X).
 */
const textParamsSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[\x20-\x7E]+$/, 'Text uses printable ASCII characters.'),
    plane: z.enum(['XY', 'XZ', 'YZ']),
    /** Center of the text block, on the face. */
    origin: vectorSchema,
    /** Font size in mm; capital letters are about 0.7 of it. */
    size: dimension,
    depth: dimension,
    target: featureIdSchema.optional(),
    mode: z.enum(['engrave', 'emboss']).optional(),
  })
  .strict();
const holeParamsSchema = z
  .object({
    target: featureIdSchema,
    centers: z.array(vectorSchema).min(1).max(32),
    diameter: dimension,
    axis: z.enum(['X', 'Y', 'Z']),
  })
  .strict();
export const parameterNameSchema = z
  .string()
  .regex(
    /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/,
    'Parameter names start with a letter or _ and use letters, digits and _.'
  );
/** Arithmetic over numbers and parameter names: + - * / and parentheses. Evaluated by a small parser, never as code. */
const expressionSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_+\-*/().\s]+$/, 'Expressions use numbers, parameter names, + - * / and parentheses.');
/** Dotted path to a numeric parameter field, e.g. size.2, radius, profile.width, centers.0.1. */
const bindingPathSchema = z
  .string()
  .max(64)
  .regex(/^[a-zA-Z]+(\.[a-zA-Z0-9]+)*$/);
const bindingsSchema = z
  .record(bindingPathSchema, expressionSchema)
  .refine((value) => Object.keys(value).length <= 64, 'At most 64 bindings per feature.');
const parameterSchema = z
  .object({
    name: parameterNameSchema,
    value: z.number().finite().min(-100_000).max(100_000),
    description: z.string().min(1).max(200).optional(),
  })
  .strict();
export type Parameter = z.infer<typeof parameterSchema>;
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
/** Embedded image-only assets. SVG is decoded as an image, never inserted into the DOM. */
export const graphicContentSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string().min(1).max(80),
    font: z.enum(['sans', 'serif', 'mono']), weight: z.enum(['regular', 'bold']),
    spacing: z.number().finite().min(-0.05).max(0.5), align: z.enum(['left', 'center', 'right']), color: hexColor }).strict(),
  z.object({type:z.literal('image'),asset:z.string().regex(/^sha256:[a-f0-9]{64}$/)}).strict(),
  z.object({ type: z.literal('image'), asset:z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(), dataUrl: z.string().max(65536)
    .regex(/^data:image\/(png|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/)
    .refine(value => {
      try {
        const data = atob(value.split(',')[1]);
        if (value.startsWith('data:image/png')) {
          if (!data.startsWith('\x89PNG\r\n\x1a\n') || data.slice(12,16) !== 'IHDR') return false;
          const size = (at:number) => [0,1,2,3].reduce((n,i) => n*256+data.charCodeAt(at+i),0);
          return [size(16),size(20)].every(n => n>0 && n<=2048);
        }
        if (!/<svg[\s>]/i.test(data) || /<!|<(?:script|foreignObject|image|use|animate|set|style)\b|\bon\w+\s*=|\b(?:href|src)\s*=|url\s*\(/i.test(data)) return false;
        const root = data.match(/<svg\b[^>]*>/i)?.[0] ?? '';
        return [...root.matchAll(/\b(?:width|height)\s*=\s*["']([^"']+)["']/gi)].every(m => /^\d+(?:\.\d+)?(?:px)?$/.test(m[1]) && Number.parseFloat(m[1])>0 && Number.parseFloat(m[1])<=2048);
      } catch { return false; }
    }, 'Use a PNG up to 2048 pixels or a static self-contained SVG with pixel dimensions up to 2048, without external or dynamic content.') }).strict(),
]);
export const surfaceGraphicSchema = z.object({
  id: featureIdSchema,
  /** Anchor relative to this result's local bounds. Moves and resized bounds carry the graphic. */
  anchor: triplet(z.number().finite().min(0).max(1)),
  normal: directionSchema, xDirection: directionSchema,
  width: dimension, height: dimension, depth: dimension,
  rotation: z.number().finite().min(-360).max(360),
  /** Clip surfaces more oblique than this angle to the projector. Prevents back-side bleed. */
  maxAngle: z.number().finite().min(5).max(85),
  content: graphicContentSchema,
}).strict().refine(g => Math.hypot(...[
  g.normal[1]*g.xDirection[2]-g.normal[2]*g.xDirection[1],
  g.normal[2]*g.xDirection[0]-g.normal[0]*g.xDirection[2],
  g.normal[0]*g.xDirection[1]-g.normal[1]*g.xDirection[0],
]) > 1e-6, 'Graphic normal and X direction must not be parallel.');
export type SurfaceGraphic = z.infer<typeof surfaceGraphicSchema>;
export const MATERIAL_LOOK_KEYS = [...MATERIAL_IDS, 'unassigned'] as const;
export const materialLookSchema = z.object({
  finish: z.enum(FINISHES).optional(),
  coat: z.enum(COATS).optional(),
  detail: z.enum(SURFACE_DETAILS).optional(),
  /** Multiplies the surface detail pattern size. */
  detailScale: z.number().finite().min(0.25).max(4).optional(),
}).strict();
export type MaterialLook = z.infer<typeof materialLookSchema>;
export const presentationSchema = z.object({
  preset: z.enum(['studio', 'soft', 'dramatic']).optional(),
  exposure: z.number().finite().min(0.25).max(3).optional(),
  environment: z.number().finite().min(0).max(3).optional(),
  keyIntensity: z.number().finite().min(0).max(8).optional(),
  /** Softbox dimensions relative to the automatic rig. */
  keySize: z.number().finite().min(0.25).max(3).optional(),
  fillIntensity: z.number().finite().min(0).max(3).optional(),
  lightRotation: z.number().finite().min(-180).max(180).optional(),
  background: hexColor.optional(),
  shadows: z.boolean().optional(),
  environmentPreset: z.enum(['studio', 'dark_studio', 'warehouse', 'outdoor']).optional(),
  environmentRotation: z.number().finite().min(-180).max(180).optional(),
  lightColor: hexColor.optional(),
  lightElevation: z.number().finite().min(5).max(85).optional(),
  floor: z.enum(STUDIO_FLOOR_IDS).optional(),
  floorColor: hexColor.optional(),
  floorRoughness: z.number().finite().min(0.05).max(1).optional(),
  /** Size of one floor pattern repeat, mm. Omit for a size that follows the model. */
  floorScale: z.number().finite().min(10).max(10000).optional(),
  floorHeight: z.number().finite().min(-10000).max(10000).optional(),
  backdrop: z.enum(['plane', 'sweep']).optional(),
  backgroundMode: z.enum(['color', 'gradient', 'environment', 'transparent']).optional(),
  /** Upper color of a gradient background; `background` is its horizon color. */
  backgroundTop: hexColor.optional(),
  /** Display-only look per material, keyed by material id or 'unassigned'. Omitted fields keep the model's value. */
  materials: z.partialRecord(z.enum(MATERIAL_LOOK_KEYS), materialLookSchema).optional(),
  /** Legacy 26 Oct setting. 'coated' reads as materials.carbon_fiber {coat:'clear',detail:'carbon'}. */
  carbonFinish: z.enum(['model', 'coated']).optional(),
}).strict();
export type Presentation = z.infer<typeof presentationSchema>;
/** How a part looks and what it is made of. Results inherit it from the part they were built from. */
export const appearanceSchema = z
  .object({
    material: z.enum(MATERIAL_IDS).optional(),
    /** Color override, #rrggbb. */
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    finish: z.enum(FINISHES).optional(),
    coat: z.enum(COATS).optional(),
    roughness: z.number().finite().min(0).max(1).optional(),
    detailScale: z.number().finite().min(0.25).max(4).optional(),
    visualMaterial: z.enum(MATERIAL_IDS).optional(),
    detail: z.enum(SURFACE_DETAILS).optional(),
    graphics: z.array(surfaceGraphicSchema).max(8).refine(g => new Set(g.map(x => x.id)).size === g.length, 'Graphic IDs must be unique.').optional(),
  })
  .strict();
export type Appearance = z.infer<typeof appearanceSchema>;
export const appearanceFieldSchema = appearanceSchema.omit({ graphics: true });
const appearancePatchSchema = z.object(Object.fromEntries(Object.entries(appearanceFieldSchema.shape).map(([k, v]) => [k, v.nullable()]))).extend({graphics:z.array(surfaceGraphicSchema).optional()}).strict() as z.ZodType<{ [K in keyof Omit<Appearance, 'graphics'>]?: Omit<Appearance, 'graphics'>[K] | null }>;
export type SurfaceTarget = z.infer<typeof surfaceTargetSchema>;
export const surfaceTargetSchema = z.object({ feature: featureIdSchema, path: z.array(featureIdSchema).max(64).optional(), signature:z.object({surface:z.string().max(64),areaMm2:z.number().finite().positive(),shapeSamples:z.array(outputVectorSchema).length(9).optional(),normal:vectorSchema.optional()}).strict().optional(), select: z.union([z.object({all:z.literal(true)}).strict(), z.object({faces:z.array(z.string().max(512)).min(1).max(64), fragments:z.enum(['all','one'])}).strict()]).default({all:true}) }).strict();
export const regionPredicateSchema = z.union([
 z.object({side:z.object({plane:z.object({origin:vectorSchema,normal:directionSchema}).strict()}).strict()}).strict(),
 z.object({iso:z.object({u:z.array(z.number().min(0).max(1)).length(2).optional(),v:z.array(z.number().min(0).max(1)).length(2).optional()}).strict().refine(v=>!!v.u||!!v.v,'Specify a UV interval.')}).strict(),
 z.object({crest:z.object({axis:directionSchema,fromMm:coordinate,toMm:coordinate,extreme:directionSchema,toward:z.enum(['positive','negative']),toleranceMm:z.number().min(0.005).max(0.5).default(0.05)}).strict().refine(c=>c.toMm>c.fromMm,'Crest stations must increase.')}).strict(),
]);
export const paintRegionSchema=z.object({id:featureIdSchema,target:surfaceTargetSchema,keep:z.array(regionPredicateSchema).min(1).max(4),look:appearanceFieldSchema.omit({material:true})}).strict();
export type PaintRegion=z.infer<typeof paintRegionSchema>;

const fillParamsSchema=z.object({boundary:z.array(z.object({edge:edgeRefSchema,continuity:z.enum(['G0','G1','G2']),support:surfaceTargetSchema.optional()}).strict()).min(1).max(32),points:z.array(vectorSchema).max(32).optional(),degree:z.number().int().min(2).max(8).optional(),maxSegments:z.number().int().min(1).max(32).optional(),tolerances:z.object({g0Mm:z.number().min(0.000001).max(0.01),g1Deg:z.number().min(0.001).max(5),g2:z.number().positive().max(1).optional()}).strict()}).strict();
const joinParamsSchema=z.object({target:featureIdSchema,replaceFaces:surfaceTargetSchema,surfaces:z.array(featureIdSchema).min(1).max(16),toleranceMm:z.number().min(0.000001).max(0.01),continuity:z.object({maxAngleDeg:z.number().min(0.001).max(180),maxCurvaturePerMm:z.number().positive().max(1).optional()}).strict().optional()}).strict();
const featureBase = {
  id: featureIdSchema,
  label: z.string().min(1).max(120).optional(),
  /** Parameter expressions that drive numeric params. params always hold the resolved values. */
  bindings: bindingsSchema.optional(),
  appearance: appearanceSchema.optional(),
  graphicEdits:z.object({upsert:z.array(surfaceGraphicSchema).max(8),remove:z.array(featureIdSchema).max(8),order:z.array(featureIdSchema).max(8).optional()}).strict().optional(),
  paintRegions:z.array(paintRegionSchema).max(32).optional(),
  surfaceStyles:z.array(z.object({target:surfaceTargetSchema,look:appearanceFieldSchema.omit({material:true})}).strict()).max(64).optional(),
  mounts: z.array(mountSchema).max(32).refine(m => new Set(m.map(v => v.name)).size === m.length, 'Mount names must be unique on a feature.').optional(),
};
export const featureSchema = z.discriminatedUnion('kind', [
  z.object({ ...featureBase, kind: z.literal('instance'), params: instanceParamsSchema }).strict(),
  z.object({ ...featureBase, kind: z.literal('box'), params: boxParamsSchema }).strict(),
  z.object({ ...featureBase, kind: z.literal('cylinder'), params: cylinderParamsSchema }).strict(),
  z.object({ ...featureBase, kind: z.literal('rod'), params: rodParamsSchema }).strict(),
  z.object({ ...featureBase, kind: z.literal('subtract'), params: subtractParamsSchema }).strict(),
  z.object({ ...featureBase, kind: z.literal('fillet'), params: filletParamsSchema }).strict(),
  z.object({ ...featureBase, kind: z.literal('chamfer'), params: chamferParamsSchema }).strict(),
  z.object({ ...featureBase, kind: z.literal('union'), params: combineParamsSchema }).strict(),
  z.object({ ...featureBase, kind: z.literal('intersect'), params: combineParamsSchema }).strict(),
  z.object({ ...featureBase, kind: z.literal('transform'), params: transformParamsSchema }).strict(),
  z.object({ ...featureBase, kind: z.literal('mirror'), params: mirrorParamsSchema }).strict(),
  z.object({ ...featureBase, kind: z.literal('extrude'), params: extrudeParamsSchema }).strict(),
  z.object({ ...featureBase, kind:z.literal('fill'),params:fillParamsSchema }).strict(),
  z.object({ ...featureBase, kind:z.literal('join'),params:joinParamsSchema }).strict(),
  z.object({ ...featureBase, kind: z.literal('loft'), params: loftParamsSchema }).strict(),
  z.object({ ...featureBase, kind: z.literal('sweep'), params: sweepParamsSchema }).strict(),
  z.object({ ...featureBase, kind: z.literal('shell'), params: shellParamsSchema }).strict(),
  z.object({ ...featureBase, kind: z.literal('revolve'), params: revolveParamsSchema }).strict(),
  z.object({ ...featureBase, kind: z.literal('drill_holes'), params: holeParamsSchema }).strict(),
  z.object({ ...featureBase, kind: z.literal('pattern'), params: patternParamsSchema }).strict(),
  z.object({ ...featureBase, kind: z.literal('text'), params: textParamsSchema }).strict(),
]);
export type Feature = z.infer<typeof featureSchema>;

/**
 * A declared relationship between two parts, checked by analysis on every rebuild like a unit test for geometry.
 * a and b may name hidden construction features; they are checked through the visible results built from them.
 */
export const checkTargetSchema = z.union([featureIdSchema, z.object({feature:featureIdSchema,path:z.array(featureIdSchema).max(64).optional(),solidIndex:z.number().int().nonnegative().optional()}).strict()]);
export type CheckTarget = z.infer<typeof checkTargetSchema>;
export const checkRoot = (target: CheckTarget): string => typeof target === 'string' ? target : target.feature;
const pairCheckSchema = z
  .object({
    id: featureIdSchema,
    a: checkTargetSchema,
    b: checkTargetSchema,
    expect: z.enum(['contact', 'clearance', 'no_interference', 'overlap']),
    /** For clearance: the smallest acceptable gap. Defaults to more than the contact tolerance. */
    minGapMm: z.number().finite().min(0).max(10_000).optional(),
    note: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((c) => c.expect !== 'overlap' || !!c.note?.trim(), {
    message: 'An intended overlap needs a note explaining why.',
    path: ['note'],
  });
const axisSchema = z.enum(['X', 'Y', 'Z']);
const toleranceSchema = z.number().finite().min(0).max(10_000);
/** Design targets measure one feature's exact result, or every visible result together when a is omitted. */
const targetBase = { id: featureIdSchema, a: checkTargetSchema.optional(), note: z.string().min(1).max(200).optional() };
export const checkSchema = z.discriminatedUnion('expect', [
  pairCheckSchema,
  /** Overall exact extent along a world axis. */
  z.object({ ...targetBase, expect: z.literal('size'), axis: axisSchema, mm: dimension, toleranceMm: toleranceSchema }).strict(),
  /** Stays inside a world box. */
  z.object({ ...targetBase, expect: z.literal('within'), min: vectorSchema, max: vectorSchema }).strict()
    .refine(c => c.min.every((v, i) => v <= c.max[i]), { message: 'within min must not exceed max.', path: ['max'] }),
  /** Exact cross-section at axis = offset: its in-plane width and height (X: Y by Z, Y: X by Z, Z: X by Y). */
  z.object({ ...targetBase, expect: z.literal('section'), axis: axisSchema, offset: coordinate, widthMm: dimension.optional(), heightMm: dimension.optional(), toleranceMm: toleranceSchema }).strict()
    .refine(c => c.widthMm !== undefined || c.heightMm !== undefined, { message: 'A section target needs widthMm, heightMm or both.', path: ['widthMm'] }),
]);
export const TARGET_EXPECTATIONS = ['size', 'within', 'section'] as const;
export const isTargetCheck = <T extends { expect: string }>(check: T): boolean => (TARGET_EXPECTATIONS as readonly string[]).includes(check.expect);
/** The features a check names: both parts of a relationship, or the measured feature of a target. */
export const checkFeatures = (check: z.infer<typeof checkSchema>): string[] =>
  ('b' in check ? [check.a, check.b] : check.a ? [check.a] : []).map(checkRoot);
type Check = z.infer<typeof checkSchema>;
const analysisSettingsSchema = z
  .object({
    /** Analyze after every committed edit. Absent means on. */
    auto: z.boolean().optional(),
    /** The part everything else should connect to. Defaults to the largest visible result. */
    ground: checkTargetSchema.optional(),
    /** Gap at or below which two parts count as touching. Defaults to 0.01 mm. */
    toleranceMm: z.number().finite().min(0.0001).max(10).optional(),
    checks: z.array(checkSchema).max(MAX_FEATURES).optional(),
  })
  .strict();

/** Original creation arguments let a retried request recover its document after a restart. */
const creationSchema = z.object({
  requestId: z.string().uuid(),
  action: z.enum(['create', 'duplicate','extract']),
  extractedFrom:z.object({documentId:z.string().uuid(),storageVersion:z.number().int().positive(),revision:z.number().int().nonnegative(),featureIds:z.array(featureIdSchema)}).strict().optional(),
  documentId: z.string().uuid().optional(),
  name: z.string().min(1).max(120).optional(),
  kind: z.enum(['part', 'assembly']).optional(),
  projectId: z.string().uuid().optional(),
  expectedStorageVersion: z.number().int().positive().optional(),
}).strict();

export const documentSchema = z
  .object({
    schemaVersion: z.union([z.literal(1),z.literal(2)]),
    kind: z.enum(['part', 'assembly']).optional(),
    documentId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    units: z.literal('mm'),
    /** Human name of the part, e.g. "Front wing". Metadata: renaming keeps the revision. */
    name: z.string().min(1).max(120).optional(),
    creation: creationSchema.optional(),
    projectId: z.string().uuid().optional(),
    graphicAssets:z.record(z.string().regex(/^sha256:[a-f0-9]{64}$/),z.object({mime:z.enum(['image/png','image/svg+xml']),width:z.number().int().min(1).max(2048).optional(),height:z.number().int().min(1).max(2048).optional(),bytes:z.number().int().min(1).max(49152),base64:z.string().max(65536).regex(/^[A-Za-z0-9+/]+={0,2}$/)}).strict()).optional(),
    features: z.array(featureSchema).max(MAX_FEATURES),
    /** Named design values that feature bindings reference. Absent in documents without parameters. */
    parameters: z.array(parameterSchema).max(MAX_FEATURES).optional(),
    /** Physical analysis settings and declared checks. Absent means automatic analysis with defaults. */
    analysis: analysisSettingsSchema.optional(),
    presentation: presentationSchema.optional(),
    /** Saved Studio camera move and video output (display-only, like presentation). Defined below; read lazily. */
    video: z.lazy((): z.ZodType<StudioVideoRecipe> => studioVideoRecipeSchema).optional(),
    selectedFeatureIds: z.array(featureIdSchema).max(MAX_FEATURES),
  })
  .strict();
export type CadDocument = z.infer<typeof documentSchema>;

const context = {
  documentId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  sessionId:z.string().uuid().optional(),
  expectedStorageVersion: z.number().int().positive().optional(),
};
export const viewNameSchema = z.enum(['front', 'back', 'left', 'right', 'top', 'bottom', 'isometric', 'isometric_front_left', 'isometric_back_right', 'isometric_back_left', 'isometric_bottom_front_right', 'isometric_bottom_front_left', 'isometric_bottom_back_right', 'isometric_bottom_back_left', 'dimetric', 'trimetric']);
export type ViewName = z.infer<typeof viewNameSchema>;
/** Where a named view's camera sits relative to what it frames. */
export const VIEW_DIRECTIONS: Record<ViewName, Vector3> = {
  front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0],
  top: [0, 0, 1], bottom: [0, 0, -1], isometric: [1, -1, 1],
  isometric_front_left: [-1, -1, 1], isometric_back_right: [1, 1, 1], isometric_back_left: [-1, 1, 1],
  isometric_bottom_front_right: [1, -1, -1], isometric_bottom_front_left: [-1, -1, -1],
  isometric_bottom_back_right: [1, 1, -1], isometric_bottom_back_left: [-1, 1, -1],
  // Two equal axis foreshortenings for dimetric; three different ones for trimetric.
  dimetric: [1, -1, 0.5], trimetric: [1, -2, 1.5],
};
export const MAX_SHOTS = 12;
export const MAX_RENDER_VIEWS = Math.max(MAX_SHOTS, viewNameSchema.options.length);
const sectionSchema = z.object({ axis: z.enum(['X', 'Y', 'Z']), offset: coordinate, flip: z.boolean().optional() }).strict();
const shotFeatureIds = z.array(featureIdSchema).min(1).max(MAX_FEATURES);
/**
 * One camera the agent chooses: a direction, what to fit in the tile (zoom), and what to leave out of the way.
 * Framing is in model terms, so the same shot stays meaningful after edits.
 */
/** What fills a shot: results, a box, or a sphere around a detail. */
export const shotFrameSchema = z.union([
  z.object({ featureIds: shotFeatureIds }).strict(),
  z.object({ min: vectorSchema, max: vectorSchema }).strict().refine(b => b.min.every((v, i) => v <= b.max[i]), 'frame min must not exceed max.'),
  z.object({ center: vectorSchema, radiusMm: dimension }).strict(),
]);
export const shotSchema = z.object({
  view: viewNameSchema.or(z.literal('perspective')).optional(),
  /** Camera position relative to the framed center, e.g. [1,-1,1]; the camera looks back at the center. */
  from: directionSchema.optional(),
  up: directionSchema.optional(),
  /** What fills the tile: results, a box, or a sphere around a detail. Omit to frame everything shown. */
  frame: shotFrameSchema.optional(),
  projection: z.enum(['orthographic', 'perspective']).optional(),
  fovDegrees: z.number().finite().min(10).max(100).optional(),
  hide: shotFeatureIds.optional(),
  ghost: shotFeatureIds.optional(),
  section: sectionSchema.optional(),
  label: z.string().min(1).max(40).optional(),
}).strict()
  .refine(s => !(s.view && s.from && s.view !== 'perspective'), 'A shot uses a named view or from, not both. For a custom perspective use {from:[1,-1,1],projection:"perspective"}.')
  .refine(s => s.projection !== 'orthographic' || (s.fovDegrees === undefined && s.view !== 'perspective'), 'Perspective view or fovDegrees conflicts with projection:"orthographic". Use {from:[1,-1,1],projection:"perspective",fovDegrees:35}.')
  .transform(({view,...shot}) => ({...shot,
    ...(view === 'perspective' ? (!shot.from ? {view:'isometric' as const} : {}) : view ? {view} : {}),
    ...(shot.projection === undefined && (view === 'perspective' || shot.fovDegrees !== undefined) ? {projection:'perspective' as const} : {}),
  }));
export type Shot = z.infer<typeof shotSchema>;

/** Final images share shot framing; inspection overlays remain in render_views. */
export const studioShotSchema = shotSchema.refine(s => !s.section && !s.ghost?.length, 'Studio images do not support section or ghost overlays. Use render_views for inspection.');
export const studioImageOutputSchema = z.object({
  size: z.enum(['hd', 'qhd', 'uhd', 'square', 'portrait']).default('hd'),
  quality: z.enum(['draft', 'standard', 'high']).default('standard'), denoise: z.boolean().default(true),
}).strict();

/** A prepared human view uses the inspection cameras, outside model revision and undo. */
export const workspaceViewStateSchema = z.object({
  mode: z.enum(['modeling','studio']).default('modeling'),
  panes: z.array(shotSchema).min(1).max(4).default([{view:'isometric'}]),
  layout: z.enum(['grid','columns','rows']).default('grid'),
  highlight:z.array(surfaceTargetSchema).max(64).optional(),
  selection: z.array(featureIdSchema).max(MAX_FEATURES).default([]),
  isolate: z.array(featureIdSchema).min(1).max(MAX_FEATURES).optional(),
  presentation: presentationSchema.optional(),
  studio: z.object({
    output: studioImageOutputSchema.optional(), panel: z.enum(['output','scene','materials']).optional(),
    views: z.array(viewNameSchema).min(1).max(16).optional(),
    layout: z.enum(['sheet','separate']).optional(), labels: z.boolean().optional(),
  }).strict().optional(),
}).strict().refine(v => v.mode !== 'studio' || v.panes.length === 1,
  'Studio uses one live camera; use studio.views for an output set.')
  .refine(v=>v.mode!=='studio'||v.panes.every(s=>!s.section&&!s.ghost?.length),'Studio does not support section or ghost overlays; use modeling for inspection.')
  .refine(v=>v.mode!=='modeling'||!v.presentation&&!v.studio,'Scene presentation and studio options apply in Studio.');
export type WorkspaceViewState = z.infer<typeof workspaceViewStateSchema>;
export const workspaceViewRequestSchema = z.object({
  requestId: z.string().uuid(), projectId: z.string().uuid(), documentId: z.string().uuid(),
  revision: z.number().int().nonnegative(), state: workspaceViewStateSchema, createdAt: z.string(),
  viewerId: z.string().uuid().optional(),
  status: z.enum(['saved','pending','applied','error','cancelled']),
  appliedAt: z.string().optional(), error: z.string().max(2000).optional(),
}).strict();
export type WorkspaceViewRequest = z.infer<typeof workspaceViewRequestSchema>;
export const workspaceViewerSchema = z.object({
  viewerId: z.string().uuid(), projectId: z.string().uuid().optional(), documentId: z.string().uuid().optional(),
  revision: z.number().int().nonnegative().optional(), mode: z.enum(['modeling','studio']).optional(),
  selection: z.array(featureIdSchema).max(MAX_FEATURES).optional(), lastSeenAt: z.string(),
}).strict();
export type WorkspaceViewer = z.infer<typeof workspaceViewerSchema>;
export const workspaceViewResultSchema = z.object({
  request: workspaceViewRequestSchema.optional(), viewers: z.array(workspaceViewerSchema).max(32),
}).strict();
export const workspaceViewPollSchema = z.discriminatedUnion('action',[
  z.object({action:z.literal('poll'),sessionId:z.string().uuid(),viewerId:z.string().uuid(),
    current:workspaceViewerSchema.omit({viewerId:true,lastSeenAt:true}).optional()}).strict(),
  z.object({action:z.literal('ack'),sessionId:z.string().uuid(),viewerId:z.string().uuid(),requestId:z.string().uuid(),
    status:z.enum(['applied','error']),error:z.string().max(2000).optional()}).strict(),
]);
export const studioRenderJobSchema = z.object({
  jobId: z.string().uuid(), state: z.enum(['queued', 'running', 'complete', 'cancelled', 'error']),
  phase: z.enum(['queued', 'preparing', 'compiling', 'rendering', 'finishing', 'complete', 'cancelled', 'error']),
  createdAt: z.string(), expiresAt: z.string(), output: studioImageOutputSchema,
  presentation: presentationSchema, shot: studioShotSchema,
  camera: z.object({ eye: triplet(z.number().finite()), target: triplet(z.number().finite()), up: triplet(z.number().finite()),
    projection: z.enum(['orthographic','perspective']), fovDegrees: z.number().finite().optional(),
    widthMm: z.number().positive(), heightMm: z.number().positive(), mmPerPixel: z.number().positive(), label: z.string(),
  }).strict().optional(),
  width: z.number().int().positive(), height: z.number().int().positive(),
  samples: z.number().int().nonnegative(), targetSamples: z.number().int().positive(),
  elapsedMs: z.number().nonnegative(), etaMs: z.number().nonnegative().optional(),
  renderer: z.literal('three-gpu-pathtracer@0.0.27/WebGPU'),
  error: z.object({code:z.string(),message:z.string()}).strict().optional(),
}).strict();
export type StudioRenderJob = z.infer<typeof studioRenderJobSchema>;

/** Personal Studio camera sequences and the private, authenticated MP4 encoder wire. */
export const studioVideoCameraSchema = z.object({
  position: triplet(z.number().finite().min(-1e9).max(1e9)),
  target: triplet(z.number().finite().min(-1e9).max(1e9)),
  fov: z.number().finite().min(1).max(150),
  focalLengthMm: z.number().finite().min(10).max(300),
}).strict().refine(c => Math.hypot(...c.position.map((v, i) => v - c.target[i])) > 1e-6, 'Camera must be away from its target.');
export type StudioVideoCamera = z.infer<typeof studioVideoCameraSchema>;
export const studioVideoMotionSchema = z.enum(['smooth', 'orbit', 'move', 'cut']);
export const studioVideoEasingSchema = z.enum(['auto', 'linear', 'ease_in', 'ease_out', 'ease_in_out']);
export const studioVideoViewSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(40), camera: studioVideoCameraSchema,
  presentation: presentationSchema,
  motion: studioVideoMotionSchema, seconds: z.number().finite().min(0.5).max(10),
  hold: z.number().finite().min(0).max(5),
  easing: studioVideoEasingSchema.optional(), focus: shotFrameSchema.optional(),
}).strict();
export type StudioVideoView = z.infer<typeof studioVideoViewSchema>;
export const studioVideoSequenceSchema = z.array(studioVideoViewSchema).min(1).max(12)
  .refine(views => new Set(views.map(v => v.id)).size === views.length, 'View IDs must be unique.')
  .refine(views => {
    const duration = views.reduce((n, v, i) => n + v.hold + (i && v.motion !== 'cut' ? v.seconds : 0), 0);
    return duration >= 0.5 && duration <= 20;
  }, 'Video must last between 0.5 and 20 seconds.');
/** Social and film aspect ratios; the short side follows resolution (1080p 9:16 is 1080 x 1920). */
export const VIDEO_ASPECTS = { '16:9': [16, 9], '9:16': [9, 16], '1:1': [1, 1], '4:5': [4, 5] } as const;
export const VIDEO_RESOLUTIONS = { '720p': 720, '1080p': 1080, '4k': 2160 } as const;
export const MAX_VIDEO_SECONDS = 20, MAX_VIDEO_FRAMES = 1200;
export const studioVideoOutputSchema = z.object({
  aspect: z.enum(['16:9', '9:16', '1:1', '4:5']).default('16:9'),
  resolution: z.enum(['720p', '1080p', '4k']).default('1080p'),
  fps: z.union([z.literal(24), z.literal(30), z.literal(60)]).default(30),
  quality: z.enum(['standard', 'high']).default('standard'),
  meshDetail: z.enum(['standard','fine']).optional().describe('Final video tessellation from exact B-reps. Fine is the default; standard uses the ordinary bounded display profile.'),
  depthOfField: z.object({ fStop:z.number().finite().min(1).max(32).default(4) }).strict().optional().describe('Optional final-frame depth of field. Focus follows each keyframe target; omit to keep the full frame sharp.'),
}).strict();
export type StudioVideoOutput = z.infer<typeof studioVideoOutputSchema>;
export function videoOutputSize(output: Pick<StudioVideoOutput, 'aspect' | 'resolution'>): { width: number; height: number } {
  const [w, h] = VIDEO_ASPECTS[output.aspect], short = VIDEO_RESOLUTIONS[output.resolution];
  const even = (n: number) => Math.round(n / 2) * 2;
  return w >= h ? { width: even(short * w / h), height: short } : { width: short, height: even(short * h / w) };
}
export const STUDIO_VIDEO_PRESETS = ['turntable', 'half_orbit', 'push_pull', 'detail_reveal', 'crane'] as const;
/** A keyframe names a semantic shot (framed for the output at render time) or an exact camera. */
export const studioVideoJobSchema = z.object({
  jobId: z.string().uuid(), state: z.enum(['queued', 'running', 'complete', 'cancelled', 'error']),
  phase: z.enum(['queued', 'preparing', 'rendering', 'encoding', 'complete', 'cancelled', 'error']),
  createdAt: z.string(), expiresAt: z.string(), output: studioVideoOutputSchema,
  width: z.number().int().positive(), height: z.number().int().positive(),
  seconds: z.number().nonnegative(), frames: z.number().int().nonnegative(), completedFrames: z.number().int().nonnegative(),
  elapsedMs: z.number().nonnegative(), etaMs: z.number().nonnegative().optional(),
  /** The cameras the recipe resolved to, reusable as exact keyframes after an edit. */
  keyframes: z.array(z.object({ name: z.string(), camera: studioVideoCameraSchema, seconds: z.number(), hold: z.number(), motion: studioVideoMotionSchema,
    easing: studioVideoEasingSchema.optional(), focus: shotFrameSchema.optional() }).strict()).optional(),
  renderer: z.literal('three-webgl/studio'),
  error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
}).strict();
export type StudioVideoJob = z.infer<typeof studioVideoJobSchema>;
export const studioVideoKeyframeSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  shot: studioShotSchema.optional(),
  camera: studioVideoCameraSchema.optional(),
  /** How the camera travels into this keyframe. orbit keeps distance around the target; move goes straight; cut jumps. */
  motion: studioVideoMotionSchema.default('orbit'),
  seconds: z.number().finite().min(0.5).max(10).default(2.5),
  hold: z.number().finite().min(0).max(5).default(0),
  /** Scene overrides at this keyframe; numeric settings blend during travel. */
  presentation: presentationSchema.optional(),
  easing: studioVideoEasingSchema.optional(),
  focalLengthMm: z.number().finite().min(10).max(300).optional(),
  /** Aim at visible feature/component results, a box or a detail sphere. Resolved against the captured model. */
  focus: shotFrameSchema.optional(),
}).strict().refine(k => !!k.shot !== !!k.camera, 'A keyframe has either shot or camera.');
export const studioVideoPresetSchema = z.object({
  name: z.enum(STUDIO_VIDEO_PRESETS),
  /** Starting framing. Default: everything shown, from the front-left three-quarter view. */
  shot: studioShotSchema.optional(),
  /** Close-up target for push_pull, detail_reveal and crane. Default: the centre of the shot. */
  focus: shotFrameSchema.optional(),
  seconds: z.number().finite().min(2).max(MAX_VIDEO_SECONDS).optional(),
  direction: z.enum(['clockwise', 'counterclockwise']).optional(),
}).strict();
export const studioVideoAnimationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('construction'), fromStep: z.number().int().min(1).max(MAX_ASSEMBLY_FEATURES).optional(),
    toStep: z.number().int().min(1).max(MAX_ASSEMBLY_FEATURES).optional() }).strict(),
  z.object({ kind: z.literal('exploded'), offsets: z.array(z.object({ featureId: featureIdSchema, offsetMm: vectorSchema }).strict()).min(1).max(64),
    direction: z.enum(['out', 'in', 'out_and_back']).default('out_and_back') }).strict(),
]);
export type StudioVideoAnimation = z.infer<typeof studioVideoAnimationSchema>;
/** One recipe for agents and people: a preset or up to 12 keyframes, plus output. Saved with the model by set_video. */
export const studioVideoRecipeSchema = z.object({
  preset: studioVideoPresetSchema.optional(),
  keyframes: z.array(studioVideoKeyframeSchema).min(2).max(12).optional(),
  output: studioVideoOutputSchema.optional(),
  animation: studioVideoAnimationSchema.optional(),
}).strict().refine(r => !!r.preset !== !!r.keyframes, 'A video recipe has either preset or keyframes.')
  .refine(r => !r.keyframes || r.keyframes.reduce((n, k, i) => n + k.hold + (i && k.motion !== 'cut' ? k.seconds : 0), 0) <= MAX_VIDEO_SECONDS,
    `Video must last at most ${MAX_VIDEO_SECONDS} seconds.`);
export type StudioVideoRecipe = z.infer<typeof studioVideoRecipeSchema>;
export const studioVideoEncodingSchema = z.object({
  id: z.string().uuid(),
  width: z.number().int().min(256).max(3840).refine(n => n % 2 === 0, 'Video width must be even.'),
  height: z.number().int().min(256).max(3840).refine(n => n % 2 === 0, 'Video height must be even.'),
  fps: z.union([z.literal(24), z.literal(30), z.literal(60)]),
  frames: z.number().int().min(12).max(MAX_VIDEO_FRAMES),
  quality: z.enum(['standard', 'high']).default('standard'),
}).strict();
/** Input form: quality may be omitted and means standard. */
export type StudioVideoEncoding = z.input<typeof studioVideoEncodingSchema>;

/** What each rendered tile actually showed, so a shot can be measured in and repeated after an edit. */
export interface RenderedTile {
  label: string;
  projection: 'orthographic' | 'perspective';
  eye: Vector3; target: Vector3; up: Vector3;
  /** Visible width and height at the target, in mm. */
  widthMm: number; heightMm: number;
  /** Scale at the target: exact for orthographic tiles, at the target depth for perspective ones. */
  mmPerPixel: number;
  fovDegrees?: number;
}
export const editSchema = z.discriminatedUnion('op', [
  z.object({ op:z.literal('appearance'), target:surfaceTargetSchema, regions:z.object({upsert:z.array(paintRegionSchema).max(32).optional(),remove:z.array(featureIdSchema).max(32).optional()}).strict().optional(), set:appearanceFieldSchema.optional(), unset:z.array(z.enum(['material','color','finish','detail','coat','roughness','detailScale','visualMaterial'])).max(8).optional(), replace:appearanceSchema.nullable().optional(), graphics:z.object({upsert:z.array(surfaceGraphicSchema).max(8).optional(),remove:z.array(featureIdSchema).max(8).optional(),order:z.array(featureIdSchema).max(8).optional()}).strict().optional() }).strict(),
  z.object({ op: z.literal('set_presentation'), presentation: presentationSchema.nullable() }).strict(),
  z.object({ op: z.literal('set_video'), video: studioVideoRecipeSchema.nullable() }).strict(),
  z.object({ op: z.literal('add'), before: featureIdSchema.optional(), feature: featureSchema }).strict(),
  z.object({ op: z.literal('update'), feature: featureSchema }).strict(),
  z
    .object({
      op: z.literal('delete'),
      featureIds: z.array(featureIdSchema).min(1).max(MAX_FEATURES),
      cascade: z.boolean(),
    })
    .strict(),
  z
    .object({
      op: z.literal('set_parameter'),
      name: parameterNameSchema,
      value: z.number().finite().min(-100_000).max(100_000),
      description: z.string().min(1).max(200).optional(),
    })
    .strict(),
  z.object({ op: z.literal('delete_parameter'), name: parameterNameSchema }).strict(),
  z
    .object({
      op: z.literal('set_analysis'),
      auto: z.boolean().optional(),
      ground: featureIdSchema.nullable().optional(),
      toleranceMm: z.number().finite().min(0.0001).max(10).optional(),
    })
    .strict(),
  z.object({ op: z.literal('set_check'), check: checkSchema }).strict(),
  z.object({ op: z.literal('delete_check'), id: featureIdSchema }).strict(),
  z.object({op:z.literal('patch'),id:featureIdSchema,params:z.record(z.string(),z.unknown()).optional(),appearance:appearancePatchSchema.optional(),bindings:bindingsSchema.optional(),mounts:z.array(mountSchema).max(32).optional(),label:z.string().min(1).max(120).optional()}).strict().refine(p=>Object.keys(p).some(k=>k!=='op'&&k!=='id'),'A patch must change at least one field.'),
]);
export type Edit = z.infer<typeof editSchema>;
const documentActionFields = {
  extract:['requestId','documentId','expectedRevision','expectedStorageVersion','features','name','projectId','replacement','shared','parameters','componentFrame','incoming','dryRun','planToken'],
  asset:['hash'], list: ['name', 'requestId', 'projectId'], create: ['kind', 'name', 'requestId', 'projectId'],
  duplicate: ['documentId', 'name', 'requestId', 'projectId', 'expectedStorageVersion'], rename: ['documentId', 'name', 'expectedStorageVersion'],
  delete: ['documentId', 'expectedRevision', 'expectedStorageVersion'], open: ['documentId'],
  history: ['documentId'], move: ['documentId', 'projectId', 'expectedStorageVersion'],
  duplicate_project: ['projectId', 'name', 'requestId', 'expectedStorageVersion', 'documentVersions'],
  create_project: ['projectId', 'name', 'requestId'], rename_project: ['projectId', 'name', 'expectedStorageVersion'],
  delete_project: ['projectId', 'expectedStorageVersion', 'documentVersions'], set_main_assembly: ['projectId', 'documentId', 'expectedStorageVersion'],
} as const;
const documentActionRequired = {
  extract:['requestId','documentId','expectedRevision','expectedStorageVersion','features','name'],
  asset:['hash'], list: [], create: [], duplicate: ['documentId'], rename: ['documentId', 'name', 'expectedStorageVersion'],
  delete: ['documentId', 'expectedRevision'], open: ['documentId'], history: ['documentId'],
  move: ['documentId', 'projectId', 'expectedStorageVersion'], create_project: ['name'],
  rename_project: ['projectId', 'name', 'expectedStorageVersion'], delete_project: ['projectId', 'expectedStorageVersion'],
  duplicate_project: ['projectId', 'expectedStorageVersion', 'documentVersions'],
  set_main_assembly: ['projectId', 'expectedStorageVersion'],
} as const;
export const displayRequestSchema = z.object({ expectedRevision: z.number().int().nonnegative(), expectedStorageVersion: z.number().int().positive(), detail: z.enum(['auto','fine','coarse']).optional(), featureIds: z.array(featureIdSchema).max(MAX_FEATURES).optional(), step: z.number().int().min(1).max(MAX_FEATURES).optional() }).strict();
export type DisplayRequest = z.infer<typeof displayRequestSchema>;
export const ENGINE_VERSION = 'vibeworks-geometry-v8-guided-surfaces/replicad-1.1.0/occt-1.1.0';
const uuid = z.string().uuid();
export const intentSchema = z.object({ purpose: z.string().min(1).max(500), rationale: z.string().max(2000).optional() }).strict();
export type OperationIntent = z.infer<typeof intentSchema>;
export const operationContextSchema = z.object({ operationId: uuid, sessionId: uuid.optional(), kind: z.enum(['agent','human','system']), intent: intentSchema.optional() }).strict();
export type OperationContext = z.infer<typeof operationContextSchema>;
export const focusSchema = z.object({ projectId: uuid, documentId: uuid.optional(), featureIds: z.array(featureIdSchema).max(MAX_FEATURES).optional() }).strict();
export const agentSchema = z.object({ agentId: uuid, name: z.string().min(1).max(120), kind: z.enum(['agent','human']), createdAt: z.string(), continuedFrom: uuid.optional() }).strict();
export type AgentIdentity = z.infer<typeof agentSchema>;
export const agentSessionSchema = z.object({lastTarget:focusSchema.optional(),parentAgentId:uuid.optional(),clientInstanceId:uuid.optional(),phase:z.string().max(160).optional(),workState:z.enum(['working','waiting','completed']).optional(), sessionId: uuid, agentId: uuid, client: z.string().min(1).max(80), model: z.string().max(120).optional(), role: z.string().max(120).optional(), task: z.string().max(500).optional(), projectIds: z.array(uuid).max(64), focus: focusSchema.optional(), startedAt: z.string(), lastSeenAt: z.string(), leaseUntil: z.string(), endedAt: z.string().optional(), handoff: z.string().max(8000).optional() }).strict();
export type AgentSession = z.infer<typeof agentSessionSchema>;
const activeWorkSchema=z.object({operationId:uuid,operation:z.string().max(80),documentId:uuid.optional(),projectId:uuid.optional(),featureIds:z.array(featureIdSchema).max(MAX_FEATURES),status:z.enum(['queued','running']),startedAt:z.string()}).strict();
export const participantSchema = z.object({lastAction:z.lazy(()=>activityOperationSchema).optional(), activeWork:z.array(activeWorkSchema).max(32).optional(),identity: agentSchema, session: agentSessionSchema.optional(), connected: z.boolean(), running: z.number().int().nonnegative(), queued: z.number().int().nonnegative() }).strict();
export type Participant = z.infer<typeof participantSchema>;
export const activityOperationSchema = z.object({validationFields:z.array(z.string().max(160)).max(32).optional(), operationId:uuid, sequence:z.number().int().nonnegative(), agentId:uuid.optional(), sessionId:uuid.optional(), kind:z.enum(['agent','human','system']), operation:z.string().max(80), action:z.string().max(80).optional(), affectedProjectIds:z.array(uuid).max(1000).optional(),affectedDocumentIds:z.array(uuid).max(1000).optional(), projectId:uuid.optional(), documentId:uuid.optional(), featureIds:z.array(featureIdSchema).max(MAX_FEATURES), status:z.enum(['queued','running','success','error','unknown']), startedAt:z.string(), completedAt:z.string().optional(), fromVersion:z.number().int().positive().optional(), toVersion:z.number().int().positive().optional(), revision:z.number().int().nonnegative().optional(), commitSequence:z.number().int().positive().optional(), snapshotId:uuid.optional(), intent:intentSchema.optional(), handoff:z.string().max(8000).optional(), error:z.object({code:z.string(),message:z.string()}).strict().optional() }).strict();
export type ActivityOperation = z.infer<typeof activityOperationSchema>;
export const graphSnapshotSchema = z.object({ snapshotId:uuid, documentId:uuid, storageVersion:z.number().int().positive(), revision:z.number().int().nonnegative(), sources:z.array(z.object({documentId:uuid,storageVersion:z.number().int().positive(),revision:z.number().int().nonnegative()}).strict()).max(MAX_REFERENCED_DOCUMENTS), engineVersion:z.string().max(200), cursor:z.number().int().nonnegative(), createdAt:z.string() }).strict();
export type GraphSnapshot = z.infer<typeof graphSnapshotSchema>;
export const reviewRequestSchema=z.object({
  compareTo:z.string().uuid().optional(),
  sections:z.array(z.object({axis:z.enum(['X','Y','Z']),offset:coordinate}).strict()).min(1).max(16).optional(),
  profiles:z.array(z.object({featureId:featureIdSchema,sectionIndex:z.number().int().min(0).max(11).optional()}).strict()).min(1).max(4).optional(),
}).strict();
export const reviewTotalsSchema=z.object({
  min:triplet(z.number().finite()),max:triplet(z.number().finite()),size:triplet(z.number().finite().nonnegative()),
  sumVisibleVolumesMm3:z.number().finite().nonnegative(),solids:z.number().int().nonnegative(),valid:z.boolean(),
}).strict();
export const reviewEvidenceSchema=z.object({
  snapshot:graphSnapshotSchema,totals:reviewTotalsSchema,notes:z.array(z.string()).max(12),
  comparison:z.object({snapshotId:z.string().uuid(),revision:z.number().int().nonnegative(),before:reviewTotalsSchema,
    sizeDeltaMm:triplet(z.number().finite()),visibleVolumeDeltaMm3:z.number().finite(),
    visibleAdded:z.array(featureIdSchema).max(MAX_FEATURES),visibleRemoved:z.array(featureIdSchema).max(MAX_FEATURES),
  }).strict().optional(),
}).strict();
export type ReviewEvidence=z.infer<typeof reviewEvidenceSchema>;
export const renderedTileSchema=z.object({
  label:z.string().min(1).max(80),projection:z.enum(['orthographic','perspective']),
  eye:triplet(z.number().finite()),target:triplet(z.number().finite()),up:triplet(z.number().finite()),
  widthMm:z.number().finite().positive(),heightMm:z.number().finite().positive(),mmPerPixel:z.number().finite().positive(),
  fovDegrees:z.number().finite().positive().optional(),
}).strict();
export interface RenderedPNG {
  kind:'view'|'profile'|'baseline';label:string;mimeType:'image/png';base64:string;width:number;height:number;
  featureId?:string;sectionIndex?:number;tiles?:RenderedTile[];
}
export const renderedPNGSchema:z.ZodType<RenderedPNG>=z.object({
  kind:z.enum(['view','profile','baseline']),label:z.string().min(1).max(160),mimeType:z.literal('image/png'),
  base64:z.string().max(32*1024*1024),width:z.number().int().positive().max(5376),height:z.number().int().positive().max(5376),
  featureId:featureIdSchema.optional(),sectionIndex:z.number().int().min(0).max(11).optional(),
  tiles:z.array(renderedTileSchema).min(1).max(MAX_RENDER_VIEWS).optional(),
}).strict();
export const snapshotRequestSchema = z.object({ reevaluate:z.literal(true).optional(), id:uuid.optional(), sequence:z.number().int().nonnegative().optional() }).strict().refine(p=>!p.id || p.sequence===undefined,'Use a snapshot id or a change sequence.');
export const frozenGraphSchema = z.object({ snapshot:graphSnapshotSchema, document:documentSchema, documents:z.array(documentSchema).max(MAX_REFERENCED_DOCUMENTS) }).strict();
export type FrozenGraph = z.infer<typeof frozenGraphSchema>;
export const rejectedAttemptSchema=z.object({requestId:uuid,sessionId:uuid,operation:z.string().min(1).max(80),documentId:uuid.optional(),code:z.literal('INVALID_COMMAND'),message:z.string().min(1).max(2000),fields:z.array(z.string().max(160)).max(32)}).strict();
export type RejectedAttempt=z.infer<typeof rejectedAttemptSchema>;
export const commandEnvelopeSchema = z.object({ requestId:uuid,command:z.unknown(),sessionId:uuid.optional(),intent:intentSchema.optional(),passive:z.boolean().optional() }).strict();

export const surfacePickSchema = z.object({documentId:z.string().uuid(),revision:z.number().int().nonnegative(),storageVersion:z.number().int().positive(),displayKey:z.string().regex(/^[a-f0-9]{64}$/),feature:featureIdSchema,path:z.array(featureIdSchema).max(64),faceIndex:z.number().int().nonnegative(),point:outputVectorSchema,normal:outputVectorSchema}).strict();
export type SurfacePick = z.infer<typeof surfacePickSchema>;
export const inspectionSelectSchema = z.object({
  appearanceMode:z.enum(['authored','studio']).optional(),
  features: z.object({ ids:z.array(featureIdSchema).max(MAX_FEATURES).optional(), kinds:z.array(z.string()).max(32).optional(), fields:z.array(z.enum(['kind','label','params','appearance','bindings','mounts','inputs','dependents','visible'])).max(9).optional() }).strict().optional(),
  diff:z.object({fromSnapshot:z.string().uuid()}).strict().optional(),
  topology:z.object({near:z.object({point:vectorSchema,toleranceMm:z.number().positive().max(1000)}).strict().optional(),edges:z.object({names:z.array(z.string().max(512)).max(64).optional(),query:edgeSelection.optional()}).strict().optional(),target:z.object({feature:featureIdSchema,path:z.array(featureIdSchema).max(64).optional()}).strict(), faces:z.union([z.object({names:z.array(z.string().max(512)).max(64)}).strict(),z.object({pick:surfacePickSchema}).strict()]).optional()}).strict().optional(),
  assets:z.boolean().optional(),occurrences:z.boolean().optional(),dependencies:z.boolean().optional(),
  references:z.object({sources:z.boolean().optional(),incoming:z.boolean().optional()}).strict().optional(),
}).strict();
export type InspectionSelect=z.infer<typeof inspectionSelectSchema>;
export const commandSchemas = {
  workspace_view: z.discriminatedUnion('action',[
    z.object({action:z.literal('get'),sessionId:z.string().uuid().optional(),projectId:z.string().uuid().optional()}).strict(),
    z.object({action:z.literal('present'),sessionId:z.string().uuid().optional(),requestId:z.string().uuid().optional(),
      viewerId:z.string().uuid().optional(),documentId:z.string().uuid(),expectedRevision:z.number().int().nonnegative().optional(),
      state:workspaceViewStateSchema}).strict(),
    ...(['status','cancel'] as const).map(action => z.object({action:z.literal(action),sessionId:z.string().uuid().optional(),requestId:z.string().uuid()}).strict()),
  ]),
  agent_session: z.object({action:z.enum(['join','resume','heartbeat','update','handoff','leave']),agent:z.string().max(120).optional(),kind:z.enum(['agent','human']).optional(),client:z.string().min(1).max(80).optional(),model:z.string().max(120).optional(),role:z.string().max(120).optional(),task:z.string().max(500).optional(),projectIds:z.array(uuid).max(64).optional(),focus:focusSchema.optional(),parentAgentId:uuid.optional(),clientInstanceId:uuid.optional(),phase:z.string().max(160).optional(),workState:z.enum(['working','waiting','completed']).optional(),sessionId:uuid.optional(),handoff:z.string().max(8000).optional(),continuedFrom:z.string().max(120).optional()}).strict(),
  describe:z.object({tool:z.enum(['workspace_view','agent_session','activity','describe','apply_edits','select_features','inspect_model','analyze_model','documents','render_views','render_image','render_video','export_model','document_action']),kind:z.enum(['box','cylinder','rod','instance','extrude','fill','join','loft','sweep','shell','revolve','union','subtract','intersect','fillet','chamfer','transform','mirror','pattern','text','drill_holes']).optional(),action:z.string().max(80).optional(),sessionId:uuid.optional()}).strict(),
  activity: z.object({sessionId:uuid.optional(),projectId:uuid.optional(),documentId:uuid.optional(),agentId:uuid.optional(),after:z.number().int().nonnegative().optional(),before:z.number().int().positive().optional(),limit:z.number().int().min(1).max(100).optional(),changesOnly:z.boolean().optional()}).strict(),
  apply_edits: z
    .object({
      ...context,
      edits: z.array(editSchema).min(1).max(MAX_FEATURES),
      intent:intentSchema.optional(),
      select: z.array(featureIdSchema).max(MAX_FEATURES).optional(),
      dryRun: z.boolean().optional(),
      /** Override the document's automatic analysis for this call: true runs it, false skips it. */
      analyze: z.boolean().optional(),
      review:z.object({
        ...reviewRequestSchema.shape,shots:z.array(shotSchema).min(1).max(MAX_SHOTS).optional(),
        tileSize:z.number().int().min(128).max(768).optional(),appearance:z.enum(['parts','materials','issues']).optional(),
      }).strict().optional(),
    })
    .strict().refine(p=>!p.dryRun||!p.review,'Post-commit review is unavailable in a dry run. Commit once, or use render_views for the current model.'),
  select_features: z.object({ ...context, featureIds: z.array(featureIdSchema).max(MAX_FEATURES).default([]),selection:z.array(z.object({feature:featureIdSchema,path:z.array(featureIdSchema).max(64).optional(),faces:z.array(z.string().max(512)).max(64).optional()}).strict()).max(64).optional() }).strict(),
  inspect_model: z
    .object({detail:z.enum(['compact','full']).optional(),page:z.object({cursor:z.string().max(16384).optional(),limit:z.number().int().min(1).max(1000).optional()}).strict().optional(),select:inspectionSelectSchema.optional(),budgetBytes:z.number().int().min(1024).max(262144).optional(),sessionId:uuid.optional(),include:z.array(z.enum(['parameters','features','geometry','mounts','health','references','history','analysis'])).min(1).max(8).optional(), documentId: z.string().uuid().optional(), snapshot: snapshotRequestSchema.optional(), featureId: featureIdSchema.optional(), definitionsOnly: z.boolean().optional(), display: displayRequestSchema.optional(),
      /** One exact, view-only current-construction frame. Versions pin a single observed source graph. */
      replay: z.object({ detail:z.enum(['auto','fine','coarse']).optional(),step: z.number().int().min(1).max(MAX_ASSEMBLY_FEATURES), expectedRevision: z.number().int().nonnegative(), expectedStorageVersion: z.number().int().positive(), key: z.string().min(1).max(8192).optional() }).strict().optional(),
      /** Exact cross-sections of featureId's result, or of every visible result. */
      sections: z.array(z.object({ axis: axisSchema, offset: coordinate }).strict()).min(1).max(16).optional(),
    }).refine(p => !p.sections || (!p.definitionsOnly && !p.display && !p.replay && !p.snapshot), 'sections measure the current model; they cannot combine definitionsOnly, display, replay or snapshot.').refine(p=>!p.display || (!!p.documentId && !p.definitionsOnly && !p.featureId),'Display projection requires documentId and cannot combine definitionsOnly or featureId.').refine(p => !p.replay || (!!p.documentId && !p.featureId && !p.definitionsOnly && !p.display), 'Replay requires documentId and cannot combine featureId or definitionsOnly.')
    .strict(),
  analyze_model: z
    .object({
      action:z.enum(['run','status','result','cancel']).optional(), jobId:z.string().uuid().optional(), waitMs:z.number().int().min(0).max(20000).optional(), snapshot:snapshotRequestSchema.optional(), page:z.object({cursor:z.string().max(512).optional(),limit:z.number().int().min(1).max(1000).optional()}).strict().optional(),
      sessionId:uuid.optional(),
      documentId: z.string().uuid().optional(),
      featureIds: z.array(featureIdSchema).min(1).max(MAX_FEATURES).optional(),
    })
    .strict(),
  documents: z
    .object({
      action: z.enum(['extract','asset', 'list', 'create', 'duplicate', 'rename', 'delete', 'open', 'history', 'move', 'create_project', 'duplicate_project', 'rename_project', 'delete_project', 'set_main_assembly']),
      features:z.array(featureIdSchema).min(1).max(MAX_FEATURES).optional(),replacement:z.enum(['single','per_result']).optional(),shared:z.union([z.enum(['error','copy']),z.record(featureIdSchema,z.literal('copy'))]).optional(),parameters:z.union([z.enum(['error','copy']),z.record(z.string(),z.enum(['copy','move']))]).optional(),componentFrame:z.union([z.object({mount:z.object({featureId:featureIdSchema,name:mountNameSchema}).strict()}).strict(),z.object({frame:frameSchema}).strict()]).optional(),incoming:z.enum(['error','remap']).optional(),dryRun:z.boolean().optional(),planToken:z.string().max(128).optional(),
      hash:z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
      documentVersions: z.record(z.string().uuid(), z.number().int().positive()).optional(),
      projectId: z.string().uuid('projectId must be a UUID. For create_project, omit it and put the human-readable title in name.').optional(),
      expectedStorageVersion: z.number().int().positive().optional(),
      kind: z.enum(['part', 'assembly']).optional(),
      sessionId:uuid.optional(),
      documentId: z.string().uuid().optional(),
      name: z.string().min(1).max(120).optional(),
      expectedRevision: z.number().int().nonnegative().optional(),
      requestId: z.string().uuid().optional(),
    })
    .strict().superRefine((params, ctx) => {
      const fields: readonly string[] = documentActionFields[params.action];
      for (const key of Object.keys(params)) if (key !== 'action' && key!=='sessionId' && !fields.includes(key))
        ctx.addIssue({ code: 'custom', path: [key], message: `documents ${params.action} does not accept ${key}. Remove it; accepted fields: ${fields.join(', ')}.` });
      const required = documentActionRequired[params.action];
      for (const key of required) if (params[key as keyof typeof params] === undefined)
        ctx.addIssue({ code: 'custom', path: [key], message: `documents ${params.action} requires ${key}.` });
    }),
  render_image: z.discriminatedUnion('action', [
    z.object({ action: z.literal('start'), requestId: uuid, sessionId: uuid.optional(),
      documentId: uuid, expectedRevision: z.number().int().nonnegative().optional(),
      expectedStorageVersion: z.number().int().positive().optional(),
      shot: studioShotSchema.optional(), output: studioImageOutputSchema.optional(),
      presentation: presentationSchema.optional(), skipAnalysis: z.boolean().optional(),
    }).strict(),
    ...(['status', 'result', 'cancel'] as const).map(action => z.object({action:z.literal(action),jobId:uuid,sessionId:uuid.optional()}).strict()),
  ]),
  render_video: z.discriminatedUnion('action', [
    z.object({ action: z.literal('start'), requestId: uuid, sessionId: uuid.optional(),
      documentId: uuid, expectedRevision: z.number().int().nonnegative().optional(),
      expectedStorageVersion: z.number().int().positive().optional(),
      video: studioVideoRecipeSchema.optional(), output: studioVideoOutputSchema.partial().optional(),
      presentation: presentationSchema.optional(), skipAnalysis: z.boolean().optional(),
    }).strict(),
    ...(['status', 'result', 'cancel'] as const).map(action => z.object({action:z.literal(action),jobId:uuid,sessionId:uuid.optional()}).strict()),
  ]),
  render_views: z
    .object({
      sessionId:uuid.optional(),
      documentId: z.string().uuid().optional(),
      featureId: featureIdSchema.optional(),
      views: z.array(viewNameSchema).min(1).max(MAX_RENDER_VIEWS).optional(),
      shots: z.array(shotSchema).min(1).max(MAX_SHOTS).optional(),
      tileSize: z.number().int().min(128).max(768).optional(),
      /** parts: one distinct color per visible solid with a legend (default with several parts); materials: realistic materials. */
      appearance: z.enum(['parts', 'materials', 'issues']).optional(),
      presentation: presentationSchema.optional(),
      skipAnalysis: z.boolean().optional(),
      /** Clip the rendered model to look inside: keeps material at or below offset on the axis (above it when flip). Display only. */
      section: sectionSchema.optional(),
      outputs:z.enum(['sheet','both']).optional(),
      review:reviewRequestSchema.optional(),
    })
    .strict().refine(p => !(p.views && p.shots), 'Use views for named whole-model tiles or shots for chosen cameras, not both.'),
  export_model: z
    .object({
      sessionId:uuid.optional(),
      documentId: z.string().uuid().optional(),
      format: z.enum(['step', 'stl', 'json', 'glb']),
      look:z.enum(['authored','studio']).optional(),
      skipAnalysis: z.boolean().optional(),
      featureId: featureIdSchema.optional(),
      filename: z
        .string()
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/)
        .optional(),
    })
    .strict(),
  document_action: z
    .object({
      ...context,
      action: z.enum(['undo', 'redo', 'save', 'reset', 'load','undo_operation','redo_operation']),operationId:z.string().uuid().optional(),
      analyze: z.boolean().optional(),
      document: documentSchema.optional(),
    })
    .strict(),
} as const;
export type CommandName = keyof typeof commandSchemas;
export type CadCommand = {
  [K in CommandName]: { type: K; params: z.infer<(typeof commandSchemas)[K]> };
}[CommandName];

export type CommandEffect = 'read' | 'edit';

export function withCreationRequestId(command: CadCommand): CadCommand {
  if(command.type==='workspace_view'&&command.params.action==='present')
    return {...command,params:{...command.params,requestId:command.params.requestId??crypto.randomUUID()}};
  if (command.type === 'documents' && command.params.action === 'create_project') {
    const projectId = command.params.projectId ?? command.params.requestId ?? crypto.randomUUID();
    return {...command,params:{...command.params,projectId,requestId:command.params.requestId ?? projectId}};
  }
  return command.type === 'documents' && ['create', 'duplicate', 'duplicate_project'].includes(command.params.action)
    ? { ...command, params: { ...command.params, requestId: command.params.requestId ?? crypto.randomUUID() } }
    : command;
}

/** Creation identity can still be reconciled if unrelated receipt fields are rejected. */
export function knownCreatedDocumentId(command: CadCommand, value: unknown): string | undefined {
  if (command.type !== 'documents' || !['create', 'duplicate','extract'].includes(command.params.action)) return;
  if(command.params.dryRun)return;
  const identity = z.object({ operation: z.literal('documents'), createdDocumentId: z.string().uuid() }).safeParse(value);
  return identity.success ? identity.data.createdDocumentId : undefined;
}
/**
 * One catalog for every adapter: MCP tool descriptions, CLI help and the bridge's
 * outcome-unknown rule all read from here.
 */
export const commandInfo: Record<CommandName, { effect: CommandEffect; description: string }> = {
  workspace_view: {effect:'edit',description:`Read or prepare the human workspace without changing geometry, revisions or undo.
get lists live viewers and the latest saved request (optional projectId). present {documentId,state,viewerId?,requestId?,expectedRevision?}
saves a view for the only live viewer or an explicit viewerId. No viewer: saved for the next viewer. Multiple viewers: choose viewerId.
state:{mode:'modeling'|'studio',panes:[shot] (1–4),layout:'grid'|'columns'|'rows',selection:[ids],isolate?:[ids],presentation?,
studio?:{output?,panel?,views?,layout?,labels?}}. Cameras are render_views shots. Studio has one preview pane.
status/cancel use requestId. saved/pending is not proof of display; applied means the viewer acknowledged that exact request.
error means the viewer could not apply it. Use when the user asks to show or control their workspace.
Example: {action:'present',documentId:'UUID',state:{panes:[{view:'top'}],selection:['halo'],isolate:['halo']}}.`},
  describe:{effect:'read',description:'Focused, read-only tool help. Pass tool and optional feature kind or documents action. Returns strict schema, examples and limits. Use this instead of inventing help edits. No enrollment or geometry required.'},
  agent_session: {effect:'edit',description:'Register before CAD work. join creates a generated readable agent name and UUID; client is required. resume takes agent name/UUID and creates a new session after the old session ends/expires. The MCP adapter binds the returned session automatically; CLI uses --session or VIBEWORKS_AGENT_SESSION. heartbeat renews presence; update declares task/projectIds/focus; handoff records concise decisions and unfinished work; leave ends this session. A name is continuity, not authentication or inherited model memory. Separate agents may edit the same document.'},
  activity: {effect:'read',description:'Query registered participants and durable attributed work, filtered by projectId/documentId/agentId. limit defaults to 50. after/before paginate sequence changes; changesOnly returns committed edits. Operations distinguish reported intent, queued/running work, errors and unknown delivery. Snapshot IDs inspect historical definitions via inspect_model snapshot:{id}; snapshot:{sequence} reconstructs a graph as of a commit sequence. Unknown legacy authorship stays unknown.'},
  apply_edits: {
    effect: 'edit',
    description: `Use describe {tool:'apply_edits',kind:'pattern'} for focused syntax and limits. add.before inserts in history. patch {id,params?,appearance?,bindings?,mounts?,label?} merges top-level params and preserves omitted metadata. Rigid rotation/twist normalizes multi-turn degrees; revolve remains 0.1–360.
Apply an ordered batch atomically: one revision, rebuild and undo step. Requires current
documentId/expectedRevision. Later edits may reference earlier additions. A rejected batch preserves the
committed model; transport outcomeUnknown requires inspection. Read health/nextSteps after each batch.
review:{shots?,tileSize?,appearance?,compareTo?:snapshotId,sections?,profiles?} adds post-commit evidence (see render_views).
reviewFailure means the edit committed; retry render_views, never the edit.
Edits: add/update {feature}; delete {featureIds,cascade}; set_parameter {name,value,description?};
delete_parameter {name}; set_presentation {presentation:{preset?,exposure?,environment?,keyIntensity?,lightRotation?,background?,shadows?}|null}; set_video {video:{preset|keyframes,output?}|null} saves the Studio camera move render_video uses by default; set_analysis {auto?,ground?,toleranceMm?}; set_check
{check:{id,a,b,expect:'contact'|'clearance'|'no_interference'|'overlap',minGapMm?,note?}} or a design target
{check:{id,a?,note?,expect:'size',axis,mm,toleranceMm} | expect:'within',min,max | expect:'section',axis,
offset,widthMm?,heightMm?,toleranceMm} measuring feature a's exact result or, without a, the whole model;
delete_check {id}. Each includes op. update replaces the entire feature, retaining id/kind. cascade:true deletes
dependents. ground:null restores automatic ground selection.
Feature: {id,kind,label?,params,bindings?,appearance?,mounts?}. Params use mm, degrees and world Z up:
box {origin,size}: minimum XYZ corner and XYZ size;
cylinder {origin,radius,height}: bottom center, +Z;
instance {document,featureId?,translation,rotationAxis,angleDegrees,origin,attachment?}: places another
document's visible results (all of them as one part without featureId); rotates about origin, then
translates; no scale; follows the source's latest committed revision. Attach to named mounts with
attachment; describe kind:'instance' gives limits, attachment rules and errors. appearance overrides inherited fields;
rod {from,to,radius}: flat-ended circular solid between world endpoint centers, length 0.01–10000;
extrude {profile,plane,origin,distance}: profile {type:'rectangle',width,height} or
{type:'circle',radius}, centered on origin, or {type:'polygon',points:[[u,v],...]} with 3–64 vertices,
automatically closed. Also {type:'ellipse',radiusX,radiusY} and {type:'path',start:[u,v],segments}.
Segments: {type:'line',to}, {type:'arc',via,to}, {type:'bezier',controls:[one or two UV points],to}.
Bezier curves are exact quadratic/cubic splines; a missing closing edge is a line. Max 32 segments.
Plane XY extrudes +Z, XZ -Y, YZ +X, or plane:{normal,xDirection} at origin. Directions must be
perpendicular and are normalized. Frame = {origin,normal,xDirection}; V = normal cross U;
loft {sections:[{profile,frame},...],ruled}: 2–12 ordered sections, ruled:false for smooth OCCT surfaces;
guides:[{vertex,path}] adds authored rail boundaries; describe the loft schema for constraints and tolerances.
sweep {profile,path:{frame,start,segments},endScale?}: open planar path with actual kernel curves. Profile U is
path-plane normal, at path start, perpendicular to initial tangent; corrected Frenet transport. Or
path:{points:[[x,y,z],...]}: an exact smooth 3D spline through 2–64 points, profile U default Z. profileX
overrides profile U on either path. endScale scales the section linearly to the path end;
shell {target,thickness,removeFaces:[{point,normal,toleranceMm,expectedCount}]}: inward positive thickness,
one input solid, 1–8 planar queries. Remove every face on each plane regardless of normal sign. Exact
expectedCount 1–16 per query; missing/ambiguous/overlapping queries fail. No stable face indices;
revolve {points:[[radius,height],...],origin,angleDegrees}: closed polygon, nonnegative radii, 0.1–360
degrees about world Z;
subtract/union/intersect {target,tools:[ids]}: Boolean difference/fusion/common volume;
fillet {target,radius,edges}; chamfer {target,distance,edges}: edges 'all', 'vertical' or
{parallel?:'X'|'Y'|'Z',on?:{axis,value},near?:[[x,y,z],...],between?:[idA,idB],toleranceMm?,curve?:'line'|'circle'|'any',minLengthMm?,maxLengthMm?}.
Criteria all apply; near defaults to 0.5 mm. between selects a united-input seam. Failed blends report individual edge viability. Queries re-resolve each rebuild;
transform {target,translation,rotationAxis,angleDegrees,origin,scale,copy}: scale and rotate about
origin, then translate;
mirror {target,plane:'XY'|'XZ'|'YZ',origin,copy};
drill_holes {target,centers:[[x,y,z],...],diameter,axis:'X'|'Y'|'Z'}: up to 32 through-holes; coordinate
along axis ignored;
pattern {target,layout:{type:'linear',direction,spacing,count} |
{type:'circular',axis,origin,count,angleDegrees}}: includes the original, one compound, not fused. Counts
2–64 linear or 2–360 circular; 360 degrees excludes a duplicate endpoint. Union or subtract the whole
pattern;
text {text,plane,origin,size,depth,target?,mode?:'engrave'|'emboss'}: printable ASCII up to 80
characters, size is font size. origin centers text on the face; plane normals as for extrude. Without
target, raised letters; with target, engrave by default or emboss.
mounts:[{name,frame}] adds up to 32 named static frames on a feature; derived results inherit them and
geometry.mounts lists resolved frames.
Operations consume geometry inputs but keep them editable; attachment targets and copy:true sources stay
visible. bindings
map numeric params paths to parameter expressions, e.g. {"size.2":"thickness"}. Keep bindings on update
to keep them; changing a bound number without dropping its binding fails BINDING_CONFLICT.
Appearance: {material?,color?:'#rrggbb',finish?}. Materials: ${MATERIAL_IDS.join(', ')}. Finishes: ${FINISHES.join(', ')}.
appearance.detail accepts plain/carbon/rubber/brushed. appearance.graphics holds up to eight printed text or embedded PNG/static SVG projections, independent of exact geometry and mass. describe returns their typed placement and content schema. Anchors follow local result bounds; depth and maxAngle clip the projection. Tight curves may distort artwork. Edit the source part to place graphics on an instance.
set_presentation saves environment, lighting, floor, background and display-only material looks; null resets them. Use describe for fields and limits. render_views materials uses saved settings with optional presentation overrides. GLB includes graphics and roughness textures; STEP/STL omit printed graphics. Fonts are sans/serif/mono system families and may differ across hosts.
Derived results inherit the target's appearance unless overridden; mass uses exact volume and material
density.
select sets client selection. dryRun:true evaluates without committing. analyze:false skips analysis for an
intermediate batch, analyze:true forces it. Overlap checks require a note. Finish with complete
whole-document analysis and render_views appearance:'issues'.`,
  },

  select_features: {
    effect: 'edit',
    description: `Validate featureIds for this command client; [] clears it. Browser clients retain selection locally. Headless selection never selects or opens a human viewer. Requires current documentId/expectedRevision. Does
not change revision, geometry or undo history.`,
  },
  documents: {
    effect: 'edit',
    description: `Extract selected visible results with action:'extract', requestId, documentId, expectedRevision, expectedStorageVersion, features and name. Preview with dryRun:true, then apply the same arguments with its planToken. Explicit shared/parameters:'copy' allows shared dependencies; incoming:'remap' rewrites incoming paths. Keep requestId for persistent receipt recovery through list {requestId}. Extraction preserves coordinates, paint and assets; undo_operation/redo_operation restore all affected documents atomically.
Manage part and assembly documents. create accepts kind:'part'|'assembly' (default part); build parts
separately, then place them in an assembly with instance features through apply_edits. List, create,
duplicate, rename, delete or open workspace documents. Each has its own revision, parameters, checks and
undo history. Read/edit a specific document by passing documentId to the other tools; omitted read
context uses the startup document headlessly or the requesting browser's local active document. list returns summaries. create {name?,kind?}
returns an empty document at revision 0; kind is accepted only for create. duplicate {documentId,name?,expectedStorageVersion?}
copies the feature document at revision 0, retaining instance references; rename {documentId,name,expectedStorageVersion} keeps
revision; delete {documentId,expectedRevision} cannot remove the last document (LAST_DOCUMENT); open
{documentId} opens only the requesting browser client. Headless open validates/loads the document but does not change implicit read context or any human view. Use explicit documentIds. Creating or duplicating leaves client views unchanged. Deleting a part that an assembly instances fails with DOCUMENT_IN_USE and lists
referencingDocuments with documentId, name and featureIds. A broken source refresh marks the assembly
stale; render/geometry export fail ASSEMBLY_STALE until the instance is repaired.
Storage is bridge-owned SQLite. Listing/history never require geometry; use inspect_model definitionsOnly:true and JSON export skipAnalysis:true for recovery. list returns projects and indexed summaries; optional projectId, exact name or requestId filters.
duplicate_project {projectId,expectedStorageVersion,documentVersions,name?,requestId?} atomically copies a whole project. documentVersions must match every source document. New projectId equals requestId; duplication returns documentIds (old to new) and externalDocumentIds. Internal references and main assembly map to copies; outside references stay shared. Copies start at revision 0 with empty undo history. Retry identical arguments with the same requestId to recover the mapping, including after restart. list returns projects; find the new project by projectId equal to requestId.
create/duplicate accept projectId. create_project {name,projectId?:UUID,requestId?:UUID} allocates an ID when omitted and returns createdProjectId. Keep that ID to reconcile a lost reply with list {projectId}; do not create another identity. rename_project {projectId,name,expectedStorageVersion},
delete_project {projectId,expectedStorageVersion,documentVersions?} (include the exact documentId:storageVersion map to delete contents atomically; outside references block deletion), set_main_assembly {projectId,documentId?,expectedStorageVersion}
(omit documentId to clear), move {documentId,projectId,expectedStorageVersion}, history {documentId} returns the latest 40 audit entries.
Project expectedStorageVersion is the project's version; document expectedStorageVersion is storageVersion, distinct from geometry revision.
Metadata updates require this version. All model writes compare storage versions atomically and return STORAGE_CONFLICT on stale writes.
Undo/redo stacks survive reload, bounded to 40 each; audit snapshots are append-only. Active document and selection are client-local.
Only the fields listed for each action are accepted.
For create/duplicate, supply a UUID requestId before sending and keep it for recovery. The same requestId
and original arguments recover the same document across bridge/runtime restarts, while it remains stored.
Different arguments fail REQUEST_ID_CONFLICT. A receipt includes requestId and createdDocumentId.
After outcomeUnknown, use list {requestId} (or exact name), then inspect the returned documentId before
retrying. Never create under a new requestId just because a reply was lost.`,
  },
  inspect_model: {
    effect: 'read',
    description: `definitionsOnly:true reads saved feature definitions and history without evaluating geometry, for recovery. Optional display:{expectedRevision,expectedStorageVersion,detail:'auto'|'fine'|'coarse',featureIds?,step?} requests only a view projection, with hidden features or one root construction step. Auto reduces tessellation if needed; exact geometry is unchanged. Optional replay:{step,expectedRevision,expectedStorageVersion,key?} returns one exact current-construction frame and a bounded nested timeline. Pass the returned key for subsequent frames; changed roots/sources reject it. Repeated instances build separately in their final placements. This read never changes the model. Start here with {} to discover the startup document and workspace documents. Optional documentId targets
another document; featureId inspects one feature, including hidden inputs. Returns compact definitions by default with a 24 KiB budget. detail:full opts into editable definitions; select requests topology, occurrences, references, diffs, assets or appearance origins. Returns
parameters, bindings, client selection, visible result ids, exact bounds/volume, material-derived mass,
sections:[{axis,offset}] (up to 16) cut featureId's result or every visible result exactly and return
in-plane widthMm/heightMm and bounds (X cuts are Y wide by Z high, Y cuts X by Z, Z cuts X by Y),
kernel validation, geometry.mounts with resolved attachment frames, health/nextSteps and limits. Routine receipts omit this detail. Inspect after
REVISION_CONFLICT or outcomeUnknown before editing again.`,
  },
  render_image: { effect: 'read', description: `Final Studio PNG using the same WebGPU path tracer and guided denoiser as the browser. No human tab required. start requires documentId and a UUID requestId (also the jobId); identical retries reuse the job, different inputs with that id fail. Capture committed geometry/source revisions and saved presentation plus optional overrides. Optional shot uses render_views framing, hide, projection and fovDegrees, without section/ghost overlays. output:{size:'hd'|'qhd'|'uhd'|'square'|'portrait',quality:'draft'|'standard'|'high',denoise:boolean}; defaults HD/Standard/denoise on. start promptly freezes the committed definition graph. Exact Node preparation and analysis run inside the image job before tracing. status returns progress; result returns the completed PNG as MCP image and saved artifact; cancel stops queued/running work. Calls use action plus jobId after start, without document context. One running and one queued image; ten-minute job deadline including queue, fifteen-minute retention, eight retained jobs and 64 MiB encoded image budget. Jobs are local to this bridge lifetime. Later edits never alter a captured job. A final image is visual evidence, not a geometry/analysis certificate. No raster fallback if WebGPU/denoising fails.` },
  render_video: { effect: 'read', description: `Studio MP4 of the committed model with a moving camera, rendered by the managed renderer. No human tab required. start requires documentId and a UUID requestId (also the jobId); identical retries reuse the job. video is a recipe: either preset:{name:'turntable'|'half_orbit'|'push_pull'|'detail_reveal'|'crane',shot?,focus?,seconds?,direction?} or keyframes:[{shot|camera,motion:'orbit'|'move'|'cut',seconds,hold,presentation?}] (2-12). shot uses render_views framing (view/from, frame featureIds|box|sphere, fovDegrees) and is framed for the output aspect at render time; focus names what push_pull, detail_reveal and crane move in on. Omit video to use the recipe saved with set_video, else a turntable. output:{aspect:'16:9'|'9:16'|'1:1'|'4:5',resolution:'720p'|'1080p'|'4k',fps:24|30|60,quality:'standard'|'high'}; defaults 16:9 1080p 30 fps standard, overriding the saved output field by field. Up to ${MAX_VIDEO_SECONDS} s and ${MAX_VIDEO_FRAMES} frames. Uses saved presentation plus overrides; per-keyframe presentation blends numeric settings while the camera travels. status returns progress; result saves the MP4 as an artifact, returns its path and a poster frame as an MCP image, and lists the resolved camera keyframes so a move can be repeated exactly after an edit. cancel stops queued/running work. One running and one queued video; twenty-minute deadline including queue. Later edits never alter a captured job. Studio raster rendering (same look as the live Studio preview); not a geometry certificate.` },
  analyze_model: {effect:'read',description:`Durable exact leaf-solid analysis. run (default) pins the complete source graph and settings, starts once and advances automatically. Returns analysisJob.id, state, current and progress. status/result/cancel accept jobId; waitMs is bounded to 20000; page.limit bounds findings and page.cursor continues a pinned job. A restart resumes queued/running jobs; cancel persists. New commits supersede current jobs. snapshot explicitly inspects a historical graph without certifying the current graph. Leaf identities include feature, occurrence path, source and solidIndex. Compounds and patterns reveal internal relationships. Broad-phase bounds only rule out contact/interference; reported nearest distances and clearance remain exact. Unknown/timeouts and partial or stale jobs block health.ok. One bounded background Node worker; each native pair gets a deadline and at most one late isolated retry. Facts survive restart and are reused by complete construction and relative placement. Checks accept legacy feature strings or {feature,path?,solidIndex?}. Inspect expensive pairs through analysisJob.expensive. Rendering is review evidence, never human approval.`},
  render_views: {
    effect: 'read',
    description: `Look at a PNG contact sheet from the managed headless renderer, using authoritative Node meshes. No human tab is needed. Default views: front, back, left, right, top,
isometric; bottom, dimetric, trimetric and all eight isometric corners are also available. Named views are world directions: front looks from -Y.
shots:[...] (1–${MAX_SHOTS}, instead of views) are cameras you choose: view or from:[x,y,z] (camera side of the
framed center), up?, frame:{featureIds}|{min,max}|{center,radiusMm} to zoom on results, a box or a detail,
projection:'perspective' with fovDegrees?, hide/ghost:[ids] to see past parts, section, label. view:'perspective'
is shorthand for an isometric perspective; fovDegrees also implies perspective unless explicitly contradicted.
Example custom camera: {from:[1,-1,1],projection:'perspective',fovDegrees:35}. Change the
camera, never the model, to look elsewhere. Each tile reports eye, target, up, visible mm and mm/px;
orthographic tiles carry a scale bar. Measure in the image, and repeat the same frame after an edit.
featureId isolates a feature including hidden inputs.
appearance:'parts' identifies results by color and legend; 'materials' shows assigned appearance;
'issues' shows unintended floating parts and exact red overlap volumes. Use issues for final review.
tileSize:128–768. section:{axis,offset,flip?} clips at a world plane, retaining the lower side unless
flip:true; orange caps are display only. A top-level section applies to shots without their own. Returns a saved PNG path and MCP image content without changing
the human camera. Preflight analyzes unchecked/incomplete documents; skipAnalysis:true is an explicit
bypass and preserves the health warning.
outputs:'both' saves individual view PNGs from the same sheet, in one call. review:{} also captures an immutable graph snapshot and exact bounds/volume totals.
review:{sections:[{axis,offset}],profiles:[{featureId,sectionIndex?}],compareTo:snapshotId} adds exact cut measurements, local authored profile images (extrude/sweep/loft),
and a baseline sheet with matched cameras/framing/scene plus numeric deltas. compareTo must belong to this document. Profile images illustrate authored outlines, not reconstructed faces or continuity certification.
Only the main sheet, profile and baseline images are embedded in MCP; individual view paths are in image.panels. Total encoded image bundle is bounded to 16 MiB.`,
  },
  export_model: {
    effect: 'read',
    description: `Export exact STEP with part names/colors, triangulated STL, GLB display meshes with materials in
metres/Y-up, or editable JSON history. featureId selects geometry for STEP/STL/GLB; JSON always contains
the entire document. filename is a safe basename. Saves a unique file under artifacts and returns path,
SHA-256 and byte count; MCP also embeds the resource. Existing files are not overwritten. Preflight
analyzes unchecked/incomplete documents; skipAnalysis:true allows explicit intermediate/recovery output
without certifying completion. Check health before delivery.`,
  },
  document_action: {
    effect: 'edit',
    description: `undo_operation/redo_operation require operationId plus current documentId/expectedRevision and optional expectedStorageVersion. They restore an extraction across every affected document atomically; an external edit fails OPERATION_CONFLICT. Undo retains the created part identity and shared assets.
Undo, redo, save, reset or load the target document with current documentId/expectedRevision. reset
clears it; load replaces it with the supplied schema-valid document. Use reset/load only within the
user's authorized intent. Undo/redo increment revision; save persists without incrementing it. Keep
automatic analysis on; analyze:false is for intermediate mutations only, analyze:true forces analysis on
mutations. Inspect the resulting health before finishing.`,
  },
};

/** True when a command can change the committed document, so a lost reply leaves its outcome unknown. */
export function changesDocument(command: CadCommand): boolean {
  if(command.type==='workspace_view')return command.params.action==='present'||command.params.action==='cancel';
  if (commandInfo[command.type].effect === 'read') return false;
  if (command.type === 'document_action') return true;
  if (command.type === 'apply_edits') return !command.params.dryRun;
  if (command.type === 'documents') return !['list', 'history','asset'].includes(command.params.action)&&!command.params.dryRun;
  return true;
}

/** Discoverable limits, so an agent can plan within them instead of finding them by failure. */
export const LIMITS = {
  featuresPerDocument: MAX_FEATURES,
  instanceDepth: MAX_INSTANCE_DEPTH,
  referencedDocuments: MAX_REFERENCED_DOCUMENTS,
  assemblyFeatures: MAX_ASSEMBLY_FEATURES,
  replaySteps: MAX_ASSEMBLY_FEATURES,
  editsPerTransaction: MAX_FEATURES,
  parametersPerDocument: MAX_FEATURES,
  bindingsPerFeature: 64,
  dimensionMm: { min: 0.01, max: 10_000 },
  coordinateMm: { min: -100_000, max: 100_000 },
  holesPerFeature: 32,
  patternCopies: { linear: 64, circular: 360 },
  polygonPoints: { min: 3, max: 64 },
  curveSegments: 32, bezierControls: { min: 1, max: 2 }, loftSections: { min: 2, max: 12 },
  shellOpeningQueries: 8, mountsPerFeature: 32, resolvedMountsPerResult: 256,
  renderTilePx: { min: 128, max: 768, default: 384 },
  exportMiB: 20,
  commandTimeoutSeconds: COMMAND_TIMEOUT_MS / 1000,
} as const;

export const APP = { name: 'Vibeworks', title: 'Vibeworks CAD', version: '0.2.0' } as const;

/**
 * What any agent needs to know to use Vibeworks well, whichever adapter it uses.
 * MCP sends it as server instructions; the CLI prints it from `help`.
 */
export const AGENT_GUIDE = `Vibeworks is an agent-native CAD workspace with a local Node kernel and browser UI. Build exact editable OpenCascade B-rep solids
through the shared CAD tools; humans steer the same documents. No human tab is needed. STEP carries
exact geometry, JSON editable history; PNG, GLB and meshes are display outputs. Units are mm and
degrees, right-handed, Z up. Solid validity does not prove contact or a working mechanism.

Core loop
Join agent_session {action:"join",client:"codex"}; MCP binds the session. Reuse it across turns; own-adapter resume is idempotent. Concurrent agents pass their own sessionId on every call. CLI uses --session. update reports focus/workState; handoff records decisions; activity reads attributed work.
1. inspect_model {} discovers the startup document, revision, storageVersion, features, parameters,
exact metrics, resolved geometry.mounts, health and workspace documents. Pass documentId for another part.
2. Plan dimensions, physical parts, load paths and retention; agree mount contracts. Model subsystems separately and review an early assembly. For references, record inferred scale and compare silhouettes and junctions with matching cameras before detailing. Visual fidelity and continuity are separate from health; document unexpressible shapes before requesting tools.
3. Parameterize repeated dimensions with set_parameter and feature bindings such as {"size.2":"thickness"}.
Expressions support numbers, names, + - * / and parentheses, never code. Numeric params hold resolved values.
4. apply_edits batches are atomic, one rebuild, revision and undo step. Use semantic ids, current documentId,
expectedRevision and expectedStorageVersion when available. Later additions can reference earlier ones.
update replaces the whole feature; patch preserves omitted metadata. add.before inserts in history. dryRun previews without saving. Include intent:{purpose,rationale?} for design decisions.
5. Read health/nextSteps and repair unintended findings. render_views outputs:'both' saves a sheet and individual views together.
review:{} captures a snapshot; sections/profiles add evidence; compareTo:snapshotId matches before/after framing.
apply_edits review attaches this evidence after committing; reviewFailure never rolls back that edit. Move the camera, never the model. Analyze the whole
document with analyze_model, without featureIds. Pending checks are unknown, not failed. One run advances automatically; use jobId with status/result, bounded waitMs and page cursors. Review actual images and at least two useful parameter poses. Green health alone cannot prove a credible mechanism.

Modeling
Profiles: rectangle, circle, ellipse, polygon and exact line/arc/Bezier paths. extrude, revolve, loft
(ruled:false for smooth surfaces) and sweep build solids; shell hollows one; Booleans combine them. Blend a
joint after its union with fillet edges:{between:[a,b]}. describe {tool:'apply_edits',kind} gives focused
fields and examples. Loft correspondence, sweep guides/sections, fill/join construction sheets and variable
radius laws have bounded support described per kind. No sketch solver or general topology naming.

Parts and assemblies
Build reusable parts in their own documents (documents {action:'create',kind:'part',name}), then place them
in a kind:'assembly' document with instance features. Instances follow the latest committed source
revisions; health.references lists them. Agree named mounts on part results and attach instances to them
(align or mate, offset, twist; describe kind:'instance'). Mounts are static frames, not joints or topology
tracking. A missing source mount or result makes the assembly stale; render and geometry export fail
ASSEMBLY_STALE until repair. JSON stores workspace document IDs; export sources too.

Shape intent, physical intent and finishing
Declare the shape you must reach as checks: set_check size {axis,mm,toleranceMm}, within {min,max} and
section {axis,offset,widthMm?,heightMm?,toleranceMm}, on one feature a or the whole model. Take values from
the brief or references and put the source in note. inspect_model sections:[{axis,offset}] measures exact cuts.
Assign appearance.material or color on base parts; derived results inherit. Materials supply mass density.
Union one physical part; disconnected inputs may still have multiple solids. Pattern copies are compounds.
Use set_check for contact, clearance, no_interference or intentional overlap. A passing overlap check
requires an explanatory note; a documented passing clearance can declare an intentional gap.
Keep automatic analysis on. analyze:false skips an intermediate mutation; set_analysis auto:false persists.
Restore auto:true before finishing. Subset, skipped or incomplete analysis cannot certify completion.
Done requires health.ok with targets passing, reviewed images and appearance, and intended relationships declared.
inspect_model snapshot:{} freezes a graph; snapshot:{id} reuses it and snapshot:{sequence} inspects historical state. Reads never restore live data.
Use render_image/render_video for Studio PNGs/MP4s; start, status, result, cancel. Inspect render_views with appearance:'issues' and 'materials'. Export preflight checks unchecked models;
skipAnalysis:true is for intermediate/recovery output only. Report unresolved findings as unfinished.
When asked to show the human a view, workspace_view present controls document, selection, cameras, layout and Studio. Check status; saved/pending does not mean applied.

Recovery
Failures preserve committed document, geometry, durable history and storage. REVISION_CONFLICT and
STORAGE_CONFLICT require inspection and replanning. outcomeUnknown:true means a write may have committed;
follow recovery.steps before any retry. Use a UUID requestId for create/duplicate and documents list
{requestId} to reconcile. requiresHuman means wait for its human steps; never launch or operate a browser.
Humans diagnose connections with make doctor.

Limits
250 features, parameters and edits per document; 64 bindings per feature; dimensions 0.01–10000 mm,
coordinates ±100000 mm; 32 path segments, 1–2 Bezier controls, 12 loft sections, 8 shell queries,
32 authored mounts and 256 resolved mounts per result. Assemblies: four instance levels, 64 referenced
documents, 2000 unique features and expanded pieces, six million unique display asset values. Render tiles 128–768 px;
exports 20 MiB; command deadline 60 seconds. Split complex requests into measured batches.`;

/** The complete command catalog shared by MCP, CLI, HTTP and browser controls. */
export const AGENT_TOOLS = [
  'workspace_view',
  'agent_session',
  'activity',
  'describe',
  'inspect_model',
  'documents',
  'apply_edits',
  'analyze_model',
  'render_views',
  'render_image',
  'render_video',
  'export_model',
  'select_features',
  'document_action',
] as const satisfies readonly CommandName[];
export type AgentTool = (typeof AGENT_TOOLS)[number];
export const isAgentTool = (name: unknown): name is AgentTool =>
  typeof name === 'string' && (AGENT_TOOLS as readonly string[]).includes(name);

/** Name, effect, full description and JSON input schema of every agent tool: what MCP lists and what the CLI prints. */
export function toolCatalog(): {
  name: AgentTool;
  effect: CommandEffect;
  description: string;
  inputSchema: Record<string, unknown>;
}[] {
  return AGENT_TOOLS.map((name) => ({
    name,
    effect: commandInfo[name].effect,
    description: commandInfo[name].description,
    inputSchema: commandInputSchema(name),
  }));
}

/** Local $defs share repeated features/params without weakening the advertised validation. */
export function commandInputSchema(name: CommandName, kind?: Feature['kind']): Record<string, unknown> {
  let schema: z.ZodType = commandSchemas[name];
  if (kind) {
    if (name !== 'apply_edits') throw new Error('A feature kind is only supported for apply_edits.');
    const feature = featureSchema.options.find(option => option.shape.kind.value === kind);
    if (!feature) throw new Error(`Unknown feature kind '${kind}'.`);
    const edits = z.discriminatedUnion('op', [
      z.object({ op: z.literal('add'), before:featureIdSchema.optional(),feature }).strict(),
      z.object({ op: z.literal('update'), feature }).strict(),
      ...editSchema.options.filter(option => !['add', 'update'].includes(option.shape.op.value)),
    ]);
    schema = commandSchemas.apply_edits.safeExtend({ edits: z.array(edits).min(1).max(MAX_FEATURES) });
  }
  const json = z.toJSONSchema(schema, { reused: 'ref', io:'input' }) as Record<string, unknown>;
  if (name === 'render_image'||name === 'render_video'||name === 'workspace_view') json.type = 'object';
  if (name === 'documents') {
    const shape = commandSchemas.documents.shape;
    json.oneOf = Object.entries(documentActionFields).map(([action, fields]) => ({
      type: 'object', additionalProperties: false,
      properties: Object.fromEntries([['sessionId',{type:'string',format:'uuid'}],['action', { const: action }], ...fields.map(field => [field, z.toJSONSchema(shape[field])])]),
      required: ['action', ...documentActionRequired[action as keyof typeof documentActionRequired]],
    }));
  }
  // Short local definition names keep the larger modeling catalog compact for tool listings.
  // Only generated reference identifiers change; every validation keyword is preserved.
  if (json.$defs && typeof json.$defs === 'object') {
    const names = new Map(Object.keys(json.$defs).map((key, i) => [key, `s${i}`]));
    json.$defs = Object.fromEntries(Object.entries(json.$defs).map(([key, value]) => [names.get(key)!, value]));
    const rename = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (key === '$ref' && typeof child === 'string' && child.startsWith('#/$defs/')) {
          const name = names.get(child.slice(8));
          if (name) (value as Record<string, unknown>)[key] = `#/$defs/${name}`;
        } else rename(child);
      }
    };
    rename(json);
  }
  const counts = new Map<string, number>();
  const schemaMaps=new Set(['properties','patternProperties','$defs','definitions','dependentSchemas']);
  const schemaArrays=new Set(['oneOf','anyOf','allOf','prefixItems']);
  const schemaSingles=new Set(['items','additionalProperties','contains','not','if','then','else','propertyNames','unevaluatedProperties','unevaluatedItems','contentSchema']);
  const children=(value:Record<string,unknown>,visit:(node:unknown)=>unknown)=>Object.fromEntries(Object.entries(value).map(([key,node])=>[
    key,schemaMaps.has(key)&&node&&typeof node==='object'?Object.fromEntries(Object.entries(node).map(([name,child])=>[name,visit(child)])):
      schemaArrays.has(key)&&Array.isArray(node)?node.map(child=>visit(child)):schemaSingles.has(key)?visit(node):node,
  ]));
  const count=(value:unknown):unknown=>{
    if(!value||typeof value!=='object'||Array.isArray(value))return value;
    const key=JSON.stringify(value);if(key.length>=80)counts.set(key,(counts.get(key)??0)+1);
    children(value as Record<string,unknown>,count);return value;
  };
  count(json);
  const shared = new Map<string,string>();
  const defs = (json.$defs ?? {}) as Record<string,unknown>;
  let index=Object.keys(defs).length;
  const compress=(value:unknown,root=false):unknown=>{
    if(!value||typeof value!=='object'||Array.isArray(value))return value;
    const key=JSON.stringify(value);
    if(!root&&(counts.get(key)??0)>1){
      let name=shared.get(key);
      if(!name){name=`d${index++}`;shared.set(key,name);defs[name]=children(value as Record<string,unknown>,compress);}
      return {$ref:`#/$defs/${name}`};
    }
    return children(Object.fromEntries(Object.entries(value).filter(([key])=>!root||key!=='$defs')),compress);
  };
  const compact=compress(json,true) as Record<string,unknown>;
  // Existing definitions also participate, but definition roots must not refer to themselves.
  for(const key of Object.keys(json.$defs??{}))defs[key]=compress((json.$defs as Record<string,unknown>)[key],true);
  if(Object.keys(defs).length)compact.$defs=defs;
  // Remove aliases and single-use definitions; schema constraints remain identical.
  const usages = new Map<string,number>();
  const refs=(value:unknown):void=>{if(!value||typeof value!=='object')return;for(const [k,v] of Object.entries(value)){if(k==='$ref'&&typeof v==='string')usages.set(v,(usages.get(v)??0)+1);else refs(v);}};
  refs(compact);
  const inline=(value:unknown):unknown=>{
    if(!value||typeof value!=='object')return value;
    if(Array.isArray(value))return value.map(inline);
    const v=value as Record<string,unknown>;
    if(Object.keys(v).length===1&&typeof v.$ref==='string'&&v.$ref.startsWith('#/$defs/')&&usages.get(v.$ref)===1){const key=v.$ref.slice(8);const body=defs[key];if(body){delete defs[key];return inline(body);}}
    return Object.fromEntries(Object.entries(v).filter(([k])=>k!=='$defs').map(([k,v])=>[k,inline(v)]));
  };
  const final=inline(compact) as Record<string,unknown>;
  for(const key of Object.keys(defs))if(defs[key])defs[key]=inline(defs[key]);
  final.$defs=defs;
  const implicit=(v:unknown):void=>{if(!v||typeof v!=='object')return;const o=v as Record<string,unknown>;if('const'in o||Array.isArray(o.enum)&&o.enum.length)delete o.type;Object.values(o).forEach(implicit);};
  implicit(final);
  return final;
}

export const FEATURE_KINDS = featureSchema.options.map(option => option.shape.kind.value);

/** CLI requirements follow the selected action instead of the tool's broad effect annotation. */
export function commandRequirements(name: CommandName, action?: string): string {
  if (name === 'documents') {
    const requirements: Record<string, string> = {
      extract:'requestId UUID, documentId, expectedRevision, expectedStorageVersion, features, name; dryRun first, then apply with returned planToken; shared/parameters copy is explicit',
      list: 'no document context; optional name/requestId filters', create: 'name?, kind?, requestId?; no document context',
      duplicate: 'documentId; optional name/requestId/projectId/expectedStorageVersion',
      duplicate_project: 'source projectId, expectedStorageVersion and complete documentVersions; optional name/requestId', rename: 'documentId, name and expectedStorageVersion',
      history: 'documentId', move: 'documentId, projectId and expectedStorageVersion',
      create_project: 'name; optional projectId UUID/requestId (adapter allocates identity when omitted)', rename_project: 'projectId, name and expectedStorageVersion',
      delete_project: 'projectId and expectedStorageVersion; documentVersions must match every contained document to delete contents', set_main_assembly: 'projectId and expectedStorageVersion; documentId selects an assembly, omit to clear',
      delete: 'documentId and expectedRevision', open: 'documentId',
    };
    return action ? requirements[action] ?? 'Unknown documents action.' : Object.entries(requirements).map(([key, value]) => `${key}: ${value}`).join('\n');
  }
  if(name==='render_image')return 'start requires documentId and requestId UUID; status/result/cancel require jobId; optional expectedRevision pins capture';
  if(name==='render_video')return 'start requires documentId and requestId UUID; optional video recipe (preset or keyframes) and output; status/result/cancel require jobId';
  if(name==='workspace_view')return 'present requires documentId and state; optional expectedRevision/viewerId/requestId; get optionally takes projectId; status/cancel require requestId';
  if(name==='inspect_model')return 'optional documentId; top-level expectedRevision is not accepted; replay.step is 1-based and requires nested expectedRevision/expectedStorageVersion; use describe for syntax';
  if(name==='agent_session')return 'join/resume require client; handoff is at most 8000 characters; sessionId routes follow-up calls';
  return name === 'apply_edits' || name === 'select_features' || name === 'document_action'
    ? 'requires documentId and expectedRevision'
    : 'optional documentId (defaults to active); expectedRevision is not accepted';
}

export function parseCommand(value: unknown): CadCommand {
  const envelope = z
    .object({
      type: z.enum(Object.keys(commandSchemas) as [CommandName, ...CommandName[]]),
      params: z.unknown(),
    })
    .strict()
    .parse(value);
  return { type: envelope.type, params: commandSchemas[envelope.type].parse(envelope.params) } as CadCommand;
}

export interface Bounds {
  min: Vector3;
  max: Vector3;
  size: Vector3;
}
export interface InstanceResolution {
  featureId: string;
  documentId: string;
  name: string;
  revision: number;
  sourceFeatureIds: string[];
}
export interface GeometryInfo {
  resultKind?:'solid'|'sheet';
  diagnostics?:Record<string,unknown>;
  /** Resolved static attachment frames, including qualified nested instance mounts. */
  mounts?: ResolvedMount[];
  appearance?: Appearance;
  /** Every constituent piece has an assigned material or color, even when those values differ. */
  appearanceComplete?: boolean;
  featureId: string;
  valid: boolean;
  validationMethod: string;
  solidCount: number;
  volumeMm3: number;
  surfaceAreaMm2?: number;
  bounds: Bounds;
  faceCount?: number;
  edgeCount?: number;
  watertight?: boolean | null;
  /** Effective material id (own or inherited) and the exact mass it implies. */
  material?: string;
  massG?: number;
}
/** An exact planar cut: where the model or one result crosses axis = offset, and the cut's in-plane extents. */
export interface SectionMeasure {
  axis: 'X' | 'Y' | 'Z';
  offset: number;
  featureId?: string;
  /** True when nothing measured crosses the plane. */
  empty: boolean;
  /** In-plane extents: X sections are Y wide and Z high, Y sections X by Z, Z sections X by Y. */
  widthMm?: number;
  heightMm?: number;
  min?: Vector3;
  max?: Vector3;
  /** Visible results the plane cuts. */
  results: string[];
}
/** Physical relationships between visible parts, from exact kernel distances and overlap volumes. */
export interface AnalysisLeaf { id:string; feature:string; path:string[]; source:{documentId:string;featureId:string}; solidIndex:number; valid:boolean; bounds:Bounds; volumeMm3:number; faceCount?:number }
export interface AnalysisJob { id:string; documentId:string; snapshotId:string; state:'queued'|'running'|'complete'|'cancelled'|'superseded'|'error'; current:boolean; progress:{leafBodies:number;candidatePairs:number;done:number;cached:number;timedOut:number;unknown:number;checks:number}; inFlight?:{key:string;a:string;b:string;startedAt:number}; expensive:{key:string;a:string;b:string;attempts:number;elapsedMs:number;error:string}[]; error?:string; nextCursor?:string }
export interface AnalysisReport {
  broadPhase?:{durationMs:number;ruledOut:number;candidates:number};
  leaves?:AnalysisLeaf[];
  unknownPairs?:{a:string;b:string;reason:string}[];
  revision: number;
  scope: 'document' | 'subset';
  parts: number;
  ground?: string;
  toleranceMm: number;
  /** Pairs within contact tolerance with no significant common volume (at most 0.001 mm3). */
  contacts: { a: string; b: string; overlapMm3: number }[];
  interferences: { a: string; b: string; overlapMm3: number; intendedBy?: string }[];
  /** Parts not connected through contacts to the ground part, with the nearest connected part and the gap to it. */
  floating: { featureId: string; nearest?: string; gapMm?: number; intendedBy?: string[] }[];
  coverage?:{totalPairs:number;completedPairs:number;totalChecks:number;completedChecks:number;connectivity?:'pending'|'complete'};
  checks: {
    id: string;
    ok: boolean | null;
    status?:'pass'|'fail'|'pending'|'error';
    expect: Check['expect'];
    /** Absent for a target on every visible result. */
    a?: string;
    b?: string;
    gapMm?: number;
    overlapMm3?: number;
    /** What a target check measured: an extent, bounds, or a section's width and height. */
    measuredMm?: number;
    min?: Vector3;
    max?: Vector3;
    widthMm?: number;
    heightMm?: number;
    message: string;
  }[];
  durationMs: number;
  /** Set when analysis did not run or was cut short, with the reason. */
  skipped?: string;
}

/** Counts describe the current revision only. Null means not checked, never zero. */
export interface ModelHealth {
  constructionSheets?:string[];
  validity?:{valid:boolean;leafBodies:number}; fit?:{complete:boolean;unknown:number}; checks?:{complete:boolean;pending:number}; pending?:{jobId?:string;state?:string}; review?:{humanApproved:false};
  appearance?:{staleReferences:number};
  references?: { documentId: string; revision: number }[];
  referencesChanged?: boolean;
  referenceError?: string;
  checkedRevision: number | null;
  /** Number of committed revision increments since the last complete document analysis. */
  uncheckedChanges: number;
  analysis: 'current' | 'unchecked' | 'incomplete' | 'unavailable';
  autoAnalysis: boolean | null;
  floating: number | null;
  interferences: number | null;
  failedChecks: number | null;
  pendingChecks?:number|null;
  partsWithoutAppearance: number | null;
  ok: boolean;
  issues: {
    floating: string[];
    interferences: { a: string; b: string }[];
    failedChecks: string[];
    partsWithoutAppearance: string[];
  };
}
export const unknownHealth = (): ModelHealth => ({
  checkedRevision: null,
  uncheckedChanges: 0,
  analysis: 'unavailable',
  autoAnalysis: null,
  floating: null,
  interferences: null,
  failedChecks: null,
  partsWithoutAppearance: null,
  ok: false,
  issues: { floating: [], interferences: [], failedChecks: [], partsWithoutAppearance: [] },
});

/** One stored document, as listed in the workspace. */
export interface DocumentSummary {
  kind?: 'part' | 'assembly';
  documentId: string;
  name: string;
  revision: number;
  features: number;
  updatedAt: string;
  active: boolean;
  projectId?: string;
  storageVersion?: number;
}

export const requiresHumanSchema = z
  .object({ reason: z.string().min(1), steps: z.array(z.string().min(1)).min(1).max(10) })
  .strict();
export type RequiresHuman = z.infer<typeof requiresHumanSchema>;
export const commandFailureSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
    outcomeUnknown: z.boolean().optional(),
    requiresHuman: requiresHumanSchema.optional(),
    recovery: z.object({
      first: z.enum(['read', 'human']), steps: z.array(z.string().min(1)).min(1),
      ifReadUnavailable: requiresHumanSchema.optional(),
    }).strict().optional(),
  })
  .strict();
export type CommandFailure = z.infer<typeof commandFailureSchema>;

/** One ordered recovery path, shared by transport and adapters. No mutation is retried automatically. */
export function uncertainOutcome(command: CadCommand, code: string, message: string, requestId: string | undefined, reachable: boolean, details?: unknown, createdDocumentId?: string): CadResult {
  const creation = command.type === 'documents' && ['create', 'duplicate'].includes(command.params.action);
  const projectCreation = command.type === 'documents' && command.params.action === 'create_project';
  const projectDuplication = command.type === 'documents' && command.params.action === 'duplicate_project';
  const extraction=command.type==='documents'&&command.params.action==='extract';
  const read = extraction
    ? `Call documents with ${JSON.stringify({action:'list',requestId:command.params.requestId})} to recover the persistent extraction receipt, then inspect every affected document. Keep the same logical requestId and arguments; do not allocate another part identity.`
    : projectCreation
    ? `Call documents with ${JSON.stringify({action:'list',projectId:command.params.projectId??requestId})} to recover the project. Keep its identity; never create another project because a reply was lost.`
    : projectDuplication
    ? `Call documents with action list, then find projectId ${requestId ?? command.params.requestId} in projects. Keep the same requestId and arguments to recover its duplication mapping; never retry with a new requestId.`
    : creation
    ? `Call documents with ${JSON.stringify({ action: 'list', ...(requestId ? { requestId } : { name: command.params.name }) })}, then inspect_model with the recovered documentId. Keep the original requestId and arguments; do not create a duplicate.`
    : command.type==='workspace_view' && requestId
    ? `Call workspace_view with action status and requestId ${requestId} before sending another presentation request.`
    : `Call inspect_model with ${JSON.stringify('documentId' in command.params && command.params.documentId ? { documentId: command.params.documentId } : {})} before further edits.`;
  const human = humanRecovery(code) ?? humanRecovery('BRIDGE_TRANSPORT_ERROR')!;
  const result = commandError(command.type, code, `${message} ${reachable ? read : 'Wait for the human recovery steps, then reconcile with a safe read.'}`, details);
  if (reachable) delete result.error!.requiresHuman;
  else result.error!.requiresHuman = human;
  result.error!.recovery = { first: reachable ? 'read' : 'human', steps: reachable ? [read] : [...human.steps, read], ...(reachable ? { ifReadUnavailable: human } : {}) };
  if (changesDocument(command)) result.error!.outcomeUnknown = true;
  if (requestId) result.requestId = requestId;
  if (createdDocumentId) result.createdDocumentId = createdDocumentId;
  return result;
}

/** Only human-owned recovery belongs here. Agent actions stay in message/details. */
export function humanRecovery(code: string): RequiresHuman | undefined {
  const steps: Record<string, string[]> = {
    EXPORT_UNAVAILABLE: ['Check the managed renderer dependency with npm run renderer:install.'],
    BRIDGE_NOT_RUNNING: ['Run npm run headless in this checkout and wait for Node ready.'],
    BRIDGE_TRANSPORT_ERROR: [
      'Check the make dev terminal and restart make dev if it stopped.',
      'Run npm run headless in this checkout and check npm run -s cad -- doctor.',
    ],
    BROWSER_DISCONNECTED: [
      'Open the URL printed by make dev in the intended browser and wait for MCP ready.',
    ],
    BROWSER_ALREADY_CONNECTED: ['Close the other controlling tab to let this waiting tab connect.'],
    UNAUTHORIZED: [
      'Reload the intended browser tab to obtain the current token.',
      'If the agent still reports UNAUTHORIZED, restart its MCP server in this checkout.',
    ],
    VERSION_SKEW: [
      'Restart make dev, reload the browser tab, and restart the agent session or its MCP server.',
    ],
    COMMAND_TIMEOUT: [
      'Check the headless service terminal, then inspect the committed model.',
    ],
    INVALID_RESPONSE: ['Check the make dev terminal for the failing result fields.'],
    RESPONSE_MISMATCH: ['Check the make dev terminal for the mismatched response.'],
    INVALID_MESSAGE: ['Reload the intended browser tab.'],
    HELLO_TIMEOUT: ['Reload the intended browser tab.'],
    HOST_REJECTED: ['Use the URL printed by make dev and the adapter from the same checkout.'],
    ORIGIN_REJECTED: ['Open the exact URL printed by make dev.'],
    FETCH_SITE_REJECTED: ['Open the exact URL printed by make dev.'],
    BOOTSTRAP_REJECTED: ['Open the exact URL printed by make dev.'],
    BRIDGE_ERROR: ['Check the make dev terminal for the bridge failure.'],
    ADAPTER_ERROR: ["Check the agent's MCP server log; restart its MCP server if necessary."],
  };
  return steps[code]
    ? { reason: 'This recovery needs the person running Vibeworks.', steps: steps[code] }
    : undefined;
}

export interface BridgeEvent {
  at: string;
  code: string;
  message: string;
  closeCode?: number;
  requiresHuman?: RequiresHuman;
  fingerprint?: string;
}
export interface ConnectionDiagnosis {
  kernel?: { authority: 'node'; phase: 'initializing' | 'ready' | 'unavailable'; error?: string; workers: unknown[]; pending: number; queueLimit: number; renderer: { phase: string; error?: string }; rssBytes: number };
  bridgeReachable: boolean;
  browserConnected: boolean | null;
  fingerprints: { workspace?: string; bridge?: string; browser?: string; adapter?: string };
  issues: CommandFailure[];
  lastRejection?: BridgeEvent;
  lastDisconnect?: BridgeEvent;
}

/** Timings exclude worker startup and transport. Physical analysis has its own counters. */
export interface EvaluationStats {
  display?: { requested: 'auto' | 'fine' | 'coarse'; toleranceMm: number; angularTolerance: number; reduced: boolean; values: number; expandedValues: number; meshes: number };
  analysis?: {
    durationMs: number;
    partHits: number;
    partMisses: number;
    pairHits: number;
    pairMisses: number;
    partEntries: number;
    pairEntries: number;
    meshBytes: number;
    evictions: number;
  };
  referencedDocuments?: { documentId: string; features: number; rebuilt: string[] }[];
  durationMs: number;
  cache: {
    hits: number;
    misses: number;
    rebuilt: string[];
    evictions: number;
    entries: number;
    liveShapes: number;
    meshBytes: number;
    wasmHeapBytes: number;
  };
}

export const replayStepSchema = z.object({
  rootStep: z.number().int().min(1).max(MAX_FEATURES),
  path: z.array(z.object({ documentId: z.string().uuid(), name: z.string().max(120), featureId: featureIdSchema, label: z.string().max(120) }).strict()).min(1).max(MAX_INSTANCE_DEPTH + 1),
  kind: z.enum(['box','cylinder','rod','instance','extrude','fill','join','loft','sweep','shell','revolve','union','subtract','intersect','fillet','chamfer','transform','mirror','pattern','text','drill_holes']),
}).strict();
export type ReplayStep = z.infer<typeof replayStepSchema>;
export const replaySchema = z.object({ key: z.string().min(1).max(8192), step: z.number().int().min(1).max(MAX_ASSEMBLY_FEATURES), steps: z.array(replayStepSchema).min(1).max(MAX_ASSEMBLY_FEATURES) }).strict().refine(r => r.step <= r.steps.length, 'Replay step must exist.');
export type Replay = z.infer<typeof replaySchema>;
export type ReplayRequest = NonNullable<Extract<CadCommand, { type: 'inspect_model' }>['params']['replay']>;

export interface CadResult {
  dependentWarnings?:{documentId:string;code:string;message:string;details?:unknown}[];
  evaluationProvenance?: { authoredEngine: string; evaluatedWith: string; originalEvidence: false };
  meta?: { replyBytes: number };
  review?:ReviewEvidence;
  reviewFailure?:{code:string;message:string;committed:boolean};
  workspaceView?: z.infer<typeof workspaceViewResultSchema>;
  inspection?:Record<string,unknown>;
  actor?:{agentId:string;sessionId:string;clientInstanceId?:string};
  help?:{tool:string;kind?:string;schema:Record<string,unknown>;example:Record<string,unknown>;notes:string[]};
  removedChecks?:string[];
  agent?: AgentIdentity;
  session?: AgentSession;
  participants?: Participant[];
  sessions?:AgentSession[];
  operations?: ActivityOperation[];
  cursor?: number;
  snapshot?: GraphSnapshot;
  renderJob?: StudioRenderJob;
  videoJob?: StudioVideoJob;
  /** A finished render_video: the MP4 artifact the bridge saved, plus a poster frame. */
  video?: { mimeType: 'video/mp4'; path: string; uri: string; filename: string; byteLength: number; sha256: string;
    width: number; height: number; fps: number; frames: number; seconds: number;
    poster: { mimeType: 'image/png'; base64: string; width: number; height: number } };
  extraction?:{operationId:string;planToken:string;plan:Record<string,unknown>;equivalence?:Record<string,unknown>;retainedDocumentId?:string};
  analysisJob?:AnalysisJob;

  /** View-only current construction. Geometry describes this frame, never durable history. */
  replay?: Replay;
  operation: CommandName;
  status: 'success' | 'error';
  documentId?: string;
  revision?: number;
  storageVersion?: number;
  projects?: Project[];
  duplication?: ProjectDuplication;
  revisions?: RevisionSummary[];
  created: string[];
  updated: string[];
  deleted?: string[];
  warnings: string[];
  document?: CadDocument;
  geometry?: GeometryInfo[];
  visibleFeatureIds?: string[];
  history?: { canUndo: boolean; canRedo: boolean };
  error?: CommandFailure;
  image?: { mimeType: 'image/png'; base64: string; width: number; height: number; tiles: RenderedTile[];panels?:RenderedPNG[] };
  sections?: SectionMeasure[];
  artifact?: { filename: string; mimeType: string; base64: string; byteLength: number };
  durationMs?: number;
  requestId?: string;
  createdDocumentId?: string;
  createdProjectId?: string;
  /** A retained reply or creation identity was recovered without repeating its mutation. */
  replayed?: boolean;
  /** Disjoint elapsed phases; dependent refresh includes its own geometry and analysis. */
  timings?: CommandTimings;
  authority?: { kind: 'node'; kernel: string; workerSlot: number };
  provenance?: { documentId: string; revision: number; sources: { documentId: string; revision: number }[] };
  /** Set on apply_edits dry runs: geometry describes the uncommitted candidate. */
  dryRun?: boolean;
  evaluationStats?: EvaluationStats;
  instances?: InstanceResolution[];
  analysis?: AnalysisReport;
  health?: ModelHealth;
  nextSteps?: string[];
  /** Workspace listing, from the documents tool and inspect_model. */
  documents?: DocumentSummary[];
}

export interface CommandTimings {
  queueWaitMs: number;
  geometryEvaluationMs: number;
  analysisMs: number;
  dependentRefreshMs: number;
  renderExportMs: number;
  runtimeOtherMs: number;
  /** Adapter round trip minus runtime duration: includes bridge validation and serialization. */
  transportMs?: number;
}

/** Cached replies describe the original snapshot, but this delivery did no new runtime work. */
export function replayedResult(result: CadResult): CadResult {
  return { ...result, replayed: true, durationMs: 0, timings: { queueWaitMs: 0, geometryEvaluationMs: 0, analysisMs: 0, dependentRefreshMs: 0, renderExportMs: 0, runtimeOtherMs: 0 } };
}

export interface BridgeConnection {
  wsUrl: string;
  token: string;
  fingerprint: string;
}
/** Browser bootstrap identity changes on every bridge launch, even when the contract is unchanged. */
export const browserConnectionSchema = z.object({
  bridgeId: z.string().uuid(), token: z.string(), fingerprint: z.string(), wsUrl: z.string(),
});

export interface LocalConnection extends BridgeConnection {
  httpUrl: string;
  pid: number;
  protocolVersion: 1;
}
export interface RuntimeHello {
  type: 'hello';
  protocolVersion: 1;
  fingerprint: string;
  token: string;
  sessionId: string;
  documentId: string;
}
export interface RuntimeReady {
  type: 'ready';
  protocolVersion: 1;
  fingerprint: string;
}
export interface RuntimeRequest {
  type: 'command';
  requestId: string;
  command: CadCommand;
}
export interface RuntimeResponse {
  type: 'result';
  requestId: string;
  result: CadResult;
}
export interface RuntimeRejection {
  type: 'rejected';
  code: string;
  message: string;
  requiresHuman?: RequiresHuman;
}

export function commandError(
  operation: CommandName,
  code: string,
  message: string,
  details?: unknown,
  requiresHuman = humanRecovery(code)
): CadResult {
  return {
    operation,
    status: 'error',
    created: [],
    updated: [],
    warnings: [],
    health: unknownHealth(),
    error: {
      code,
      message,
      ...(requiresHuman ? { requiresHuman } : {}),
      ...(details === undefined ? {} : { details }),
    },
  };
}


// Storage uses this same contract over authenticated loopback HTTP, independent of a geometry tab.
/** Normalizes project-less early JSON. This identity has no deletion or navigation privileges. */
export const LEGACY_PROJECT_ID = '00000000-0000-4000-8000-000000000001';
export const projectSchema = z.object({ projectId: z.string().uuid(), name: z.string().min(1).max(120), version: z.number().int().positive(), mainAssemblyId: z.string().uuid().optional() }).strict();
export type Project = z.infer<typeof projectSchema>;
export const projectDuplicationSchema = z.object({
  sourceProjectId: z.string().uuid(), projectId: z.string().uuid(),
  documentIds: z.record(z.string().uuid(), z.string().uuid()),
  externalDocumentIds: z.array(z.string().uuid()),
}).strict();
export type ProjectDuplication = z.infer<typeof projectDuplicationSchema>;
export const duplicateProjectOperationSchema = z.object({
  action: z.literal('duplicate_project'), projectId: z.string().uuid(), requestId: z.string().uuid(),
  name: z.string().min(1).max(120).optional(), expectedVersion: z.number().int().positive(),
  documentVersions: z.record(z.string().uuid(), z.number().int().positive()), context: operationContextSchema.optional(),
}).strict();
export const savedHistorySchema = z.object({ undo: z.array(documentSchema).max(40), redo: z.array(documentSchema).max(40) }).strict();
export type SavedHistory = z.infer<typeof savedHistorySchema>;
export const storedDocumentSchema = z.object({ document: documentSchema, version: z.number().int().positive(), history: savedHistorySchema, updatedAt: z.string() }).strict();
export type StoredDocument = z.infer<typeof storedDocumentSchema>;
export const revisionSummarySchema = z.object({ version: z.number().int().positive(), revision: z.number().int().nonnegative(), updatedAt: z.string() }).strict();
export type RevisionSummary = z.infer<typeof revisionSummarySchema>;
export const storageChangeSchema = z.object({ sequence: z.number().int().positive(), documentId: z.string().uuid().optional(), projectId: z.string().uuid().optional(), version: z.number().int().positive(), deleted: z.boolean() }).strict();
export type StorageChange = z.infer<typeof storageChangeSchema>;
const version = z.number().int().positive();
export const storageOperationSchema = z.discriminatedUnion('action', [
  z.object({action:z.literal('batch'),requestId:uuid,identity:z.string(),guards:z.record(uuid,version),creates:z.array(documentSchema).max(1),writes:z.array(z.object({document:documentSchema,history:savedHistorySchema}).strict()).max(1000),receipt:z.record(z.string(),z.unknown()),context:operationContextSchema.optional()}).strict(),
  z.object({action:z.literal('operation_request'),requestId:uuid}).strict(),
  z.object({action:z.literal('operation_history'),guards:z.record(uuid,version).optional(),operationId:uuid,direction:z.enum(['undo','redo']),context:operationContextSchema.optional()}).strict(),
  duplicateProjectOperationSchema,
  z.object({ action: z.literal('list'), projectId: z.string().uuid().optional() }).strict(),
  z.object({ action: z.literal('read'), documentId: z.string().uuid() }).strict(),
  /** The current definition and its version, without undo history: what reference resolution needs. */
  z.object({ action: z.literal('body'), documentId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('write'), document: documentSchema, expectedVersion: version.nullable(), history: savedHistorySchema, references: z.record(z.string().uuid(), version).optional(), context:operationContextSchema.optional() }).strict(),
  z.object({ action: z.literal('remove'), documentId: z.string().uuid(), expectedVersion: version, context:operationContextSchema.optional() }).strict(),
  z.object({ action: z.literal('projects') }).strict(),
  z.object({ action: z.literal('project'), project: projectSchema, expectedVersion: version.nullable(), context:operationContextSchema.optional() }).strict(),
  z.object({ action: z.literal('remove_project'), projectId: z.string().uuid(), expectedVersion: version, documentVersions: z.record(z.string().uuid(), version).optional(), context:operationContextSchema.optional() }).strict(),
  z.object({ action: z.literal('changes'), after: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal('history'), documentId: z.string().uuid() }).strict(),
  z.object({action:z.literal('snapshot'),documentId:uuid,snapshot:snapshotRequestSchema.optional()}).strict(),
]);
export type StorageOperation = z.infer<typeof storageOperationSchema>;
export const documentSummarySchema = z.object({ kind: z.enum(['part', 'assembly']).optional(), documentId: z.string().uuid(), name: z.string().min(1).max(120), revision: z.number().int().nonnegative(), features: z.number().int().nonnegative(), updatedAt: z.string(), active: z.boolean(), projectId: z.string().uuid().optional(), storageVersion: version.optional() }).strict();
export const storageRequestSchema = z.object({ requestId: z.string().uuid(), operation: storageOperationSchema }).strict();
export const storageResponseSchema = z.object({batchReceipt:z.record(z.string(),z.unknown()).optional(), requestId: z.string().uuid(), fingerprint: z.string(), ok: z.boolean(), error: commandFailureSchema.optional(), duplication: projectDuplicationSchema.optional(), replayed: z.boolean().optional(), graph:frozenGraphSchema.optional(), record: storedDocumentSchema.optional(), body: z.object({ document: documentSchema, version }).strict().optional(), version: version.optional(), documents: z.array(documentSummarySchema).optional(), projects: z.array(projectSchema).optional(), changes: z.array(storageChangeSchema).max(500).optional(), cursor: z.number().int().nonnegative().optional(), revisions: z.array(revisionSummarySchema).max(40).optional() }).strict();
export type StorageResponse = z.infer<typeof storageResponseSchema>;

/** Ephemeral topology indices belong only to this display asset. Semantic references use lineage. */
export interface TopologyTable {
  faces: { solidIndex?:number; lineage: string[]; surface: string; areaMm2: number; shapeSamples?: Vector3[]; center: Vector3; normal?: Vector3; neighbours: number[] }[];
  edges: { endpoints?:Vector3[]; lineage: string[]; faces: number[]; center: Vector3; lengthMm: number }[];
}
export const topologyTableSchema = z.object({
  faces: z.array(z.object({ solidIndex:z.number().int().nonnegative().optional(), lineage: z.array(z.string().max(512)).max(64), surface: z.string().max(64), areaMm2: z.number().finite().nonnegative(), shapeSamples:z.array(outputVectorSchema).length(9).optional(), center: outputVectorSchema, normal: outputVectorSchema.optional(), neighbours: z.array(z.number().int().nonnegative()) }).strict()).max(100000),
  edges: z.array(z.object({ endpoints:z.array(outputVectorSchema).length(2).optional(),lineage: z.array(z.string().max(512)).max(64), faces: z.array(z.number().int().nonnegative()), center: outputVectorSchema, lengthMm: z.number().finite().nonnegative() }).strict()).max(200000),
}).strict();
export const appearanceOriginSchema=z.object({documentId:z.string(),featureId:z.string(),path:z.array(z.string()).optional(),layer:z.string(),styleId:z.string().optional()}).strict();
export type AppearanceOrigin=z.infer<typeof appearanceOriginSchema>;
export const regionReportSchema=z.object({method:z.literal('exact-surface-UV predicates; triangular display boundary approximation'),sectionBrackets:z.literal(256),errors:z.object({supportMeshToleranceMm:z.number().positive(),crossingResidualMm:z.number().finite().nonnegative(),crossingResidualUV:z.number().finite().nonnegative(),boundary:z.literal('straight triangle chords; no exact CAD boundary or global error certification')}).strict().optional(),splineExtrema:z.literal('Bernstein derivative roots on trimmed knot spans').optional(),areas:z.array(z.object({id:z.string(),areaMm2:z.number().finite().nonnegative(),crestChordToleranceMm:z.number().optional()}).strict()).max(32)}).strict();
export const displayIdentitySchema = z.object({
  resultKind:z.enum(['solid','sheet']).optional(),
  regionReport:regionReportSchema.optional(),
  graphicBounds:z.object({min:outputVectorSchema,max:outputVectorSchema}).strict().optional(),
  appearanceOrigins:z.record(z.string(),appearanceOriginSchema).optional(),
  occurrencePath: z.array(featureIdSchema).max(64).optional(),
  source: z.object({ documentId: uuid, revision: z.number().int().nonnegative(), featureId: featureIdSchema }).strict().optional(),
  topology: topologyTableSchema.optional(),
  faceRanges: z.array(z.number().int().nonnegative()).max(800000).optional(),
  edgeRanges: z.array(z.number().int().nonnegative()).max(800000).optional(),
});
/** Node-to-client display data. Exact metrics remain the kernel output, meshes are display aids. */
export interface DisplayMesh {
  resultKind?:'solid'|'sheet';
  regionReport?:z.infer<typeof regionReportSchema>;
  /** Unpainted local result bounds; every clipped style fragment shares its graphic projector frame. */
  graphicBounds?:{min:Vector3;max:Vector3};
  appearanceOrigins?:Record<string,AppearanceOrigin>;
  /** Shared local-space asset; rigid placement is applied by the renderer. */
  transform?: number[];
  occurrencePath?: string[];
  source?: { documentId: string; revision: number; featureId: string };
  topology?: TopologyTable;
  faceRanges?: number[];
  edgeRanges?: number[];
  appearance?: Appearance;
  featureId: string;
  vertices: number[];
  normals: number[];
  triangles: number[];
  lines: number[];
}
export type GeometryAnalysis = AnalysisReport & { interferenceMeshes?: (DisplayMesh & { a: string; b: string })[] };
export interface DisplayEvaluation {
  topologyQuery?:{feature:string;path?:string[];faceIndices?:number[];edgeIndices?:number[]};
  displayKey?: string;
  replay?: Replay;
  instances?: InstanceResolution[];
  references?: { documentId: string; revision: number }[];
  referencesChanged?: boolean;
  referenceError?: string;
  stats?: EvaluationStats;
  geometry: GeometryInfo[];
  visibleFeatureIds: string[];
  meshes: DisplayMesh[];
  /** Why an implicit display was left out; the exact result and its commit stand. */
  displayError?: string;
  /** Present when the evaluation was asked to analyze physical relationships. */
  analysis?: GeometryAnalysis;
  /** Present when the evaluation was asked for exact cross-sections. */
  sections?: SectionMeasure[];
}

export interface RuntimeDelivery { result: CadResult; evaluation?: DisplayEvaluation }

export const displayMeshSchema = z.object({ ...displayIdentitySchema.shape, featureId: featureIdSchema, transform: z.array(z.number().finite()).length(16).optional(), appearance: appearanceSchema.optional(), vertices: z.array(z.number().finite()).max(8_000_000), normals: z.array(z.number().finite()).max(8_000_000), triangles: z.array(z.number().int().nonnegative()).max(8_000_000), lines: z.array(z.number().finite()).max(8_000_000) }).strict();

/** Read-only local service telemetry. Measurements never substitute for model validation. */
export const serviceStatusSchema=z.object({
 serviceId:z.string().uuid(),phase:z.enum(['online','starting','restarting','unavailable']),startedAt:z.string(),uptimeMs:z.number().nonnegative(),
 memoryBytes:z.number().nonnegative(),storageBytes:z.number().nonnegative(),mcpClients:z.number().int().nonnegative(),
 pending:z.number().int().nonnegative(),workers:z.number().int().nonnegative(),error:z.string().optional(),
 requests:z.object({total:z.number().int().nonnegative(),failed:z.number().int().nonnegative(),active:z.number().int().nonnegative(),mcp:z.number().int().nonnegative(),
  samples:z.array(z.object({at:z.number(),count:z.number().int().nonnegative(),failed:z.number().int().nonnegative()})).max(60)})
}).strict();
export type ServiceStatus=z.infer<typeof serviceStatusSchema>;
export const mcpPresenceSchema=z.object({id:z.string().uuid(),action:z.enum(['heartbeat','leave'])}).strict();
export const serviceRestartSchema=z.object({action:z.literal('restart')}).strict();
