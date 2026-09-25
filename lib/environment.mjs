export function environmentReport(env = process.env) {
  const has = name => Boolean(String(env[name] || '').trim());
  const groups = {
    auth: ['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY'],
    database: [has('DATABASE_URL') ? 'DATABASE_URL' : 'POSTGRES_URL'],
    storage: ['BLOB_READ_WRITE_TOKEN'],
    billing: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_STARTER', 'STRIPE_PRICE_PRO', 'STRIPE_PRICE_SCALE'],
    computerUse: ['COMPUTER_USE_SNAPSHOT_ID'],
    ai: has('AI_GATEWAY_API_KEY') || has('VERCEL_OIDC_TOKEN') || has('VERCEL') ? [] : ['AI_GATEWAY_API_KEY']
  };
  const features = Object.fromEntries(Object.entries(groups).map(([name, names]) => {
    const missing = names.filter(variable => !has(variable));
    return [name, { ready: missing.length === 0, missing }];
  }));
  return { ready: Object.values(features).every(feature => feature.ready), features, obsolete: ['E2B_API_KEY', 'E2B_TEMPLATE'].filter(has) };
}
