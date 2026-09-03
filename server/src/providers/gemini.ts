import axios from 'axios';

import type { SearchRequest } from '../types/search';

const geminiQueryModel = (process.env.GEMINI_QUERY_MODEL?.trim() || 'gemini-2.5-flash').replace(
  /^models\//,
  '',
);
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiQueryModel)}:generateContent`;

const parsedGeminiTimeoutMs = Number(process.env.GEMINI_QUERY_TIMEOUT_MS ?? 7_000);
const geminiTimeoutMs = Number.isFinite(parsedGeminiTimeoutMs)
  ? Math.min(8_000, Math.max(1_500, Math.round(parsedGeminiTimeoutMs)))
  : 7_000;

export const isGeminiQueryAssistanceEnabled = () =>
  process.env.GEMINI_QUERY_ASSISTANCE_ENABLED === 'true' &&
  Boolean(process.env.GEMINI_API_KEY?.trim());

export const expandQueryWithGemini = async (
  rawQuery: string,
  request: SearchRequest,
) => {
  if (!isGeminiQueryAssistanceEnabled()) {
    return rawQuery;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey?.trim()) {
    return rawQuery;
  }

  const response = await axios.post(
    `${GEMINI_ENDPOINT}?key=${apiKey}`,
    {
      contents: [
        {
          parts: [
            {
              text: `Rewrite this public-web lead discovery query for local United States business search. Focus on category synonyms, metro-area phrasing, and decision-maker roles. Return one short search phrase only. Do not include personal contact data, login instructions, or private sources.\nCategory: ${request.companyType}\nCity: ${request.city}\nResearch brief: ${request.researchBrief?.trim() || 'No additional brief'}\nOriginal: ${rawQuery}`,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 48,
      },
    },
    {
      timeout: geminiTimeoutMs,
    },
  );

  const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

  return text || rawQuery;
};
