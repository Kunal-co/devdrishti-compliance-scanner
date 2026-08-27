import type { NextApiRequest, NextApiResponse } from 'next';
import formidable from 'formidable';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ImageAnnotatorClient } from '@google-cloud/vision';

export const config = {
  api: {
    bodyParser: false,
  },
};

type Data = { text?: string; error?: string };

async function initVisionClient(): Promise<ImageAnnotatorClient> {
  // If the service account JSON is provided as a base64 env var (GOOGLE_SERVICE_ACCOUNT),
  // decode it and write to a temp file so the client library can pick it up.
  const base64 = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (base64) {
    const json = Buffer.from(base64, 'base64').toString('utf8');
    const tmpDir = os.tmpdir();
    const tmpPath = path.join(tmpDir, `gcloud-sa-${Date.now()}.json`);
    fs.writeFileSync(tmpPath, json, { encoding: 'utf8' });
    process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpPath;
  }

  return new ImageAnnotatorClient();
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
      res.status(500).json({ error: 'Upload error' });
      return;
    }

    const imageFile = (files as any).image;
    if (!imageFile) {
      res.status(400).json({ error: 'No image uploaded' });
      return;
    }

    try {
      const client = await initVisionClient();
      const buffer = fs.readFileSync(imageFile.filepath || imageFile.path);

      // Call Google Cloud Vision text detection
      const [result] = await client.textDetection({ image: { content: buffer } });
      const fullText = result.fullTextAnnotation?.text ?? '';

      res.status(200).json({ text: fullText });
    } catch (e) {
      console.error('OCR error', e);
      res.status(500).json({ error: 'OCR processing error' });
    }
  });
}
