
import { GoogleGenAI, GenerateContentResponse } from "@google/genai";

const SYSTEM_INSTRUCTION = `
You are an expert linguist specializing in Urdu and English.
Your task is to convert Urdu text into Roman English (Roman Urdu).

Guidelines:
1. If the input contains images, perform OCR on each to extract the Urdu text.
2. Provide a direct, phonetic transliteration into Roman English for all provided content.
3. Maintain all original punctuation and structural formatting.
4. Output ONLY the transliterated text. No preamble, no "Page X" markers unless they are in the source.
5. Example: "میں اسکول جا رہا ہوں" -> "Mein school ja raha hoon".
`;

export type StreamInput = string | { data: string; mimeType: string };

export class GeminiService {
  private ai: GoogleGenAI;

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  }

  async *convertStream(inputs: StreamInput[]): AsyncGenerator<string> {
    const parts = inputs.map(input => {
      if (typeof input === 'string') {
        return { text: input };
      } else {
        return { inlineData: { data: input.data, mimeType: input.mimeType } };
      }
    });

    parts.push({ text: "Transcribe (if image) and convert all the above Urdu content into Roman English. Keep the order of segments preserved. Return only transliteration." });

    try {
      const result = await this.ai.models.generateContentStream({
        model: 'gemini-3-flash-preview',
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          temperature: 0.1,
          thinkingConfig: { thinkingBudget: 0 } // Disable thinking for pure transliteration speed
        },
      });

      for await (const chunk of result) {
        const text = chunk.text;
        if (text) yield text;
      }
    } catch (error: any) {
      console.error('Gemini Stream Error Detail:', error);
      const msg = error?.message || 'Streaming conversion failed.';
      throw new Error(`AI Uplink Error: ${msg}`);
    }
  }
}
