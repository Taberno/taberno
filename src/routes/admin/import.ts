import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import '../../types';
import { createReadStream } from 'fs';
import fs from 'fs';
import { render, renderFragment } from '../../admin/render';
import { getAdminById } from '../../admin/auth';
import { getAllSettings } from '../../db/queries/admin';
import { findImportJob, listRecentImportJobs } from '../../db/queries/import';
import { startWxrImportJob, startApiImportJob } from '../../import/woocommerce/jobs';
import { exportStore, stageStoreImport } from '../../admin/store-transfer';

export async function importRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/import', importPage);
  fastify.post('/import/wxr', uploadWxr);
  fastify.post('/import/woocommerce', connectApi);
  fastify.get('/import/jobs/:id', jobStatus);
  fastify.get('/import/export', exportStoreHandler);
  fastify.post('/import/store', importStoreHandler);
}

async function importPage(req: FastifyRequest<{ Querystring: { job?: string; error?: string } }>, reply: FastifyReply) {
  const admin = getAdminById(req.session.adminId!)!;
  const activeJob = req.query.job ? findImportJob(req.query.job) : null;

  return reply.type('text/html').send(
    await render(
      'import',
      {
        admin,
        settings: getAllSettings(),
        activeJob,
        jobs: listRecentImportJobs(10),
        error: req.query.error,
        pageTitle: 'Import / Export',
        pageSection: 'settings', // lives under Settings in the nav

      },
      reply,
    ),
  );
}

async function uploadWxr(req: FastifyRequest, reply: FastifyReply) {
  const data = await req.file();
  if (!data) return reply.redirect('/admin/import?error=no_file');

  const xml = (await data.toBuffer()).toString('utf-8');
  const jobId = startWxrImportJob(xml);
  return reply.redirect(`/admin/import?job=${jobId}`);
}

async function connectApi(
  req: FastifyRequest<{
    Body: {
      store_url?: string;
      consumer_key?: string;
      consumer_secret?: string;
      import_products?: string;
      import_orders?: string;
      import_pages?: string;
    };
  }>,
  reply: FastifyReply,
) {
  const { store_url, consumer_key, consumer_secret } = req.body;
  if (!store_url || !consumer_key || !consumer_secret) {
    return reply.redirect('/admin/import?error=missing_fields');
  }

  const jobId = startApiImportJob(
    { storeUrl: store_url.trim(), consumerKey: consumer_key.trim(), consumerSecret: consumer_secret.trim() },
    {
      importProducts: req.body.import_products === 'on',
      importOrders: req.body.import_orders === 'on',
      importPages: req.body.import_pages === 'on',
    },
  );
  return reply.redirect(`/admin/import?job=${jobId}`);
}

async function jobStatus(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  const job = findImportJob(req.params.id);
  if (!job) return reply.code(404).send('Not found');
  return reply.type('text/html').send(renderFragment('partials/import-job', { job }));
}

// ── Whole-store transfer (export / import a full taberno store) ───────────────

async function exportStoreHandler(
  req: FastifyRequest<{ Querystring: { digital?: string } }>,
  reply: FastifyReply,
) {
  const includeDigitalFiles = req.query.digital === '1';
  const { zipPath, dir, filename } = await exportStore({ includeDigitalFiles });
  const stream = createReadStream(zipPath);
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  stream.on('close', cleanup);
  stream.on('error', cleanup);
  reply.header('Content-Type', 'application/zip');
  reply.header('Content-Disposition', `attachment; filename="${filename}"`);
  return reply.send(stream);
}

async function importStoreHandler(req: FastifyRequest, reply: FastifyReply) {
  // A whole-store export can be very large (all product images, digital files),
  // so lift the per-file limit well above the global multipart cap.
  const data = await req.file({ limits: { fileSize: 5 * 1024 * 1024 * 1024 } });
  if (!data) return reply.redirect('/admin/import?error=No+file+uploaded');

  try {
    const buffer = await data.toBuffer();
    const { manifest } = await stageStoreImport(buffer);
    // The current DB is about to be replaced by the import, so log to stdout
    // (survives the restart) rather than the soon-to-be-overwritten DB.
    console.log('Store import staged — restarting to apply.', JSON.stringify(manifest.counts));
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Import failed';
    return reply.redirect(`/admin/import?error=${encodeURIComponent(msg)}`);
  }

  // Staged successfully — restart so pending-import applies it before the DB
  // reopens. Show a self-refreshing page since /admin is briefly unavailable.
  reply.type('text/html').send(`<!doctype html><html><head><meta charset="utf-8">
<title>Importing store…</title><meta http-equiv="refresh" content="8; url=/admin">
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:32rem;margin:6rem auto;padding:0 1.5rem;color:#374151;text-align:center}</style>
</head><body><h1 style="font-size:1.25rem">Importing your store…</h1>
<p>The server is restarting to apply the import. This page will reload automatically — if it doesn't, <a href="/admin">click here</a> in a few seconds.</p>
</body></html>`);
  setTimeout(() => process.exit(0), 600);
}
