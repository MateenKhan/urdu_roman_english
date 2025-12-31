
import React, { useState, useRef, useEffect } from 'react';
import { GeminiService, StreamInput } from './services/geminiService';
import { AppState, ResumeMetadata } from './types';
import * as pdfjs from 'pdfjs-dist';
import { Document, Packer, Paragraph, TextRun } from 'docx';

pdfjs.GlobalWorkerOptions.workerSrc = 'https://esm.sh/pdfjs-dist@4.0.379/build/pdf.worker.mjs';

const DEFAULT_CHUNK_SIZE_KB = 32;
const MAX_PREVIEW_CHUNKS = 100;

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
  
  // New features state
  const [rangeStart, setRangeStart] = useState<string>("");
  const [rangeEnd, setRangeEnd] = useState<string>("");
  const [isMinimized, setIsMinimized] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  
  const geminiRef = useRef<GeminiService | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const previewEndRef = useRef<HTMLDivElement>(null);
  const finalChunksRef = useRef<string[]>([]);
  const isPausedRef = useRef<boolean>(false);
  const isRunningRef = useRef<boolean>(false);

  useEffect(() => {
    geminiRef.current = new GeminiService();
  }, []);

  useEffect(() => {
    if (autoScroll && previewEndRef.current) {
      previewEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [state.preview, streamingText, autoScroll]);

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
      
      if (isPdf) {
        // Just for visual feedback, we'll update totalItems later during process
        setRangeStart("1");
      }
    }
  };

  const resetSession = () => {
    abortControllerRef.current?.abort();
    isRunningRef.current = false;
    isPausedRef.current = false;
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
        if (metadata.rangeStart) setRangeStart(metadata.rangeStart.toString());
        if (metadata.rangeEnd) setRangeEnd(metadata.rangeEnd.toString());
        
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
      totalItems,
      rangeStart: rangeStart ? parseInt(rangeStart) : undefined,
      rangeEnd: rangeEnd ? parseInt(rangeEnd) : undefined
    };
    const blob = new Blob([JSON.stringify(metadata, null, 2)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.file.name}_recovery_meta.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportToDocx = async () => {
    if (!finalChunksRef.current.length) return;
    try {
      const doc = new Document({
        sections: [{
          properties: {},
          children: finalChunksRef.current.map(text => 
            new Paragraph({
              children: [new TextRun({ text: text.trim(), size: 24 })],
              spacing: { after: 200 }
            })
          ),
        }],
      });

      const blob = await Packer.toBlob(doc);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Roman_${state.file?.name.replace(/\.[^/.]+$/, "")}.docx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("DOCX Export Error", err);
      setState(prev => ({ ...prev, error: "Failed to generate Word document." }));
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    // Visual feedback could be added here
  };

  const copyAllToClipboard = () => {
    copyToClipboard(finalChunksRef.current.join("\n\n"));
  };

  const pdfToImageBase64 = async (pdfDoc: any, pageNum: number): Promise<string> => {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error("Canvas Context Fail");
    canvas.height = viewport.height;
    canvas.width = viewport.width;
    await page.render({ canvasContext: context, viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.7).split(',')[1];
  };

  const processFile = async () => {
    if (!state.file || !geminiRef.current || isRunningRef.current) return;
    
    isRunningRef.current = true;
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
        setCurrentOriginal("Processing image...");
        let fullText = "";
        for await (const chunk of geminiRef.current.convertStream([{ data: base64, mimeType: state.file.type }])) {
          if (abortControllerRef.current.signal.aborted || isPausedRef.current) break;
          setStreamingText(prev => prev + chunk);
          fullText += chunk;
        }
        if (!isPausedRef.current && !abortControllerRef.current.signal.aborted) {
          finalChunksRef.current = [fullText];
          setProcessedItems(1);
          updateProgress(1, startTime, "Uploaded Image", fullText);
        }
      } else if (isPdf) {
        const arrayBuffer = await state.file.arrayBuffer();
        const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
        const totalPages = pdf.numPages;
        
        const start = rangeStart ? Math.max(1, parseInt(rangeStart)) : 1;
        const end = rangeEnd ? Math.min(totalPages, parseInt(rangeEnd)) : totalPages;
        
        setTotalItems(end);
        
        let currentPage = Math.max(start, processedItems + 1);

        while (currentPage <= end) {
          if (abortControllerRef.current.signal.aborted || isPausedRef.current) break;
          
          const remainingPages = end - currentPage + 1;
          const currentBatchSize = Math.min(batchSize, remainingPages);
          const batchInputs: StreamInput[] = [];
          const batchOriginalTexts: string[] = [];

          for (let i = 0; i < currentBatchSize; i++) {
            const pageNum = currentPage + i;
            if (useOCR) {
              const base64 = await pdfToImageBase64(pdf, pageNum);
              batchInputs.push({ data: base64, mimeType: 'image/jpeg' });
              batchOriginalTexts.push(`Page ${pageNum} (OCR)`);
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
            
            if (!isPausedRef.current && !abortControllerRef.current.signal.aborted) {
              finalChunksRef.current.push(batchResult + "\n\n");
              const nextProcessed = Math.min(currentPage + currentBatchSize - 1, end);
              updateProgress(nextProcessed / end, startTime, batchOriginalTexts.join(" | "), batchResult);
              currentPage += currentBatchSize;
              setProcessedItems(nextProcessed);
            }
          } else {
            currentPage += currentBatchSize;
            setProcessedItems(currentPage - 1);
          }
        }
      } else {
        // Text Buffering - Range functionality not applicable to raw offset text but could be added as line counts if needed
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
            
            if (!isPausedRef.current && !abortControllerRef.current.signal.aborted) {
              finalChunksRef.current.push(batchResult + "\n");
              updateProgress(Math.min(currentBatchOffset, totalSize) / totalSize, startTime, batchOriginals.join(" | "), batchResult);
              offset = currentBatchOffset;
              setProcessedItems(offset);
            }
          } else {
             offset = currentBatchOffset;
             setProcessedItems(offset);
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
        error: `Stream Terminated: ${err.message}`,
        stats: { ...prev.stats, status: 'error' }
      }));
      setStreamingText("");
    } finally {
      isRunningRef.current = false;
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

  const downloadResultTxt = () => {
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
    <div className="min-h-screen bg-slate-50 py-8 px-4 sm:px-6 lg:px-8 font-sans transition-all">
      <div className={`max-w-7xl mx-auto ${isMinimized ? 'blur-sm' : ''}`}>
        <header className="flex flex-col md:flex-row items-center justify-between mb-8 gap-6">
          <div className="flex items-center space-x-4">
            <div className="p-3 bg-indigo-600 rounded-2xl shadow-lg text-white">
              <i className="fas fa-microchip text-3xl"></i>
            </div>
            <div>
              <h1 className="text-3xl font-black text-slate-900 tracking-tight">
                Urdu<span className="text-indigo-600">2</span>Roman <span className="text-xs align-middle bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full ml-1">V2.2 X-STREAM</span>
              </h1>
              <p className="text-sm text-slate-500 font-medium">Professional Buffer Pipeline</p>
            </div>
          </div>
          
          <div className="flex items-center bg-white p-3 rounded-2xl shadow-xl border border-slate-200 space-x-3">
            <div className="hidden md:flex flex-col pr-4 border-r border-slate-100 items-end">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Transport</span>
                <span className={`text-[10px] font-bold uppercase ${state.stats.status === 'processing' ? 'text-green-500' : 'text-slate-400'}`}>
                    {state.stats.status}
                </span>
            </div>

            {state.file && (state.stats.status === 'idle' || state.stats.status === 'paused' || state.stats.status === 'error') && (
              <button 
                onClick={processFile}
                className="group relative flex items-center space-x-2 px-6 py-2.5 bg-indigo-600 text-white rounded-xl font-black hover:bg-indigo-700 transition-all shadow-lg active:scale-95"
              >
                <i className="fas fa-play text-xs"></i>
                <span className="text-sm">{state.stats.status === 'paused' ? 'RESUME' : 'PLAY'}</span>
              </button>
            )}

            {state.stats.status === 'processing' && (
              <button 
                onClick={pauseConversion}
                className="flex items-center space-x-2 px-6 py-2.5 bg-amber-500 text-white rounded-xl font-black hover:bg-amber-600 transition-all shadow-lg active:scale-95"
              >
                <i className="fas fa-pause text-xs"></i>
                <span className="text-sm">PAUSE</span>
              </button>
            )}

            {(state.stats.status !== 'idle') && (
              <button 
                onClick={stopConversion}
                title="Stop & Reset"
                className="flex items-center justify-center w-10 h-10 bg-slate-100 text-red-500 rounded-xl font-bold hover:bg-red-50 transition-all active:scale-95 border border-slate-200"
              >
                <i className="fas fa-square text-xs"></i>
              </button>
            )}

            <div className="h-8 w-px bg-slate-100 mx-1"></div>
            
            <button 
              onClick={() => setIsMinimized(true)}
              className="w-10 h-10 flex items-center justify-center bg-slate-50 text-slate-500 rounded-xl hover:bg-slate-100 transition-all"
              title="Minimize Dashboard"
            >
              <i className="fas fa-minus"></i>
            </button>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Sidebar */}
          <div className="lg:col-span-3 space-y-6">
            <section className="bg-white rounded-3xl shadow-sm p-6 border border-slate-200 space-y-6">
              <h2 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center">
                <i className="fas fa-cog mr-2 text-indigo-500"></i> Buffer Config
              </h2>
              
              <div className="space-y-5">
                <div className="relative group">
                  <input 
                    type="file" 
                    onChange={handleFileChange}
                    accept=".txt,.pdf,image/*"
                    className="absolute inset-0 opacity-0 cursor-pointer z-10"
                    disabled={state.stats.status === 'processing'}
                  />
                  <div className={`p-5 border-2 border-dashed rounded-2xl transition-all text-center ${state.file ? 'border-indigo-500 bg-indigo-50/30' : 'border-slate-200 group-hover:border-indigo-400 bg-slate-50/50'}`}>
                    <i className={`fas ${state.file ? 'fa-book-open text-indigo-600' : 'fa-upload text-slate-300'} text-3xl mb-3`}></i>
                    <p className="text-[11px] font-bold text-slate-700 truncate px-2">
                      {state.file ? state.file.name : "LOAD SOURCE FILE"}
                    </p>
                    <p className="text-[9px] text-slate-400 mt-1 uppercase">PDF, TXT, or Image</p>
                  </div>
                </div>

                {state.file?.name.endsWith('.pdf') && (
                  <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 space-y-3">
                    <span className="text-[10px] font-black text-slate-700 uppercase tracking-wider">Page Range</span>
                    <div className="flex items-center space-x-2">
                      <input 
                        type="number" 
                        placeholder="Start"
                        value={rangeStart}
                        onChange={(e) => setRangeStart(e.target.value)}
                        className="w-full bg-white border border-slate-200 rounded-lg p-2 text-xs font-mono"
                        disabled={state.stats.status === 'processing'}
                      />
                      <span className="text-slate-400">to</span>
                      <input 
                        type="number" 
                        placeholder="End"
                        value={rangeEnd}
                        onChange={(e) => setRangeEnd(e.target.value)}
                        className="w-full bg-white border border-slate-200 rounded-lg p-2 text-xs font-mono"
                        disabled={state.stats.status === 'processing'}
                      />
                    </div>
                  </div>
                )}

                <div className="space-y-3">
                  <div className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <span className="text-xs font-black text-slate-700 uppercase tracking-wider flex items-center">
                      <i className="fas fa-eye text-indigo-500 mr-2"></i> Vision OCR
                    </span>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" checked={useOCR} onChange={() => setUseOCR(!useOCR)} className="sr-only peer" disabled={state.stats.status === 'processing'} />
                      <div className="w-11 h-6 bg-slate-200 rounded-full peer peer-checked:after:translate-x-full peer-checked:bg-indigo-600 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
                    </label>
                  </div>

                  <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-black text-slate-700 uppercase tracking-wider">Batch Depth</span>
                      <span className="text-indigo-600 font-mono font-bold bg-white px-2 py-0.5 rounded-lg border border-indigo-100 text-xs">{batchSize} Pgs</span>
                    </div>
                    <input 
                        type="range" 
                        min="1" 
                        max="10" 
                        value={batchSize} 
                        onChange={(e) => setBatchSize(parseInt(e.target.value))} 
                        className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600" 
                        disabled={state.stats.status === 'processing'} 
                    />
                  </div>
                </div>
              </div>
            </section>

            <section className="bg-white rounded-3xl shadow-sm p-6 border border-slate-200">
              <h2 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-4">Export Options</h2>
              <div className="grid grid-cols-1 gap-3">
                <div className="flex space-x-2">
                  <button onClick={downloadResultTxt} disabled={!finalChunksRef.current.length} className="flex-1 p-3 bg-slate-50 rounded-xl border border-slate-100 text-[10px] font-black text-slate-600 hover:bg-slate-100 disabled:opacity-40">
                    <i className="fas fa-file-alt mr-2 text-slate-400"></i> TXT
                  </button>
                  <button onClick={exportToDocx} disabled={!finalChunksRef.current.length} className="flex-1 p-3 bg-indigo-50 rounded-xl border border-indigo-100 text-[10px] font-black text-indigo-600 hover:bg-indigo-100 disabled:opacity-40">
                    <i className="fas fa-file-word mr-2 text-indigo-400"></i> DOCX
                  </button>
                </div>
                <button onClick={copyAllToClipboard} disabled={!finalChunksRef.current.length} className="w-full p-3 bg-slate-50 rounded-xl border border-slate-100 text-[10px] font-black text-slate-600 hover:bg-slate-100 disabled:opacity-40">
                  <i className="fas fa-copy mr-2 text-slate-400"></i> COPY ALL
                </button>
              </div>
            </section>
          </div>

          {/* Monitoring Feed */}
          <div className="lg:col-span-9">
            <div className="bg-slate-900 rounded-[2.5rem] shadow-2xl border-8 border-slate-800 flex flex-col h-[800px] overflow-hidden">
              {/* Feed Header */}
              <div className="bg-slate-800/50 px-6 py-4 border-b border-white/5 flex items-center justify-between">
                <div className="flex items-center space-x-4">
                  <div className="flex items-center space-x-2">
                     <div className={`w-2.5 h-2.5 rounded-full ${state.stats.status === 'processing' ? 'bg-red-500 animate-pulse' : 'bg-slate-600'}`}></div>
                     <span className="text-[11px] font-mono font-black text-slate-300 uppercase tracking-widest">Live Output Monitor</span>
                  </div>
                  <button 
                    onClick={() => setAutoScroll(!autoScroll)} 
                    className={`text-[10px] font-bold px-3 py-1 rounded-full transition-all ${autoScroll ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30' : 'bg-slate-700 text-slate-400 border border-slate-600'}`}
                  >
                    {autoScroll ? 'AUTO-SCROLL ON' : 'AUTO-SCROLL OFF'}
                  </button>
                </div>
                <div className="flex space-x-1">
                   <div className="w-1.5 h-1.5 rounded-full bg-slate-700"></div>
                   <div className="w-1.5 h-1.5 rounded-full bg-slate-700"></div>
                   <div className="w-1.5 h-1.5 rounded-full bg-slate-700"></div>
                </div>
              </div>

              {/* View Headers */}
              <div className="grid grid-cols-2 border-b border-white/5 bg-slate-900/50">
                <div className="p-3 text-center border-r border-white/5 text-[10px] font-black text-slate-500 uppercase tracking-widest">Source Input</div>
                <div className="p-3 text-center text-[10px] font-black text-slate-500 uppercase tracking-widest">Synthesized Output</div>
              </div>

              {/* Feed Content */}
              <div className="flex-1 overflow-y-auto p-4 space-y-2 scrollbar-hide font-mono">
                {state.preview.map((p, i) => (
                  <div key={i} className="grid grid-cols-2 gap-4 group transition-all border-b border-white/5 pb-3 mb-1">
                    <div className="p-4 bg-slate-800/20 rounded-2xl border border-white/5 relative">
                      <p className="text-slate-400 text-xs leading-relaxed line-clamp-6 select-all" dir="rtl">{p.original}</p>
                    </div>
                    <div className="p-4 bg-indigo-500/5 rounded-2xl border border-indigo-500/10 group-hover:bg-indigo-500/10 transition-colors relative">
                      <button 
                        onClick={() => copyToClipboard(p.converted)}
                        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-slate-800 text-indigo-400 text-[10px] p-2 rounded-lg border border-indigo-500/30 hover:bg-slate-700"
                        title="Copy this chunk"
                      >
                        <i className="fas fa-copy"></i>
                      </button>
                      <p className="text-indigo-200/90 text-xs leading-relaxed select-text">{p.converted}</p>
                    </div>
                  </div>
                ))}

                {(streamingText || currentOriginal) && (
                  <div className="grid grid-cols-2 gap-4 animate-in fade-in slide-in-from-bottom-4 duration-500 py-4 border-t border-indigo-500/30 bg-indigo-500/5 rounded-3xl mt-4 px-2">
                    <div className="p-4 bg-slate-800/60 rounded-2xl border border-white/10">
                      <p className="text-slate-300 text-xs leading-relaxed" dir="rtl">{currentOriginal || 'Waiting for buffer...'}</p>
                    </div>
                    <div className="p-4 bg-green-500/10 rounded-2xl border border-green-500/30">
                      <p className="text-green-300 text-xs leading-relaxed whitespace-pre-wrap select-text">
                        {streamingText}
                        <span className="inline-block w-2.5 h-4 bg-green-400 ml-1 animate-ping"></span>
                      </p>
                    </div>
                  </div>
                )}

                {!state.preview.length && !streamingText && !state.error && (
                  <div className="h-full flex flex-col items-center justify-center text-slate-700 opacity-20">
                    <i className="fas fa-microchip text-7xl mb-6"></i>
                    <p className="font-black tracking-widest text-lg uppercase">Pipeline Ready</p>
                  </div>
                )}
                <div ref={previewEndRef} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Minimized Controller */}
      {isMinimized && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-10">
          <div className="bg-slate-900 border-4 border-slate-800 rounded-3xl shadow-2xl p-4 flex items-center space-x-6 min-w-[400px]">
            <div className="flex items-center space-x-4">
              <div className={`w-3 h-3 rounded-full ${state.stats.status === 'processing' ? 'bg-green-500 animate-pulse' : 'bg-slate-600'}`}></div>
              <div>
                <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Active Progress</p>
                <p className="text-sm font-black text-white">{progressPercent}% Completed</p>
              </div>
            </div>
            
            <div className="h-10 w-px bg-white/10"></div>
            
            <div className="flex items-center space-x-2">
              {state.stats.status === 'processing' ? (
                <button onClick={pauseConversion} className="w-10 h-10 flex items-center justify-center bg-amber-500 text-white rounded-xl hover:bg-amber-600 transition-all">
                  <i className="fas fa-pause"></i>
                </button>
              ) : (
                <button onClick={processFile} className="w-10 h-10 flex items-center justify-center bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all">
                  <i className="fas fa-play"></i>
                </button>
              )}
              <button onClick={stopConversion} className="w-10 h-10 flex items-center justify-center bg-slate-800 text-red-500 rounded-xl hover:bg-red-900 transition-all">
                <i className="fas fa-stop"></i>
              </button>
            </div>

            <div className="h-10 w-px bg-white/10"></div>

            <button onClick={() => setIsMinimized(false)} className="w-10 h-10 flex items-center justify-center bg-white/5 text-white rounded-xl hover:bg-white/10 transition-all">
              <i className="fas fa-expand"></i>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
