/**
 * Cloudflare R2 Storage — PDF document backup
 *
 * Architecture: dual-write strategy
 *   1. Local filesystem (/tmp/theopus-uploads/) — fast access for PDF processing
 *   2. Cloudflare R2 (cloud) — persistent backup, survives sandbox resets
 *
 * On sandbox reset: pull files from R2 → local (sync endpoint)
 *
 * R2 uses S3-compatible API, so we use @aws-sdk/client-s3.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { promises as fs } from 'fs'
import path from 'path'

// ==================== CONFIG ====================

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || ''
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || ''
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || ''
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'themagnumopus'
const R2_ENDPOINT = process.env.R2_ENDPOINT || ''
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || ''

// ==================== S3 CLIENT (singleton) ====================

let s3Client: S3Client | null = null

/**
 * Get S3 client configured for R2 (singleton pattern for hot-reload safety).
 */
function getS3Client(): S3Client | null {
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ENDPOINT) {
    return null
  }
  if (s3Client) return s3Client

  s3Client = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: false, // R2 prefers virtual-hosted-style
  })
  return s3Client
}

/**
 * Check if R2 is configured (env vars present).
 */
export function isR2Configured(): boolean {
  return !!(R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_ENDPOINT && R2_BUCKET_NAME)
}

// ==================== TYPES ====================

export interface R2UploadResult {
  success: boolean
  key: string
  etag?: string
  size: number
  error?: string
}

export interface R2DownloadResult {
  success: boolean
  buffer?: Buffer
  size?: number
  error?: string
}

export interface R2ListResult {
  success: boolean
  objects: Array<{
    key: string
    size: number
    lastModified: Date
  }>
  error?: string
}

// ==================== UPLOAD ====================

/**
 * Upload a buffer to R2 with a given key.
 *
 * @param key - S3 key (e.g., "pdfs/uuid_test.pdf")
 * @param buffer - File content
 * @param contentType - MIME type (default: application/pdf)
 * @returns Upload result with etag + size
 */
export async function uploadToR2(
  key: string,
  buffer: Buffer,
  contentType: string = 'application/pdf'
): Promise<R2UploadResult> {
  const client = getS3Client()
  if (!client) {
    return { success: false, key, size: 0, error: 'R2 not configured (missing credentials)' }
  }

  try {
    const result = await client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        // Cache for 1 hour on Cloudflare edge
        CacheControl: 'max-age=3600',
        // Custom metadata: upload timestamp
        Metadata: {
          uploadedAt: new Date().toISOString(),
          uploadedBy: 'theopusflashlite',
        },
      })
    )

    console.log(`[R2] Uploaded: ${key} (${buffer.length} bytes, etag=${result.ETag})`)
    return {
      success: true,
      key,
      etag: result.ETag,
      size: buffer.length,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[R2] Upload failed for ${key}:`, msg)
    return { success: false, key, size: 0, error: msg }
  }
}


// ==================== DOWNLOAD ====================

/**
 * Download an object from R2 as a buffer.
 *
 * @param key - S3 key
 * @returns Buffer or error
 */
export async function downloadFromR2(key: string): Promise<R2DownloadResult> {
  const client = getS3Client()
  if (!client) {
    return { success: false, error: 'R2 not configured' }
  }

  try {
    const result = await client.send(
      new GetObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
      })
    )

    if (!result.Body) {
      return { success: false, error: 'No body in response' }
    }

    // Convert stream to buffer
    const chunks: Buffer[] = []
    for await (const chunk of result.Body as AsyncIterable<Buffer>) {
      chunks.push(chunk)
    }
    const buffer = Buffer.concat(chunks)

    console.log(`[R2] Downloaded: ${key} (${buffer.length} bytes)`)
    return {
      success: true,
      buffer,
      size: buffer.length,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[R2] Download failed for ${key}:`, msg)
    return { success: false, error: msg }
  }
}

