
export interface ConversionStats {
  totalBytes: number;
  processedBytes: number;
  startTime: number;
  estimatedTimeRemaining: number | null;
  status: 'idle' | 'processing' | 'completed' | 'error' | 'paused';
  chunksProcessed: number;
}

export interface ChunkResult {
  original: string;
  converted: string;
}

export interface ResumeMetadata {
  fileName: string;
  fileSize: number;
  lastProcessedIndex: number; // Page number for PDF, offset for TXT
  accumulatedContent: string[];
  useOCR: boolean;
  totalItems: number;
}

export interface AppState {
  file: File | null;
  stats: ConversionStats;
  preview: ChunkResult[];
  error: string | null;
  resumeData: ResumeMetadata | null;
}
