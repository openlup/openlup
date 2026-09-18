import OpenAI from 'openai';
import { toFile } from 'openai/uploads';

let client: OpenAI | null = null;
export function readOpenAiApiKey(env: Record<string, string | undefined> = process.env): string {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY missing');
  return apiKey;
}

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: readOpenAiApiKey() });
  }
  return client;
}

function buildFreePrompt(preserveTexts: string[]): string {
  const quoted = preserveTexts.map((t) => `  • "${t}"`).join('\n');
  return `Replace the dog in the first image with the dog from the second image.

Preserve the label design exactly. The first image's label contains the following text — keep every character byte-for-byte, including Polish diacritics (ł ą ę ż ć ó ń ś ź) and all percentage values:

${quoted}

Do NOT translate, paraphrase, or improve any text. Do NOT change colors, fonts, badge layout, brand mark, or any design element. Only the central dog photo should change.`;
}

function buildMaskPrompt(): string {
  return `Place the dog from the second image into the transparent region of the first image. Match the studio lighting and color palette of the surrounding label. Make the integration seamless — natural framing, no harsh edges. Do not modify anything outside the transparent region.`;
}

export const imageGenFacade = {
  /** Free-form swap: model regenerates the whole label. Faster, 3D rendering, but
   *  Polish text can drift. Use as primary attempt. */
  async swapDogOnCan(
    labelPng: Buffer,
    dogPng: Buffer,
    preserveTexts: string[],
  ): Promise<Buffer> {
    const res = await getClient().images.edit({
      model: 'gpt-image-1',
      image: [
        await toFile(labelPng, 'label.png', { type: 'image/png' }),
        await toFile(dogPng, 'dog.png', { type: 'image/png' }),
      ],
      prompt: buildFreePrompt(preserveTexts),
      quality: 'high',
      size: '1024x1536',
    });
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) throw new Error('image gen returned no data');
    return Buffer.from(b64, 'base64');
  },

  /** Mask-based swap: model only edits where mask is transparent. Text/design
   *  outside the mask are byte-perfect from the input label. Flat 2D result. */
  async swapDogOnCanWithMask(
    labelPng: Buffer,
    dogPng: Buffer,
    maskPng: Buffer,
  ): Promise<Buffer> {
    const res = await getClient().images.edit({
      model: 'gpt-image-1',
      image: [
        await toFile(labelPng, 'label.png', { type: 'image/png' }),
        await toFile(dogPng, 'dog.png', { type: 'image/png' }),
      ],
      mask: await toFile(maskPng, 'mask.png', { type: 'image/png' }),
      prompt: buildMaskPrompt(),
      quality: 'high',
      size: '1024x1536',
    });
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) throw new Error('image gen returned no data');
    return Buffer.from(b64, 'base64');
  },
};
