/**
 * Calls `onLost` once when the canvas loses its WebGL context, which low-memory devices do at any time, not only at
 * start. The default is prevented so the browser may hand the context back, though the inspector does not wait for it.
 * Returns the function that stops listening.
 */
export function watchContextLoss(canvas: EventTarget, onLost: () => void): () => void {
  let fired = false;
  const lost = (e: Event) => {
    e.preventDefault();
    if (fired) return;
    fired = true;
    onLost();
  };
  canvas.addEventListener("webglcontextlost", lost);
  return () => canvas.removeEventListener("webglcontextlost", lost);
}

