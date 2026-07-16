// Express app skeleton shared by the combined server (src/server.js) and the
// standalone vendor-portal server (src/vendor-server.js): security headers,
// JSON parsing and static assets.
const express = require('express');
const helmet = require('helmet');
const path = require('path');
const { PROD } = require('./context');

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
        // helmet adds upgrade-insecure-requests by default, which forces HTTPS and
        // breaks plain-HTTP localhost testing (Safari enforces it strictly).
        // In production everything is behind Traefik TLS, where it is a no-op anyway.
        ...(PROD ? {} : { upgradeInsecureRequests: null }),
      },
    },
    // HSTS only makes sense once served over HTTPS; Traefik terminates TLS
    strictTransportSecurity: PROD ? { maxAge: 15552000 } : false,
  }));

  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public'), serveIndex ? {} : { index: false }));

  return app;
}

module.exports = { createBaseApp };
