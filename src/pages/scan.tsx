import { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import Link from 'next/link';
import { useInspectionStore } from '@/store/inspectionStore';
import { useAuthStore } from '@/store/authStore';
import mockOCRDatabase from '@/data/mockOCRDatabase.json';
import { ExtractionResult, Finding } from '@/types';
import ImageUploader, { ImageUploaderHandle } from '@/components/ImageUploader';

type Vertex = { x?: number; y?: number };
type Annotation = { description?: string; boundingPoly?: { vertices?: Vertex[] }; level?: 'line' | 'word' };

const FIELD_ORDER = [
  'net_quantity',
  'mrp',
  'manufacturer',
  'date_of_manufacture',
  'batch_number',
  'country_of_origin',
  'consumer_care',
] as const;

const FIELD_PATTERNS: Record<string, RegExp> = {
  mrp: /(mrp|m\.r\.p\.?|maximum retail price)[:\s]*(rs\.?|₹|inr)?\s?\d+(?:[.,]\d+)?/i,
  net_quantity: /\b(net\s*(qty|quantity|wt|weight)[:\s]*)?\d+(?:[.,]\d+)?\s*(g|gm|gms|kg|ml|l|ltr|litre)\b/i,
  date_of_manufacture:
    /(mfg|manufactur(ed|ing)|pack(ed|ing))?\s*date[:\s]*\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/i,
  batch_number: /(batch|lot)\s*(no\.?|number)?[:\s]*[\w-]+/i,
  country_of_origin: /country\s*of\s*origin[:\s]*.+/i,
  consumer_care: /(consumer|customer)\s*care[:\s]*.+/i,
  manufacturer: /(manufactur(er|ed|ing)?|mfr\.?)\s*(by|name)?[:\s]+.+/i,
};

// Patterns where a line is just the label (to be merged with next line)
const LABEL_ONLY_PATTERNS: RegExp[] = [
  /^(mrp|m\.r\.p\.?|maximum retail price)\s*[:\-]?\s*$/i,
  /^net\s*(qty|quantity|wt|weight)\s*[:\-]?\s*$/i,
  /^(mfg|manufactur(ed|ing)|pack(ed|ing))?\s*date\s*[:\-]?\s*$/i,
  /^(batch|lot)\s*(no\.?|number)?\s*[:\-]?\s*$/i,
  /^country\s*of\s*origin\s*[:\-]?\s*$/i,
  /^(consumer|customer)\s*care\s*[:\-]?\s*$/i,
  /^(manufactur(er|ed|ing)?|mfr\.?)\s*(by|name)?\s*[:\-]?\s*$/i,
];
const isLabelOnly = (line: string) => LABEL_ONLY_PATTERNS.some((p) => p.test(line.trim()));

const NON_TITLE_WORDS = /\b(image|photo|logo|placeholder|insert|barcode|sample photo|click here)\b/i;

function cleanText(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function unionBbox(a?: Annotation['boundingPoly'], b?: Annotation['boundingPoly']): Annotation['boundingPoly'] | undefined {
  const verts = [...(a?.vertices || []), ...(b?.vertices || [])];
  if (!verts.length) return undefined;
  const xs = verts.map((v) => v.x ?? 0);
  const ys = verts.map((v) => v.y ?? 0);
  const x0 = Math.min(...xs),
    x1 = Math.max(...xs),
    y0 = Math.min(...ys),
    y1 = Math.max(...ys);
  return { vertices: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] };
}

/** Merge label-only lines with their value line that follows */
function mergeBrokenLabelLines(
  lines: string[],
  lineAnnotations: Annotation[]
): { lines: string[]; annotations: Map<string, Annotation> } {
  const mergedLines: string[] = [];
  const annotationMap = new Map<string, Annotation>();
  const findAnno = (line: string) => lineAnnotations.find((a) => a.description === line);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isLabelOnly(line) && i + 1 < lines.length && !isLabelOnly(lines[i + 1])) {
      const next = lines[i + 1];
      const combined = cleanText(`${line} ${next}`);
      mergedLines.push(combined);
      const bbox = unionBbox(findAnno(line)?.boundingPoly, findAnno(next)?.boundingPoly);
      if (bbox) annotationMap.set(combined, { description: combined, boundingPoly: bbox, level: 'line' });
      i++;
      continue;
    }
    mergedLines.push(line);
    const a = findAnno(line);
    if (a) annotationMap.set(line, a);
  }
  return { lines: mergedLines, annotations: annotationMap };
}

