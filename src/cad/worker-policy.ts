// Backstop for finalizer-managed temporaries inside replicad/OCCT. Heap size is
// allocated WASM capacity (it does not shrink), not a claim about live allocations.
export const MAX_WORKER_EVALUATIONS = 128;
// Recycling discards every cached exact shape, so a large model must stay warm. The valid reference
// F1 graph holds 918 MB of capacity after one evaluation; recycling at 256 MB rebuilt it on every command.
// Above the soft limit only renewed growth (a leak) recycles; a model that simply needs the space keeps it.
export const MAX_WORKER_HEAP_BYTES = 1536 * 1024 * 1024;
// Frozen assembly construction keeps a larger exact working set than a single edit.
export const MAX_PROJECTION_HEAP_BYTES = 2048 * 1024 * 1024;
// Close to OCCT's 4 GiB WASM ceiling: always recycle rather than risk an out-of-memory crash mid-command.
export const HARD_WORKER_HEAP_BYTES = 2560 * 1024 * 1024;
export function shouldRecycleWorker(evaluations: number, heapBytes: number, projection = false, grewBytes = 0): boolean {
  if (evaluations >= MAX_WORKER_EVALUATIONS || heapBytes >= HARD_WORKER_HEAP_BYTES) return true;
  return evaluations > 1 && grewBytes > 0 && heapBytes >= (projection ? MAX_PROJECTION_HEAP_BYTES : MAX_WORKER_HEAP_BYTES);
}
