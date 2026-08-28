import React, { useState, useImperativeHandle, forwardRef } from 'react';
import Tesseract from 'tesseract.js';

type AnnotationVertex = { x?: number; y?: number };
type Annotation = {
  description?: string;
  boundingPoly?: { vertices?: AnnotationVertex[] };
};

type OCRResult = {
  text?: string;
  annotations?: Annotation[];
};

type Props = {
  onResult: (file: File | null, result: OCRResult) => void;
  autoUpload?: boolean;
  onError?: (message: string) => void;
};

export type ImageUploaderHandle = {
  uploadSelected: () => Promise<void>;
  hasSelected: () => boolean;
};

function getImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

const ImageUploader = forwardRef<ImageUploaderHandle, Props>(({ onResult, autoUpload = true, onError }, ref) => {
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleFileSelect = (file: File | null) => {
    if (!file) return;
    setFilePreview(URL.createObjectURL(file));
    setSelectedFile(file);
    if (autoUpload) runOcr(file);
  };

  const runOcr = async (file: File) => {
    setUploading(true);
    setProgress(0);
    setErrorMsg(null);
    try {
      const { width, height } = await getImageDimensions(file);

      const { data } = await Tesseract.recognize(file, 'eng', {
        logger: (m) => {
          if (m.status === 'recognizing text') setProgress(Math.round(m.progress * 100));
        },
      });

      // Convert Tesseract's pixel-space line boxes into the same
      // normalized {description, boundingPoly:{vertices}} shape the
      // rest of the app (scan.tsx overlay, verify.tsx) already expects.
      const annotations: Annotation[] = (data.lines || [])
        .filter((line) => line.text && line.text.trim().length > 0)
        .map((line) => {
          const { x0, y0, x1, y1 } = line.bbox;
          const vertices: AnnotationVertex[] = [
            { x: x0 / width, y: y0 / height },
            { x: x1 / width, y: y0 / height },
            { x: x1 / width, y: y1 / height },
            { x: x0 / width, y: y1 / height },
          ];
          return { description: line.text.trim(), boundingPoly: { vertices } };
        });

      onResult(file, { text: data.text || '', annotations });
    } catch (err: any) {
      console.error('Tesseract OCR error', err);
      const message = err?.message || 'OCR processing failed';
      setErrorMsg(message);
      onError?.(message);
      onResult(file, { text: '', annotations: [] });
    } finally {
      setUploading(false);
    }
  };

  useImperativeHandle(ref, () => ({
    uploadSelected: async () => {
      if (!selectedFile) return Promise.resolve();
      await runOcr(selectedFile);
    },
    hasSelected: () => !!selectedFile,
  }));

  return (
    <div className="space-y-4">
      <div>
        <input
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(e) => handleFileSelect(e.target.files?.[0] ?? null)}
        />
      </div>

      <div>
        <button
          type="button"
          onClick={() => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.capture = 'environment';
            input.onchange = () => handleFileSelect(input.files ? input.files[0] : null);
            input.click();
          }}
          className="px-3 py-2 bg-blue-600 text-white rounded"
        >
          Take photo / Upload
        </button>
      </div>

      {filePreview && (
        <div>
          <img src={filePreview} alt="preview" style={{ maxWidth: '100%', height: 'auto' }} />
        </div>
      )}

      {!autoUpload && selectedFile && (
        <div>
          <button
            type="button"
            onClick={() => runOcr(selectedFile)}
            disabled={uploading}
            className="mt-2 px-4 py-2 bg-indigo-600 text-white rounded"
          >
            {uploading ? `Scanning… ${progress}%` : 'Upload to OCR'}
          </button>
          <button
            type="button"
            onClick={() => { setSelectedFile(null); setFilePreview(null); }}
            className="ml-2 mt-2 px-4 py-2 bg-gray-200 text-gray-800 rounded"
          >
            Remove
          </button>
        </div>
      )}

      {autoUpload && uploading && <div>Scanning… {progress}%</div>}

      {errorMsg && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
          ⚠ {errorMsg}
        </div>
      )}
    </div>
  );
});

export default ImageUploader;
