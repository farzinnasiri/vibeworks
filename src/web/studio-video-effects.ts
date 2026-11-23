/** Approximate thin-lens circle of confusion for the pinned Three Bokeh pass, in normalized scene units. */
export interface VideoDepthOfField { focusDistance:number;focalLengthMm:number;fStop:number;unitMm:number }
export function videoAperture(lens:VideoDepthOfField){
  const distance=Math.max(lens.focusDistance*lens.unitMm,lens.focalLengthMm+1);
  return lens.focalLengthMm**2*lens.unitMm/(lens.fStop*distance*(distance-lens.focalLengthMm)*35);
}
