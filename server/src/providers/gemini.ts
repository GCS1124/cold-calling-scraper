import axios from 'axios';

import type { SearchRequest } from '../types/search';

const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

export const expandQueryWithGemini = async (
  rawQuery: string,
  request: SearchRequest,
) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return rawQuery;
  }

  const response = await axios.post(
    `${GEMINI_ENDPOINT}?key=${apiKey}`,
    {
      contents: [
        {
          parts: [
            {
              text: `Rewrite this lead-generation query for local United States business search. Focus on US market wording, metro-area phrasing, and buyer-friendly business categories. Return one short query only.\nCategory: ${request.companyType}\nCity: ${request.city}\nOriginal: ${rawQuery}`,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
      },
    },
    {
      timeout: 12000,
    },
  );

  const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

  return text || rawQuery;
};