/** Detect product title by clustering large/adjacent text lines near top */
function detectProductName(lines: string[], lineAnnotations: Annotation[]): { text: string; bbox?: Annotation['boundingPoly'] } | null {
  const metrics = lines
    .map((line, idx) => {
      const anno = lineAnnotations.find((a) => a.description === line);
      const vertices = anno?.boundingPoly?.vertices || [];
      const ys = vertices.map((v) => v.y ?? 0);
      const height = ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
      const topY = ys.length ? Math.min(...ys) : 1;
      const letterCount = (line.match(/[A-Za-z]/g) || []).length;
      return { line, idx, height, topY, letterCount, vertices };
    })
    .filter((m) => m.letterCount >= 2 && m.line.length <= 60 && !NON_TITLE_WORDS.test(m.line));

  if (!metrics.length) return null;

  const topCandidates = metrics.filter((m) => m.topY <= 0.6);
  const pool = topCandidates.length ? topCandidates : metrics;

  const tallest = [...pool].sort((a, b) => b.height - a.height)[0];
  const band = pool.filter((m) => tallest.height === 0 || Math.abs(m.height - tallest.height) / tallest.height < 0.35);
  band.sort((a, b) => a.idx - b.idx);
  const tallestPos = band.findIndex((b) => b.idx === tallest.idx);
  let start = tallestPos,
    end = tallestPos;
  while (start > 0 && band[start - 1].idx === band[start].idx - 1) start--;
  while (end < band.length - 1 && band[end + 1].idx === band[end].idx + 1) end++;
  const cluster = band.slice(start, end + 1);

  const text = cleanText(cluster.map((c) => c.line).join(' '));
  const allVerts = cluster.flatMap((c) => c.vertices);
  let bbox: Annotation['boundingPoly'] | undefined;
  if (allVerts.length) {
    const xs = allVerts.map((v) => v.x ?? 0),
      ys = allVerts.map((v) => v.y ?? 0);
    bbox = {
      vertices: [
        { x: Math.min(...xs), y: Math.min(...ys) },
        { x: Math.max(...xs), y: Math.min(...ys) },
        { x: Math.max(...xs), y: Math.max(...ys) },
        { x: Math.min(...xs), y: Math.max(...ys) },
      ],
    };
  }
  return { text, bbox };
}

