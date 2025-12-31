
import React, { useState, useRef, useEffect } from 'react';
import { GeminiService, StreamInput } from './services/geminiService';
import { AppState, ResumeMetadata } from './types';
import * as pdfjs from 'pdfjs-dist';
import { Document, Packer, Paragraph, TextRun } from 'docx';

pdfjs.GlobalWorkerOptions.workerSrc = 'https://esm.sh/pdfjs-dist@4.0.379/build/pdf.worker.mjs';

const DEFAULT_CHUNK_SIZE_KB = 128; // Optimized for GB books
const MAX_PREVIEW_CHUNKS = 30; // Aggressive memory management for mobile APKs

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
  const [batchSize, setBatchSize] = useState(2);
  const [streamingText, setStreamingText] = useState("");
  const [currentOriginal, setCurrentOriginal] = useState("");
  const [totalItems, setTotalItems] = useState<number>(0);
  const [processedItems, setProcessedItems] = useState<number>(0);
  
  const [rangeStart, setRangeStart] = useState<string>("");
  const [rangeEnd, setRangeEnd] = useState<string>("");
  const [isMinimized, setIsMinimized] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showApkInfo, setShowApkInfo] = useState(false);
  
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
        setState(prev => ({ ...prev, error: 'File type not supported. Use PDF, TXT or Images.' }));
        return;
      }

      resetSession();
      setState(prev => ({
        ...prev,
        file,
        stats: { ...prev.stats, totalBytes: file.size, status: 'idle' },
        error: null
      }));
      if (isPdf) setRangeStart("1");
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
      stats: { ...prev.stats, processedBytes: 0, chunksProcessed: 0, status: 'idle', estimatedTimeRemaining: null }
    }));
  };

  const stopConversion = () => resetSession();
  const pauseConversion = () => {
    isPausedRef.current = true;
    setState(prev => ({ ...prev, stats: { ...prev.stats, status: 'paused' } }));
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
      setState(prev => ({ ...prev, error: "Word export failed." }));
    }
  };

  const copyToClipboard = (text: string) => navigator.clipboard.writeText(text);

  const pdfToImageBase64 = async (pdfDoc: any, pageNum: number): Promise<string> => {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.2 });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error("Canvas context init failed");
    canvas.height = viewport.height;
    canvas.width = viewport.width;
    await page.render({ canvasContext: context, viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.5).split(',')[1];
  };

  const processFile = async () => {
    if (!state.file || !geminiRef.current || isRunningRef.current) return;
    isRunningRef.current = true;
    isPausedRef.current = false;
    abortControllerRef.current = new AbortController();
    const startTime = Date.now();
    setState(prev => ({ ...prev, stats: { ...prev.stats, status: 'processing', startTime }, error: null }));

    try {
      const isPdf = state.file.name.toLowerCase().endsWith('.pdf');
      const isImg = state.file.type.startsWith('image/');

      if (isImg) {
        setTotalItems(1);
        const base64 = await new Promise<string>((res) => {
          const r = new FileReader();
          r.onload = () => res((r.result as string).split(',')[1]);
          r.readAsDataURL(state.file!);
        });
        setCurrentOriginal("Processing Image...");
        let full = "";
        for await (const chunk of geminiRef.current.convertStream([{ data: base64, mimeType: state.file.type }])) {
          if (abortControllerRef.current.signal.aborted || isPausedRef.current) break;
          setStreamingText(p => p + chunk);
          full += chunk;
        }
        if (!isPausedRef.current && !abortControllerRef.current.signal.aborted) {
          finalChunksRef.current = [full];
          setProcessedItems(1);
          updateProgress(1, startTime, "Image Source", full);
        }
      } else if (isPdf) {
        const arrayBuffer = await state.file.arrayBuffer();
        const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
        const totalPages = pdf.numPages;
        const start = rangeStart ? Math.max(1, parseInt(rangeStart)) : 1;
        const end = rangeEnd ? Math.min(totalPages, parseInt(rangeEnd)) : totalPages;
        setTotalItems(end);
        let current = Math.max(start, processedItems + 1);

        while (current <= end) {
          if (abortControllerRef.current.signal.aborted || isPausedRef.current) break;
          const currentBatchSize = Math.min(batchSize, end - current + 1);
          const inputs: StreamInput[] = [];
          const originals: string[] = [];

          for (let i = 0; i < currentBatchSize; i++) {
            const num = current + i;
            if (useOCR) {
              inputs.push({ data: await pdfToImageBase64(pdf, num), mimeType: 'image/jpeg' });
              originals.push(`Page ${num} (OCR Scan)`);
            } else {
              const page = await pdf.getPage(num);
              const text = (await page.getTextContent()).items.map((it: any) => it.str).join(' ');
              if (text.trim()) { 
                inputs.push(text); 
                originals.push(text.slice(0, 300)); 
              }
            }
          }

          if (inputs.length > 0) {
            setStreamingText("");
            setCurrentOriginal(originals.join("\n---\n"));
            let resultText = "";
            for await (const chunk of geminiRef.current.convertStream(inputs)) {
              if (abortControllerRef.current.signal.aborted || isPausedRef.current) break;
              setStreamingText(p => p + chunk);
              resultText += chunk;
            }
            if (!isPausedRef.current && !abortControllerRef.current.signal.aborted) {
              finalChunksRef.current.push(resultText);
              updateProgress(current / end, startTime, originals[0], resultText);
              current += currentBatchSize;
              setProcessedItems(current - 1);
            }
          } else {
            current++;
            setProcessedItems(current - 1);
          }
        }
      } else {
        // Large Text files handling (GB support via slicing)
        let offset = processedItems;
        const total = state.file.size;
        setTotalItems(total);
        const sz = DEFAULT_CHUNK_SIZE_KB * 1024;
        
        while (offset < total) {
          if (abortControllerRef.current.signal.aborted || isPausedRef.current) break;
          const chunk = await state.file.slice(offset, offset + sz).text();
          if (chunk.trim()) {
            setStreamingText("");
            setCurrentOriginal(chunk.slice(0, 400));
            let res = "";
            for await (const s of geminiRef.current.convertStream([chunk])) {
              if (abortControllerRef.current.signal.aborted || isPausedRef.current) break;
              setStreamingText(p => p + s);
              res += s;
            }
            if (!isPausedRef.current && !abortControllerRef.current.signal.aborted) {
              finalChunksRef.current.push(res);
              offset += sz;
              updateProgress(offset / total, startTime, chunk.slice(0, 100), res);
              setProcessedItems(offset);
            }
          } else { 
            offset += sz; 
            setProcessedItems(offset); 
          }
        }
      }

      if (!abortControllerRef.current.signal.aborted && !isPausedRef.current) {
        setState(prev => ({ ...prev, stats: { ...prev.stats, status: 'completed', estimatedTimeRemaining: 0 } }));
      }
    } catch (err: any) {
      setState(prev => ({ ...prev, error: `Critical System Error: ${err.message}`, stats: { ...prev.stats, status: 'error' } }));
    } finally { 
      isRunningRef.current = false; 
    }
  };

  const updateProgress = (progress: number, startTime: number, original: string, converted: string) => {
    const elap = (Date.now() - startTime) / 1000;
    const rem = progress > 0 ? (elap / progress) - elap : 0;
    setState(prev => ({
      ...prev,
      stats: { 
        ...prev.stats, 
        processedBytes: Math.floor(progress * prev.stats.totalBytes), 
        estimatedTimeRemaining: rem, 
        chunksProcessed: prev.stats.chunksProcessed + 1 
      },
      preview: [...prev.preview, { original, converted }].slice(-MAX_PREVIEW_CHUNKS),
    }));
  };

  const progressPercent = totalItems > 0 ? Math.min(100, Math.floor((processedItems / totalItems) * 100)) : 0;

  return (
    <div className="min-h-screen bg-[#0f172a] font-sans text-slate-200 overflow-x-hidden selection:bg-indigo-500/30">
      {/* APK Info Modal */}
      {showApkInfo && (
        <div className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 w-full max-w-md p-8 rounded-[2rem] shadow-2xl animate-in zoom-in-95 duration-200">
            <h3 className="text-2xl font-black text-white mb-4">Native APK Mode</h3>
            <p className="text-slate-400 text-sm mb-6 leading-relaxed">
              To use this source code as a native Android App (.apk), you can deploy it as a <strong>PWA</strong>. 
              Open this app in Chrome on your phone and select <strong>"Add to Home Screen"</strong>.
              It will work exactly like a native app with a home screen icon.
            </p>
            <button 
              onClick={() => setShowApkInfo(false)} 
              className="w-full py-4 bg-indigo-600 text-white font-black rounded-2xl active:scale-95 transition-all shadow-xl shadow-indigo-500/20"
            >
              GOT IT
            </button>
          </div>
        </div>
      )}

      <div className={`max-w-7xl mx-auto p-4 transition-all duration-700 ${isMinimized ? 'opacity-10 scale-90 blur-xl pointer-events-none' : 'opacity-100'}`}>
        <header className="flex flex-col md:flex-row items-center justify-between mb-10 gap-6 pt-4">
          <div className="flex items-center space-x-5">
            <div className="p-4 bg-indigo-600 rounded-[1.5rem] shadow-2xl shadow-indigo-500/40 text-white ring-4 ring-indigo-500/20">
              <i className="fas fa-microchip text-3xl"></i>
            </div>
            <div>
              <div className="flex items-center">
                <h1 className="text-3xl font-black text-white tracking-tighter">Urdu<span className="text-indigo-500">2</span>Roman</h1>
                <span className="text-[9px] bg-indigo-500 text-white px-2 py-0.5 rounded-full ml-3 font-black tracking-widest animate-pulse">NATIVE CORE</span>
              </div>
              <p className="text-xs text-slate-500 font-bold uppercase tracking-[0.2em] opacity-80 mt-1">High-Speed GB Book Transliteration</p>
            </div>
          </div>
          
          <div className="flex items-center bg-slate-900/80 p-3 rounded-[2rem] border border-slate-700/50 space-x-3 backdrop-blur-2xl">
             <button onClick={() => setShowApkInfo(true)} className="px-4 py-2 text-[10px] font-black text-indigo-400 uppercase tracking-widest hover:bg-indigo-500/10 rounded-xl transition-all border border-indigo-500/20">
               APK INFO
             </button>
             <div className="h-8 w-px bg-slate-700 mx-2"></div>
             
             {state.file && state.stats.status !== 'processing' && state.stats.status !== 'completed' && (
               <button onClick={processFile} className="flex items-center space-x-2 px-8 py-3 bg-indigo-600 text-white rounded-2xl font-black shadow-lg hover:shadow-indigo-500/40 transition-all active:scale-95">
                 <i className="fas fa-play text-xs"></i> <span>{state.stats.status === 'paused' ? 'RESUME' : 'START'}</span>
               </button>
             )}

             {state.stats.status === 'processing' && (
               <button onClick={pauseConversion} className="flex items-center space-x-2 px-8 py-3 bg-amber-500 text-white rounded-2xl font-black shadow-lg active:scale-95">
                 <i className="fas fa-pause text-xs"></i> <span>PAUSE</span>
               </button>
             )}

             {state.stats.status !== 'idle' && (
               <button onClick={stopConversion} className="w-12 h-12 flex items-center justify-center bg-slate-800 text-red-500 rounded-2xl border border-slate-700 hover:bg-red-500/10 active:scale-95 transition-all">
                 <i className="fas fa-stop"></i>
               </button>
             )}

             <button onClick={() => setIsMinimized(true)} className="w-12 h-12 flex items-center justify-center bg-slate-800 text-slate-400 rounded-2xl hover:text-white transition-all">
               <i className="fas fa-compress-alt"></i>
             </button>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Settings / Controls */}
          <div className="lg:col-span-3 space-y-6">
            <div className="bg-slate-900/50 rounded-[2.5rem] p-6 border border-slate-800 space-y-6">
              <h2 className="text-[10px] font-black text-slate-500 uppercase tracking-widest flex items-center">
                <i className="fas fa-layer-group mr-3 text-indigo-500"></i> Buffer Input
              </h2>
              
              <div className="space-y-4">
                <div className="relative group">
                   <input type="file" onChange={handleFileChange} accept=".txt,.pdf,image/*" className="absolute inset-0 opacity-0 cursor-pointer z-10" />
                   <div className={`p-6 border-2 border-dashed rounded-3xl text-center transition-all ${state.file ? 'bg-indigo-500/5 border-indigo-500/50' : 'bg-slate-800/30 border-slate-700'}`}>
                      <i className={`fas ${state.file ? 'fa-file-pdf text-indigo-400' : 'fa-upload text-slate-600'} text-4xl mb-3`}></i>
                      <p className="text-[11px] font-black text-slate-300 truncate px-2">{state.file ? state.file.name : 'UPLOAD BOOK (UP TO 2GB)'}</p>
                      <p className="text-[9px] text-slate-600 mt-2">PDF, TXT, OCR-READY IMAGES</p>
                   </div>
                </div>

                {state.file?.name.endsWith('.pdf') && (
                  <div className="p-5 bg-slate-800/40 rounded-3xl space-y-4 border border-slate-700/30">
                    <p className="text-[9px] font-black text-slate-500 uppercase tracking-[0.2em]">Processing Range</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <span className="text-[8px] text-slate-500 block mb-1">START</span>
                        <input type="number" placeholder="1" value={rangeStart} onChange={e => setRangeStart(e.target.value)} className="w-full p-3 bg-slate-900 border border-slate-700 rounded-xl text-xs font-mono text-indigo-400 focus:border-indigo-500 outline-none" />
                      </div>
                      <div>
                        <span className="text-[8px] text-slate-500 block mb-1">END</span>
                        <input type="number" placeholder="End" value={rangeEnd} onChange={e => setRangeEnd(e.target.value)} className="w-full p-3 bg-slate-900 border border-slate-700 rounded-xl text-xs font-mono text-indigo-400 focus:border-indigo-500 outline-none" />
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between p-5 bg-indigo-500/5 rounded-3xl border border-indigo-500/20">
                  <div className="flex flex-col">
                    <span className="text-xs font-black text-indigo-100">VISION OCR</span>
                    <span className="text-[8px] text-indigo-400/60 uppercase">PDF -> Image Scan</span>
                  </div>
                  <button onClick={() => setUseOCR(!useOCR)} className={`w-14 h-7 rounded-full transition-all relative ${useOCR ? 'bg-indigo-600 shadow-[0_0_15px_rgba(79,70,229,0.5)]' : 'bg-slate-800'}`}>
                    <div className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-all shadow-md ${useOCR ? 'right-1' : 'left-1'}`}></div>
                  </button>
                </div>
              </div>
            </div>

            <div className="bg-slate-900/50 rounded-[2.5rem] p-6 border border-slate-800">
              <h2 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-4">Export Final File</h2>
              <div className="grid grid-cols-2 gap-3">
                <button onClick={exportToDocx} disabled={!finalChunksRef.current.length} className="flex flex-col items-center p-5 bg-slate-800/50 text-indigo-400 rounded-3xl border border-slate-700 hover:bg-slate-800 transition-all disabled:opacity-20 active:scale-95">
                  <i className="fas fa-file-word text-2xl mb-2"></i>
                  <span className="text-[10px] font-black">WORD</span>
                </button>
                <button onClick={() => copyToClipboard(finalChunksRef.current.join("\n\n"))} disabled={!finalChunksRef.current.length} className="flex flex-col items-center p-5 bg-slate-800/50 text-slate-400 rounded-3xl border border-slate-700 hover:bg-slate-800 transition-all disabled:opacity-20 active:scale-95">
                  <i className="fas fa-copy text-2xl mb-2"></i>
                  <span className="text-[10px] font-black">COPY</span>
                </button>
              </div>
            </div>
          </div>

          {/* Monitoring Feed */}
          <div className="lg:col-span-9">
            <div className="bg-slate-900 rounded-[3.5rem] border-[14px] border-slate-800 shadow-3xl h-[750px] flex flex-col overflow-hidden relative group/feed">
               <div className="p-6 border-b border-white/5 bg-slate-800/30 flex justify-between items-center backdrop-blur-md">
                  <div className="flex items-center space-x-4">
                     <div className={`w-3.5 h-3.5 rounded-full ring-4 ${state.stats.status === 'processing' ? 'bg-red-500 ring-red-500/20 animate-pulse' : 'bg-slate-600 ring-slate-600/20'}`}></div>
                     <div>
                        <span className="text-[11px] font-mono font-black text-white uppercase tracking-[0.3em]">TRANS-CORE FEED</span>
                        <p className="text-[8px] text-slate-500 uppercase font-black tracking-widest mt-0.5">Packet Streaming Enabled</p>
                     </div>
                  </div>
                  <div className="flex items-center space-x-3">
                    <button onClick={() => setAutoScroll(!autoScroll)} className={`text-[9px] font-black px-5 py-2 rounded-2xl border transition-all ${autoScroll ? 'bg-indigo-600 text-white border-indigo-500' : 'bg-slate-800 text-slate-500 border-slate-700'}`}>
                        {autoScroll ? 'AUTO-FOLLOW' : 'MANUAL'}
                    </button>
                  </div>
               </div>

               <div className="flex-1 overflow-y-auto p-8 space-y-8 scrollbar-hide">
                  {state.preview.map((p, i) => (
                    <div key={i} className="grid grid-cols-1 md:grid-cols-2 gap-8 animate-in fade-in slide-in-from-bottom-6 duration-700">
                      <div className="bg-slate-800/20 p-6 rounded-[2rem] border border-white/5 shadow-inner">
                        <div className="flex justify-between items-center mb-4">
                            <p className="text-slate-600 text-[9px] font-black uppercase tracking-widest">Urdu Segment</p>
                            <span className="text-[8px] bg-slate-700/50 text-slate-500 px-2 py-0.5 rounded">ORIGINAL</span>
                        </div>
                        <p className="text-slate-300 text-base leading-relaxed text-right" dir="rtl">{p.original}</p>
                      </div>
                      <div className="bg-indigo-500/5 p-6 rounded-[2rem] border border-indigo-500/10 group relative shadow-2xl">
                        <div className="flex justify-between items-center mb-4">
                            <p className="text-indigo-500/60 text-[9px] font-black uppercase tracking-widest">Roman Output</p>
                            <button onClick={() => copyToClipboard(p.converted)} className="text-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity p-2 hover:bg-indigo-500/10 rounded-lg">
                                <i className="fas fa-copy"></i>
                            </button>
                        </div>
                        <p className="text-indigo-100 text-base leading-relaxed font-medium">{p.converted}</p>
                      </div>
                    </div>
                  ))}

                  {(streamingText || currentOriginal) && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8 py-10 border-y border-white/5 bg-indigo-500/5 rounded-[2.5rem] px-6 shadow-2xl animate-pulse">
                       <div className="opacity-40 grayscale scale-95 blur-[0.5px]">
                         <p className="text-indigo-200 text-sm leading-relaxed text-right" dir="rtl">{currentOriginal || 'Fetching packets...'}</p>
                       </div>
                       <div className="relative">
                         <div className="absolute -top-4 -left-4 bg-green-500 text-black text-[9px] px-3 py-1 rounded-full font-black animate-bounce shadow-lg shadow-green-500/20">UPLINK ACTIVE</div>
                         <p className="text-green-300 text-sm leading-relaxed font-mono whitespace-pre-wrap">
                           {streamingText}
                           <span className="inline-block w-2.5 h-5 bg-green-400 ml-1 animate-pulse"></span>
                         </p>
                       </div>
                    </div>
                  )}

                  {!state.preview.length && !streamingText && (
                    <div className="h-full flex flex-col items-center justify-center text-slate-800 select-none grayscale opacity-30">
                      <div className="relative mb-8">
                        <i className="fas fa-microchip text-[120px]"></i>
                        <div className="absolute inset-0 bg-indigo-500 blur-3xl opacity-10"></div>
                      </div>
                      <p className="font-black text-3xl uppercase tracking-[0.6em]">Core Standby</p>
                      <p className="text-xs mt-4 tracking-widest font-bold">READY FOR LARGE VOLUME INGESTION</p>
                    </div>
                  )}
                  <div ref={previewEndRef} />
               </div>

               {/* Stats Overlay */}
               {state.stats.status !== 'idle' && (
                 <div className="absolute bottom-10 left-10 right-10 bg-slate-900/95 backdrop-blur-3xl p-6 rounded-[2.5rem] border border-slate-700/50 shadow-2xl flex items-center justify-between animate-in slide-in-from-bottom-10">
                    <div className="flex-1 mr-12">
                       <div className="flex justify-between text-[10px] font-black text-slate-500 mb-3 tracking-widest">
                          <span>TOTAL PACKET FLOW: {progressPercent}%</span>
                          <span>ETA: {state.stats.estimatedTimeRemaining ? `~${Math.ceil(state.stats.estimatedTimeRemaining / 60)}m ${Math.floor(state.stats.estimatedTimeRemaining % 60)}s` : '--:--'}</span>
                       </div>
                       <div className="h-2.5 bg-white/5 rounded-full overflow-hidden border border-white/5">
                         <div className="h-full bg-indigo-600 shadow-[0_0_20px_rgba(79,70,229,0.7)] transition-all duration-1000 ease-out" style={{ width: `${progressPercent}%` }}></div>
                       </div>
                    </div>
                    <div className="text-right">
                       <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Processed</p>
                       <p className="text-indigo-400 font-mono font-black text-lg">
                        {processedItems.toLocaleString()} <span className="text-[10px] text-slate-600">{state.file?.name.endsWith('.pdf') ? 'Pages' : 'Bytes'}</span>
                       </p>
                    </div>
                 </div>
               )}
            </div>
          </div>
        </div>
      </div>

      {/* APK-Style Bottom Bar (when minimized) */}
      {isMinimized && (
        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-24">
           <div className="bg-slate-900 border-4 border-slate-800 p-4 rounded-[3rem] shadow-[0_35px_60px_-15px_rgba(0,0,0,0.8)] flex items-center space-x-8 min-w-[380px] backdrop-blur-2xl">
              <div className="flex items-center space-x-5 pl-6">
                 <div className={`w-4 h-4 rounded-full ${state.stats.status === 'processing' ? 'bg-green-500 shadow-[0_0_15px_rgba(34,197,94,0.6)] animate-pulse' : 'bg-slate-700'}`}></div>
                 <div>
                    <p className="text-white font-black text-sm">{progressPercent}% Core Ingestion</p>
                    <p className="text-[8px] text-slate-500 uppercase font-black tracking-widest">{state.stats.status}</p>
                 </div>
              </div>
              <div className="flex space-x-3 pr-2">
                 {state.stats.status === 'processing' ? (
                   <button onClick={pauseConversion} className="w-14 h-14 flex items-center justify-center bg-amber-600 text-white rounded-[1.5rem] shadow-xl active:scale-95 transition-all"><i className="fas fa-pause text-lg"></i></button>
                 ) : (
                   <button onClick={processFile} className="w-14 h-14 flex items-center justify-center bg-indigo-600 text-white rounded-[1.5rem] shadow-xl active:scale-95 transition-all"><i className="fas fa-play text-lg"></i></button>
                 )}
                 <button onClick={stopConversion} className="w-14 h-14 flex items-center justify-center bg-slate-800 text-red-500 rounded-[1.5rem] border border-slate-700 shadow-xl active:scale-95 transition-all"><i className="fas fa-stop text-lg"></i></button>
                 <button onClick={() => setIsMinimized(false)} className="w-14 h-14 flex items-center justify-center bg-white/5 text-white rounded-[1.5rem] border border-white/10 shadow-xl active:scale-95 transition-all"><i className="fas fa-expand-alt text-lg"></i></button>
              </div>
           </div>
        </div>
      )}
    </div>
  );
};

export default App;
