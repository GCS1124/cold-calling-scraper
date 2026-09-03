import type { ResearchDepth } from '../types/search';

export type ResearchDepthConfig = {
  queryMultiplier: number;
  maxQueryFamilies: number;
  secondPageQueryLimit: number;
  googleMapsQueryLimit: number;
  timeMultiplier: number;
};

const configs: Record<ResearchDepth, ResearchDepthConfig> = {
  quick: {
    queryMultiplier: 0.65,
    maxQueryFamilies: 8,
    secondPageQueryLimit: 0,
    googleMapsQueryLimit: 6,
    timeMultiplier: 0.65,
  },
  verified: {
    queryMultiplier: 1,
    maxQueryFamilies: 12,
    secondPageQueryLimit: 12,
    googleMapsQueryLimit: 12,
    timeMultiplier: 1,
  },
  pro: {
    queryMultiplier: 1.45,
    maxQueryFamilies: 18,
    secondPageQueryLimit: 20,
    googleMapsQueryLimit: 18,
    timeMultiplier: 1.35,
  },
};

export const normalizeResearchDepth = (value?: unknown): ResearchDepth =>
  typeof value === 'string' && value in configs ? (value as ResearchDepth) : 'verified';

export const getResearchDepthConfig = (value?: unknown) =>
  configs[normalizeResearchDepth(value)];
