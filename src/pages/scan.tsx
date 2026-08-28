import { useState, useRef } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import Link from 'next/link';
import { useInspectionStore } from '@/store/inspectionStore';
import { useAuthStore } from '@/store/authStore';
import mockOCRDatabase from '@/data/mockOCRDatabase.json';
import { ExtractionResult, Finding } from '@/types';
import ImageUploader, { ImageUploaderHandle } from '@/components/ImageUploader';

type Annotation = { description?: string; boundingPoly?: { vertices?: { x?: number; y?: number }[] } };

export default function Scan() {
  const router = useRouter();
  const inspector = useAuthStore((state) => state.inspector);
  const createInspection = useInspectionStore((state) => state.createInspection);
  const addFinding = useInspectionStore((state) => state.addFinding);
  const addProductImage = useInspectionStore((s: any) => s.addProductImage);
  const addOcrAnnotations = useInspectionStore((s: any) => s.addOcrAnnotations);

  const [productName, setProductName] = useState('');
  const [category, setCategory] = useState('');
  const [location, setLocation] = useState('');
  const [selectedProduct, setSelectedProduct] = useState<string>('');
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractionResult, setExtractionResult] = useState<ExtractionResult | null>(null);
  const [uploadedImageUrl, setUploadedImageUrl] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [uploaderRunning, setUploaderRunning] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const uploaderRef = useRef<ImageUploaderHandle | null>(null);

  const products = Object.keys(mockOCRDatabase);

  function parseOcrIntoExtractionResult(ocrText: string, ocrAnnotations: Annotation[] = []): ExtractionResult {
    const lines = ocrText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const name = productName || lines[0] || selectedProduct || 'Unknown product';
    const now = new Date().toISOString();

    // Field patterns, checked in this order. One line can satisfy at most
    // ONE field, and once a field is filled it is locked — this is what
    // stops something like the MRP line from also being read into, say,
    // batch number, and vice versa.
    const fieldPatterns: Record<string, RegExp> = {
      mrp: /(mrp)?[:\s]*(rs\.?|₹|inr)\s?\d+(?:[.,]\d+)?/i,
      net_quantity: /\b\d+(?:[.,]\d+)?\s*(g|kg|ml|l)\b/i,
      date_of_manufacture: /(mfg|manufactur(ed|ing))?\s*(date)?[:\s]*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/i,
      batch_number: /(batch|lot)\s*(no\.?)?[:\s]*[\w-]+/i,
      country_of_origin: /country\s*of\s*origin[:\s]*[\w\s]+/i,
      consumer_care: /(consumer|customer)\s*care[:\s].+/i,
      manufacturer_name: /(mfd|manufactured)\s*by[:\s].+/i,
      manufacturer_address: /(address|regd\.?\s*office)[:\s].+/i,
    };

    const assignedLineIdx = new Set<number>();
    const found: Record<string, { value: string; bbox?: Annotation['boundingPoly'] }> = {};

    lines.forEach((line, idx) => {
      if (assignedLineIdx.has(idx)) return;
      for (const [field, pattern] of Object.entries(fieldPatterns)) {
        if (found[field]) continue; // field already locked, skip
        if (pattern.test(line)) {
          const matchingAnnotation = ocrAnnotations.find((a) => a.description === line);
          found[field] = { value: line, bbox: matchingAnnotation?.boundingPoly };
          assignedLineIdx.add(idx);
          break;
        }
      }
    });

    const makeField = (field: string) => ({
      value: found[field]?.value ?? '',
      confidence: found[field] ? 0.85 : 0.4,
      bounding_box: found[field]?.bbox ? JSON.stringify(found[field]!.bbox) : '',
      status: (found[field] ? 'extracted' : 'needs_review') as 'extracted' | 'needs_review',
    });

    const extractions: any = {
      product_name: { value: name, confidence: 0.9, bounding_box: '', status: 'extracted' },
      net_quantity: makeField('net_quantity'),
      mrp: makeField('mrp'),
      manufacturer_name: makeField('manufacturer_name'),
      manufacturer_address: makeField('manufacturer_address'),
      date_of_manufacture: makeField('date_of_manufacture'),
      consumer_care: makeField('consumer_care'),
      country_of_origin: makeField('country_of_origin'),
      batch_number: makeField('batch_number'),
    };

    return {
      product_id: selectedProduct || `OCR-${Date.now()}`,
      product_name: name,
      category: category || 'unknown',
      timestamp: now,
      extractions,
    };
  }
  // Called by ImageUploader via onResult(file, { text, annotations })
  const handleOcrResult = (file: File | null, result: { text?: string; annotations?: Annotation[] }) => {
    if (file) setUploadedImageUrl(URL.createObjectURL(file));
    const text = result?.text ?? '';
    const res = parseOcrIntoExtractionResult(text, result.annotations || []);
    setExtractionResult(res);
    setAnnotations(result.annotations || []);
    setUploaderRunning(false);
  };

  const handleExtractFallback = async () => {
    if (!selectedProduct) {
      alert('Select a mock product or upload an image to extract from.');
      return;
    }
    setIsExtracting(true);
    setTimeout(() => {
      const mockData = mockOCRDatabase[selectedProduct as keyof typeof mockOCRDatabase];
      setExtractionResult(mockData as any);
      setIsExtracting(false);
    }, 600);
  };

  const handleStartInspection = () => {
    if (!extractionResult) return;

    createInspection(inspector?.id, inspector?.name, inspector?.badge_number, extractionResult.product_name, extractionResult.category, location || 'Unknown');

    if (uploadedImageUrl) addProductImage(uploadedImageUrl);
    if (annotations.length) addOcrAnnotations(annotations);

    Object.entries(extractionResult.extractions).forEach(([field, data]) => {
      const mockFinding: Finding = {
        field,
        rule_id: `R${Math.floor(Math.random() * 10) + 1}`.padStart(3, '0'),
        ai_extraction: (data as any).value,
        ai_confidence: (data as any).confidence,
        ai_recommendation: (data as any).status === 'extracted' ? 'PASS' : 'NEEDS_REVIEW',
        evidence_link: uploadedImageUrl || '',
        reason: (data as any).flag || 'Data extracted from OCR',
      };
      addFinding(mockFinding);
    });

    // small tick to ensure state set before navigation
    setTimeout(() => router.push('/verify'), 50);
  };

  // compute overlay style, supports normalized (0..1) or pixel coords
  const computeBoxStyle = (vertices?: { x?: number; y?: number }[]) => {
    if (!imgRef.current || !vertices || vertices.length === 0) return {};
    const img = imgRef.current;
    const natW = img.naturalWidth || img.width || 1;
    const natH = img.naturalHeight || img.height || 1;
    const displayW = img.clientWidth || 1;
    const displayH = img.clientHeight || 1;
    const isNormalized = vertices.every((v) => (v.x || 0) <= 1 && (v.y || 0) <= 1);
    const scaled = vertices.map((v) => ({
      x: (v.x || 0) * (isNormalized ? natW : 1),
      y: (v.y || 0) * (isNormalized ? natH : 1),
    }));
    const scaleX = displayW / natW;
    const scaleY = displayH / natH;
    const xs = scaled.map((v) => v.x * scaleX);
    const ys = scaled.map((v) => v.y * scaleY);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    const right = Math.max(...xs);
    const bottom = Math.max(...ys);
    return {
      left: `${left}px`,
      top: `${top}px`,
      width: `${Math.max(1, right - left)}px`,
      height: `${Math.max(1, bottom - top)}px`,
    } as React.CSSProperties;
  };

  const hasSelected = uploaderRef.current?.hasSelected() ?? false;

  return (
    <>
      <Head>
        <title>Scan & Extract - DevDrishti</title>
      </Head>

      <div className="min-h-screen bg-gray-50">
        <header className="bg-white shadow">
          <div className="max-w-7xl mx-auto px-4 py-6 flex justify-between items-center">
            <h1 className="text-2xl font-bold text-gray-900">📷 Scan & Extract</h1>
            <Link href="/dashboard" className="text-blue-600 hover:text-blue-800 font-medium">
              ← Back to Dashboard
            </Link>
          </div>
        </header>

        <main className="max-w-4xl mx-auto px-4 py-8">
          {!extractionResult ? (
            <div className="bg-white rounded-lg shadow p-8">
              <h2 className="text-xl font-bold text-gray-800 mb-6">Product Details</h2>

              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Select Mock Product</label>
                  <select
                    value={selectedProduct}
                    onChange={(e) => setSelectedProduct(e.target.value)}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">Choose a product...</option>
                    {products.map((p) => (
                      <option key={p} value={p}>
                        {mockOCRDatabase[p as keyof typeof mockOCRDatabase].product_name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Product Name (Override)</label>
                  <input
                    type="text"
                    value={productName}
                    onChange={(e) => setProductName(e.target.value)}
                    placeholder="Enter product name (optional)"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Category</label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">Select category...</option>
                    <option value="FMCG - Personal Care">FMCG - Personal Care</option>
                    <option value="FMCG - Cooking Oil">FMCG - Cooking Oil</option>
                    <option value="Food - Biscuits">Food - Biscuits</option>
                    <option value="Food - Dairy">Food - Dairy</option>
                    <option value="Medicines">Medicines</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Store Location</label>
                  <input
                    type="text"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    placeholder="e.g., Mumbai Store, Bangalore Market"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div className="bg-gray-50 p-4 rounded">
                  <h3 className="font-semibold">Upload / Take Picture</h3>
                  <p className="text-sm text-gray-600 mb-3">Use your device camera or upload an image of the product label.</p>
                  <ImageUploader ref={uploaderRef} onResult={handleOcrResult} autoUpload={false} />
                  {hasSelected && !extractionResult && (
                    <p className="text-sm text-gray-600 mt-2">File ready — click “Upload image to OCR” to extract values.</p>
                  )}
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={handleExtractFallback}
                    disabled={isExtracting}
                    className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-bold py-3 px-4 rounded-lg transition-colors"
                  >
                    Use selected mock product
                  </button>

                  <button
                    onClick={async () => {
                      if (!uploaderRef.current) {
                        alert('Choose an image first.');
                        return;
                      }
                      try {
                        setUploaderRunning(true);
                        await uploaderRef.current.uploadSelected();
                      } catch (err) {
                        console.error('OCR upload error', err);
                        alert('OCR upload failed — check console/logs.');
                        setUploaderRunning(false);
                      }
                    }}
                    className="flex-1 bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-3 px-4 rounded-lg transition-colors"
                  >
                    {uploaderRunning ? 'Processing OCR…' : 'Upload image to OCR'}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="bg-white rounded-lg shadow p-8">
                <h2 className="text-xl font-bold text-gray-800 mb-6">Extraction Results</h2>

                {uploadedImageUrl && (
                  <div className="mb-4 relative">
                    <img ref={imgRef} src={uploadedImageUrl} alt="uploaded" style={{ maxWidth: '100%', height: 'auto' }} onLoad={() => { /* force reflow for overlays */ }} />
                    <div style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, pointerEvents: 'none' }}>
                      {annotations.map((a, i) => (
                        <div key={i} style={{ position: 'absolute', border: '2px solid rgba(59,130,246,0.8)', background: 'rgba(59,130,246,0.08)', borderRadius: 4, ...computeBoxStyle(a.boundingPoly?.vertices) }} />
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-4">
                  {Object.entries(extractionResult.extractions).map(([field, data]) => (
                    <div key={field} className="border border-gray-200 rounded-lg p-4">
                      <div className="flex justify-between items-start gap-4">
                        <div className="flex-1">
                          <h3 className="font-bold text-gray-800 capitalize">{field.replace(/_/g, ' ')}</h3>
                          <input
                            type="text"
                            value={(data as any).value}
                            onChange={(e) => {
                              setExtractionResult((prev) => {
                                if (!prev) return prev;
                                return {
                                  ...prev,
                                  extractions: {
                                    ...prev.extractions,
                                    [field]: {
                                      ...(prev.extractions as any)[field],
                                      value: e.target.value,
                                      status: 'extracted',
                                    },
                                  },
                                };
                              });
                            }}
                            className="mt-1 w-full px-3 py-2 border border-gray-300 rounded"
                          />
                        </div>

                        <div className="text-right">
                          <span className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${(data as any).status === 'extracted' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'}`}>
                            {(data as any).status === 'extracted' ? '✓ Extracted' : '⚠ Review'}
                          </span>
                          <p className="text-xs text-gray-500 mt-2">{Math.round((data as any).confidence * 100)}% confidence</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex gap-4">
                <button onClick={() => { setExtractionResult(null); setUploadedImageUrl(null); setAnnotations([]); }} className="flex-1 bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-2 px-4 rounded-lg transition-colors">← Back</button>
                <button
                  onClick={handleStartInspection}
                  disabled={!extractionResult}
                  className={`flex-1 font-bold py-2 px-4 rounded-lg transition-colors ${extractionResult ? 'bg-green-600 hover:bg-green-700 text-white' : 'bg-gray-200 text-gray-600 cursor-not-allowed'}`}
                >
                  ✓ Continue to Verification
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
    </>
  );
}
