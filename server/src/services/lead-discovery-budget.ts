const maxCandidatePool = 3_000;

/**
 * Public contact requirements are applied after discovery. Keep bounded
 * headroom so missing phones do not make every search under-fill silently.
 */
export const getLeadDiscoveryCandidateTarget = (requestedCount: number) => {
  const normalizedCount = Math.max(1, Math.round(requestedCount || 1));

  return Math.min(
    maxCandidatePool,
    Math.max(normalizedCount * 2, normalizedCount + 50),
  );
};
