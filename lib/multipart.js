// lib/multipart.js
// Minimal multipart/form-data parser for Vercel serverless functions.
// Uses busboy (lightweight, streaming) — install with: npm i busboy

import Busboy from 'busboy';

/**
 * Parse a multipart/form-data request.
 * Returns: { fields: {key: string}, files: [{filename, contentType, data, size}, ...] }
 *
 * Files are buffered in memory (we cap at 5 files × 20MB each in the handler).
 */
export function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.startsWith('multipart/form-data')) {
      return reject(new Error('Expected multipart/form-data'));
    }

    const fields = {};
    const files = [];

    const bb = Busboy({
      headers: req.headers,
      limits: {
        files: 5,                  // max 5 files per submission
        fileSize: 20 * 1024 * 1024, // max 20 MB per file
        fields: 20,                // max 20 form fields
        fieldSize: 1024 * 1024     // max 1 MB per text field (room for JSON)
      }
    });

    bb.on('field', (name, val) => {
      fields[name] = val;
    });

    bb.on('file', (name, fileStream, info) => {
      const chunks = [];
      let size = 0;
      let truncated = false;

      fileStream.on('data', (chunk) => {
        chunks.push(chunk);
        size += chunk.length;
      });
      fileStream.on('limit', () => {
        truncated = true;
      });
      fileStream.on('end', () => {
        if (truncated) {
          // Skip files that exceeded the size limit
          console.warn(`File ${info.filename} exceeded size limit — skipped`);
          return;
        }
        files.push({
          fieldName: name,
          filename: info.filename || 'unnamed',
          contentType: info.mimeType || 'application/octet-stream',
          data: Buffer.concat(chunks),
          size
        });
      });
    });

    bb.on('error', (err) => reject(err));
    bb.on('finish', () => resolve({ fields, files }));

    req.pipe(bb);
  });
}
