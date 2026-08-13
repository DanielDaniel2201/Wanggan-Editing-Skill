import { videoRenderer } from "./video.mjs";
import { captionsRenderer } from "./captions.mjs";
import { textGroupRenderer } from "./text-group.mjs";
import { imageRenderer } from "./image.mjs";

const RENDERERS = [videoRenderer, captionsRenderer, textGroupRenderer, imageRenderer];

export function registerBuiltinRenderers(registry) {
  for (const renderer of RENDERERS) {
    registry.registerAssetRenderer(renderer.id, renderer);
  }
}
