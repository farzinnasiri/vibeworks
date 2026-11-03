/** Count labels shared by the UI, receipts and review images. */
export const countLabel = (count: number, singular: string, plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;

/** Three significant figures, including sub-milligram parts, without scientific notation. */
export function massLabel(grams: number): { value: string; unit: 'g' | 'kg' } {
  const unit = grams >= 1000 ? 'kg' : 'g';
  return { value: new Intl.NumberFormat('en', { maximumSignificantDigits: 3 }).format(unit === 'kg' ? grams / 1000 : grams), unit };
}
