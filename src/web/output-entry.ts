// Loaded only by the bridge's managed renderer. No runtime, storage or OCCT imports.
import { renderContactSheet } from "./contact-sheet";
import { exportGlb } from "./glb-export";
import { decodeAssets } from "../shared/display";
import type { Evaluation } from "../cad/types";
/** The bridge sends each display asset once, encoded (see packDisplay). */
const unpack = (evaluation: Evaluation & { assets?: unknown }): Evaluation => {
  const { assets, assetEncoding: _encoding, ...rest } = evaluation as Evaluation & { assets?: unknown; assetEncoding?: string };
  if (assets === undefined) return evaluation;
  const decoded = decodeAssets(assets);
  if (!decoded) throw new Error("Display assets could not be decoded.");
  return { ...rest, meshes: (rest.meshes as unknown as ({ asset: number } & Record<string, unknown>)[]).map(({ asset, ...metadata }) => ({ ...decoded[asset], ...metadata })) as Evaluation["meshes"] };
};
const base64 = (bytes: ArrayBuffer) => {
  let binary = "";
  const data = new Uint8Array(bytes);
  for (let i = 0; i < data.length; i += 0x8000)
    binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(binary);
};
(globalThis as any).__outputs = {
  render: (evaluation: Evaluation, ...rest: Parameters<typeof renderContactSheet> extends [unknown, ...infer R] ? R : never) =>
    renderContactSheet(unpack(evaluation), ...rest),
  glb: async (evaluation: Evaluation, ...rest: Parameters<typeof exportGlb> extends [unknown, ...infer R] ? R : never) => {
    const result = await exportGlb(unpack(evaluation), ...rest);
    return { base64: base64(result.bytes), mimeType: result.mimeType };
  },
};
