
import React, { useState, useRef, useEffect } from 'react';
import { GeminiService, StreamInput } from './services/geminiService';
import { AppState, ConversionStats, ChunkResult, ResumeMetadata } from './types';
import * as pdfjs from 'pdfjs-dist';

pdfjs.GlobalWorkerOptions.workerSrc = 'https://esm.sh/pdfjs-dist@4.0.379/build/pdf.worker.mjs';

const DEFAULT_CHUNK_SIZE_KB = 32;
const MAX_PREVIEW_CHUNKS = 50; // Increased for better history

const App: React.FC = () => {
  const [state, setState] = useState<AppState>({
    file: null,
    stats: {
      totalBytes: 0,
      processedBytes: 0,
      startTime: 0,
      estimatedTimeRemaining: null,
      status: 'idle',
      chunksProcessed: 0,
    },
    preview: [],
    error: null,
    resumeData: null
  });

  const [useOCR, setUseOCR] = useState(false);
  const [batchSize, setBatchSize] = useState(1);
  const [streamingText, setStreamingText] = useState("");
  const [currentOriginal, setCurrentOriginal] = useState("");
  const [totalItems, setTotalItems] = useState<number>(0);
  const [processedItems, setProcessedItems] = useState<number>(0);
  
  const geminiRef = useRef<GeminiService | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const previewEndRef = useRef<HTMLDivElement>(null);
  const finalChunksRef = useRef<string[]>([]);
  const isPausedRef = useRef<boolean>(false);

  useEffect(() => {
    geminiRef.current = new GeminiService();
  }, []);

  useEffect(() => {
    if (previewEndRef.current) {
      previewEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [state.preview, streamingText]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const isPdf = file.type === 'application/pdf' || file.name.endsWith('.pdf');
      const isTxt = file.type === 'text/plain' || file.name.endsWith('.txt');
      const isImg = file.type.startsWith('image/');

      if (!isPdf && !isTxt && !isImg) {
        setState(prev => ({ ...prev, error: 'Supported formats: .txt, .pdf, images.' }));
        return;
      }

      resetSession();
      setState(prev => ({
        ...prev,
        file,
        stats: {
          ...prev.stats,
          totalBytes: file.size,
          status: 'idle',
        },
        error: null
      }));
    }
  };

  const resetSession = () => {
    finalChunksRef.current = [];
    setStreamingText("");
    setCurrentOriginal("");
    setProcessedItems(0);
    setTotalItems(0);
    setState(prev => ({
      ...prev,
      preview: [],
      stats: {
        ...prev.stats,
        processedBytes: 0,
        chunksProcessed: 0,
        status: 'idle',
        estimatedTimeRemaining: null
      }
    }));
  };

  const stopConversion = () => {
    abortControllerRef.current?.abort();
    resetSession();
  };

  const pauseConversion = () => {
    isPausedRef.current = true;
    setState(prev => ({ ...prev, stats: { ...prev.stats, status: 'paused' } }));
  };

  const handleMetadataUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const metadata: ResumeMetadata = JSON.parse(event.target?.result as string);
        finalChunksRef.current = metadata.accumulatedContent;
        setProcessedItems(metadata.lastProcessedIndex);
        setTotalItems(metadata.totalItems);
        setUseOCR(metadata.useOCR);
        
        setState(prev => ({
          ...prev,
          resumeData: metadata,
          stats: {
            ...prev.stats,
            status: 'paused'
          }
        }));
      } catch (err) {
        setState(prev => ({ ...prev, error: 'Failed to parse metadata file.' }));
      }
    };
    reader.readAsText(file);
  };

  const downloadMetadata = () => {
    if (!state.file) return;
    const metadata: ResumeMetadata = {
      fileName: state.file.name,
      fileSize: state.file.size,
      lastProcessedIndex: processedItems,
      accumulatedContent: finalChunksRef.current,
      useOCR,
      totalItems
    };
    const blob = new Blob([JSON.stringify(metadata, null, 2)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.file.name}_meta.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const pdfToImageBase64 = async (pdfDoc: any, pageNum: number): Promise<string> => {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error("Canvas Error");
    canvas.height = viewport.height;
    canvas.width = viewport.width;
    await page.render({ canvasContext: context, viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.7).split(',')[1];
  };

  const processFile = async () => {
    if (!state.file || !geminiRef.current) return;
    
    isPausedRef.current = false;
    abortControllerRef.current = new AbortController();
    const startTime = Date.now();
    
    setState(prev => ({
      ...prev,
      stats: { ...prev.stats, status: 'processing', startTime },
      error: null
    }));

    try {
      const isPdf = state.file.name.toLowerCase().endsWith('.pdf');
      const isImg = state.file.type.startsWith('image/');

      if (isImg) {
        setTotalItems(1);
        const reader = new FileReader();
        const base64Promise = new Promise<string>((resolve) => {
          reader.onload = () => resolve((reader.result as string).split(',')[1]);
          reader.readAsDataURL(state.file!);
        });
        const base64 = await base64Promise;
        setCurrentOriginal("Image Content Extraction...");
        let fullText = "";
        for await (const chunk of geminiRef.current.convertStream([{ data: base64, mimeType: state.file.type }])) {
          if (abortControllerRef.current.signal.aborted || isPausedRef.current) break;
          setStreamingText(prev => prev + chunk);
          fullText += chunk;
        }
        if (!isPausedRef.current) {
          finalChunksRef.current = [fullText];
          setProcessedItems(1);
          updateProgress(1, startTime, "Uploaded Image", fullText);
        }
      } else if (isPdf) {
        const arrayBuffer = await state.file.arrayBuffer();
        const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
        const totalPages = pdf.numPages;
        setTotalItems(totalPages);
        
        let currentPage = processedItems + 1;

        while (currentPage <= totalPages) {
          if (abortControllerRef.current.signal.aborted || isPausedRef.current) break;
          
          const currentBatchSize = Math.min(batchSize, totalPages - currentPage + 1);
          const batchInputs: StreamInput[] = [];
          const batchOriginalTexts: string[] = [];

          for (let i = 0; i < currentBatchSize; i++) {
            const pageNum = currentPage + i;
            if (useOCR) {
              const base64 = await pdfToImageBase64(pdf, pageNum);
              batchInputs.push({ data: base64, mimeType: 'image/jpeg' });
              batchOriginalTexts.push(`Page ${pageNum} (Scanned)`);
            } else {
              const page = await pdf.getPage(pageNum);
              const content = await page.getTextContent();
              const text = content.items.map((item: any) => item.str).join(' ');
              if (text.trim()) {
                batchInputs.push(text);
                batchOriginalTexts.push(text.slice(0, 300));
              }
            }
          }

          if (batchInputs.length > 0) {
            setStreamingText("");
            setCurrentOriginal(batchOriginalTexts.join("\n---\n"));
            let batchResult = "";
            for await (const chunk of geminiRef.current.convertStream(batchInputs)) {
              if (abortControllerRef.current.signal.aborted || isPausedRef.current) break;
              setStreamingText(prev => prev + chunk);
              batchResult += chunk;
            }
            
            if (!isPausedRef.current) {
              finalChunksRef.current.push(batchResult + "\n\n");
              updateProgress(Math.min(currentPage + currentBatchSize - 1, totalPages) / totalPages, startTime, batchOriginalTexts.join(" | "), batchResult);
              currentPage += currentBatchSize;
              setProcessedItems(currentPage - 1);
            }
          } else {
            currentPage += currentBatchSize;
            setProcessedItems(currentPage - 1);
          }
        }
      } else {
        // Text Buffering
        let offset = processedItems;
        const file = state.file;
        const totalSize = file.size;
        setTotalItems(totalSize);
        const chunkSize = DEFAULT_CHUNK_SIZE_KB * 1024;

        while (offset < totalSize) {
          if (abortControllerRef.current.signal.aborted || isPausedRef.current) break;
          
          const batchInputs: StreamInput[] = [];
          const batchOriginals: string[] = [];
          let currentBatchOffset = offset;
          
          for (let i = 0; i < batchSize; i++) {
            if (currentBatchOffset >= totalSize) break;
            const chunk = file.slice(currentBatchOffset, currentBatchOffset + chunkSize);
            const text = await chunk.text();
            if (text.trim()) {
              batchInputs.push(text);
              batchOriginals.push(text.slice(0, 300));
            }
            currentBatchOffset += chunkSize;
          }

          if (batchInputs.length > 0) {
            setStreamingText("");
            setCurrentOriginal(batchOriginals.join("\n---\n"));
            let batchResult = "";
            for await (const streamChunk of geminiRef.current.convertStream(batchInputs)) {
              if (abortControllerRef.current.signal.aborted || isPausedRef.current) break;
              setStreamingText(prev => prev + streamChunk);
              batchResult += streamChunk;
            }
            
            if (!isPausedRef.current) {
              finalChunksRef.current.push(batchResult + "\n");
              updateProgress(Math.min(currentBatchOffset, totalSize) / totalSize, startTime, batchOriginals.join(" | "), batchResult);
              offset = currentBatchOffset;
              setProcessedItems(Math.min(offset, totalSize));
            }
          } else {
             offset = currentBatchOffset;
             setProcessedItems(Math.min(offset, totalSize));
          }
        }
      }

      if (!abortControllerRef.current.signal.aborted && !isPausedRef.current) {
        setState(prev => ({
          ...prev,
          stats: { ...prev.stats, status: 'completed', estimatedTimeRemaining: 0 }
        }));
        setStreamingText("");
        setCurrentOriginal("");
      }
    } catch (err: any) {
      console.error('Processing error:', err);
      setState(prev => ({
        ...prev,
        error: `Stream Error: ${err.message}`,
        stats: { ...prev.stats, status: 'error' }
      }));
      setStreamingText("");
    }
  };

  const updateProgress = (progress: number, startTime: number, original: string, converted: string) => {
    const elapsed = (Date.now() - startTime) / 1000;
    const remaining = progress > 0 ? (elapsed / progress) - elapsed : 0;

    setState(prev => ({
      ...prev,
      stats: {
        ...prev.stats,
        processedBytes: Math.floor(progress * prev.stats.totalBytes),
        estimatedTimeRemaining: remaining,
        chunksProcessed: prev.stats.chunksProcessed + 1,
      },
      preview: [...prev.preview, { original, converted }].slice(-MAX_PREVIEW_CHUNKS),
    }));
  };

  const downloadResult = () => {
    if (!finalChunksRef.current.length || !state.file) return;
    const blob = new Blob(finalChunksRef.current, { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Roman_${state.file.name.replace(/\.[^/.]+$/, "")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const progressPercent = totalItems > 0 
    ? Math.round((processedItems / totalItems) * 100) 
    : 0;

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4 sm:px-6 lg:px-8 font-sans">
      <div className="max-w-7xl mx-auto">
        <header className="flex flex-col md:flex-row items-center justify-between mb-8 gap-4">
          <div className="flex items-center space-x-4">
            <div className="p-3 bg-indigo-600 rounded-2xl shadow-lg text-white">
              <i className="fas fa-language text-3xl"></i>
            </div>
            <div>
              <h1 className="text-3xl font-black text-slate-900 tracking-tight">
                Urdu<span className="text-indigo-600">2</span>Roman <span className="text-xs align-middle bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full ml-1">SIDE-BY-SIDE</span>
              </h1>
              <p className="text-sm text-slate-500">Professional Book Transliteration Engine</p>
            </div>
          </div>
          
          {/* Transport Controls */}
          <div className="flex items-center bg-white p-2 rounded-2xl shadow-md border border-slate-200 space-x-2">
            {state.file && (state.stats.status === 'idle' || state.stats.status === 'paused' || state.stats.status === 'error') ? (
              <button 
                onClick={processFile}
                className="flex items-center space-x-2 px-6 py-2 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-700 transition-all shadow-md active:scale-95"
              >
                <i className="fas fa-play text-sm"></i>
                <span>{state.stats.status === 'paused' ? 'Resume' : 'Play'}</span>
              </button>
            ) : null}

            {state.stats.status === 'processing' && (
              <button 
                onClick={pauseConversion}
                className="flex items-center space-x-2 px-6 py-2 bg-amber-500 text-white rounded-xl font-bold hover:bg-amber-600 transition-all shadow-md active:scale-95"
              >
                <i className="fas fa-pause text-sm"></i>
                <span>Pause</span>
              </button>
            )}

            {(state.stats.status !== 'idle') && (
              <button 
                onClick={stopConversion}
                className="flex items-center space-x-2 px-4 py-2 bg-slate-100 text-slate-600 rounded-xl font-bold hover:bg-slate-200 transition-all active:scale-95"
              >
                <i className="fas fa-stop text-sm text-red-500"></i>
                <span>Stop</span>
              </button>
            )}
            
            {state.stats.status === 'completed' && (
              <button 
                onClick={downloadResult}
                className="flex items-center space-x-2 px-6 py-2 bg-green-600 text-white rounded-xl font-bold hover:bg-green-700 transition-all shadow-md active:scale-95"
              >
                <i className="fas fa-file-download text-sm"></i>
                <span>Export Book</span>
              </button>
            )}
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Settings Sidebar */}
          <div className="lg:col-span-3 space-y-6">
            <section className="bg-white rounded-3xl shadow-sm p-6 border border-slate-200 space-y-6">
              <h2 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center">
                <i className="fas fa-sliders-h mr-2"></i> Session Settings
              </h2>
              
              <div className="space-y-4">
                <div className="relative group">
                  <input 
                    type="file" 
                    onChange={handleFileChange}
                    accept=".txt,.pdf,image/*"
                    className="absolute inset-0 opacity-0 cursor-pointer z-10"
                    disabled={state.stats.status === 'processing'}
                  />
                  <div className={`p-4 border-2 border-dashed rounded-2xl transition-all text-center ${state.file ? 'border-green-200 bg-green-50' : 'border-slate-200 group-hover:border-indigo-400'}`}>
                    <i className={`fas ${state.file ? 'fa-file-alt text-green-500' : 'fa-cloud-upload-alt text-slate-300'} text-2xl mb-2`}></i>
                    <p className="text-[10px] font-bold text-slate-600 truncate px-2">
                      {state.file ? state.file.name : "Choose Book or Image"}
                    </p>
                  </div>
                </div>

                <div className="flex items-center justify-between p-3 bg-slate-50 rounded-2xl border border-slate-100">
                  <span className="text-xs font-bold text-slate-700 flex items-center">
                    <i className="fas fa-camera text-indigo-500 mr-2"></i> OCR
                  </span>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input type="checkbox" checked={useOCR} onChange={() => setUseOCR(!useOCR)} className="sr-only peer" disabled={state.stats.status === 'processing'} />
                    <div className="w-10 h-5 bg-slate-200 rounded-full peer peer-checked:after:translate-x-full peer-checked:bg-indigo-600 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all"></div>
                  </label>
                </div>

                <div className="p-3 bg-slate-50 rounded-2xl border border-slate-100 space-y-2">
                  <div className="flex justify-between items-center text-xs font-bold text-slate-700">
                    <span>Batch Density</span>
                    <span className="text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">{batchSize}x</span>
                  </div>
                  <input type="range" min="1" max="10" value={batchSize} onChange={(e) => setBatchSize(parseInt(e.target.value))} className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600" disabled={state.stats.status === 'processing'} />
                </div>
              </div>
            </section>

            <section className="bg-white rounded-3xl shadow-sm p-6 border border-slate-200">
              <h2 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4">Metadata Recovery</h2>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={downloadMetadata} disabled={!state.file || finalChunksRef.current.length === 0} className="p-3 bg-slate-50 rounded-xl border border-slate-100 text-[10px] font-bold text-slate-600 hover:bg-slate-100 disabled:opacity-50">
                  <i className="fas fa-download block mb-1"></i> Save Meta
                </button>
                <div className="relative">
                  <input type="file" onChange={handleMetadataUpload} accept=".txt" className="absolute inset-0 opacity-0 cursor-pointer" />
                  <button className="w-full p-3 bg-indigo-50 rounded-xl border border-indigo-100 text-[10px] font-bold text-indigo-600 hover:bg-indigo-100 pointer-events-none">
                    <i className="fas fa-upload block mb-1"></i> Load Meta
                  </button>
                </div>
              </div>
            </section>

            {state.stats.status !== 'idle' && (
              <section className="bg-white rounded-3xl shadow-sm p-6 border border-slate-200 space-y-4">
                <div className="flex justify-between text-xs font-black uppercase tracking-widest text-slate-400">
                  <span>Progress</span>
                  <span>{progressPercent}%</span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-indigo-600 transition-all duration-700" style={{ width: `${progressPercent}%` }}></div>
                </div>
                <div className="grid grid-cols-2 gap-4 text-center">
                  <div className="bg-slate-50 p-2 rounded-xl">
                    <p className="text-[10px] font-bold text-slate-400">UNIT</p>
                    <p className="text-sm font-black text-indigo-600">{processedItems}/{totalItems}</p>
                  </div>
                  <div className="bg-slate-50 p-2 rounded-xl">
                    <p className="text-[10px] font-bold text-slate-400">TIME</p>
                    <p className="text-sm font-black text-indigo-600">{state.stats.estimatedTimeRemaining ? `${Math.ceil(state.stats.estimatedTimeRemaining / 60)}m` : '--'}</p>
                  </div>
                </div>
              </section>
            )}
          </div>

          {/* Main Feed - Side-by-Side */}
          <div className="lg:col-span-9">
            <div className="bg-slate-900 rounded-[2.5rem] shadow-2xl border-8 border-slate-800 flex flex-col h-[750px] overflow-hidden">
              {/* Feed Header */}
              <div className="bg-slate-800/50 p-4 border-b border-white/5 flex items-center justify-between">
                <div className="flex items-center space-x-6 text-[10px] font-mono tracking-widest uppercase">
                  <div className="flex items-center space-x-2 text-slate-400">
                     <div className={`w-2 h-2 rounded-full ${state.stats.status === 'processing' ? 'bg-green-500 animate-pulse' : 'bg-slate-600'}`}></div>
                     <span>Live Monitor</span>
                  </div>
                  <div className="text-slate-500">Channel: Urdu_UTF8 >> Roman_EN</div>
                </div>
                <div className="flex items-center space-x-2">
                   <span className="text-[10px] font-mono text-indigo-400 bg-indigo-400/10 px-2 py-0.5 rounded">BUFF_SIZE: {batchSize}X</span>
                </div>
              </div>

              {/* Comparison Grid Header */}
              <div className="grid grid-cols-2 border-b border-white/5 bg-slate-900">
                <div className="p-3 text-center border-r border-white/5 text-[10px] font-bold text-slate-500 uppercase tracking-widest">Original Input</div>
                <div className="p-3 text-center text-[10px] font-bold text-slate-500 uppercase tracking-widest">Roman Output</div>
              </div>

              {/* Feed Content */}
              <div className="flex-1 overflow-y-auto p-4 space-y-1 scrollbar-hide font-mono">
                {state.error && (
                  <div className="m-4 p-4 bg-red-500/10 border border-red-500/20 rounded-2xl text-red-400 text-xs">
                    <i className="fas fa-exclamation-circle mr-2"></i> {state.error}
                  </div>
                )}

                {state.preview.map((p, i) => (
                  <div key={i} className="grid grid-cols-2 gap-4 group transition-all border-b border-white/5 pb-2 mb-2">
                    <div className="p-4 bg-slate-800/30 rounded-2xl border border-white/5 group-hover:bg-slate-800/50 transition-colors">
                      <div className="text-[8px] text-slate-600 mb-1 flex justify-between">
                        <span>CHUNK_{i.toString().padStart(3, '0')}</span>
                        <span>SOURCE</span>
                      </div>
                      <p className="text-slate-400 text-xs leading-relaxed line-clamp-4 overflow-hidden" dir="rtl">{p.original}</p>
                    </div>
                    <div className="p-4 bg-indigo-600/5 rounded-2xl border border-indigo-500/10 group-hover:bg-indigo-600/10 transition-colors">
                      <div className="text-[8px] text-indigo-500/50 mb-1 flex justify-between">
                        <span>PROCESSED</span>
                        <i className="fas fa-check-circle"></i>
                      </div>
                      <p className="text-indigo-100 text-xs leading-relaxed">{p.converted}</p>
                    </div>
                  </div>
                ))}

                {(streamingText || currentOriginal) && (
                  <div className="grid grid-cols-2 gap-4 animate-in fade-in slide-in-from-bottom-2 duration-500 pt-2 border-t border-indigo-500/20">
                    <div className="p-4 bg-slate-800/50 rounded-2xl border border-white/10 shadow-lg shadow-black/20">
                      <div className="text-[8px] text-green-400 mb-2 flex items-center space-x-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></div>
                        <span className="tracking-widest font-bold">CURRENT_INGESTION</span>
                      </div>
                      <p className="text-slate-300 text-xs leading-relaxed overflow-hidden" dir="rtl">{currentOriginal || 'Extracting data...'}</p>
                    </div>
                    <div className="p-4 bg-green-900/10 rounded-2xl border border-green-500/30 shadow-[0_0_20px_rgba(34,197,94,0.1)]">
                       <div className="text-[8px] text-green-400 mb-2 flex items-center justify-between">
                        <span className="tracking-widest font-bold">STREAM_SYNTHESIS</span>
                        <i className="fas fa-bolt animate-bounce"></i>
                      </div>
                      <p className="text-green-300 text-xs leading-relaxed whitespace-pre-wrap">
                        {streamingText}
                        <span className="inline-block w-2 h-4 bg-green-400 ml-1 animate-ping"></span>
                      </p>
                    </div>
                  </div>
                )}

                {!state.preview.length && !streamingText && !state.error && (
                  <div className="h-full flex flex-col items-center justify-center text-slate-700 opacity-20 select-none">
                    <div className="mb-6 relative">
                      <i className="fas fa-terminal text-6xl"></i>
                      <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-indigo-500 rounded-full animate-ping"></div>
                    </div>
                    <p className="font-black tracking-[0.3em] text-sm uppercase">Engine Standby</p>
                    <p className="text-[10px] mt-2 italic">Select a file and press PLAY to begin uplink</p>
                  </div>
                )}
                <div ref={previewEndRef} />
              </div>

              {/* Timeline Footer */}
              <div className="bg-slate-800/30 px-6 py-2 border-t border-white/5 flex items-center justify-between">
                <div className="flex items-center space-x-4">
                   <div className="text-[9px] font-mono text-slate-500">
                     SYSTEM: GEMINI_FLASH_V3
                   </div>
                   <div className="h-3 w-px bg-white/5"></div>
                   <div className="text-[9px] font-mono text-slate-500 uppercase">
                     MODALITY: {useOCR ? 'OCR_STREAM' : 'TEXT_PARSE'}
                   </div>
                </div>
                <div className="text-[9px] font-mono text-slate-400">
                  © 2025 TRANS-LINGUAL CORE
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
