const loadScript = (src, publishableKey) =>
  new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.crossOrigin = 'anonymous';
    script.setAttribute('data-clerk-publishable-key', publishableKey);
    script.addEventListener('load', resolve, { once: true });
    script.addEventListener('error', () => reject(new Error(`Unable to load ${src}.`)), {
      once: true,
    });
    document.head.append(script);
  });

window.createSalesForgeClerk = async publishableKey => {
  if (!window.__internal_ClerkUICtor) {
    await loadScript('/public/clerk-runtime/ui.browser.js', publishableKey);
  }

  if (!window.Clerk) {
    await loadScript('/public/clerk-runtime/clerk.browser.js', publishableKey);
  }

  await window.Clerk.load({ clerkUICtor: window.__internal_ClerkUICtor });
  return window.Clerk;
};
