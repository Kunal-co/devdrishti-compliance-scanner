// src/pages/api/ocr.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import formidable from 'formidable';
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

async function callVisionApi(base64Image: string) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY is not set in environment');

  const endpoint = `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`;

  const body = {
    requests: [
      {
        image: { content: base64Image },
        features: [
          { type: 'TEXT_DETECTION', maxResults: 1 },
          // Optionally include DOCUMENT_TEXT_DETECTION if you need layout-aware results:
          // { type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }
        ],
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

  const form = new formidable.IncomingForm({ multiples: false });
  form.parse(req, async (err, _fields, files) => {
    if (err) {
      console.error('form parse error', err);
      res.status(500).json({ error: 'Upload parse error' });
      return;
    }

    const imageFile = (files as any).image;
    if (!imageFile) {
      res.status(400).json({ error: 'No image uploaded' });
      return;
    }

    try {
      const buffer = fs.readFileSync(imageFile.filepath || imageFile.path);
      const base64Image = buffer.toString('base64');

      const visionResp = await callVisionApi(base64Image);

      // Parse response: prefer fullTextAnnotation (DOCUMENT_TEXT_DETECTION) or textAnnotations
      const resp0 = visionResp?.responses?.[0] || {};
      const fullText = resp0.fullTextAnnotation?.text || resp0?.textAnnotations?.[0]?.description || '';

      // Build token-level annotations from textAnnotations[1..]
      const rawAnnotations = (resp0.textAnnotations || []).slice(1).map((a: any) => {
        // Vision sometimes returns boundingPoly with vertices; vertices may omit x/y for some vertices.
        return {
          description: a.description,
          boundingPoly: a.boundingPoly,
        } as Annotation;
      });

      res.status(200).json({ text: fullText, annotations: rawAnnotations });
    } catch (e: any) {
      console.error('OCR handler error', e);
      res.status(500).json({ error: e?.message || 'OCR processing error' });
    }
  });
}
