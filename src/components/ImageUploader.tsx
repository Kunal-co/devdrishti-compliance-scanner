import React, { useState } from 'react';

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
};

export default function ImageUploader({ onResult }: Props) {
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const handleFile = (file: File | null) => {
    if (!file) return;
    setFilePreview(URL.createObjectURL(file));
    uploadFile(file);
  };

  const uploadFile = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('image', file);

      const res = await fetch('/api/ocr', {
        method: 'POST',
        body: fd,
      });
      const data = await res.json();
      // Expect server to return { text: '...', annotations: [...] }
      onResult(file, { text: data.text || '', annotations: data.annotations || [] });
    } catch (err) {
      console.error('Upload/ocr error', err);
      onResult(file, { text: '', annotations: [] });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <input
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
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
            input.onchange = () => handleFile(input.files ? input.files[0] : null);
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

      {uploading && <div>Processing OCR…</div>}
    </div>
  );
}
