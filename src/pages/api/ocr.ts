// src/pages/api/ocr.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs';

export const config = {
  api: {
    bodyParser: false,
  },
};

type Annotation = {
  description?: string;
  boundingPoly?: { vertices?: { x?: number; y?: number }[] };
};
type Data = { text?: string; annotations?: Annotation[]; error?: string };

async function createFormParser(opts = { multiples: false }) {
  // dynamic import so bundler doesn't try to eagerly resolve the package at build time
  const pkg = await import('formidable').catch((e) => {
    // If import failed, rethrow with helpful message
    throw new Error('Failed to import formidable: ' + String(e));
  });

  // pkg may be { default: [Function] } or the function itself or module with IncomingForm constructor
  const mod: any = (pkg && pkg.default) ? pkg.default : pkg;

  // If mod is a function (factory style), call it:
  if (typeof mod === 'function') {
    try {
      return mod(opts);
    } catch (e) {
      // continue to other strategies
    }
  }

  // If mod.IncomingForm exists as a constructor, use that:
  if (mod && typeof mod.IncomingForm === 'function') {
    return new mod.IncomingForm(opts);
  }

  // Fallback: if the module itself has parse method
  if (mod && typeof mod.parse === 'function') {
    return mod;
  }

  throw new Error('Unsupported formidable export shape. Upgrade/downgrade formidable or adjust parser code.');
}

function parseForm(req: NextApiRequest) {
  return new Promise<{ fields: any; files: any }>(async (resolve, reject) => {
    try {
      const form = await createFormParser({ multiples: false });

      // If form has parse as function (the normal API)
      if (typeof (form as any).parse === 'function') {
        (form as any).parse(req, (err: any, fields: any, files: any) => {
          if (err) return reject(err);
          resolve({ fields, files });
        });
        return;
      }

      // If we reach here, we couldn't find a parse function
      reject(new Error('formidable parser does not provide parse(req, cb)'));
    } catch (err) {
      reject(err);
    }
  });
}

async function callVisionApiWithBase64(base64Image: string) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY is not set in environment');

  const endpoint = `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`;

  const body = {
    requests: [
      {
        image: { content: base64Image },
        features: [{ type: 'TEXT_DETECTION', maxResults: 1 }],
      },
    ],
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Vision API error ${res.status}: ${t}`);
  }

  const json = await res.json();
  return json;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Data>) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { files } = await parseForm(req);
    const imageFile = (files as any).image;
    if (!imageFile) {
      res.status(400).json({ error: 'No image uploaded' });
      return;
    }

    const buffer = fs.readFileSync(imageFile.filepath || imageFile.path);
    const base64Image = buffer.toString('base64');

    const visionResp = await callVisionApiWithBase64(base64Image);
    const resp0 = visionResp?.responses?.[0] || {};
    const fullText = resp0.fullTextAnnotation?.text || resp0?.textAnnotations?.[0]?.description || '';

    const rawAnnotations = (resp0.textAnnotations || []).slice(1).map((a: any) => ({
      description: a.description,
      boundingPoly: a.boundingPoly,
    }));

    res.status(200).json({ text: fullText, annotations: rawAnnotations });
  } catch (err: any) {
    // Log server-side
    console.error('ocr api error:', err && err.stack ? err.stack : err);
    // Respond with JSON so client won't try to parse HTML
    res.status(500).json({ error: err?.message ?? 'OCR processing error' });
  }
}
