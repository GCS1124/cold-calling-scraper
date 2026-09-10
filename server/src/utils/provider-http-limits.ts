/**
 * Explicit limits for direct Axios calls to untrusted public providers. Keep
 * provider responses small and predictable before parsing them in memory.
 */
export const publicProviderAxiosLimits = {
  maxContentLength: 2_000_000,
  maxBodyLength: 1_000_000,
};
