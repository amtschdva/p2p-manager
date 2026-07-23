// Express app skeleton shared by the combined server (src/server.js) and the
// standalone vendor-portal server (src/vendor-server.js): security headers,
// JSON parsing and static assets.
const express = require('express');
const helmet = require('helmet');
const path = require('path');
const { PROD } = require('./context');

// Is the app actually reached over HTTPS? True in production behind Traefik/any
// TLS proxy (the default). When serving plain HTTP directly or behind a proxy
// that does NOT terminate TLS, set INSECURE_HTTP=1 — otherwise the browser's
// upgrade-insecure-requests rewrites every /css and /js request to https://,
// so the page loads unstyled with a dead SPA (blank after login).
const HTTPS_UPFRONT = PROD && process.env.INSECURE_HTTP !== '1';

function createBaseApp({ serveIndex = true } = {}) {
  const app = express();

  // behind a reverse proxy (Traefik) the client IP arrives in X-Forwarded-For
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // 'unsafe-inline' is required by the inline event handlers in the SPA; Chart.js comes from jsdelivr
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        // only force-upgrade http->https when TLS is actually in front, else
        // plain-HTTP deployments can't load their own /css and /js
        ...(HTTPS_UPFRONT ? {} : { upgradeInsecureRequests: null }),
      },
    },
    // HSTS only makes sense once served over HTTPS
    strictTransportSecurity: HTTPS_UPFRONT ? { maxAge: 15552000 } : false,
  }));

  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public'), serveIndex ? {} : { index: false }));

  return app;
}

module.exports = { createBaseApp };