/**
 * Download an R2 object to a local file path.
 *
 * @param key - S3 key
 * @param localPath - Absolute path to save file
 */
export async function downloadFileFromR2(
  key: string,
  localPath: string
): Promise<{ success: boolean; size?: number; error?: string }> {
  const result = await downloadFromR2(key)
  if (!result.success || !result.buffer) {
    return { success: false, error: result.error }
  }

  try {
    // Ensure directory exists
    await fs.mkdir(path.dirname(localPath), { recursive: true })
    await fs.writeFile(localPath, result.buffer)
    console.log(`[R2] Saved to local: ${localPath} (${result.size} bytes)`)
    return { success: true, size: result.size }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}

// ==================== DELETE ====================

/**
 * Delete an object from R2.
 */
export async function deleteFromR2(key: string): Promise<{ success: boolean; error?: string }> {
  const client = getS3Client()
  if (!client) {
    return { success: false, error: 'R2 not configured' }
  }

  try {
    await client.send(
      new DeleteObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
      })
    )
    console.log(`[R2] Deleted: ${key}`)
    return { success: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[R2] Delete failed for ${key}:`, msg)
    return { success: false, error: msg }
  }
}

// ==================== CHECK EXISTENCE ====================


// ==================== LIST ====================

/**
 * List objects in R2 bucket (optionally filtered by prefix).
 *
 * @param prefix - Filter objects by key prefix (e.g., "pdfs/")
 * @param maxKeys - Max results (default 100, max 1000)
 */
export async function listR2Objects(
  prefix?: string,
  maxKeys: number = 100
): Promise<R2ListResult> {
  const client = getS3Client()
  if (!client) {
    return { success: false, objects: [], error: 'R2 not configured' }
  }

  try {
    const result = await client.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET_NAME,
        Prefix: prefix,
        MaxKeys: maxKeys,
      })
    )

    const objects = (result.Contents || []).map(obj => ({
      key: obj.Key || '',
      size: obj.Size || 0,
      lastModified: obj.LastModified || new Date(0),
    }))

    console.log(`[R2] Listed ${objects.length} objects (prefix=${prefix || 'none'})`)
    return { success: true, objects }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[R2] List failed:', msg)
    return { success: false, objects: [], error: msg }
  }
}

// ==================== PRE-SIGNED URLS ====================


// ==================== CONVENIENCE: PDF STORAGE ====================

/**
 * Standard R2 key for PDF documents: "pdfs/<documentId>_<filename>"
 */
export function r2KeyForPdf(documentId: string, originalName: string): string {
  const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_')
  return `pdfs/${documentId}_${safeName}`
}

/**
 * Upload a PDF buffer to R2 with standard key naming.
 */
export async function uploadPdfToR2(
  documentId: string,
  originalName: string,
  buffer: Buffer
): Promise<R2UploadResult> {
  const key = r2KeyForPdf(documentId, originalName)
  return await uploadToR2(key, buffer, 'application/pdf')
}

// ==================== HEALTH CHECK ====================

/**
 * Verify R2 connection + bucket access.
 * Used by /api/health to show R2 status in UI.
 */
export async function checkR2Health(): Promise<{
  configured: boolean
  connected: boolean
  bucket: string
  error?: string
  objectCount?: number
}> {
  if (!isR2Configured()) {
    return { configured: false, connected: false, bucket: R2_BUCKET_NAME }
  }

  const client = getS3Client()
  if (!client) {
    return { configured: true, connected: false, bucket: R2_BUCKET_NAME, error: 'Client init failed' }
  }

  try {
    const list = await client.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET_NAME,
        MaxKeys: 1,
      })
    )
    return {
      configured: true,
      connected: true,
      bucket: R2_BUCKET_NAME,
      objectCount: list.KeyCount || 0,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { configured: true, connected: false, bucket: R2_BUCKET_NAME, error: msg }
  }
}
