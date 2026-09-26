// Module hook: any import of lib/auth.mjs resolves to the fake used by the UI harness.
const fake = new URL('./fake-auth.mjs', import.meta.url).href;
export async function resolve(specifier, context, next) {
  if (/(^|\/)lib\/auth\.mjs$/.test(specifier) && !context.parentURL?.endsWith('fake-auth.mjs')) return { url: fake, shortCircuit: true };
  return next(specifier, context);
}
