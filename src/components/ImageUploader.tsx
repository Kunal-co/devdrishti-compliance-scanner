import React, { useState, useImperativeHandle, forwardRef } from 'react';

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
  autoUpload?: boolean; // if false, wait for user to click "Upload to OCR"
  onError?: (message: string) => void;
};

export type ImageUploaderHandle = {
  uploadSelected: () => Promise<void>;
  hasSelected: () => boolean;
};

const ImageUploader = forwardRef<ImageUploaderHandle, Props>(({ onResult, autoUpload = true, onError }, ref) => {
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleFileSelect = (file: File | null) => {
    if (!file) return;
    setFilePreview(URL.createObjectURL(file));
    setSelectedFile(file);
    if (autoUpload) uploadFile(file);
  };

  const uploadFile = async (file: File) => {
    setUploading(true);
    setErrorMsg(null);
    try {
      const fd = new FormData();
      fd.append('image', file);

      const res = await fetch('/api/ocr', {
        method: 'POST',
        body: fd,
      });

      let data: any = null;
      try {
        data = await res.json();
      } catch {
        throw new Error(`OCR request failed (status ${res.status})`);
      }

      if (!res.ok) {
        throw new Error(data?.error || `OCR request failed (status ${res.status})`);
      }

      // Expect server to return { text: '...', annotations: [...] }
      onResult(file, { text: data.text || '', annotations: data.annotations || [] });
    } catch (err: any) {
      console.error('Upload/ocr error', err);
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
      await uploadFile(selectedFile);
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
            onClick={() => uploadFile(selectedFile)}
            disabled={uploading}
            className="mt-2 px-4 py-2 bg-indigo-600 text-white rounded"
          >
            {uploading ? 'Processing OCR…' : 'Upload to OCR'}
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

      {autoUpload && uploading && <div>Processing OCR…</div>}

      {errorMsg && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
          ⚠ {errorMsg}
        </div>
      )}
    </div>
  );
});

export default ImageUploader;
