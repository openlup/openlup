import sharp from 'sharp';

export interface DogZone {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Cocker spaniel bounding box on PL labels (measured against public/labels/lamb_front.png).
// Used as the editable region in mask-based generation.
export const DOG_ZONE: DogZone = { x: 383, y: 920, w: 957, h: 580 };

export const maskGenerator = {
  /** Builds a mask matching the label dimensions: transparent in `zone`, opaque elsewhere.
   *  OpenAI's images.edit only modifies transparent regions; opaque pixels stay byte-perfect. */
  async forLabel(labelPng: Buffer, zone: DogZone = DOG_ZONE): Promise<Buffer> {
    const meta = await sharp(labelPng).metadata();
    const W = meta.width;
    const H = meta.height;
    if (!W || !H) throw new Error('label has no dimensions');

    const top = zone.y;
    const left = zone.x;
    const bottom = H - zone.y - zone.h;
    const right = W - zone.x - zone.w;

    return sharp({
      create: { width: zone.w, height: zone.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .extend({ top, bottom, left, right, background: { r: 0, g: 0, b: 0, alpha: 1 } })
      .png()
      .toBuffer();
  },
};
