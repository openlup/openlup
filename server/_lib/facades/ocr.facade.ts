import OpenAI from 'openai';

const SYSTEM_PROMPT = `You are an OCR assistant. Read all visible text in the provided product label image and return ONLY a valid JSON array of strings — one element per distinct text block. Preserve every character exactly, including Polish diacritics (ł, ą, ę, ż, ć, ó, ń, ś, ź) and percentage signs. Do not translate, do not paraphrase, do not add explanations. Output JSON only.`;

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

export const ocrFacade = {
  async readText(imagePng: Buffer): Promise<string[]> {
    const base64 = imagePng.toString('base64');
    const res = await getClient().chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 500,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${base64}`, detail: 'high' },
            },
          ],
        },
      ],
    });
    const raw = res.choices?.[0]?.message?.content?.trim() ?? '[]';
    return parseStrict(raw);
  },
};

function parseStrict(raw: string): string[] {
  const stripped = raw.replace(/^```(?:json)?/, '').replace(/```$/, '').trim();
  try {
    const parsed = JSON.parse(stripped) as unknown;
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return parsed as string[];
    }
  } catch {
    // fall through
  }
  return [];
}
