import { createAssembly, type Shape3D } from 'replicad';
import type { OpenCascadeInstance } from 'replicad-opencascadejs';
import { indexedShapes } from './topology';
import { CadError } from './document';

/** XCAF subshape colours preserve exact solids and whole-face paint in an ordinary STEP file. */
export function coloredSTEP(oc: OpenCascadeInstance, items: { shape: Shape3D; name: string; color: string; faces: Map<number, string> }[]): Blob {
  const doc = createAssembly(items), owned: { delete(): void }[] = [];
  const own = <T extends { delete(): void }>(value: T): T => { owned.push(value); return value; };
  const filename = `/painted-${crypto.randomUUID()}.step`;
  try {
    const main = own(doc.wrapped.Main()), shapes = own(oc.XCAFDoc_DocumentTool.ShapeTool(main)), colors = own(oc.XCAFDoc_DocumentTool.ColorTool(main));
    for (const item of items) {
      if (!item.faces.size) continue;
      const label = own(shapes.FindShape(item.shape.wrapped, false)), faces = indexedShapes(oc, item.shape.wrapped, 'FACE');
      try {
        for (const [index, hex] of item.faces) {
          const face = faces[index];
          if (!face) throw new CadError('EXPORT_FACE_MAPPING', 'A painted face could not be mapped to the exact exported solid.');
          const sub = own(shapes.AddSubShape(label, face));
          if (sub.IsNull()) throw new CadError('EXPORT_FACE_MAPPING', 'The STEP document could not register a painted face.');
          const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
          const color = own(new oc.Quantity_ColorRGBA(rgb[0], rgb[1], rgb[2], 1));
          colors.SetColor(sub, color, oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf);
        }
      } finally { faces.forEach(face => face.delete()); }
    }
    const session = own(new oc.XSControl_WorkSession()), writer = own(new oc.STEPCAFControl_Writer(session, false));
    writer.SetColorMode(true); writer.SetLayerMode(true); writer.SetNameMode(true);
    oc.Interface_Static.SetIVal('write.surfacecurve.mode', 1);
    oc.Interface_Static.SetIVal('write.precision.mode', 0);
    oc.Interface_Static.SetIVal('write.step.assembly', 2);
    oc.Interface_Static.SetIVal('write.step.schema', 5);
    if (!writer.Perform(doc.wrapped, filename, own(new oc.Message_ProgressRange()))) throw new CadError('EXPORT_FAILED', 'The exact STEP writer failed.');
    return new Blob([new Uint8Array(oc.FS.readFile(filename))], { type: 'application/STEP' });
  } finally {
    try { oc.FS.unlink(filename); } catch { /* No file is created when transfer fails. */ }
    owned.reverse().forEach(value => value.delete()); doc.delete();
  }
}
