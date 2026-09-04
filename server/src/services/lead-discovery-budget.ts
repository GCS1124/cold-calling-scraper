const maxCandidatePool = 3_000;

/**
 * Public contact requirements are applied after discovery. Keep bounded
 * headroom so missing phones do not make every search under-fill silently.
 * Public profile sources need more headroom than structured business listings
 * because phone evidence is much less consistently published there.
 */
export const getLeadDiscoveryCandidateTarget = (
  requestedCount: number,
  headroomMultiplier = 2,
) => {
  const normalizedCount = Math.max(1, Math.round(requestedCount || 1));
  const normalizedMultiplier = Math.min(3, Math.max(1, headroomMultiplier));

  return Math.min(
    maxCandidatePool,
    Math.max(
      Math.ceil(normalizedCount * normalizedMultiplier),
      normalizedCount + 50,
    ),
  );
};