/** Improved parsing with tolerant MRP detection and word-level fallback */
function parseOcrIntoExtractionResult(ocrText: string, ocrAnnotations: Annotation[] = []): ExtractionResult {
  const rawLines = ocrText.split(/\r?\n/).map((l) => cleanText(l)).filter(Boolean);
  const lineAnnotations = ocrAnnotations.filter((a) => a.level !== 'word');
  const wordAnnotations = ocrAnnotations.filter((a) => a.level === 'word');
  const now = new Date().toISOString();

  const nameResult = detectProductName(rawLines, lineAnnotations);
  const name = cleanText((globalThis as any).__DEV__ ? '' : '') || nameResult?.text || 'Unknown product';

  // Merge label-only lines
  const { lines, annotations: mergedAnnoMap } = mergeBrokenLabelLines(rawLines, lineAnnotations);
  const findBbox = (line: string) =>
    mergedAnnoMap.get(line)?.boundingPoly ?? lineAnnotations.find((a) => a.description === line)?.boundingPoly;

  const assignedLineIdx = new Set<number>();
  const found: Record<string, { value: string; bbox?: Annotation['boundingPoly'] }> = {};

  // Tolerant patterns
  const CURRENCY_VALUE = /(?:₹|Rs\.?|INR)\s*[0-9]+(?:[.,][0-9]+)?/i;
  const NUMBER_WITH_OPTIONAL_CURRENCY = /[0-9]+(?:[.,][0-9]+)?\s*(?:₹|Rs\.?|INR)?/i;

  // First pass: line-level matches
  lines.forEach((line, idx) => {
    if (assignedLineIdx.has(idx)) return;
    if (nameResult && line === nameResult.text) return;

    for (const field of FIELD_ORDER) {
      if (found[field]) continue;
      try {
        if (FIELD_PATTERNS[field].test(line)) {
          found[field] = { value: cleanText(line), bbox: findBbox(line) };
          assignedLineIdx.add(idx);
          break;
        }
      } catch {
        // ignore regex runtime errors
      }

      // Extra handling for MRP when label/amount are separated
      if (field === 'mrp') {
        if (CURRENCY_VALUE.test(line) || /\bmrp\b/i.test(line) || /maximum\s+retail\s+price/i.test(line)) {
          const nm = line.match(CURRENCY_VALUE) || line.match(/[0-9]+(?:[.,][0-9]+)?/);
          if (nm) {
            found.mrp = { value: cleanText(line), bbox: findBbox(line) };
            assignedLineIdx.add(idx);
            break;
          }
        }
      }
    }
  });

  // Word-level fallback to assemble currency + amount windows
  if (!found.mrp && wordAnnotations.length) {
    for (let i = 0; i < wordAnnotations.length; i++) {
      const w = wordAnnotations[i];
      const txt = (w.description || '').trim();
      if (!txt) continue;

      // Token includes currency+amount
      if (CURRENCY_VALUE.test(txt) || /^(?:₹|Rs\.?|INR)\s*[0-9]/i.test(txt)) {
        const prev = wordAnnotations[i - 1]?.description || '';
        const next = wordAnnotations[i + 1]?.description || '';
        const candidate = cleanText([prev, txt, next].filter(Boolean).join(' '));
        if (NUMBER_WITH_OPTIONAL_CURRENCY.test(candidate)) {
          const bbox = unionBbox(w.boundingPoly, unionBbox(wordAnnotations[i - 1]?.boundingPoly, wordAnnotations[i + 1]?.boundingPoly));
          found.mrp = { value: candidate, bbox };
          break;
        }
      }

      // Numeric token with previous currency token
      if (/^[0-9]+(?:[.,][0-9]+)?$/.test(txt)) {
        const prev = (wordAnnotations[i - 1]?.description || '').trim();
        if (/^(?:₹|Rs\.?|INR)$/i.test(prev) || /mrp/i.test(prev)) {
          const candidate = cleanText([prev, txt].join(' '));
          const bbox = unionBbox(w.boundingPoly, wordAnnotations[i - 1]?.boundingPoly);
          found.mrp = { value: candidate, bbox };
          break;
        }
      }

      // 'MRP' token followed by amount
      if (/^mrp[:\s]*$/i.test(txt)) {
        const next = (wordAnnotations[i + 1]?.description || '').trim();
        if (NUMBER_WITH_OPTIONAL_CURRENCY.test(next) || CURRENCY_VALUE.test(next)) {
          const candidate = cleanText([txt, next].join(' '));
          const bbox = unionBbox(w.boundingPoly, wordAnnotations[i + 1]?.boundingPoly);
          found.mrp = { value: candidate, bbox };
          break;
        }
      }
    }
  }

  // Manufacturer parsing (split name and address if possible)
  let manufacturerName = '';
  let manufacturerAddress = '';
  let manufacturerBbox: Annotation['boundingPoly'] | undefined;
  if (found.manufacturer) {
    manufacturerBbox = found.manufacturer.bbox;
    const raw = found.manufacturer.value.replace(/^(manufactur(er|ed|ing)?|mfr\.?)\s*(by|name)?[:\s]+/i, '');
    const commaIdx = raw.indexOf(',');
    if (commaIdx > -1) {
      manufacturerName = cleanText(raw.slice(0, commaIdx));
      manufacturerAddress = cleanText(raw.slice(commaIdx + 1));
    } else {
      manufacturerName = cleanText(raw);
    }
  }
  if (!manufacturerAddress) {
    const addressLineIdx = lines.findIndex(
      (line, idx) =>
        !assignedLineIdx.has(idx) &&
        (!nameResult || line !== nameResult.text) &&
        /(\b\d{6}\b|road|street|nagar|city|india|pvt\.?\s*ltd)/i.test(line)
    );
    if (addressLineIdx > -1) {
      const line = lines[addressLineIdx];
      manufacturerAddress = cleanText(line);
      assignedLineIdx.add(addressLineIdx);
      if (!manufacturerBbox) manufacturerBbox = findBbox(line);
    }
  }

  const makeField = (value: string, bbox?: Annotation['boundingPoly'], baseConfidence = 0.85) => ({
    value,
    confidence: value ? baseConfidence : 0.4,
    bounding_box: bbox ? JSON.stringify(bbox) : '',
    status: (value ? 'extracted' : 'needs_review') as 'extracted' | 'needs_review',
  });

  const extractions: any = {
    product_name: makeField(nameResult?.text || '', nameResult?.bbox, 0.9),
    net_quantity: makeField(found.net_quantity?.value ?? '', found.net_quantity?.bbox),
    mrp: makeField(found.mrp?.value ?? '', found.mrp?.bbox),
    manufacturer_name: makeField(manufacturerName, manufacturerBbox),
    manufacturer_address: makeField(manufacturerAddress, manufacturerBbox),
    date_of_manufacture: makeField(found.date_of_manufacture?.value ?? '', found.date_of_manufacture?.bbox),
    consumer_care: makeField(found.consumer_care?.value ?? '', found.consumer_care?.bbox),
    country_of_origin: makeField(found.country_of_origin?.value ?? '', found.country_of_origin?.bbox),
    batch_number: makeField(found.batch_number?.value ?? '', found.batch_number?.bbox),
  };

  return {
    product_id: `OCR-${Date.now()}`,
    product_name: nameResult?.text || 'Unknown product',
    category: 'unknown',
    timestamp: now,
    extractions,
  };
}

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
  const [activeField, setActiveField] = useState<string | null>(null);
  const [overlayTick, setOverlayTick] = useState(0);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const uploaderRef = useRef<ImageUploaderHandle | null>(null);

  const products = Object.keys(mockOCRDatabase);
  const bumpOverlay = useCallback(() => setOverlayTick((t) => t + 1), []);

  useEffect(() => {
    if (!uploadedImageUrl) return;
    if (imgRef.current?.complete) bumpOverlay();
    const t1 = setTimeout(bumpOverlay, 60);
    const t2 = setTimeout(bumpOverlay, 350);
    window.addEventListener('resize', bumpOverlay);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      window.removeEventListener('resize', bumpOverlay);
    };
  }, [uploadedImageUrl, extractionResult, bumpOverlay]);

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
    createInspection(
      inspector?.id,
      inspector?.name,
      inspector?.badge_number,
      extractionResult.product_name,
      extractionResult.category,
      location || 'Unknown'
    );
    if (uploadedImageUrl) addProductImage(uploadedImageUrl);
    if (annotations.length) addOcrAnnotations(annotations);

    Object.entries(extractionResult.extractions).forEach(([field, data]) => {
      const mockFinding: Finding = {
        field,
        rule_id: `R${(Math.floor(Math.random() * 10) + 1).toString().padStart(3, '0')}`,
        ai_extraction: (data as any).value,
        ai_confidence: (data as any).confidence,
        ai_recommendation: (data as any).status === 'extracted' ? 'PASS' : 'NEEDS_REVIEW',
        evidence_link: uploadedImageUrl || '',
        reason: (data as any).flag || 'Data extracted from OCR',
        bounding_box: (data as any).bounding_box || '',
      };
      addFinding(mockFinding);
    });

    setTimeout(() => router.push('/verify'), 50);
  };

  const computeBoxStyle = (vertices?: Vertex[]) => {
    if (!imgRef.current || !vertices || vertices.length === 0) return { display: 'none' } as React.CSSProperties;
    const img = imgRef.current;
    const natW = img.naturalWidth || 1,
      natH = img.naturalHeight || 1;
    const displayW = img.clientWidth || 0,
      displayH = img.clientHeight || 0;
    if (!displayW || !displayH) return { display: 'none' } as React.CSSProperties;
    const isNormalized = vertices.every((v) => (v.x || 0) <= 1 && (v.y || 0) <= 1);
    const scaled = vertices.map((v) => ({ x: (v.x || 0) * (isNormalized ? natW : 1), y: (v.y || 0) * (isNormalized ? natH : 1) }));
    const scaleX = displayW / natW,
      scaleY = displayH / natH;
    const xs = scaled.map((v) => v.x * scaleX),
      ys = scaled.map((v) => v.y * scaleY);
    const left = Math.min(...xs),
      top = Math.min(...ys),
      right = Math.max(...xs),
      bottom = Math.max(...ys);
    return {
      left: `${left}px`,
      top: `${top}px`,
      width: `${Math.max(1, right - left)}px`,
      height: `${Math.max(1, bottom - top)}px`,
    } as React.CSSProperties;
  };

  const hasSelected = uploaderRef.current?.hasSelected() ?? false;
  const activeFieldBbox = activeField && extractionResult ? (extractionResult.extractions as any)[activeField]?.bounding_box : null;
  let activeVertices: Vertex[] | undefined;
  if (activeFieldBbox) {
    try {
      activeVertices = JSON.parse(activeFieldBbox)?.vertices;
    } catch {
      activeVertices = undefined;
    }
  }

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
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200"
                  >
                    <option value="">Choose a product...</option>
                    {products.map((p) => (
                      <option key={p} value={p}>
                        {(mockOCRDatabase as any)[p].product_name}
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
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-200"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Category</label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200"
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
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-200"
                  />
                </div>

                <div className="bg-gray-50 p-4 rounded">
                  <h3 className="font-semibold">Upload / Take Picture</h3>
                  <p className="text-sm text-gray-600 mb-3">Use your device camera or upload an image of the product label.</p>
                  <ImageUploader ref={uploaderRef} onResult={handleOcrResult} autoUpload={false} />
                  {hasSelected && !extractionResult && (
                    <p className="text-sm text-gray-600 mt-2">File ready — click "Upload image to OCR" to extract values.</p>
                  )}
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={handleExtractFallback}
                    disabled={isExtracting}
                    className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-bold py-3 px-4 rounded-lg transition-colors"
                  >
                    {isExtracting ? 'Selecting...' : 'Use selected mock product'}
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
                  <div className="mb-4 relative inline-block">
                    <img
                      ref={imgRef}
                      src={uploadedImageUrl}
                      alt="uploaded"
                      style={{ maxWidth: '100%', height: 'auto', display: 'block' }}
                      onLoad={bumpOverlay}
                    />
                    <div key={overlayTick} style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, pointerEvents: 'none' }}>
                      {annotations
                        .filter((a) => a.level !== 'word')
                        .map((a, i) => {
                          const verts = a.boundingPoly?.vertices;
                          const style = computeBoxStyle(verts);
                          return (
                            <div
                              key={i}
                              style={{
                                position: 'absolute',
                                border: '2px solid rgba(59,130,246,0.6)',
                                background: 'rgba(59,130,246,0.08)',
                                borderRadius: 3,
                                boxSizing: 'border-box',
                                ...style,
                              }}
                            />
                          );
                        })}
                      {activeVertices && (
                        <div
                          style={{
                            position: 'absolute',
                            border: '3px solid rgba(22,163,74,0.95)',
                            background: 'rgba(22,163,74,0.18)',
                            borderRadius: 4,
                            boxShadow: '0 0 0 2px rgba(255,255,255,0.4)',
                            ...computeBoxStyle(activeVertices),
                          }}
                        />
                      )}
                    </div>
                  </div>
                )}

                {uploadedImageUrl && (
                  <p className="text-xs text-gray-500 mb-4">
                    Blue boxes show everything OCR matched. Click a field below to highlight exactly where its value came from (green).
                  </p>
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
                            onFocus={() => setActiveField(field)}
                            onBlur={() => setActiveField((cur) => (cur === field ? null : cur))}
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
                            className={`mt-1 w-full px-3 py-2 border rounded ${activeField === field ? 'border-green-500 ring-2 ring-green-200' : 'border-gray-300'}`}
                          />
                        </div>

                        <div className="text-right">
                          <span
                            className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${
                              (data as any).status === 'extracted' ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
                            }`}
                          >
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
                <button
                  onClick={() => {
                    setExtractionResult(null);
                    setUploadedImageUrl(null);
                    setAnnotations([]);
                  }}
                  className="flex-1 bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-2 px-4 rounded-lg"
                >
                  ← Back
                </button>

                <button
                  onClick={handleStartInspection}
                  disabled={!extractionResult}
                  className={`flex-1 font-bold py-2 px-4 rounded-lg transition-colors ${
                    extractionResult ? 'bg-green-600 hover:bg-green-700 text-white' : 'bg-gray-300 cursor-not-allowed'
                  }`}
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
