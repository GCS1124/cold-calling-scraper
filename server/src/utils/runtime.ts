/** Keep network-backed public providers out of Vitest workers unless a test
 * injects the provider explicitly. The production and local dev runtimes do
 * not include Vitest in argv, so their defaults remain active. */
export const isTestRuntime = () =>
  process.env.NODE_ENV === 'test' ||
  process.argv.some((argument) => /(?:^|[\\/])vitest(?:[\\/]|\.|$)/i.test(argument));
