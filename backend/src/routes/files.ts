import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';
import { query } from '../db';
import { requireAuth, type AuthedRequest } from '../middleware/auth';
import { HttpError } from '../middleware/error';

export const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
  'application/pdf', 'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip',
  'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/webm', 'audio/wav', 'audio/x-wav', 'audio/aac',
  // Android uploads attachments as generic binary; the extension + size checks still apply.
  'application/octet-stream',
  'video/mp4',
]);

const ALLOWED_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic',
  '.pdf', '.txt', '.doc', '.docx', '.xls', '.xlsx', '.zip',
  '.mp3', '.m4a', '.ogg', '.webm', '.wav', '.aac', '.mp4',
]);

function ensureUploadDir(): void {
  fs.mkdirSync(config.uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    ensureUploadDir();
    cb(null, config.uploadDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, `${uuidv4()}${ALLOWED_EXT.has(ext) ? ext : '.bin'}`);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_MIME.has(file.mimetype) && !ALLOWED_EXT.has(ext)) {
      cb(new HttpError(415, `File type not allowed: ${file.mimetype}`));
      return;
    }
    cb(null, true);
  },
});

interface FileRow {
  id: string;
  stored_name: string;
  original_name: string;
  mime_type: string;
  size_bytes: string;
  uploaded_by: string;
}

export function filesRouter(): Router {
  const r = Router();

  r.post('/upload', requireAuth, upload.single('file'), async (req: AuthedRequest, res, next) => {
    try {
      if (!req.file) throw new HttpError(400, 'No file uploaded (multipart field name: file)');
      const { rows } = await query<FileRow>(
        `INSERT INTO files (stored_name, original_name, mime_type, size_bytes, uploaded_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, req.user!.id],
      );
      const f = rows[0];
      const url = `/api/files/${f.stored_name}`;
      res.status(201).json({
        url,
        name: f.original_name,
        fileName: f.original_name,
        storedName: f.stored_name,
        mime: f.mime_type,
        mimeType: f.mime_type,
        size: Number(f.size_bytes),
        sizeBytes: Number(f.size_bytes),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Authenticated download. Simplified membership rule (per spec): the caller
   * must be authenticated AND the file must exist in the files table (i.e. it
   * was uploaded by an authorized team member — only team members can upload,
   * and the team is a closed set of 10). Path traversal is blocked by looking
   * up stored_name in the DB and resolving inside UPLOAD_DIR.
   */
  r.get('/files/:name', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const { rows } = await query<FileRow>('SELECT * FROM files WHERE stored_name = $1', [req.params.name]);
      const f = rows[0];
      if (!f) throw new HttpError(404, 'File not found');
      const full = path.resolve(config.uploadDir, f.stored_name);
      if (!full.startsWith(path.resolve(config.uploadDir) + path.sep) || !fs.existsSync(full)) {
        throw new HttpError(404, 'File not found');
      }
      res.type(f.mime_type);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(f.original_name)}"`);
      res.sendFile(full);
    } catch (err) {
      next(err);
    }
  });

  return r;
}
