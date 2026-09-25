import { withWorkflow } from 'workflow/next';

export default withWorkflow({
  serverExternalPackages: ['workflow', '@workflow/core', '@workflow/world-local', 'pdfjs-dist', 'mammoth'],
  async rewrites() {
    return [
      { source: '/', destination: '/index.html' },
      { source: '/privacy', destination: '/privacy.html' },
      { source: '/terms', destination: '/terms.html' },
      { source: '/health', destination: '/api/health' },
      { source: '/public/:path*', destination: '/:path*' },
      { source: '/assets/:path*', destination: '/api/_assets/:path*' }
    ];
  }
});
