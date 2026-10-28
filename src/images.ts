// Image input: read a screenshot or picture from disk into a form the model adapters can send.
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

export type Image = { mime: string; data: string };
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024, MAX_IMAGES = 4;
export const isImagePath = (p: string) => extname(p).toLowerCase() in MIME;
/** Read an image file as base64. Throws a readable error when it is too big or not an image. */
export function readImage(path: string): Image {
  const mime = MIME[extname(path).toLowerCase()]; if (!mime) throw new Error(`${path}: not a supported image (png, jpg, gif, webp)`);
  const size = statSync(path).size; if (size > MAX_IMAGE_BYTES) throw new Error(`${path}: ${(size / 1048576).toFixed(1)} MB is over the ${MAX_IMAGE_BYTES / 1048576} MB limit`);
  return { mime, data: readFileSync(path).toString("base64") };
}
/**
 * Does this model take images? OpenAI and Claude models do; for local servers it is a guess from the model name (llava, vision, -vl, gemma3, minicpm-v, pixtral, ...),
 * so a text-only model gets a clear message instead of an obscure server error.
 */
export function visionLikely(provider: string, model: string): boolean {
  if (provider === "anthropic") return true;
  if (provider === "openai") return !/^(gpt-3|gpt-4(-0|-32k)?$|o1-mini|o1-preview|text-|davinci)/i.test(model);
  return /llava|vision|[-_:.]vl\b|[-_]vl[-_:]|gemma-?3|minicpm-v|pixtral|llama-?3\.2-(11|90)b|moondream|bakllava|internvl|qwen.*vl|glm-4v|mistral-small-?3/i.test(model);
}
