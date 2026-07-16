// Standalone vendor-portal server — runs the vendor_portal module as its own
// container so only this surface needs to face the internet (the staff app
// can then be IP-restricted at the reverse proxy). Shares the PostgreSQL
// database with the core app; requires the same JWT_SECRET so vendor tokens
// and attachment downloads work across both processes.
//
//   node src/vendor-server.js          (default port 9140; VENDOR_PORT overrides)
//
// The core app should then run with MODULES that exclude vendor_portal, and
// the reverse proxy routes /vendor + /api/vendor here.
const { init } = require('./db');
const { createBaseApp } = require('./app-base');
const { attachmentHandler } = require('./routes/invoices');
const { logoHandler } = require('./routes/admin');
const { wrap } = require('./context');

const PORT = process.env.VENDOR_PORT || process.env.PORT || 9140;

const app = createBaseApp({ serveIndex: false }); // never serve the staff SPA from this container

require('./routes/vendor-portal')(app);

// the portal SPA links these two endpoints; they are vendor-token aware
app.get('/api/invoices/:id/attachment', wrap(attachmentHandler));
app.get('/logo', logoHandler);

app.get('/', (req, res) => res.redirect('/vendor'));

async function main() {
  await init(); // schema is shared — created by whichever process starts first
  app.listen(PORT, () => {
    console.log(`Vendor portal running at http://localhost:${PORT}/vendor`);
  });
}

main().catch((e) => {
  console.error('Startup failed:', e.message);
  process.exit(1);
});
