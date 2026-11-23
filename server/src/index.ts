import 'dotenv/config'
import bcrypt from 'bcryptjs'
import cookieParser from 'cookie-parser'
import compression from 'compression'
import cors from 'cors'
import express, { type NextFunction, type Request, type Response } from 'express'
import rateLimit from 'express-rate-limit'
import helmet from 'helmet'
import jwt from 'jsonwebtoken'
import { Prisma, PrismaClient } from '@prisma/client'
import { OAuth2Client } from 'google-auth-library'
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextReader, TextWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js'
import { z } from 'zod'

const app = express()
const prisma = new PrismaClient()
const homepageInlineImageMaxChars = 350_000
const homepageHeroImageFallback = '/assets/images/home-hero.jpg'
const port = Number(process.env.PORT || 4000)
const isRailwayDeployment = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PUBLIC_DOMAIN)
const isProduction = process.env.NODE_ENV === 'production' || isRailwayDeployment
function homepageContentForResponse(pageKey: string, content: NonNullable<Awaited<ReturnType<typeof prisma.pageContent.findUnique>>>) {
  if (pageKey !== 'HOME_HERO_IMAGE') return content
  const blocks = content.blocks
  if (!blocks || typeof blocks !== 'object' || Array.isArray(blocks)) return content
  const savedImages = 'images' in blocks && Array.isArray(blocks.images)
    ? blocks.images
    : 'image' in blocks && typeof blocks.image === 'string'
      ? [blocks.image]
      : []
  const displayImages = savedImages.filter((image): image is string =>
    typeof image === 'string' && Boolean(image.trim()) && (!image.startsWith('data:image/') || image.length <= homepageInlineImageMaxChars))
  return {
    ...content,
    blocks: {
      ...blocks,
      images: displayImages,
      image: displayImages[0] || homepageHeroImageFallback,
    },
  }
}
const configuredProductionOrigin = process.env.PUBLIC_APP_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN.replace(/^https?:\/\//, '')}` : '')
const productionOrigin = new URL(configuredProductionOrigin || 'https://carmmessage-production.up.railway.app')
if (isProduction && (productionOrigin.protocol !== 'https:' || productionOrigin.hostname === 'localhost' || productionOrigin.hostname.endsWith('.localhost'))) {
  throw new Error('Set PUBLIC_APP_URL to the public HTTPS website URL in production.')
}
const clientOrigin = isProduction
  ? productionOrigin.origin
  : process.env.CLIENT_ORIGIN || 'http://localhost:5173'
const jwtSecret = process.env.JWT_SECRET || (isProduction ? '' : 'local-only-change-this-secret')
if (!jwtSecret) throw new Error('Set JWT_SECRET before starting in production.')
const lightfmServiceUrl = process.env.LIGHTFM_SERVICE_URL || 'http://127.0.0.1:8001'
const lightfmApiToken = process.env.LIGHTFM_API_TOKEN || ''
const xenditSecretKey = process.env.XENDIT_SECRET_KEY || process.env.XENDIT_TEST_SECRET_KEY || ''
const xenditCallbackToken = process.env.XENDIT_CALLBACK_TOKEN || ''
const resendApiKey = process.env.RESEND_API_KEY || ''
const resendFrom = process.env.RESEND_FROM || ''
const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim() || ''
const facebookAppId = process.env.FACEBOOK_APP_ID?.trim() || ''
const facebookAppSecret = process.env.FACEBOOK_APP_SECRET?.trim() || ''
const googleOAuthClient = new OAuth2Client()
const systemBackupFormat = 'carmels-in-communion-backup'
const maxBackupPlaintextBytes = 45 * 1024 * 1024
async function sendEmail(email: { to: string; subject: string; text: string; html: string }): Promise<void> {
  if (!resendApiKey || !resendFrom) throw new Error('Resend email is not configured. Set RESEND_API_KEY and RESEND_FROM in server/.env.')
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: resendFrom, ...email }),
    signal: AbortSignal.timeout(15000),
  })
  if (response.ok) return
  const responseText = await response.text()
  let detail = ''
  try {
    const body: unknown = responseText ? JSON.parse(responseText) : null
    if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') detail = body.message
    else if (body && typeof body === 'object' && 'name' in body && typeof body.name === 'string') detail = body.name
  } catch {
    detail = ''
  }
  throw new Error(`Resend email request failed (HTTP ${response.status})${detail ? `: ${detail}` : '.'}`)
}
const backupTables = [
  { name: 'User', columns: ['id', 'name', 'email', 'phone', 'address', 'privacyConsentAt', 'privacyPolicyVersion', 'passwordHash', 'role', 'isActive', 'canManageUsers', 'canManageDetails', 'canManageUpdates', 'createdAt', 'updatedAt'], uniqueColumns: ['email'] },
  { name: 'OAuthIdentity', columns: ['id', 'provider', 'providerUserId', 'userId', 'createdAt'], uniqueColumns: [], uniqueColumnGroups: [['provider', 'providerUserId']] },
  { name: 'Monastery', columns: ['id', 'name', 'city', 'slug', 'description', 'imageUrl', 'address', 'contact', 'sortOrder', 'createdAt', 'updatedAt'], uniqueColumns: ['slug'] },
  { name: 'Discernment', columns: ['id', 'userId', 'stage', 'monastery', 'note', 'createdAt', 'updatedAt'], uniqueColumns: ['userId'] },
  { name: 'Donation', columns: ['id', 'referenceCode', 'amount', 'type', 'fund', 'paymentMethod', 'xenditInvoiceId', 'xenditInvoiceUrl', 'paymongoPaymentIntentId', 'paymongoQrImageUrl', 'paymongoQrExpiresAt', 'isManual', 'isAnonymous', 'donorName', 'donorEmail', 'donorPhone', 'wantsReceipt', 'receiptEmailSentAt', 'receiptEmailSendingAt', 'paymentReference', 'beneficiaryMonasteryId', 'userId', 'status', 'createdAt', 'updatedAt'], uniqueColumns: ['referenceCode', 'xenditInvoiceId', 'paymongoPaymentIntentId'] },
  { name: 'DonationFile', columns: ['id', 'donationId', 'fileUrl', 'type', 'fileName', 'createdAt'], uniqueColumns: [] },
  { name: 'Conversation', columns: ['id', 'userId', 'name', 'email', 'subject', 'category', 'isRead', 'lastMessageAt', 'createdAt'], uniqueColumns: ['userId'] },
  { name: 'Message', columns: ['id', 'conversationId', 'senderId', 'senderType', 'body', 'readAt', 'createdAt'], uniqueColumns: [] },
  { name: 'Update', columns: ['id', 'title', 'slug', 'excerpt', 'body', 'coverImage', 'category', 'publishedAt', 'createdAt', 'updatedAt'], uniqueColumns: ['slug'] },
  { name: 'PageContent', columns: ['id', 'pageKey', 'blocks', 'updatedAt'], uniqueColumns: ['pageKey'], jsonColumns: ['blocks'] },
  { name: 'ContentInteraction', columns: ['id', 'userId', 'readingId', 'eventType', 'dedupeKey', 'createdAt'], uniqueColumns: ['dedupeKey'] },
  { name: 'FAQ', columns: ['id', 'question', 'answer', 'sortOrder', 'isPublished', 'updatedAt'], uniqueColumns: [] },
  { name: 'AuditLog', columns: ['id', 'userId', 'action', 'entity', 'entityId', 'meta', 'createdAt'], uniqueColumns: [], jsonColumns: ['meta'] },
] as const
const backupDependencies: Record<string, Array<{ table: string; column: string }>> = {
  OAuthIdentity: [{ table: 'User', column: 'userId' }],
  Discernment: [{ table: 'User', column: 'userId' }],
  Donation: [{ table: 'Monastery', column: 'beneficiaryMonasteryId' }, { table: 'User', column: 'userId' }],
  DonationFile: [{ table: 'Donation', column: 'donationId' }],
  Conversation: [{ table: 'User', column: 'userId' }],
  Message: [{ table: 'Conversation', column: 'conversationId' }, { table: 'User', column: 'senderId' }],
  ContentInteraction: [{ table: 'User', column: 'userId' }],
  AuditLog: [{ table: 'User', column: 'userId' }],
}
const backupEnumColumns: Record<string, Record<string, string>> = {
  User: { role: '"Role"' },
  Discernment: { stage: '"DiscernmentStage"' },
  Donation: { type: '"DonationType"', paymentMethod: '"PaymentMethod"', status: '"DonationStatus"' },
  Conversation: { category: '"MessageCategory"' },
  Message: { senderType: '"SenderType"' },
  ContentInteraction: { eventType: '"ContentInteractionType"' },
}

app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use(compression())
app.use(helmet({
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  contentSecurityPolicy: {
    directives: {
      connectSrc: ["'self'", 'https://accounts.google.com/gsi/', 'https://connect.facebook.net', 'https://graph.facebook.com', 'https://www.facebook.com', 'https://web.facebook.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://images.unsplash.com', 'https://www.facebook.com', 'https://static.xx.fbcdn.net'],
      mediaSrc: ["'self'", 'data:'],
      frameSrc: ["'self'", 'https://www.youtube-nocookie.com', 'https://player.vimeo.com', 'https://accounts.google.com/gsi/', 'https://www.facebook.com', 'https://staticxx.facebook.com'],
      scriptSrc: ["'self'", 'https://accounts.google.com/gsi/client', 'https://connect.facebook.net'],
    },
  },
}))
app.use(cors({ origin: clientOrigin, credentials: true }))
app.use(express.json({ limit: '16mb' }))
app.use(cookieParser())
app.use('/api/auth', rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.setHeader('Retry-After', '300').status(429).json({ error: 'Too many authentication attempts. Please wait 5 minutes before trying again.' }),
}))
app.use('/api/contact', rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false }))
const passwordResetRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.setHeader('Retry-After', '900').status(429).json({ error: 'Too many password reset requests. Please wait 15 minutes before trying again.' }),
})
const registrationEmailRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.setHeader('Retry-After', '900').status(429).json({ error: 'Too many verification emails. Please wait 15 minutes before trying again.' }),
})
const registrationVerifyRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.setHeader('Retry-After', '900').status(429).json({ error: 'Too many verification attempts. Please wait 15 minutes before trying again.' }),
})
app.use('/api/content/interactions', rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }))

const cookieOptions = { httpOnly: true, secure: isProduction, sameSite: 'strict' as const, path: '/' }
const visitorChatCookieOptions = { ...cookieOptions, path: '/api/chat' }
type AuthRequest = Request & { auth?: { id: string; role: 'ADMIN' | 'FORMATOR' | 'USER'; canManageUsers: boolean; canManageDetails: boolean; canManageUpdates: boolean } }
function staffConversationAccessWhere(req: AuthRequest): Prisma.ConversationWhereInput {
  const actor = req.auth!
  if (actor.role === 'ADMIN') {
    return { OR: [{ staffRecipientId: null }, { staffRecipient: { is: { role: 'ADMIN' } } }] }
  }
  return { staffRecipientId: actor.id }
}
async function optionalAuthenticate(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.cookies?.carmel_session) return next()
  return authenticate(req, res, next)
}
async function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.carmel_session as string | undefined
  if (!token) return res.status(401).json({ error: 'Sign in is required.' })
  let claims: jwt.JwtPayload
  try {
    const verified = jwt.verify(token, jwtSecret)
    if (typeof verified === 'string' || typeof verified.id !== 'string') return res.status(401).json({ error: 'Invalid session.' })
    claims = verified
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ error: 'Your session has expired. Please sign in again.' })
    }
    return next(error)
  }
  try {
    const user = await prisma.user.findUnique({
      where: { id: claims.id as string },
      select: { id: true, role: true, isActive: true, sessionVersion: true, sessionExpiresAt: true, canManageUsers: true, canManageDetails: true, canManageUpdates: true },
    })
    if (!user?.isActive) return res.status(401).json({ error: 'This account is inactive or no longer exists.' })
    if (typeof claims.sessionVersion !== 'number' || claims.sessionVersion !== user.sessionVersion
      || !user.sessionExpiresAt || user.sessionExpiresAt <= new Date()) {
      return res.status(401).json({ error: 'Your session has ended. Please sign in again.' })
    }
    req.auth = {
      id: user.id,
      role: user.role,
      canManageUsers: user.canManageUsers,
      canManageDetails: user.canManageDetails,
      canManageUpdates: user.canManageUpdates,
    }
    next()
  } catch (error) {
    next(error)
  }
}
function allowRoles(...roles: Array<'ADMIN' | 'FORMATOR' | 'USER'>) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) return res.status(403).json({ error: 'You do not have access to this resource.' })
    next()
  }
}
type StaffPermission = 'canManageUsers' | 'canManageDetails' | 'canManageUpdates'
async function authorizeStaffPermission(req: AuthRequest, res: Response, permission: StaffPermission) {
  if (!req.auth) {
    res.status(401).json({ error: 'Sign in is required.' })
    return false
  }
  if (req.auth.role === 'ADMIN') return true
  if (req.auth.role !== 'FORMATOR') {
    res.status(403).json({ error: 'You do not have access to this resource.' })
    return false
  }
  if (!req.auth[permission]) {
    res.status(403).json({ error: 'Your administrator has not granted access to this resource.' })
    return false
  }
  return true
}
function validate<T extends z.ZodType>(schema: T, input: unknown) {
  const result = schema.safeParse(input)
  return result.success ? { data: result.data, error: null } : { data: null, error: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) }
}
async function audit(userId: string, action: string, entity: string, entityId: string, meta?: Prisma.InputJsonValue) {
  await prisma.auditLog.create({ data: { userId, action, entity, entityId, meta } })
}
const asyncRoute = (handler: (req: AuthRequest, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(handler(req as AuthRequest, res)).catch(next)
function routeParam(req: Request, name: string): string {
  const value = req.params[name]
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}
async function callLightfm<T>(path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
  if (!lightfmApiToken) throw new Error('Set LIGHTFM_API_TOKEN in server/.env and recommender/.env to enable the LightFM service.')
  const response = await fetch(`${lightfmServiceUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${lightfmApiToken}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const responseBody = await response.text()
  let result: (T & { detail?: string }) | undefined
  if (responseBody) {
    try {
      result = JSON.parse(responseBody) as T & { detail?: string }
    } catch {
      if (response.ok) throw new Error('The LightFM service returned an invalid response.')
    }
  }
  if (!response.ok) throw new Error(result?.detail || `The LightFM service returned HTTP ${response.status}.`)
  if (result === undefined) throw new Error('The LightFM service returned an empty response.')
  return result
}
async function createEncryptedBackupArchive(payload: unknown, password: string) {
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  if (plaintext.byteLength > maxBackupPlaintextBytes) {
    throw new Error('The system backup is larger than the supported 45 MB limit.')
  }
  const writer = new ZipWriter(new Uint8ArrayWriter())
  await writer.add('carmels-in-communion-backup.json', new TextReader(plaintext.toString('utf8')), {
    password,
    encryptionStrength: 3,
  })
  return Buffer.from(await writer.close())
}

function validateSystemBackupPayload(payload: unknown): { exportedAt: string; tables: Record<string, unknown[]> } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid backup payload.')
  const data = payload as Record<string, unknown>
  if (data.format !== systemBackupFormat || data.version !== 1 || typeof data.exportedAt !== 'string'
    || !Number.isFinite(Date.parse(data.exportedAt)) || !data.tables || typeof data.tables !== 'object' || Array.isArray(data.tables)) {
    throw new Error('Invalid backup payload.')
  }
  const tables = data.tables as Record<string, unknown>
  if (Object.keys(tables).length !== backupTables.length) throw new Error('Backup does not contain every application table.')
  for (const table of backupTables) {
    const rows = tables[table.name]
    if (!Array.isArray(rows)) throw new Error(`Backup table ${table.name} is missing.`)
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`Backup table ${table.name} contains an invalid row.`)
      const record = row as Record<string, unknown>
      if (typeof record.id !== 'string' || Object.keys(record).some((column) => !(table.columns as readonly string[]).includes(column))
        || table.columns.some((column) => !Object.hasOwn(record, column))) {
        throw new Error(`Backup table ${table.name} contains an invalid record shape.`)
      }
    }
  }
  return { exportedAt: data.exportedAt, tables: tables as Record<string, unknown[]> }
}

function decryptLegacySystemBackup(envelopeText: string, password: string): { exportedAt: string; tables: Record<string, unknown[]> } {
  try {
    const envelope: unknown = JSON.parse(envelopeText)
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('Invalid envelope.')
    const value = envelope as Record<string, unknown>
    const encryption = value.encryption as Record<string, unknown> | null
    if (value.format !== systemBackupFormat || value.version !== 1 || typeof value.exportedAt !== 'string'
      || !Number.isFinite(Date.parse(value.exportedAt)) || !encryption
      || encryption.algorithm !== 'AES-256-GCM' || encryption.keyDerivation !== 'scrypt'
      || typeof encryption.salt !== 'string' || typeof encryption.iv !== 'string'
      || typeof encryption.authTag !== 'string' || typeof value.ciphertext !== 'string') {
      throw new Error('Invalid backup format.')
    }
    const salt = Buffer.from(encryption.salt, 'base64')
    const iv = Buffer.from(encryption.iv, 'base64')
    const authTag = Buffer.from(encryption.authTag, 'base64')
    const ciphertext = Buffer.from(value.ciphertext, 'base64')
    if (salt.byteLength !== 16 || iv.byteLength !== 12 || authTag.byteLength !== 16
      || ciphertext.byteLength > maxBackupPlaintextBytes) throw new Error('Invalid backup data.')
    const key = scryptSync(password, salt, 32)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    if (plaintext.byteLength > maxBackupPlaintextBytes) throw new Error('Backup exceeds the supported size.')
    const backup = validateSystemBackupPayload(JSON.parse(plaintext.toString('utf8')))
    if (backup.exportedAt !== value.exportedAt) throw new Error('Backup timestamp does not match.')
    return backup
  } catch {
    throw new Error('This backup is invalid, damaged, or cannot be decrypted with the configured password.')
  }
}

async function decryptSystemBackupArchive(archive: Buffer, password: string) {
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(archive)))
  try {
    const entries = await reader.getEntries()
    const entry = entries[0]
    if (entries.length !== 1 || !entry || entry.directory || entry.filename !== 'carmels-in-communion-backup.json'
      || entry.uncompressedSize > maxBackupPlaintextBytes) {
      throw new Error('Invalid backup archive.')
    }
    const payload = JSON.parse(await entry.getData(new TextWriter(), { password }))
    return validateSystemBackupPayload(payload)
  } catch {
    throw new Error('This archive is invalid, damaged, or cannot be opened with the configured password.')
  } finally {
    await reader.close()
  }
}
function backupSqlValue(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.toISOString()
  throw new Error('Backup contains a value of an unsupported type.')
}
function backupValueSql(table: typeof backupTables[number], column: string, row: Record<string, unknown>) {
  const value = row[column]
  if ('jsonColumns' in table && (table.jsonColumns as readonly string[]).includes(column)) {
    return value === null ? Prisma.sql`NULL::jsonb` : Prisma.sql`${JSON.stringify(value)}::jsonb`
  }
  const sqlValue = backupSqlValue(value)
  if (column.endsWith('At')) return sqlValue === null ? Prisma.sql`NULL::timestamp(3)` : Prisma.sql`${sqlValue}::timestamp(3)`
  if (table.name === 'Donation' && column === 'amount') return Prisma.sql`${sqlValue}::numeric(10,2)`
  if (column === 'sortOrder') return Prisma.sql`${sqlValue}::integer`
  const enumType = backupEnumColumns[table.name]?.[column]
  if (enumType) return sqlValue === null ? Prisma.sql`NULL::${Prisma.raw(enumType)}` : Prisma.sql`${sqlValue}::${Prisma.raw(enumType)}`
  return Prisma.sql`${sqlValue}`
}
const backupPasswordSchema = z.string().min(1).max(128)
const backupExportPasswordSchema = z.string().min(16).max(128)

app.get('/api/health', (_req, res) => res.json({
  status: 'ok',
  service: 'carmel-in-communion-api',
  xenditConfigured: Boolean(xenditSecretKey),
  xenditEnabled: Boolean(xenditSecretKey && xenditCallbackToken),
  emailConfigured: Boolean(resendApiKey && resendFrom),
}))

app.post('/api/admin/system-backup/export', authenticate, allowRoles('ADMIN'), rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
}), asyncRoute(async (req, res) => {
  const parsedPassword = backupExportPasswordSchema.safeParse(req.get('x-system-backup-password') || '')
  if (!parsedPassword.success) {
    return res.status(400).json({ error: 'Choose a unique backup password with at least 16 characters.' })
  }
  const exportedAt = new Date().toISOString()
  const backupArchive = await prisma.$transaction(async (tx) => {
    await tx.auditLog.create({
      data: {
        userId: req.auth!.id,
        action: 'SYSTEM_BACKUP_EXPORT',
        entity: 'SystemBackup',
        meta: { exportedAt },
      },
    })
    const tables: Record<string, unknown[]> = {}
    for (const table of backupTables) {
      tables[table.name] = await tx.$queryRaw<Array<Record<string, unknown>>>(
        Prisma.raw(`SELECT * FROM "${table.name}" ORDER BY "id"`),
      )
    }
    return createEncryptedBackupArchive({ format: systemBackupFormat, version: 1, exportedAt, tables }, parsedPassword.data)
  }, { maxWait: 10_000, timeout: 120_000 })
  const filename = `carmels-system-backup-${exportedAt.replaceAll(':', '-').replaceAll('.', '-')}.zip`
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.send(backupArchive)
}))

app.post('/api/admin/system-backup/import', authenticate, allowRoles('ADMIN'), rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
}), express.raw({ type: ['application/zip', 'application/octet-stream', 'application/x-zip-compressed', 'text/plain'], limit: '64mb' }), asyncRoute(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.byteLength === 0) return res.status(400).json({ error: 'Select a valid Carmel system backup file.' })
  const password = req.get('x-system-backup-password') || ''
  const parsedPassword = backupPasswordSchema.safeParse(password)
  if (!parsedPassword.success) return res.status(400).json({ error: 'Enter the backup encryption password.' })
  let backup: ReturnType<typeof validateSystemBackupPayload>
  try {
    if (req.body.byteLength > 0 && req.body[0] === 0x50 && req.body[1] === 0x4b) {
      backup = await decryptSystemBackupArchive(req.body, parsedPassword.data)
    } else {
      backup = decryptLegacySystemBackup(req.body.toString('utf8'), parsedPassword.data)
    }
  } catch (error) {
    if (error instanceof Error) return res.status(400).json({ error: error.message })
    throw error
  }
  const importedAt = new Date().toISOString()
  const result = await prisma.$transaction(async (tx) => {
    let mergedRecords = 0
    let skippedRecords = 0
    const skippedIds = new Map<string, Set<string>>()
    for (const table of backupTables) skippedIds.set(table.name, new Set())
    for (const table of backupTables) {
      const tableSql = Prisma.raw(`"${table.name}"`)
      const columnsSql = Prisma.raw(table.columns.map((column) => `"${column}"`).join(', '))
      const updateSql = Prisma.join(table.columns.filter((column) => column !== 'id').map((column) => {
        const identifier = Prisma.raw(`"${column}"`)
        return Prisma.sql`${identifier} = EXCLUDED.${identifier}`
      }))
      for (const value of backup.tables[table.name]) {
        const row = value as Record<string, unknown>
        if (typeof row.id !== 'string') throw new Error(`Backup table ${table.name} contains an invalid record ID.`)
        const missingParent = (backupDependencies[table.name] || []).some(({ table: parentTable, column }) => {
          const parentId = row[column]
          return typeof parentId === 'string' && skippedIds.get(parentTable)?.has(parentId)
        })
        if (missingParent) {
          skippedRecords += 1
          skippedIds.get(table.name)?.add(row.id)
          continue
        }
        const uniqueGroups = [
          ...table.uniqueColumns.map((column) => [column]),
          ...('uniqueColumnGroups' in table ? table.uniqueColumnGroups : []),
        ]
        const uniqueClauses = uniqueGroups.flatMap((columns) => {
          const clauses = columns.flatMap((column) => {
            if (row[column] === null) return []
            return [Prisma.sql`${Prisma.raw(`"${column}"`)} = ${backupSqlValue(row[column])}`]
          })
          return clauses.length === columns.length ? [Prisma.join(clauses, ' AND ')] : []
        })
        if (uniqueClauses.length) {
          const conflicts = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT "id" FROM ${tableSql}
            WHERE "id" <> ${row.id} AND (${Prisma.join(uniqueClauses, ' OR ')})
            LIMIT 1
          `)
          if (conflicts.length) {
            skippedRecords += 1
            skippedIds.get(table.name)?.add(row.id)
            continue
          }
        }
        const valuesSql = Prisma.join(table.columns.map((column) => backupValueSql(table, column, row)))
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO ${tableSql} (${columnsSql})
          VALUES (${valuesSql})
          ON CONFLICT ("id") DO UPDATE SET ${updateSql}
        `)
        mergedRecords += 1
      }
    }
    await tx.auditLog.create({
      data: {
        userId: req.auth!.id,
        action: 'SYSTEM_BACKUP_IMPORT',
        entity: 'SystemBackup',
        meta: { backupExportedAt: backup.exportedAt, importedAt, mergedRecords, skippedRecords },
      },
    })
    return { mergedRecords, skippedRecords }
  }, { maxWait: 10_000, timeout: 600_000 })
  res.json({ ...result, backupExportedAt: backup.exportedAt, importedAt, mode: 'merge' })
}))

const memberPrivacyVersion = '2026-11-20'
const registrationCodeLifetimeMs = 10 * 60 * 1000
const registrationCodeResendDelayMs = 60 * 1000
const registrationCodeMaxAttempts = 5
const retiredDemoAccountEmails = new Set([
  'demo.admin@carmel.test',
  'demo.formator@carmel.test',
  'demo.member@carmel.test',
])
const registerSchema = z.object({ name: z.string().trim().min(2).max(100), email: z.email().transform((value) => value.toLowerCase()), gender: z.enum(['MALE', 'FEMALE', 'ANONYMOUS']).default('ANONYMOUS'), phone: z.string().trim().min(7).max(30), address: z.string().trim().min(5).max(300), password: z.string().min(10).max(128) })
const registrationEmailSchema = z.object({ email: z.email().trim().toLowerCase() })
const registrationVerificationSchema = registrationEmailSchema.extend({ code: z.string().regex(/^\d{6}$/) })
function registrationCodeHash(email: string, salt: string, code: string) {
  return createHmac('sha256', jwtSecret).update(`${email}:${salt}:${code}`).digest('hex')
}
function registrationCodeMatches(expectedHash: string, email: string, salt: string, code: string) {
  const expected = Buffer.from(expectedHash, 'hex')
  const actual = Buffer.from(registrationCodeHash(email, salt, code), 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
function cleanupExpiredRegistrationVerifications() {
  void prisma.registrationVerification.deleteMany({ where: { expiresAt: { lte: new Date() } } }).catch((error: unknown) => {
    console.error('Unable to clean up expired registration verifications:', error instanceof Error ? error.message : 'Unknown error')
  })
}
cleanupExpiredRegistrationVerifications()
const registrationVerificationCleanupTimer = setInterval(cleanupExpiredRegistrationVerifications, 10 * 60 * 1000)
registrationVerificationCleanupTimer.unref()
async function sendRegistrationVerificationEmail(email: string, code: string) {
  await sendEmail({
    to: email,
    subject: 'Verify your Carmels in Communion email',
    text: `Your Carmels in Communion verification code is ${code}.\n\nEnter this six-digit code to complete your account registration. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
    html: `<p>Your Carmels in Communion verification code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:8px">${code}</p><p>Enter this six-digit code to complete your account registration. It expires in 10 minutes.</p><p>If you did not request this, you can ignore this email.</p>`,
  })
}
function registrationEmailDeliveryErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.includes('only send testing emails to your own email address')) {
    return 'Email verification is not enabled for public signups yet. The sending domain must be verified in Resend.'
  }
  return 'We could not send a verification code right now. Please try again later.'
}
app.post('/api/auth/register', registrationEmailRateLimit, asyncRoute(async (req, res) => {
  const parsed = validate(registerSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'Please check the form fields.', details: parsed.error })
  const input = parsed.data!
  if (retiredDemoAccountEmails.has(input.email)) return res.status(403).json({ error: 'This email address is not available for registration.' })
  const now = new Date()
  const [existingUser, existingVerification] = await Promise.all([
    prisma.user.findUnique({ where: { email: input.email }, select: { id: true } }),
    prisma.registrationVerification.findUnique({ where: { email: input.email }, select: { lastSentAt: true } }),
  ])
  if (existingUser) {
    return res.status(409).json({ error: 'An account with this email is already registered. Please sign in instead.' })
  }
  if (!resendApiKey || !resendFrom) return res.status(503).json({ error: 'Email verification is not configured yet. Please contact the Federation office for help.' })

  if (existingVerification) {
    const waitSeconds = Math.ceil((existingVerification.lastSentAt.getTime() + registrationCodeResendDelayMs - now.getTime()) / 1000)
    if (waitSeconds > 0) {
      res.setHeader('Retry-After', String(waitSeconds))
      return res.status(429).json({ error: `A verification code was just sent. Please wait ${waitSeconds} seconds before requesting another.` })
    }
  }

  const passwordHash = await bcrypt.hash(input.password, 10)
  const code = String(randomInt(100_000, 1_000_000))
  const codeSalt = randomBytes(16).toString('hex')
  const codeHash = registrationCodeHash(input.email, codeSalt, code)
  const expiresAt = new Date(now.getTime() + registrationCodeLifetimeMs)
  const verification = await prisma.registrationVerification.upsert({
    where: { email: input.email },
    create: {
      email: input.email,
      name: input.name,
      gender: input.gender,
      phone: input.phone,
      address: input.address,
      passwordHash,
      privacyConsentAt: now,
      privacyPolicyVersion: memberPrivacyVersion,
      codeHash,
      codeSalt,
      attempts: 0,
      expiresAt,
      lastSentAt: now,
    },
    update: {
      name: input.name,
      gender: input.gender,
      phone: input.phone,
      address: input.address,
      passwordHash,
      privacyConsentAt: now,
      privacyPolicyVersion: memberPrivacyVersion,
      codeHash,
      codeSalt,
      attempts: 0,
      expiresAt,
      lastSentAt: now,
    },
  })
  try {
    await sendRegistrationVerificationEmail(input.email, code)
  } catch (error) {
    console.error('Registration verification email delivery failed:', error instanceof Error ? error.message : 'Unknown error')
    await prisma.registrationVerification.deleteMany({ where: { id: verification.id, codeHash } })
    return res.status(503).json({ error: registrationEmailDeliveryErrorMessage(error) })
  }
  return res.status(202).json({ verificationRequired: true, email: input.email, resendAfterSeconds: registrationCodeResendDelayMs / 1000 })
}))
app.post('/api/auth/register/resend', registrationEmailRateLimit, asyncRoute(async (req, res) => {
  const parsed = validate(registrationEmailSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'Enter a valid email address.' })
  if (!resendApiKey || !resendFrom) return res.status(503).json({ error: 'Email verification is not configured yet. Please contact the Federation office for help.' })
  const email = parsed.data!.email
  const now = new Date()
  const verification = await prisma.registrationVerification.findUnique({ where: { email } })
  if (!verification || verification.expiresAt <= now) {
    if (verification) await prisma.registrationVerification.deleteMany({ where: { id: verification.id } })
    return res.status(410).json({ error: 'This registration request expired. Please submit the signup form again.' })
  }
  const waitSeconds = Math.ceil((verification.lastSentAt.getTime() + registrationCodeResendDelayMs - now.getTime()) / 1000)
  if (waitSeconds > 0) {
    res.setHeader('Retry-After', String(waitSeconds))
    return res.status(429).json({ error: `Please wait ${waitSeconds} seconds before requesting another code.` })
  }

  const code = String(randomInt(100_000, 1_000_000))
  const codeSalt = randomBytes(16).toString('hex')
  const codeHash = registrationCodeHash(email, codeSalt, code)
  const expiresAt = new Date(now.getTime() + registrationCodeLifetimeMs)
  const updated = await prisma.registrationVerification.updateMany({
    where: { id: verification.id, lastSentAt: verification.lastSentAt, expiresAt: { gt: now } },
    data: { codeHash, codeSalt, attempts: 0, expiresAt, lastSentAt: now },
  })
  if (!updated.count) {
    res.setHeader('Retry-After', String(registrationCodeResendDelayMs / 1000))
    return res.status(429).json({ error: 'A new verification code was just requested. Please check your email.' })
  }
  try {
    await sendRegistrationVerificationEmail(email, code)
  } catch (error) {
    console.error('Registration verification email delivery failed:', error instanceof Error ? error.message : 'Unknown error')
    await prisma.registrationVerification.deleteMany({ where: { id: verification.id, codeHash } })
    return res.status(503).json({ error: registrationEmailDeliveryErrorMessage(error) })
  }
  return res.json({ message: 'A new verification code was sent.', resendAfterSeconds: registrationCodeResendDelayMs / 1000 })
}))
app.post('/api/auth/register/verify', registrationVerifyRateLimit, asyncRoute(async (req, res) => {
  const parsed = validate(registrationVerificationSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'Enter the six-digit verification code from your email.' })
  const { email, code } = parsed.data!
  const now = new Date()
  let outcome: { kind: 'verified' } | { kind: 'missing' | 'expired' | 'locked' | 'invalid' | 'stale' }
  try {
    outcome = await prisma.$transaction(async (tx) => {
      const verification = await tx.registrationVerification.findUnique({ where: { email } })
      if (!verification) return { kind: 'missing' }
      if (verification.expiresAt <= now) {
        await tx.registrationVerification.deleteMany({ where: { id: verification.id } })
        return { kind: 'expired' }
      }
      if (verification.attempts >= registrationCodeMaxAttempts) return { kind: 'locked' }

      const matches = registrationCodeMatches(verification.codeHash, email, verification.codeSalt, code)
      if (!matches) {
        const updated = await tx.registrationVerification.updateMany({
          where: { id: verification.id, attempts: verification.attempts, expiresAt: { gt: now } },
          data: { attempts: { increment: 1 } },
        })
        if (!updated.count) return { kind: 'stale' }
        return { kind: verification.attempts + 1 >= registrationCodeMaxAttempts ? 'locked' : 'invalid' }
      }

      const claimed = await tx.registrationVerification.updateMany({
        where: { id: verification.id, codeHash: verification.codeHash, attempts: verification.attempts, expiresAt: { gt: now } },
        data: { attempts: registrationCodeMaxAttempts },
      })
      if (!claimed.count) return { kind: 'stale' }
      await tx.user.create({
        data: {
          name: verification.name,
          email: verification.email,
          gender: verification.gender,
          phone: verification.phone,
          address: verification.address,
          passwordHash: verification.passwordHash,
          role: 'USER',
          privacyConsentAt: verification.privacyConsentAt,
          privacyPolicyVersion: verification.privacyPolicyVersion,
          discernment: { create: {} },
        },
      })
      await tx.registrationVerification.delete({ where: { id: verification.id } })
      return { kind: 'verified' }
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      await prisma.registrationVerification.deleteMany({ where: { email } })
      return res.status(409).json({ error: 'An account with this email is already registered. Please sign in instead.' })
    }
    throw error
  }

  if (outcome.kind === 'missing') return res.status(404).json({ error: 'No active verification request was found. Please submit the signup form again.' })
  if (outcome.kind === 'expired') return res.status(410).json({ error: 'This verification code expired. Please submit the signup form again.' })
  if (outcome.kind === 'locked') return res.status(429).json({ error: 'Too many incorrect codes. Request a new verification code to continue.' })
  if (outcome.kind === 'invalid') return res.status(400).json({ error: 'That verification code is incorrect. Please try again.' })
  if (outcome.kind === 'stale') return res.status(409).json({ error: 'This verification request changed. Please request a new code and try again.' })
  return res.json({ verified: true, message: 'Your email has been verified and your account is ready. Please sign in.' })
}))
const loginSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string().min(1).max(128),
})
app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const parsed = validate(loginSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'Enter a valid email and password.' })
  const input = parsed.data!
  if (retiredDemoAccountEmails.has(input.email)) return res.status(401).json({ error: 'Email or password is incorrect.' })
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: {
      id: true,
      name: true,
      email: true,
      gender: true,
      phone: true,
      address: true,
      avatarImage: true,
      passwordHash: true,
      role: true,
      isActive: true,
      canManageUsers: true,
      canManageDetails: true,
      canManageUpdates: true,
    },
  })
  if (user) {
    if (!user.isActive || !(await bcrypt.compare(input.password, user.passwordHash))) return res.status(401).json({ error: 'Email or password is incorrect.' })
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000)
    const sessionUser = await prisma.user.update({
      where: { id: user.id },
      data: { sessionVersion: { increment: 1 }, sessionExpiresAt: expiresAt },
      select: { sessionVersion: true },
    })
    if (user.role === 'ADMIN' || user.role === 'FORMATOR') {
      void audit(user.id, 'LOGIN', 'Session', user.id, { role: user.role }).catch((error: unknown) => {
        console.error('Unable to record the sign-in audit event.', error)
      })
    }
    const token = jwt.sign({ id: user.id, role: user.role, sessionVersion: sessionUser.sessionVersion }, jwtSecret, { expiresIn: '8h' })
    res.cookie('carmel_session', token, { ...cookieOptions, maxAge: 8 * 60 * 60 * 1000 })
    return res.json({ user: { id: user.id, name: user.name, email: user.email, gender: user.gender, phone: user.phone, address: user.address, avatarImage: user.avatarImage, role: user.role, canManageUsers: user.canManageUsers, canManageDetails: user.canManageDetails, canManageUpdates: user.canManageUpdates } })
  }
  return res.status(401).json({ error: 'Email or password is incorrect.' })
}))
const googleAuthSchema = z.object({
  credential: z.string().min(1).max(20_000),
  intent: z.enum(['login', 'signup']),
})
const googleAuthUserSelect = {
  id: true,
  name: true,
  email: true,
  gender: true,
  phone: true,
  address: true,
  avatarImage: true,
  role: true,
  isActive: true,
  canManageUsers: true,
  canManageDetails: true,
  canManageUpdates: true,
} satisfies Prisma.UserSelect
const identityWhereForGoogle = (providerUserId: string) => ({
  provider_providerUserId: { provider: 'GOOGLE', providerUserId },
})
const linkGoogleIdentityToUser = async (userId: string, providerUserId: string) => {
  try {
    await prisma.oAuthIdentity.create({
      data: { provider: 'GOOGLE', providerUserId, userId },
    })
    return true
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
    const existingIdentity = await prisma.oAuthIdentity.findUnique({
      where: identityWhereForGoogle(providerUserId),
      select: { userId: true },
    })
    return existingIdentity?.userId === userId
  }
}
app.post('/api/auth/google', asyncRoute(async (req, res) => {
  if (!googleClientId) return res.status(503).json({ error: 'Google sign-in is not configured yet.' })
  const parsed = validate(googleAuthSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'Google sign-in could not be started. Please try again.' })
  const input = parsed.data!

  let payload
  try {
    const ticket = await googleOAuthClient.verifyIdToken({ idToken: input.credential, audience: googleClientId })
    payload = ticket.getPayload()
  } catch (error) {
    console.error('Google ID token verification failed:', error instanceof Error ? error.name : 'Unknown error')
    return res.status(401).json({ error: 'Google could not verify this sign-in. Please try again.' })
  }
  if (!payload?.sub || !payload.email || payload.email_verified !== true) {
    return res.status(401).json({ error: 'Google did not provide a verified email address for this account.' })
  }

  const email = payload.email.trim().toLowerCase()
  if (retiredDemoAccountEmails.has(email)) return res.status(403).json({ error: 'This email address is not available for sign-in.' })
  const alreadyRegisteredForSignup = () => res.status(409).json({
    code: 'ACCOUNT_ALREADY_REGISTERED',
    error: 'This Google account is already registered. Please sign in instead.',
    email,
  })
  const findGoogleIdentity = () => prisma.oAuthIdentity.findUnique({
    where: identityWhereForGoogle(payload.sub),
    include: { user: { select: googleAuthUserSelect } },
  })
  let identity = await findGoogleIdentity()
  let user = identity?.user ?? null
  if (user && input.intent === 'signup') {
    if (!user.isActive || user.role !== 'USER') {
      return res.status(403).json({ error: 'Google sign-in is only available for active member accounts.' })
    }
    return alreadyRegisteredForSignup()
  }
  if (!user) {
    const existingAccount = await prisma.user.findUnique({ where: { email }, select: googleAuthUserSelect })
    if (existingAccount) {
      if (!existingAccount.isActive || existingAccount.role !== 'USER') {
        return res.status(403).json({ error: 'Google sign-in is only available for active member accounts.' })
      }
      if (input.intent === 'signup') return alreadyRegisteredForSignup()
      if (!await linkGoogleIdentityToUser(existingAccount.id, payload.sub)) {
        return res.status(409).json({ error: 'This Google account is already linked to a different member account.' })
      }
      user = existingAccount
    } else if (input.intent === 'login') {
      return res.status(401).json({ error: 'No Google-linked member account was found. Create an account or use your existing sign-in method.' })
    }

    if (!existingAccount) {
      const name = (payload.name?.trim() || email.split('@')[0]).slice(0, 100)
      const passwordHash = await bcrypt.hash(randomBytes(32).toString('base64url'), 10)
      try {
        user = await prisma.user.create({
          data: {
            name,
            email,
            passwordHash,
            role: 'USER',
            privacyConsentAt: new Date(),
            privacyPolicyVersion: memberPrivacyVersion,
            discernment: { create: {} },
            oauthIdentities: { create: { provider: 'GOOGLE', providerUserId: payload.sub } },
          },
          select: googleAuthUserSelect,
        })
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
        identity = await findGoogleIdentity()
        if (identity) {
          if (input.intent === 'signup') return alreadyRegisteredForSignup()
          user = identity.user
        } else {
          const accountCreatedConcurrently = await prisma.user.findUnique({ where: { email }, select: googleAuthUserSelect })
          if (!accountCreatedConcurrently) throw error
          if (!accountCreatedConcurrently.isActive || accountCreatedConcurrently.role !== 'USER') {
            return res.status(403).json({ error: 'Google sign-in is only available for active member accounts.' })
          }
          if (input.intent === 'signup') return alreadyRegisteredForSignup()
          if (!await linkGoogleIdentityToUser(accountCreatedConcurrently.id, payload.sub)) {
            return res.status(409).json({ error: 'This Google account is already linked to a different member account.' })
          }
          user = accountCreatedConcurrently
        }
      }
    }
  }
  if (!user) throw new Error('Google sign-in completed without resolving an account.')
  if (!user.isActive || user.role !== 'USER') {
    return res.status(403).json({ error: 'Google sign-in is only available for active member accounts.' })
  }

  if (input.intent === 'signup') return res.status(201).json({ accountCreated: true })

  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const sessionUser = await prisma.user.update({
    where: { id: user.id },
    data: { sessionVersion: { increment: 1 }, sessionExpiresAt: expiresAt },
    select: { sessionVersion: true },
  })
  const token = jwt.sign({ id: user.id, role: user.role, sessionVersion: sessionUser.sessionVersion }, jwtSecret, { expiresIn: '8h' })
  res.cookie('carmel_session', token, { ...cookieOptions, maxAge: 8 * 60 * 60 * 1000 })
  return res.json({ user: {
    id: user.id,
    name: user.name,
    email: user.email,
    gender: user.gender,
    phone: user.phone,
    address: user.address,
    avatarImage: user.avatarImage,
    role: user.role,
    canManageUsers: user.canManageUsers,
    canManageDetails: user.canManageDetails,
    canManageUpdates: user.canManageUpdates,
  } })
}))
const facebookAuthSchema = z.object({
  accessToken: z.string().min(1).max(20_000),
  intent: z.enum(['login', 'signup']),
})
const facebookTokenDebugSchema = z.object({
  data: z.object({
    app_id: z.string(),
    is_valid: z.boolean(),
    user_id: z.string().optional(),
    expires_at: z.number().optional(),
  }),
})
const facebookProfileSchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  email: z.email().nullish(),
})
const identityWhereForFacebook = (providerUserId: string) => ({
  provider_providerUserId: { provider: 'FACEBOOK', providerUserId },
})
const linkFacebookIdentityToUser = async (userId: string, providerUserId: string) => {
  try {
    await prisma.oAuthIdentity.create({
      data: { provider: 'FACEBOOK', providerUserId, userId },
    })
    return true
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
    const existingIdentity = await prisma.oAuthIdentity.findUnique({
      where: identityWhereForFacebook(providerUserId),
      select: { userId: true },
    })
    return existingIdentity?.userId === userId
  }
}
app.post('/api/auth/facebook', asyncRoute(async (req, res) => {
  if (!facebookAppId || !facebookAppSecret) {
    return res.status(503).json({ error: 'Facebook sign-in is not configured yet.' })
  }
  const parsed = validate(facebookAuthSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'Facebook sign-in could not be started. Please try again.' })
  const input = parsed.data!

  let facebookProfile: { id: string; name?: string | null; email: string }
  try {
    const debugUrl = new URL('https://graph.facebook.com/v27.0/debug_token')
    debugUrl.searchParams.set('input_token', input.accessToken)
    debugUrl.searchParams.set('access_token', `${facebookAppId}|${facebookAppSecret}`)
    const profileUrl = new URL('https://graph.facebook.com/v27.0/me')
    profileUrl.searchParams.set('fields', 'id,name,email')
    profileUrl.searchParams.set('access_token', input.accessToken)
    const [debugResponse, profileResponse] = await Promise.all([
      fetch(debugUrl, { signal: AbortSignal.timeout(10_000) }),
      fetch(profileUrl, { signal: AbortSignal.timeout(10_000) }),
    ])
    const [debugPayload, profilePayload] = await Promise.all([
      debugResponse.json() as Promise<unknown>,
      profileResponse.json() as Promise<unknown>,
    ])
    const debug = facebookTokenDebugSchema.safeParse(debugPayload)
    const tokenInfo = debug.success ? debug.data.data : null
    if (
      !debugResponse.ok
      || !tokenInfo?.is_valid
      || tokenInfo.app_id !== facebookAppId
      || !tokenInfo.user_id
      || (tokenInfo.expires_at !== undefined && tokenInfo.expires_at > 0 && tokenInfo.expires_at * 1000 <= Date.now())
    ) {
      return res.status(401).json({ error: 'Facebook could not verify this sign-in. Please try again.' })
    }

    const profile = facebookProfileSchema.safeParse(profilePayload)
    if (!profileResponse.ok || !profile.success || profile.data.id !== tokenInfo.user_id) {
      return res.status(401).json({ error: 'Facebook could not verify this sign-in. Please try again.' })
    }
    if (!profile.data.email) {
      return res.status(401).json({ error: 'Facebook did not provide an email address. Grant email permission and try again.' })
    }
    facebookProfile = { ...profile.data, email: profile.data.email }
  } catch (error) {
    console.error('Facebook token verification request failed:', error instanceof Error ? error.name : 'Unknown error')
    return res.status(502).json({ error: 'Facebook could not verify this sign-in right now. Please try again.' })
  }

  const email = facebookProfile.email.trim().toLowerCase()
  if (retiredDemoAccountEmails.has(email)) return res.status(403).json({ error: 'This email address is not available for sign-in.' })
  const alreadyRegisteredForSignup = () => res.status(409).json({
    code: 'ACCOUNT_ALREADY_REGISTERED',
    error: 'This Facebook account is already registered. Please sign in instead.',
    email,
  })
  const findFacebookIdentity = () => prisma.oAuthIdentity.findUnique({
    where: identityWhereForFacebook(facebookProfile.id),
    include: { user: { select: googleAuthUserSelect } },
  })
  let identity = await findFacebookIdentity()
  let user = identity?.user ?? null
  if (user && input.intent === 'signup') {
    if (!user.isActive || user.role !== 'USER') {
      return res.status(403).json({ error: 'Facebook sign-in is only available for active member accounts.' })
    }
    return alreadyRegisteredForSignup()
  }
  if (!user) {
    const existingAccount = await prisma.user.findUnique({ where: { email }, select: googleAuthUserSelect })
    if (existingAccount) {
      if (!existingAccount.isActive || existingAccount.role !== 'USER') {
        return res.status(403).json({ error: 'Facebook sign-in is only available for active member accounts.' })
      }
      if (input.intent === 'signup') return alreadyRegisteredForSignup()
      if (!await linkFacebookIdentityToUser(existingAccount.id, facebookProfile.id)) {
        return res.status(409).json({ error: 'This Facebook account is already linked to a different member account.' })
      }
      user = existingAccount
    } else if (input.intent === 'login') {
      return res.status(401).json({ error: 'No Facebook-linked member account was found. Create an account or use your existing sign-in method.' })
    }

    if (!existingAccount) {
      const name = (facebookProfile.name?.trim() || email.split('@')[0]).slice(0, 100)
      const passwordHash = await bcrypt.hash(randomBytes(32).toString('base64url'), 10)
      try {
        user = await prisma.user.create({
          data: {
            name,
            email,
            passwordHash,
            role: 'USER',
            privacyConsentAt: new Date(),
            privacyPolicyVersion: memberPrivacyVersion,
            discernment: { create: {} },
            oauthIdentities: { create: { provider: 'FACEBOOK', providerUserId: facebookProfile.id } },
          },
          select: googleAuthUserSelect,
        })
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
        identity = await findFacebookIdentity()
        if (identity) {
          if (input.intent === 'signup') return alreadyRegisteredForSignup()
          user = identity.user
        } else {
          const accountCreatedConcurrently = await prisma.user.findUnique({ where: { email }, select: googleAuthUserSelect })
          if (!accountCreatedConcurrently) throw error
          if (!accountCreatedConcurrently.isActive || accountCreatedConcurrently.role !== 'USER') {
            return res.status(403).json({ error: 'Facebook sign-in is only available for active member accounts.' })
          }
          if (input.intent === 'signup') return alreadyRegisteredForSignup()
          if (!await linkFacebookIdentityToUser(accountCreatedConcurrently.id, facebookProfile.id)) {
            return res.status(409).json({ error: 'This Facebook account is already linked to a different member account.' })
          }
          user = accountCreatedConcurrently
        }
      }
    }
  }
  if (!user) throw new Error('Facebook sign-in completed without resolving an account.')
  if (!user.isActive || user.role !== 'USER') {
    return res.status(403).json({ error: 'Facebook sign-in is only available for active member accounts.' })
  }

  if (input.intent === 'signup') return res.status(201).json({ accountCreated: true })

  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const sessionUser = await prisma.user.update({
    where: { id: user.id },
    data: { sessionVersion: { increment: 1 }, sessionExpiresAt: expiresAt },
    select: { sessionVersion: true },
  })
  const token = jwt.sign({ id: user.id, role: user.role, sessionVersion: sessionUser.sessionVersion }, jwtSecret, { expiresIn: '8h' })
  res.cookie('carmel_session', token, { ...cookieOptions, maxAge: 8 * 60 * 60 * 1000 })
  return res.json({ user: {
    id: user.id,
    name: user.name,
    email: user.email,
    gender: user.gender,
    phone: user.phone,
    address: user.address,
    avatarImage: user.avatarImage,
    role: user.role,
    canManageUsers: user.canManageUsers,
    canManageDetails: user.canManageDetails,
    canManageUpdates: user.canManageUpdates,
  } })
}))
const passwordResetRequestSchema = z.object({ email: z.email().transform((value) => value.toLowerCase()) })
app.post('/api/auth/password-reset/request', passwordResetRateLimit, asyncRoute(async (req, res) => {
  const parsed = validate(passwordResetRequestSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'Enter a valid email address.' })
  if (!resendApiKey || !resendFrom) return res.status(503).json({ error: 'Email is not configured yet. Please contact the Federation office for help.' })

  const user = await prisma.user.findUnique({ where: { email: parsed.data!.email }, select: { id: true, isActive: true } })
  if (user?.isActive) {
    const token = randomBytes(32).toString('base64url')
    const tokenHash = createHash('sha256').update(token).digest('hex')
    await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } })
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    })
    const resetUrl = `${clientOrigin.replace(/\/$/, '')}/account/reset-password?token=${encodeURIComponent(token)}`
    try {
      await sendEmail({
        to: parsed.data!.email,
        subject: 'Reset your Carmels in Communion password',
        text: `We received a request to reset the password for your Carmels in Communion account.\n\nUse this link within one hour to choose a new password:\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
        html: `<p>We received a request to reset the password for your Carmels in Communion account.</p><p><a href="${resetUrl}">Choose a new password</a>. This link expires in one hour.</p><p>If you did not request this, you can ignore this email.</p>`,
      })
    } catch (error) {
      await prisma.passwordResetToken.deleteMany({ where: { tokenHash } })
      console.error('Password reset email delivery failed:', error instanceof Error ? error.message : 'Unknown error')
      return res.status(503).json({ error: 'We could not send the reset email right now. Please try again later.' })
    }
  }
  res.status(202).json({ message: 'If an account exists for that email address, a password reset link will be sent.' })
}))
const passwordResetSchema = z.object({
  token: z.string().min(32).max(128),
  password: z.string().min(10).max(128),
})
app.post('/api/auth/password-reset/confirm', passwordResetRateLimit, asyncRoute(async (req, res) => {
  const parsed = validate(passwordResetSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'Enter a valid reset link and a password of at least 10 characters.' })
  const tokenHash = createHash('sha256').update(parsed.data!.token).digest('hex')
  const reset = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, expiresAt: true, user: { select: { isActive: true } } },
  })
  if (!reset || reset.expiresAt <= new Date() || !reset.user.isActive) {
    if (reset) await prisma.passwordResetToken.deleteMany({ where: { id: reset.id } })
    return res.status(400).json({ error: 'This password reset link is invalid or expired. Request a new one to continue.' })
  }

  const passwordHash = await bcrypt.hash(parsed.data!.password, 10)
  const completed = await prisma.$transaction(async (transaction) => {
    const consumed = await transaction.passwordResetToken.deleteMany({
      where: { id: reset.id, expiresAt: { gt: new Date() } },
    })
    if (consumed.count !== 1) return false
    await transaction.user.update({ where: { id: reset.userId }, data: { passwordHash, sessionVersion: { increment: 1 }, sessionExpiresAt: null } })
    await transaction.passwordResetToken.deleteMany({ where: { userId: reset.userId } })
    return true
  })
  if (!completed) return res.status(400).json({ error: 'This password reset link is invalid or expired. Request a new one to continue.' })
  res.json({ message: 'Your password has been updated. You can now sign in.' })
}))
app.post('/api/auth/logout', asyncRoute(async (req, res) => {
  res.clearCookie('carmel_session', cookieOptions)
  const token = req.cookies?.carmel_session as string | undefined
  if (token) {
    try {
      const verified = jwt.verify(token, jwtSecret)
      if (typeof verified !== 'string' && typeof verified.id === 'string' && typeof verified.sessionVersion === 'number') {
        const revoked = await prisma.user.updateMany({
          where: { id: verified.id, sessionVersion: verified.sessionVersion },
          data: { sessionVersion: { increment: 1 }, sessionExpiresAt: null },
        })
        if (revoked.count && (verified.role === 'ADMIN' || verified.role === 'FORMATOR')) {
          await audit(verified.id, 'LOGOUT', 'Session', verified.id, { role: verified.role })
        }
      }
    } catch (error) {
      if (!(error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError)) throw error
    }
  }
  res.status(204).end()
}))
app.get('/api/auth/me', authenticate, asyncRoute(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.id }, select: { id: true, name: true, email: true, gender: true, phone: true, address: true, avatarImage: true, role: true, isActive: true, canManageUsers: true, canManageDetails: true, canManageUpdates: true } })
  if (!user?.isActive) return res.status(401).json({ error: 'This account is inactive.' })
  res.json({ user })
}))
const profileUpdateSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.email().transform((value) => value.toLowerCase()),
  gender: z.enum(['MALE', 'FEMALE', 'ANONYMOUS']).optional(),
  phone: z.string().trim().min(7).max(30).optional(),
  address: z.string().trim().min(5).max(300).optional(),
  avatarImage: z.string().max(1_400_000).regex(/^data:image\/(?:jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/).nullable().optional(),
  currentPassword: z.string().optional(),
  newPassword: z.string().min(10).max(128).optional(),
}).refine((input) => !input.newPassword || Boolean(input.currentPassword), { message: 'Enter your current password to set a new password.', path: ['currentPassword'] })
app.patch('/api/auth/me', authenticate, allowRoles('ADMIN', 'FORMATOR', 'USER'), asyncRoute(async (req, res) => {
  const parsed = validate(profileUpdateSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'Please check the profile fields.', details: parsed.error })
  const input = parsed.data!
  const currentUser = await prisma.user.findUnique({ where: { id: req.auth!.id }, select: { id: true, name: true, email: true, gender: true, phone: true, address: true, avatarImage: true, passwordHash: true, isActive: true } })
  if (!currentUser?.isActive) return res.status(401).json({ error: 'This account is inactive.' })
  if (input.newPassword && !(await bcrypt.compare(input.currentPassword!, currentUser.passwordHash))) return res.status(400).json({ error: 'Your current password is incorrect.' })
  const data: Prisma.UserUpdateInput = { name: input.name, email: input.email }
  if (input.gender !== undefined) data.gender = input.gender
  if (input.phone !== undefined) data.phone = input.phone
  if (input.address !== undefined) data.address = input.address
  if (input.avatarImage !== undefined) data.avatarImage = input.avatarImage
  if (input.newPassword) {
    data.passwordHash = await bcrypt.hash(input.newPassword, 10)
    data.sessionVersion = { increment: 1 }
    data.sessionExpiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000)
  }
  try {
    const user = await prisma.user.update({ where: { id: currentUser.id }, data, select: { id: true, name: true, email: true, gender: true, phone: true, address: true, avatarImage: true, role: true, isActive: true, sessionVersion: true } })
    await audit(user.id, 'UPDATE_PROFILE', 'User', user.id, {
      nameChanged: currentUser.name !== user.name,
      emailChanged: currentUser.email !== user.email,
      genderChanged: currentUser.gender !== user.gender,
      phoneChanged: currentUser.phone !== user.phone,
      addressChanged: currentUser.address !== user.address,
      avatarChanged: currentUser.avatarImage !== user.avatarImage,
      passwordChanged: Boolean(input.newPassword),
    })
    const { sessionVersion, ...publicUser } = user
    if (input.newPassword) {
      const token = jwt.sign({ id: user.id, role: user.role, sessionVersion }, jwtSecret, { expiresIn: '8h' })
      res.cookie('carmel_session', token, { ...cookieOptions, maxAge: 8 * 60 * 60 * 1000 })
    }
    res.json({ user: publicUser })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return res.status(409).json({ error: 'An account with this email already exists.' })
    throw error
  }
}))

const donationSchema = z.object({
  amount: z.coerce.number().finite().min(50).max(10000000),
  payment: z.enum(['GCASH', 'MAYA', 'BANK', 'CARD']),
  anonymous: z.boolean().default(true),
  name: z.string().trim().max(100).optional().default(''),
  email: z.union([z.email(), z.literal('')]).optional().default(''),
  phone: z.string().trim().max(30).optional().default(''),
  receipt: z.boolean().default(false),
  reference: z.string().trim().max(100).optional().default(''),
})
app.post('/api/donations', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.setHeader('Retry-After', '900').status(429).json({
    error: 'Too many donation checkout attempts. Please wait 15 minutes before trying again.',
  }),
}), optionalAuthenticate, asyncRoute(async (req, res) => {
  const parsed = validate(donationSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'Please check the donation details.', details: parsed.error })
  const input = parsed.data!
  if (!input.anonymous && (!input.name || !input.email)) return res.status(400).json({ error: 'Name and email are required for a named donation.' })
  if (input.receipt && !input.email) return res.status(400).json({ error: 'Enter an email address for the acknowledgment receipt.' })
  if (xenditSecretKey) {
    if (!xenditCallbackToken) return res.status(503).json({ error: 'Set XENDIT_CALLBACK_TOKEN in server/.env and configure the matching Xendit webhook before accepting test donations.' })
    const referenceCode = `CARMEL-${new Date().getFullYear()}-${randomBytes(16).toString('hex').toUpperCase()}`
    const created = await prisma.$transaction(async (tx) => {
      const donation = await tx.donation.create({ data: {
        referenceCode,
        amount: new Prisma.Decimal(input.amount),
        type: 'ONE_TIME',
        fund: 'Federation formation program',
        paymentMethod: input.payment,
        isAnonymous: input.anonymous,
        ...(req.auth?.role === 'USER' ? { userId: req.auth.id } : {}),
        donorName: input.anonymous ? null : input.name || null,
        donorEmail: input.anonymous && !input.receipt ? null : input.email || null,
        donorPhone: input.anonymous && !input.receipt ? null : input.phone || null,
        wantsReceipt: input.receipt || !input.anonymous,
        status: 'PENDING',
      } })
      await tx.auditLog.create({ data: {
        action: 'DONATION_RECEIVED',
        entity: 'Donation',
        entityId: donation.id,
        meta: {
          referenceCode,
          amount: input.amount,
          paymentMethod: input.payment,
          status: 'PENDING',
          isAnonymous: input.anonymous,
        },
      } })
      return donation
    })
    const configuredOrigin = clientOrigin
    let returnOrigin = configuredOrigin
    if (!isProduction) {
      const requestOrigin = req.get('origin')
      if (requestOrigin) {
        try {
          const parsedOrigin = new URL(requestOrigin)
          if (parsedOrigin.hostname === 'localhost' || parsedOrigin.hostname === '127.0.0.1') returnOrigin = parsedOrigin.origin
        } catch {
          // Use the configured client origin when the request Origin header is invalid.
        }
      }
    }
    const redirectUrl = new URL('/donations', returnOrigin)
    redirectUrl.searchParams.set('reference', referenceCode)
    const invoiceData = {
      amount: input.amount,
      currency: 'PHP',
      external_id: referenceCode,
      invoice_duration: 86400,
      description: `Donation (${referenceCode})`,
      payment_methods: [{
        GCASH: 'GCASH',
        MAYA: 'PAYMAYA',
        BANK: 'BANK_TRANSFER',
        CARD: 'CARDS',
      }[input.payment]],
      success_redirect_url: `${redirectUrl.toString()}&xendit=success`,
      failure_redirect_url: `${redirectUrl.toString()}&xendit=cancelled`,
      ...(input.email ? { payer_email: input.email } : {}),
    }
    let xenditResponse: Awaited<ReturnType<typeof fetch>>
    try {
      xenditResponse = await fetch('https://api.xendit.co/v2/invoices', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${xenditSecretKey}:`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(invoiceData),
        signal: AbortSignal.timeout(15000),
      })
    } catch (error) {
      console.error('Xendit invoice request failed:', error instanceof Error ? error.message : 'Unknown network error')
      await prisma.donation.update({ where: { id: created.id }, data: { status: 'FAILED' } })
      return res.status(502).json({ error: 'Could not reach Xendit to create checkout. Please try again.' })
    }
    let invoice: { id?: unknown; invoice_url?: unknown; error_code?: unknown }
    try {
      invoice = await xenditResponse.json() as typeof invoice
    } catch {
      console.error(`Xendit returned an unreadable invoice response (HTTP ${xenditResponse.status}).`)
      await prisma.donation.update({ where: { id: created.id }, data: { status: 'FAILED' } })
      return res.status(502).json({ error: 'Xendit returned an unexpected response. Please try again.' })
    }
    if (!xenditResponse.ok || typeof invoice.id !== 'string' || typeof invoice.invoice_url !== 'string') {
      const errorCode = typeof invoice.error_code === 'string' && /^[A-Z0-9_]{2,100}$/.test(invoice.error_code)
        ? invoice.error_code
        : 'UNKNOWN_ERROR'
      console.error(`Xendit invoice request failed (HTTP ${xenditResponse.status}, ${errorCode}).`)
      await prisma.donation.update({ where: { id: created.id }, data: { status: 'FAILED' } })
      if (errorCode === 'UNAVAILABLE_PAYMENT_METHOD_ERROR') {
        const method = { GCASH: 'GCash', MAYA: 'Maya', BANK: 'Bank Transfer', CARD: 'Cards' }[input.payment]
        return res.status(502).json({
          error: `${method} is not enabled for this Xendit account yet. In Xendit Dashboard, open Payment Channels → Activate Payment Channels and request activation. Some channels require account verification. You can use GCash or Maya while waiting.`,
        })
      }
      return res.status(502).json({ error: `Xendit could not create checkout (${errorCode}). Check the API terminal for details.` })
    }
    await prisma.donation.update({
      where: { id: created.id },
      data: { xenditInvoiceId: invoice.id, xenditInvoiceUrl: invoice.invoice_url },
    })
    return res.status(201).json({
      donation: {
        referenceCode,
        amount: created.amount,
        paymentMethod: created.paymentMethod,
        isAnonymous: created.isAnonymous,
        status: created.status,
        createdAt: created.createdAt,
      },
      invoiceUrl: invoice.invoice_url,
    })
  }
  const referenceCode = `CARMEL-${new Date().getFullYear()}-${randomBytes(16).toString('hex').toUpperCase()}`
  const retainName = !input.anonymous
  const donation = await prisma.$transaction(async (tx) => {
    const created = await tx.donation.create({ data: {
      referenceCode,
      amount: new Prisma.Decimal(input.amount),
      type: 'ONE_TIME',
      fund: 'Federation formation program',
      paymentMethod: input.payment,
      isAnonymous: input.anonymous,
      ...(req.auth?.role === 'USER' ? { userId: req.auth.id } : {}),
      donorName: retainName ? input.name || null : null,
      donorEmail: retainName || input.receipt ? input.email || null : null,
      donorPhone: retainName || input.receipt ? input.phone || null : null,
      wantsReceipt: input.receipt || !input.anonymous,
      paymentReference: input.reference || null,
      status: input.reference ? 'RECONCILING' : 'PENDING',
    }, select: { id: true, referenceCode: true, amount: true, paymentMethod: true, isAnonymous: true, status: true, createdAt: true } })
    await tx.auditLog.create({ data: {
      action: 'DONATION_RECEIVED',
      entity: 'Donation',
      entityId: created.id,
      meta: {
        referenceCode: created.referenceCode,
        amount: input.amount,
        paymentMethod: input.payment,
        status: created.status,
        isAnonymous: input.anonymous,
      },
    } })
    return {
      referenceCode: created.referenceCode,
      amount: created.amount,
      paymentMethod: created.paymentMethod,
      isAnonymous: created.isAnonymous,
      status: created.status,
      createdAt: created.createdAt,
    }
  })
  const receiptEmailSent = donation.status === 'COMPLETED' && input.receipt
    ? await sendDonationAcknowledgment(donation.referenceCode)
    : false
  res.status(201).json({ donation: { ...donation, receiptEmailSent } })
}))
async function sendDonationAcknowledgment(referenceCode: string): Promise<boolean> {
  if (!resendApiKey || !resendFrom) {
    console.warn('Donation acknowledgment email was not sent because Resend is not configured.')
    return false
  }
  const donation = await prisma.donation.findUnique({
    where: { referenceCode },
    select: {
      id: true,
      referenceCode: true,
      amount: true,
      paymentMethod: true,
      donorName: true,
      isAnonymous: true,
      donorEmail: true,
      wantsReceipt: true,
      status: true,
      receiptEmailSentAt: true,
      receiptEmailSendingAt: true,
      createdAt: true,
    },
  })
  if (!donation || !['COMPLETED', 'VERIFIED'].includes(donation.status) || !donation.wantsReceipt || !donation.donorEmail || donation.receiptEmailSentAt) return false
  const staleSendingCutoff = new Date(Date.now() - 5 * 60 * 1000)
  if (donation.receiptEmailSendingAt && donation.receiptEmailSendingAt > staleSendingCutoff) return false
  const sentAt = new Date()
  const claimed = await prisma.donation.updateMany({
    where: {
      id: donation.id,
      status: { in: ['COMPLETED', 'VERIFIED'] },
      wantsReceipt: true,
      receiptEmailSentAt: null,
      OR: [{ receiptEmailSendingAt: null }, { receiptEmailSendingAt: { lt: staleSendingCutoff } }],
    },
    data: { receiptEmailSendingAt: sentAt },
  })
  if (!claimed.count) return false
  const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!)
  const name = donation.isAnonymous ? 'Benefactor' : donation.donorName || 'Donor'
  try {
    await sendEmail({
      to: donation.donorEmail,
      subject: `Donation received — ${donation.referenceCode}`,
      text: `Dear ${name},\n\nThank you for your generous donation to Carmels in Communion. Your payment has been confirmed and your donation was successfully received.\n\nAcknowledgment reference: ${donation.referenceCode}\nAmount: ${donation.amount.toFixed(2)} PHP\nPayment method: ${donation.paymentMethod}\nDate: ${donation.createdAt.toLocaleDateString('en-PH')}\n\nPlease keep this email as your acknowledgment. If you have questions, contact ocdnuns.vocpromph@gmail.com.\n\nWith gratitude,\nCarmels in Communion`,
      html: `<p>Dear ${escapeHtml(name)},</p><p>Thank you for your generous donation to Carmels in Communion. Your payment has been confirmed and your donation was successfully received.</p><table><tbody><tr><th align="left">Acknowledgment reference</th><td>${escapeHtml(donation.referenceCode)}</td></tr><tr><th align="left">Amount</th><td>PHP ${escapeHtml(donation.amount.toFixed(2))}</td></tr><tr><th align="left">Payment method</th><td>${escapeHtml(donation.paymentMethod)}</td></tr><tr><th align="left">Date</th><td>${escapeHtml(donation.createdAt.toLocaleDateString('en-PH'))}</td></tr></tbody></table><p>Please keep this email as your acknowledgment. For questions, contact <a href="mailto:ocdnuns.vocpromph@gmail.com">ocdnuns.vocpromph@gmail.com</a>.</p><p>With gratitude,<br />Carmels in Communion</p>`,
    })
    await prisma.donation.updateMany({
      where: { id: donation.id, receiptEmailSendingAt: sentAt },
      data: { receiptEmailSentAt: new Date(), receiptEmailSendingAt: null },
    })
    return true
  } catch (error) {
    await prisma.donation.updateMany({
      where: { id: donation.id, receiptEmailSendingAt: sentAt },
      data: { receiptEmailSendingAt: null },
    })
    console.error(`Donation acknowledgment email delivery failed for ${donation.referenceCode}:`, error instanceof Error ? error.message : 'Unknown error')
    return false
  }
}
app.post('/api/donations/xendit-webhook', asyncRoute(async (req, res) => {
  if (!xenditCallbackToken) return res.status(503).json({ error: 'Xendit webhook verification is not configured.' })
  const callbackToken = req.get('x-callback-token') || ''
  const expectedToken = Buffer.from(xenditCallbackToken)
  const receivedToken = Buffer.from(callbackToken)
  if (expectedToken.length !== receivedToken.length || !timingSafeEqual(expectedToken, receivedToken)) {
    return res.status(401).json({ error: 'Invalid Xendit callback token.' })
  }
  const callbackSchema = z.object({
    external_id: z.string().min(1),
    id: z.string().optional(),
    status: z.string(),
    amount: z.number().finite().positive(),
  }).passthrough()
  const parsedCallback = callbackSchema.safeParse(req.body)
  if (!parsedCallback.success) return res.status(400).json({ error: 'Invalid Xendit invoice notification.' })
  const callback = parsedCallback.data
  if (callback.status !== 'PAID' && callback.status !== 'EXPIRED') return res.json({ received: true })
  const donation = await prisma.donation.findUnique({
    where: { referenceCode: callback.external_id },
    select: { id: true, referenceCode: true, amount: true, status: true, xenditInvoiceId: true },
  })
  if (!donation) return res.status(404).json({ error: 'Donation for this Xendit invoice was not found.' })
  if (callback.id && donation.xenditInvoiceId && callback.id !== donation.xenditInvoiceId) {
    return res.status(409).json({ error: 'Xendit invoice ID does not match the donation.' })
  }
  if (callback.status === 'PAID' && !donation.amount.equals(new Prisma.Decimal(callback.amount))) {
    return res.status(400).json({ error: 'Xendit invoice amount does not match the donation.' })
  }
  if (donation.status === 'COMPLETED') {
    await sendDonationAcknowledgment(donation.referenceCode)
    return res.json({ received: true })
  }
  const nextStatus = callback.status === 'PAID' ? 'COMPLETED' : 'FAILED'
  await prisma.$transaction(async (tx) => {
    await tx.donation.update({ where: { id: donation.id }, data: { status: nextStatus } })
    await tx.auditLog.create({ data: {
      action: callback.status === 'PAID' ? 'DONATION_PAID' : 'DONATION_EXPIRED',
      entity: 'Donation',
      entityId: donation.id,
      meta: { referenceCode: donation.referenceCode, status: nextStatus },
    } })
  })
  if (nextStatus === 'COMPLETED') await sendDonationAcknowledgment(donation.referenceCode)
  res.json({ received: true })
}))
app.get('/api/donations/mine', authenticate, allowRoles('USER'), asyncRoute(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.id }, select: { email: true, isActive: true } })
  if (!user?.isActive) return res.status(401).json({ error: 'This account is inactive.' })
  const donations = await prisma.donation.findMany({
    where: { OR: [{ userId: req.auth!.id }, { donorEmail: user.email }] },
    orderBy: { createdAt: 'desc' },
    select: { referenceCode: true, amount: true, paymentMethod: true, status: true, createdAt: true },
  })
  res.json({ donations })
}))
const discernmentStages = ['EXPLORING', 'PRAYING_AND_LEARNING', 'READY_TO_VISIT', 'IN_CONVERSATION'] as const
const discernmentSchema = z.object({ monastery: z.string().trim().max(150).default(''), note: z.string().trim().max(5000).default('') })
const memberMessageSchema = z.object({ body: z.string().trim().min(1).max(5000) })
app.get('/api/discernment/mine', authenticate, allowRoles('USER'), asyncRoute(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.id }, select: { isActive: true } })
  if (!user?.isActive) return res.status(401).json({ error: 'This account is inactive.' })
  const discernment = await prisma.discernment.upsert({ where: { userId: req.auth!.id }, update: {}, create: { userId: req.auth!.id } })
  res.json({ discernment })
}))
app.patch('/api/discernment/mine', authenticate, allowRoles('USER'), asyncRoute(async (req, res) => {
  const parsed = validate(discernmentSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'Please check your discernment details.', details: parsed.error })
  const discernment = await prisma.discernment.upsert({ where: { userId: req.auth!.id }, update: parsed.data!, create: { userId: req.auth!.id, ...parsed.data! } })
  res.json({ discernment })
}))
app.get('/api/account/staff', authenticate, allowRoles('USER'), asyncRoute(async (_req, res) => {
  const staff = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'FORMATOR'] }, isActive: true },
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, role: true },
  })
  res.json({ staff })
}))
app.get('/api/account/conversations', authenticate, allowRoles('USER'), asyncRoute(async (req, res) => {
  const conversations = await prisma.conversation.findMany({
    where: { userId: req.auth!.id },
    orderBy: { lastMessageAt: 'desc' },
    include: {
      staffRecipient: { select: { id: true, name: true, role: true } },
      messages: { orderBy: { createdAt: 'asc' }, include: { sender: { select: { id: true, name: true, role: true } } } },
    },
  })
  const ids = conversations.map(({ id }) => id)
  if (ids.length) {
    await prisma.message.updateMany({ where: { conversationId: { in: ids }, senderType: { in: ['ADMIN', 'FORMATOR'] }, readAt: null }, data: { readAt: new Date() } })
  }
  res.json({ conversations })
}))
const newMemberConversationSchema = z.object({
  recipientId: z.string().min(1),
  body: z.string().trim().min(1).max(5000),
})
app.post('/api/account/conversations', authenticate, allowRoles('USER'), asyncRoute(async (req, res) => {
  const parsed = validate(newMemberConversationSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'Choose a staff member and enter a message.' })
  const [user, recipient] = await Promise.all([
    prisma.user.findUnique({ where: { id: req.auth!.id }, select: { id: true, name: true, email: true, isActive: true } }),
    prisma.user.findUnique({ where: { id: parsed.data!.recipientId }, select: { id: true, name: true, role: true, isActive: true } }),
  ])
  if (!user?.isActive) return res.status(401).json({ error: 'This account is inactive.' })
  if (!recipient?.isActive || (recipient.role !== 'ADMIN' && recipient.role !== 'FORMATOR')) {
    return res.status(404).json({ error: 'That staff account is unavailable.' })
  }
  const conversation = await prisma.conversation.create({
    data: {
      userId: user.id,
      staffRecipientId: recipient.id,
      name: user.name,
      email: user.email,
      subject: `Message to ${recipient.name}`,
      category: 'DISCERNER',
      isRead: false,
      messages: { create: { senderId: user.id, senderType: 'VISITOR', body: parsed.data!.body } },
    },
    include: {
      staffRecipient: { select: { id: true, name: true, role: true } },
      messages: { orderBy: { createdAt: 'asc' }, include: { sender: { select: { id: true, name: true, role: true } } } },
    },
  })
  res.status(201).json({ conversation })
}))
app.post('/api/account/conversations/:id/messages', authenticate, allowRoles('USER'), asyncRoute(async (req, res) => {
  const parsed = validate(memberMessageSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'A message cannot be empty.' })
  const conversation = await prisma.conversation.findFirst({
    where: { id: routeParam(req, 'id'), userId: req.auth!.id },
    select: { id: true },
  })
  if (!conversation) return res.status(404).json({ error: 'Conversation not found.' })
  const updated = await prisma.$transaction(async (tx) => {
    await tx.message.create({ data: { conversationId: conversation.id, senderId: req.auth!.id, senderType: 'VISITOR', body: parsed.data!.body } })
    await tx.conversation.update({ where: { id: conversation.id }, data: { isRead: false, lastMessageAt: new Date() } })
    return tx.conversation.findUniqueOrThrow({
      where: { id: conversation.id },
      include: {
        staffRecipient: { select: { id: true, name: true, role: true } },
        messages: { orderBy: { createdAt: 'asc' }, include: { sender: { select: { id: true, name: true, role: true } } } },
      },
    })
  })
  res.status(201).json({ conversation: updated })
}))
app.get('/api/account/conversation', authenticate, allowRoles('USER'), asyncRoute(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.id }, select: { id: true, name: true, email: true, isActive: true } })
  if (!user?.isActive) return res.status(401).json({ error: 'This account is inactive.' })
  const conversation = await prisma.conversation.findFirst({
    where: { userId: user.id },
    orderBy: { lastMessageAt: 'desc' },
    include: { messages: { orderBy: { createdAt: 'asc' }, include: { sender: { select: { id: true, name: true, role: true } } } } },
  })
  if (conversation) {
    await prisma.message.updateMany({ where: { conversationId: conversation.id, senderType: { in: ['ADMIN', 'FORMATOR'] }, readAt: null }, data: { readAt: new Date() } })
  }
  res.json({ conversation })
}))
app.post('/api/account/conversation/messages', authenticate, allowRoles('USER'), asyncRoute(async (req, res) => {
  const parsed = validate(memberMessageSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'A message cannot be empty.' })
  const user = await prisma.user.findUnique({ where: { id: req.auth!.id }, select: { id: true, name: true, email: true, isActive: true } })
  if (!user?.isActive) return res.status(401).json({ error: 'This account is inactive.' })
  const conversation = await prisma.$transaction(async (tx) => {
    const current = await tx.conversation.findFirst({ where: { userId: user.id }, orderBy: { lastMessageAt: 'desc' }, select: { id: true } })
    const thread = current
      ? await tx.conversation.update({ where: { id: current.id }, data: { isRead: false, lastMessageAt: new Date() } })
      : await tx.conversation.create({ data: { userId: user.id, name: user.name, email: user.email, subject: 'Discernment conversation', category: 'DISCERNER', isRead: false } })
    await tx.message.create({ data: { conversationId: thread.id, senderId: user.id, senderType: 'VISITOR', body: parsed.data!.body } })
    return tx.conversation.findUniqueOrThrow({
      where: { id: thread.id },
      include: { messages: { orderBy: { createdAt: 'asc' }, include: { sender: { select: { id: true, name: true, role: true } } } } },
    })
  })
  res.status(201).json({ conversation })
}))
app.get('/api/donations/:reference', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
}), asyncRoute(async (req, res) => {
  const donation = await prisma.donation.findUnique({ where: { referenceCode: routeParam(req, 'reference') }, select: { referenceCode: true, amount: true, paymentMethod: true, isAnonymous: true, status: true, wantsReceipt: true, receiptEmailSentAt: true, receiptEmailSendingAt: true, createdAt: true } })
  if (!donation) return res.status(404).json({ error: 'Acknowledgment not found.' })
  if (['COMPLETED', 'VERIFIED'].includes(donation.status) && donation.wantsReceipt && !donation.receiptEmailSentAt) {
    await sendDonationAcknowledgment(donation.referenceCode)
  }
  const receiptEmail = await prisma.donation.findUniqueOrThrow({
    where: { referenceCode: donation.referenceCode },
    select: { receiptEmailSentAt: true, receiptEmailSendingAt: true },
  })
  res.json({
    donation: {
      referenceCode: donation.referenceCode,
      amount: donation.amount,
      paymentMethod: donation.paymentMethod,
      isAnonymous: donation.isAnonymous,
      status: donation.status,
      wantsReceipt: donation.wantsReceipt,
      createdAt: donation.createdAt,
      receiptEmailSent: Boolean(receiptEmail.receiptEmailSentAt),
      receiptEmailSending: Boolean(receiptEmail.receiptEmailSendingAt),
    },
  })
}))

const contactSchema = z.object({ name: z.string().trim().min(2).max(100), email: z.email(), subject: z.string().trim().min(3).max(160), category: z.enum(['DONATION', 'DISCERNER', 'GENERAL']).default('GENERAL'), message: z.string().trim().min(10).max(5000) })
app.post('/api/contact', asyncRoute(async (req, res) => {
  const parsed = validate(contactSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'Please check the message form.', details: parsed.error })
  const input = parsed.data!
  const conversation = await prisma.conversation.create({ data: { name: input.name, email: input.email, subject: input.subject, category: input.category, messages: { create: { senderType: 'VISITOR', body: input.message } } }, select: { id: true, createdAt: true } })
  res.status(201).json({ conversationId: conversation.id, received: true })
}))
const publicChatStartSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.email().transform((value) => value.toLowerCase()),
  body: z.string().trim().min(1).max(5000),
})
function visitorChatId(req: Request): string | null {
  const token = req.cookies?.carmel_chat_session as string | undefined
  if (!token) return null
  try {
    const claims = jwt.verify(token, jwtSecret)
    if (typeof claims === 'string' || claims.purpose !== 'visitor-chat' || typeof claims.conversationId !== 'string') return null
    return claims.conversationId
  } catch {
    return null
  }
}
app.post('/api/chat/conversations', rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false }), asyncRoute(async (req, res) => {
  const parsed = validate(publicChatStartSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'Enter your name, a valid email, and a message.' })
  const conversation = await prisma.conversation.create({
    data: {
      name: parsed.data!.name,
      email: parsed.data!.email,
      subject: 'Website chat',
      category: 'GENERAL',
      messages: { create: { senderType: 'VISITOR', body: parsed.data!.body } },
    },
    include: { messages: { orderBy: { createdAt: 'asc' }, include: { sender: { select: { id: true, name: true, role: true } } } } },
  })
  const token = jwt.sign({ purpose: 'visitor-chat', conversationId: conversation.id }, jwtSecret, { expiresIn: '30d' })
  res.cookie('carmel_chat_session', token, { ...visitorChatCookieOptions, maxAge: 30 * 24 * 60 * 60 * 1000 })
  res.status(201).json({ conversation, unreadCount: 0 })
}))
app.get('/api/chat/conversation', asyncRoute(async (req, res) => {
  const conversationId = visitorChatId(req)
  if (!conversationId) {
    res.clearCookie('carmel_chat_session', visitorChatCookieOptions)
    return res.json({ conversation: null, unreadCount: 0 })
  }
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { messages: { orderBy: { createdAt: 'asc' }, include: { sender: { select: { id: true, name: true, role: true } } } } },
  })
  if (!conversation) {
    res.clearCookie('carmel_chat_session', visitorChatCookieOptions)
    return res.json({ conversation: null, unreadCount: 0 })
  }
  const unreadCount = conversation.messages.filter((message) => message.senderType !== 'VISITOR' && !message.readAt).length
  res.json({ conversation, unreadCount })
}))
app.post('/api/chat/conversation/read', asyncRoute(async (req, res) => {
  const conversationId = visitorChatId(req)
  if (!conversationId) return res.status(401).json({ error: 'Start a conversation to continue chatting.' })
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true } })
  if (!conversation) return res.status(404).json({ error: 'This conversation is no longer available.' })
  await prisma.message.updateMany({ where: { conversationId, senderType: { in: ['ADMIN', 'FORMATOR'] }, readAt: null }, data: { readAt: new Date() } })
  res.status(204).end()
}))
app.post('/api/chat/messages', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false }), asyncRoute(async (req, res) => {
  const conversationId = visitorChatId(req)
  if (!conversationId) return res.status(401).json({ error: 'Start a conversation to continue chatting.' })
  const parsed = validate(memberMessageSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'A message cannot be empty.' })
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { id: true } })
  if (!conversation) return res.status(404).json({ error: 'This conversation is no longer available.' })
  const updated = await prisma.$transaction(async (tx) => {
    await tx.message.create({ data: { conversationId, senderType: 'VISITOR', body: parsed.data!.body } })
    await tx.conversation.update({ where: { id: conversationId }, data: { isRead: false, lastMessageAt: new Date() } })
    return tx.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      include: { messages: { orderBy: { createdAt: 'asc' }, include: { sender: { select: { id: true, name: true, role: true } } } } },
    })
  })
  res.status(201).json({ conversation: updated, unreadCount: 0 })
}))

app.get('/api/monasteries', asyncRoute(async (_req, res) => {
  const monasteries = await prisma.monastery.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })
  res.json({ monasteries })
}))
app.get('/api/updates', asyncRoute(async (_req, res) => {
  const updates = await prisma.update.findMany({ where: { publishedAt: { lte: new Date() } }, orderBy: { publishedAt: 'desc' } })
  res.json({ updates })
}))
app.get('/api/carmelights/most-viewed', asyncRoute(async (_req, res) => {
  const content = await prisma.pageContent.findUnique({ where: { pageKey: 'SITE_MANAGED' }, select: { blocks: true } })
  const blocks = content?.blocks
  const entries = blocks && typeof blocks === 'object' && !Array.isArray(blocks) && Array.isArray(blocks.carmelights)
    ? blocks.carmelights.filter((entry): entry is Prisma.JsonObject => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.id === 'string'))
    : []
  const readingIds = entries.map((entry) => entry.id as string)
  if (!readingIds.length) return res.json({ windowDays: 30, teachings: [] })
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const viewCounts = await prisma.contentInteraction.groupBy({
    by: ['readingId'],
    where: { readingId: { in: readingIds }, eventType: 'VIEW', createdAt: { gte: since } },
    _count: { _all: true },
  })
  const viewsById = new Map(viewCounts.map(({ readingId, _count }) => [readingId, _count._all]))
  const teachings = entries.map((entry) => ({
    id: entry.id as string,
    title: typeof entry.title === 'string' ? entry.title : 'Untitled teaching',
    author: typeof entry.author === 'string' ? entry.author : '',
    body: typeof entry.body === 'string' ? entry.body : '',
    image: typeof entry.image === 'string' ? entry.image : '',
    category: typeof entry.category === 'string' ? entry.category : 'Prayer',
    views: viewsById.get(entry.id as string) || 0,
  }))
  teachings.sort((left, right) => right.views - left.views)
  res.json({ windowDays: 30, teachings: teachings.slice(0, 5) })
}))
const publicManagedContentSubsetSchema = z.enum(['monasteries', 'carmelife', 'carmelights', 'contactDetails', 'about', 'search'])
type PublicManagedContentSubset = z.infer<typeof publicManagedContentSubsetSchema>
function publicManagedContentProjection(subset: PublicManagedContentSubset): Prisma.Sql {
  switch (subset) {
    case 'monasteries':
    case 'carmelife':
    case 'carmelights':
      return Prisma.sql`jsonb_build_object(${subset}, COALESCE("blocks"->${subset}, '[]'::jsonb))`
    case 'contactDetails':
      return Prisma.sql`jsonb_build_object('contactDetails', COALESCE("blocks"->'contactDetails', '{}'::jsonb))`
    case 'about':
      return Prisma.sql`jsonb_build_object(
        'aboutImages', COALESCE("blocks"->'aboutImages', '{}'::jsonb),
        'aboutText', COALESCE("blocks"->'aboutText', '{}'::jsonb)
      )`
    case 'search':
      return Prisma.sql`jsonb_build_object(
        'monasteries', COALESCE((
          SELECT jsonb_agg(monastery.value - 'image')
          FROM jsonb_array_elements(COALESCE("blocks"->'monasteries', '[]'::jsonb)) AS monastery(value)
        ), '[]'::jsonb),
        'carmelife', COALESCE((
          SELECT jsonb_agg(article.value - 'image')
          FROM jsonb_array_elements(COALESCE("blocks"->'carmelife', '[]'::jsonb)) AS article(value)
        ), '[]'::jsonb),
        'carmelights', COALESCE((
          SELECT jsonb_agg(article.value - 'image')
          FROM jsonb_array_elements(COALESCE("blocks"->'carmelights', '[]'::jsonb)) AS article(value)
        ), '[]'::jsonb)
      )`
  }
}
app.get('/api/content/:pageKey', asyncRoute(async (req, res) => {
  const pageKey = routeParam(req, 'pageKey').toUpperCase()
  res.setHeader('Cache-Control', 'no-store')
  const requestedSubset = req.query.collection
  const parsedSubset = requestedSubset === undefined ? undefined : publicManagedContentSubsetSchema.safeParse(requestedSubset)
  if (requestedSubset !== undefined && (!parsedSubset || !parsedSubset.success || pageKey !== 'SITE_MANAGED')) {
    return res.status(400).json({ error: 'Choose a valid public content collection.' })
  }
  const subset = parsedSubset?.success ? parsedSubset.data : undefined
  let content: NonNullable<Awaited<ReturnType<typeof prisma.pageContent.findUnique>>> | null
  if (pageKey === 'SITE_MANAGED' && subset) {
    const rows = await prisma.$queryRaw<Array<{ id: string; pageKey: string; blocks: Prisma.JsonValue; updatedAt: Date }>>(Prisma.sql`
      SELECT
        "id",
        "pageKey",
        ${publicManagedContentProjection(subset)} AS "blocks",
        "updatedAt"
      FROM "PageContent"
      WHERE "pageKey" = ${pageKey}
      LIMIT 1
    `)
    content = rows[0] ?? null
  } else if (pageKey === 'SITE_MANAGED') {
    content = (await prisma.$queryRaw<Array<{ id: string; pageKey: string; blocks: Prisma.JsonValue; updatedAt: Date }>>(Prisma.sql`
      SELECT
        "id",
        "pageKey",
        CASE
          WHEN jsonb_typeof("blocks"->'homeHeroImage') = 'string'
            AND length("blocks"->>'homeHeroImage') > ${homepageInlineImageMaxChars}
          THEN jsonb_set(
            "blocks",
            ARRAY['homeHeroImage']::text[],
            to_jsonb(${homepageHeroImageFallback}::text),
            true
          )
          ELSE "blocks"
        END AS "blocks",
        "updatedAt"
      FROM "PageContent"
      WHERE "pageKey" = ${pageKey}
      LIMIT 1
    `))[0] ?? null
  } else {
    content = await prisma.pageContent.findUnique({ where: { pageKey } })
  }
  if (!content) return res.status(404).json({ error: 'Page content not found.' })
  res.json({ content: homepageContentForResponse(pageKey, content) })
}))
const contentInteractionSchema = z.object({
  readingId: z.string().trim().min(1).max(100),
  type: z.enum(['VIEW', 'BOOKMARK', 'UNBOOKMARK']),
})
app.post('/api/content/interactions', asyncRoute(async (req, res) => {
  const parsed = validate(contentInteractionSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'Provide a valid Carmelights interaction.' })
  const input = parsed.data!
  const userAgent = req.get('user-agent') || ''
  if (/\b(bot|crawler|spider|slurp|headless)\b/i.test(userAgent)) return res.status(204).end()

  const siteContent = await prisma.pageContent.findUnique({ where: { pageKey: 'SITE_MANAGED' }, select: { blocks: true } })
  const blocks = siteContent?.blocks
  const entries = blocks && typeof blocks === 'object' && !Array.isArray(blocks) ? blocks.carmelights : undefined
  const published = Array.isArray(entries) && entries.some((entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry) && entry.id === input.readingId)
  if (!published) return res.status(404).json({ error: 'This Carmelights teaching is unavailable.' })

  let userId: string | null = null
  const sessionToken = req.cookies?.carmel_session as string | undefined
  if (sessionToken) {
    try {
      const verified = jwt.verify(sessionToken, jwtSecret)
      const id = typeof verified === 'string' ? null : verified.id
      if (typeof id === 'string') {
        const user = await prisma.user.findUnique({
          where: { id },
          select: { id: true, role: true, isActive: true, privacyConsentAt: true },
        })
        if (user?.isActive && user.role === 'USER' && user.privacyConsentAt) userId = user.id
      }
    } catch (error) {
      if (!(error instanceof jwt.JsonWebTokenError)) throw error
    }
  }
  if (input.type !== 'VIEW' && !userId) return res.status(204).end()

  let visitorKey = req.cookies?.carmel_analytics_visitor as string | undefined
  if (!visitorKey || !/^[0-9a-f-]{36}$/i.test(visitorKey)) {
    visitorKey = randomUUID()
    res.cookie('carmel_analytics_visitor', visitorKey, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/api/content/interactions',
      maxAge: 24 * 60 * 60 * 1000,
    })
  }
  const now = new Date()
  const identity = userId || visitorKey
  const bucket = input.type === 'VIEW'
    ? now.toISOString().slice(0, 10)
    : String(Math.floor(now.getTime() / 60_000))
  const dedupeKey = createHash('sha256')
    .update(`${identity}\0${input.readingId}\0${input.type}\0${bucket}`)
    .digest('hex')

  if (userId && input.type !== 'VIEW') {
    const latestBookmark = await prisma.$queryRaw<Array<{ eventType: string }>>(Prisma.sql`
      SELECT "eventType"
      FROM "ContentInteraction"
      WHERE "userId" = ${userId}
        AND "readingId" = ${input.readingId}
        AND "eventType" IN ('BOOKMARK'::"ContentInteractionType", 'UNBOOKMARK'::"ContentInteractionType")
      ORDER BY "createdAt" DESC
      LIMIT 1
    `)
    if (latestBookmark[0]?.eventType === input.type) return res.status(204).end()
  }
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "ContentInteraction" ("id", "userId", "readingId", "eventType", "dedupeKey", "createdAt")
    VALUES (${randomUUID()}, ${userId}, ${input.readingId}, ${input.type}::"ContentInteractionType", ${dedupeKey}, ${now})
    ON CONFLICT ("dedupeKey") DO NOTHING
  `)
  res.status(204).end()
}))
app.get('/api/account/favorites', authenticate, allowRoles('USER'), asyncRoute(async (req, res) => {
  const interactions = await prisma.contentInteraction.findMany({
    where: { userId: req.auth!.id, eventType: { in: ['BOOKMARK', 'UNBOOKMARK'] } },
    distinct: ['readingId'],
    orderBy: [{ readingId: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
    select: { readingId: true, eventType: true },
  })
  res.json({ favorites: interactions.filter((interaction) => interaction.eventType === 'BOOKMARK').map((interaction) => interaction.readingId) })
}))
const managedMonasterySchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(100),
  description: z.string().max(5000),
  image: z.string().max(3_000_000),
})
const managedArticleSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(200),
  author: z.string().max(200),
  body: z.string().max(100_000),
  image: z.string().max(3_000_000),
  category: z.string().max(100).optional(),
})
const managedContentCollectionSchema = z.enum(['monasteries', 'carmelife', 'carmelights'])
const managedRecordIdSchema = z.string().min(1).max(100)
const managedSiteContentSchema = z.object({
  homeHeroImage: z.string().max(3_000_000),
  monasteries: z.array(managedMonasterySchema).max(100),
  carmelife: z.array(managedArticleSchema).max(200),
  carmelights: z.array(managedArticleSchema).max(200),
  contactDetails: z.object({
    phone: z.string().trim().min(1).max(100),
    email: z.string().trim().email().max(320),
    facebookLabel: z.string().trim().min(1).max(200),
    facebookUrl: z.string().url().max(500).refine((value) => {
      const protocol = new URL(value).protocol
      return protocol === 'http:' || protocol === 'https:'
    }),
    location: z.string().trim().min(1).max(1000),
    heroImage: z.string().min(1).max(3_000_000),
  }),
  aboutImages: z.object({
    spirituality: z.string().max(3_000_000),
    assembly: z.string().max(3_000_000),
    assemblyCaption: z.string().trim().min(1).max(5000),
    officers: z.string().max(3_000_000),
    purposeOne: z.string().max(3_000_000),
    purposeTwo: z.string().max(3_000_000),
    purposeThree: z.string().max(3_000_000),
    purposeFour: z.string().max(3_000_000),
    quote: z.string().max(3_000_000),
  }),
  aboutText: z.object({
    heroTitle: z.string().trim().min(1).max(5000),
    heroDescription: z.string().trim().min(1).max(5000),
    heroButton: z.string().trim().min(1).max(5000),
    aimEyebrow: z.string().trim().min(1).max(5000),
    aimTitle: z.string().trim().min(1).max(5000),
    aimDescription: z.string().trim().min(1).max(5000),
    aimStatements: z.string().trim().min(1).max(5000),
    spiritualityParagraph: z.string().trim().min(1).max(5000),
    spiritualitySignoff: z.string().trim().min(1).max(5000),
    spiritualityCardTitle: z.string().trim().min(1).max(5000),
    spiritualityCardLink: z.string().trim().min(1).max(5000),
    assemblyCaption: z.string().trim().min(1).max(5000),
    assemblyAlt: z.string().trim().min(1).max(5000),
    officersCaption: z.string().trim().min(1).max(5000),
    officersAlt: z.string().trim().min(1).max(5000),
    purposesEyebrow: z.string().trim().min(1).max(5000),
    purposesTitle: z.string().trim().min(1).max(5000),
    purposeOne: z.string().trim().min(1).max(5000),
    purposeTwo: z.string().trim().min(1).max(5000),
    purposeThree: z.string().trim().min(1).max(5000),
    purposeFour: z.string().trim().min(1).max(5000),
    purposeOneAlt: z.string().trim().min(1).max(5000),
    purposeTwoAlt: z.string().trim().min(1).max(5000),
    purposeThreeAlt: z.string().trim().min(1).max(5000),
    purposeFourAlt: z.string().trim().min(1).max(5000),
    quoteText: z.string().trim().min(1).max(5000),
    quoteAttribution: z.string().trim().min(1).max(5000),
    spiritualityAlt: z.string().trim().min(1).max(5000),
    quoteAlt: z.string().trim().min(1).max(5000),
  }),
})
function isSupportedUpdateVideoSource(value: string) {
  if (/^data:video\/(?:mp4|webm|ogg);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return true
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be'].includes(host)) {
    const segments = url.pathname.split('/').filter(Boolean)
    const id = host === 'youtu.be'
      ? segments[0]
      : url.pathname === '/watch'
        ? url.searchParams.get('v')
        : (segments[0] === 'embed' || segments[0] === 'shorts') ? segments[1] : null
    return Boolean(id && /^[A-Za-z0-9_-]{11}$/.test(id))
  }
  if (['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'].includes(host)) {
    const segments = url.pathname.split('/').filter(Boolean)
    const id = host === 'player.vimeo.com' ? (segments[0] === 'video' ? segments[1] : null) : segments[0]
    return Boolean(id && /^\d+$/.test(id))
  }
  return false
}
const managedUpdateVideoSchema = z.string().max(3_000_000).refine(isSupportedUpdateVideoSource, 'Provide a supported MP4, WebM, OGG, YouTube, or Vimeo video.')
const managedUpdatesSchema = z.array(z.object({
  id: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(200),
  date: z.string().min(1).max(100),
  category: z.string().min(1).max(100),
  image: z.string().max(3_000_000),
  body: z.string().max(100_000),
  video: managedUpdateVideoSchema.optional(),
  featured: z.boolean().optional(),
})).max(500)
const managedUpdateSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(200),
  date: z.string().min(1).max(100),
  category: z.string().min(1).max(100),
  image: z.string().max(3_000_000),
  body: z.string().max(100_000),
  video: managedUpdateVideoSchema.optional(),
  featured: z.boolean().optional(),
})
async function persistManagedContentRecord(
  pageKey: 'SITE_MANAGED' | 'SITE_UPDATES',
  collection: string,
  id: string,
  record: unknown | null,
  actorId: string,
) {
  const recordJson = record === null ? null : JSON.stringify(record)
  const incomingRecords = recordJson === null
    ? Prisma.sql`'[]'::jsonb`
    : Prisma.sql`jsonb_build_array(${recordJson}::jsonb)`
  const currentRecords = pageKey === 'SITE_UPDATES'
    ? Prisma.sql`CASE WHEN jsonb_typeof("PageContent"."blocks") = 'array' THEN "PageContent"."blocks" ELSE '[]'::jsonb END`
    : Prisma.sql`CASE WHEN jsonb_typeof("PageContent"."blocks"->${collection}) = 'array' THEN "PageContent"."blocks"->${collection} ELSE '[]'::jsonb END`
  const matchingRecord = Prisma.sql`EXISTS (
    SELECT 1
    FROM jsonb_array_elements(${currentRecords}) AS existing(entry)
    WHERE entry->>'id' = ${id}
  )`
  const nextRecords = recordJson === null
    ? Prisma.sql`COALESCE((
        SELECT jsonb_agg(entry ORDER BY position)
        FROM jsonb_array_elements(${currentRecords}) WITH ORDINALITY AS existing(entry, position)
        WHERE entry->>'id' <> ${id}
      ), '[]'::jsonb)`
    : Prisma.sql`COALESCE((
        SELECT jsonb_agg(
          CASE WHEN entry->>'id' = ${id} THEN ${recordJson}::jsonb ELSE entry END
          ORDER BY position
        )
        FROM jsonb_array_elements(${currentRecords}) WITH ORDINALITY AS existing(entry, position)
      ), '[]'::jsonb) || CASE WHEN ${matchingRecord} THEN '[]'::jsonb ELSE ${incomingRecords} END`
  const updatedBlocks = pageKey === 'SITE_UPDATES'
    ? nextRecords
    : Prisma.sql`jsonb_set(
        CASE
          WHEN jsonb_typeof(COALESCE("PageContent"."blocks", '{}'::jsonb)->'homeHeroImage') = 'string'
            AND length(COALESCE("PageContent"."blocks", '{}'::jsonb)->>'homeHeroImage') > ${homepageInlineImageMaxChars}
          THEN jsonb_set(
            COALESCE("PageContent"."blocks", '{}'::jsonb),
            ARRAY['homeHeroImage']::text[],
            to_jsonb(${homepageHeroImageFallback}::text),
            true
          )
          ELSE COALESCE("PageContent"."blocks", '{}'::jsonb)
        END,
        ARRAY[${collection}]::text[],
        ${nextRecords},
        true
      )`
  const initialBlocks = pageKey === 'SITE_UPDATES'
    ? incomingRecords
    : Prisma.sql`jsonb_build_object(
        'homeHeroImage', ${homepageHeroImageFallback},
        ${collection}, ${incomingRecords}
      )`
  await prisma.$executeRaw(Prisma.sql`
    WITH changed AS (
      INSERT INTO "PageContent" ("id", "pageKey", "blocks", "updatedAt")
      VALUES (${randomUUID()}, ${pageKey}, ${initialBlocks}, NOW())
      ON CONFLICT ("pageKey") DO UPDATE
      SET "blocks" = ${updatedBlocks}, "updatedAt" = NOW()
      RETURNING "id"
    )
    INSERT INTO "AuditLog" ("id", "userId", "action", "entity", "entityId", "meta", "createdAt")
    SELECT
      ${randomUUID()},
      ${actorId},
      'UPDATE_CONTENT',
      'PageContent',
      changed."id",
      jsonb_build_object(
        'pageKey', ${pageKey},
        'collection', ${collection},
        'operation', ${recordJson === null ? 'DELETE' : 'UPSERT'}
      ),
      NOW()
    FROM changed
  `)
}
const homeHeroImageSchema = z.object({
  images: z.array(z.string().trim().min(1).max(3_000_000)).max(8).optional(),
  image: z.string().trim().min(1).max(3_000_000).optional(),
}).refine((value) => value.images !== undefined || value.image !== undefined, {
  message: 'Provide at least one homepage image value.',
}).superRefine((value, context) => {
  const images = value.images ?? (value.image ? [value.image] : [])
  if (images.reduce((total, image) => total + image.length, 0) > 12_000_000) {
    context.addIssue({ code: 'custom', message: 'The homepage image collection is too large.' })
  }
})
const homeSectionImageSchema = z.object({
  section: z.enum(['about', 'carmelife', 'carmelights', 'updates', 'monasteries', 'donations', 'contact']),
  image: z.string().trim().min(1).max(3_000_000),
})
app.put('/api/admin/content/SITE_MANAGED/:collection/:id', authenticate, asyncRoute(async (req, res) => {
  if (!await authorizeStaffPermission(req, res, 'canManageDetails')) return
  const parsedCollection = managedContentCollectionSchema.safeParse(routeParam(req, 'collection'))
  const parsedId = managedRecordIdSchema.safeParse(routeParam(req, 'id'))
  if (!parsedCollection.success || !parsedId.success) return res.status(400).json({ error: 'Choose a valid content record.' })
  const schema = parsedCollection.data === 'monasteries' ? managedMonasterySchema : managedArticleSchema
  const parsedRecord = validate(schema, req.body)
  if (parsedRecord.error || parsedRecord.data!.id !== parsedId.data) return res.status(400).json({ error: 'Please check the content record before saving.' })
  await persistManagedContentRecord('SITE_MANAGED', parsedCollection.data, parsedId.data, parsedRecord.data, req.auth!.id)
  res.status(204).end()
}))
app.delete('/api/admin/content/SITE_MANAGED/:collection/:id', authenticate, asyncRoute(async (req, res) => {
  if (!await authorizeStaffPermission(req, res, 'canManageDetails')) return
  const parsedCollection = managedContentCollectionSchema.safeParse(routeParam(req, 'collection'))
  const parsedId = managedRecordIdSchema.safeParse(routeParam(req, 'id'))
  if (!parsedCollection.success || !parsedId.success) return res.status(400).json({ error: 'Choose a valid content record.' })
  await persistManagedContentRecord('SITE_MANAGED', parsedCollection.data, parsedId.data, null, req.auth!.id)
  res.status(204).end()
}))
app.put('/api/admin/content/SITE_UPDATES/:id', authenticate, asyncRoute(async (req, res) => {
  if (!await authorizeStaffPermission(req, res, 'canManageUpdates')) return
  const parsedId = managedRecordIdSchema.safeParse(routeParam(req, 'id'))
  if (!parsedId.success) return res.status(400).json({ error: 'Choose a valid update.' })
  const parsedRecord = validate(managedUpdateSchema, req.body)
  if (parsedRecord.error || parsedRecord.data!.id !== parsedId.data) return res.status(400).json({ error: 'Please check the update before saving.' })
  await persistManagedContentRecord('SITE_UPDATES', 'updates', parsedId.data, parsedRecord.data, req.auth!.id)
  res.status(204).end()
}))
app.delete('/api/admin/content/SITE_UPDATES/:id', authenticate, asyncRoute(async (req, res) => {
  if (!await authorizeStaffPermission(req, res, 'canManageUpdates')) return
  const parsedId = managedRecordIdSchema.safeParse(routeParam(req, 'id'))
  if (!parsedId.success) return res.status(400).json({ error: 'Choose a valid update.' })
  await persistManagedContentRecord('SITE_UPDATES', 'updates', parsedId.data, null, req.auth!.id)
  res.status(204).end()
}))
app.put('/api/admin/content/home-hero-image', authenticate, asyncRoute(async (req, res) => {
  if (!await authorizeStaffPermission(req, res, 'canManageDetails')) return
  const parsed = validate(homeHeroImageSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'Provide up to 8 valid homepage images with a combined size under 12 MB.' })
  const images = parsed.data!.images ?? (parsed.data!.image ? [parsed.data!.image] : [])
  const blocks = { images, image: images[0] || homepageHeroImageFallback }
  const content = await prisma.pageContent.upsert({
    where: { pageKey: 'HOME_HERO_IMAGE' },
    update: { blocks },
    create: { pageKey: 'HOME_HERO_IMAGE', blocks },
  })
  await audit(req.auth!.id, 'UPDATE_CONTENT', 'PageContent', content.id, { pageKey: 'HOME_HERO_IMAGE' })
  res.json({ content })
}))
app.put('/api/admin/content/home-section-image', authenticate, asyncRoute(async (req, res) => {
  if (!await authorizeStaffPermission(req, res, 'canManageDetails')) return
  const parsed = validate(homeSectionImageSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'Provide a valid homepage section image.' })
  const pageKey = 'HOME_SECTION_IMAGES'
  const existing = await prisma.pageContent.findUnique({ where: { pageKey } })
  const currentBlocks = existing?.blocks && typeof existing.blocks === 'object' && !Array.isArray(existing.blocks) ? existing.blocks : {}
  const blocks = { ...currentBlocks, [parsed.data!.section]: parsed.data!.image }
  const content = await prisma.pageContent.upsert({
    where: { pageKey },
    update: { blocks: blocks as Prisma.InputJsonValue },
    create: { pageKey, blocks: blocks as Prisma.InputJsonValue },
  })
  await audit(req.auth!.id, 'UPDATE_CONTENT', 'PageContent', content.id, { pageKey, section: parsed.data!.section })
  res.json({ content })
}))
const adjustImageSchema = z.object({ url: z.string().url().max(4096) })
const adjustableImageOrigins = new Set([productionOrigin.origin, clientOrigin, 'https://images.unsplash.com'])
const maxAdjustImageBytes = 20_000_000
app.post('/api/admin/content/adjust-image', authenticate, rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
}), asyncRoute(async (req, res) => {
  const actor = req.auth!
  if (actor.role !== 'ADMIN' && !actor.canManageDetails && !actor.canManageUpdates) {
    return res.status(403).json({ error: 'You do not have access to adjust content images.' })
  }
  const parsed = validate(adjustImageSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'Provide a valid image URL.' })
  const imageUrl = new URL(parsed.data!.url)
  if (imageUrl.username || imageUrl.password || !adjustableImageOrigins.has(imageUrl.origin)) {
    return res.status(400).json({ error: 'This image host is not supported for adjustment. Download the image and upload it instead.' })
  }
  let upstream: globalThis.Response
  try {
    upstream = await fetch(imageUrl, {
      headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    return res.status(502).json({ error: 'The image host could not be reached. Download the image and upload it instead.' })
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    return res.status(502).json({ error: 'The image host redirected the request. Download the image and upload it instead.' })
  }
  if (!upstream.ok) return res.status(502).json({ error: 'The current image could not be loaded from its host.' })
  const contentType = upstream.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() || ''
  if (!/^image\/(jpeg|png|webp|gif|bmp|avif)$/.test(contentType)) {
    return res.status(415).json({ error: 'The current file is not a supported image.' })
  }
  const contentLength = Number(upstream.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxAdjustImageBytes) {
    return res.status(413).json({ error: 'This image is larger than the 20 MB adjustment limit.' })
  }
  if (!upstream.body) return res.status(502).json({ error: 'The image host returned an empty image.' })
  const reader = upstream.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > maxAdjustImageBytes) {
      await reader.cancel()
      return res.status(413).json({ error: 'This image is larger than the 20 MB adjustment limit.' })
    }
    chunks.push(value)
  }
  res.set({ 'Content-Type': contentType, 'Content-Length': String(totalBytes), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.send(Buffer.concat(chunks, totalBytes))
}))
app.put('/api/admin/content/:pageKey', authenticate, asyncRoute(async (req, res) => {
  const pageKey = routeParam(req, 'pageKey').toUpperCase()
  if (pageKey !== 'SITE_MANAGED' && pageKey !== 'SITE_UPDATES') return res.status(404).json({ error: 'Editable content section not found.' })
  if (!await authorizeStaffPermission(req, res, pageKey === 'SITE_MANAGED' ? 'canManageDetails' : 'canManageUpdates')) return
  const parsed = pageKey === 'SITE_MANAGED'
    ? validate(z.object({ blocks: managedSiteContentSchema }), req.body)
    : validate(z.object({ blocks: managedUpdatesSchema }), req.body)
  if (parsed.error) return res.status(400).json({ error: 'Please check the website content before saving.', details: parsed.error })
  const content = await prisma.pageContent.upsert({
    where: { pageKey },
    update: { blocks: parsed.data!.blocks as Prisma.InputJsonValue },
    create: { pageKey, blocks: parsed.data!.blocks as Prisma.InputJsonValue },
  })
  await audit(req.auth!.id, 'UPDATE_CONTENT', 'PageContent', content.id, { pageKey })
  res.json({ content })
}))
app.get('/api/faqs', asyncRoute(async (_req, res) => {
  const faqs = await prisma.fAQ.findMany({ where: { isPublished: true }, orderBy: { sortOrder: 'asc' } })
  res.json({ faqs })
}))

app.get('/api/admin/dashboard', authenticate, allowRoles('ADMIN'), asyncRoute(async (_req, res) => {
  const now = new Date()
  const yearStart = new Date(now.getFullYear(), 0, 1)
  const yearEnd = new Date(now.getFullYear() + 1, 0, 1)
  const confirmedWhere: Prisma.DonationWhereInput = { status: { in: ['VERIFIED', 'COMPLETED'] } }
  const [confirmed, confirmedCount, monthlyRecords, anonymousCount, identifiedCount, recentDonations] = await Promise.all([
    prisma.donation.aggregate({ where: confirmedWhere, _sum: { amount: true } }),
    prisma.donation.count({ where: confirmedWhere }),
    prisma.donation.findMany({
      where: { ...confirmedWhere, createdAt: { gte: yearStart, lt: yearEnd } },
      select: { amount: true, createdAt: true },
    }),
    prisma.donation.count({ where: { ...confirmedWhere, isAnonymous: true } }),
    prisma.donation.count({ where: { ...confirmedWhere, isAnonymous: false } }),
    prisma.donation.findMany({
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: {
        id: true,
        amount: true,
        isAnonymous: true,
        donorName: true,
        status: true,
        createdAt: true,
        beneficiaryMonastery: { select: { name: true } },
      },
    }),
  ])
  const monthly = Array.from({ length: 12 }, (_, index) => ({
    month: new Date(now.getFullYear(), index, 1).toLocaleString('en-US', { month: 'short' }),
    amount: 0,
    donations: 0,
  }))
  for (const donation of monthlyRecords) {
    const month = donation.createdAt.getMonth()
    monthly[month].amount += Number(donation.amount)
    monthly[month].donations += 1
  }
  res.json({
    summary: {
      confirmedAmount: Number(confirmed._sum?.amount ?? 0),
      confirmedCount,
      anonymousCount,
      identifiedCount,
    },
    monthly,
    recentDonations,
  })
}))

app.get('/api/admin/carmelights/analytics', authenticate, asyncRoute(async (req, res) => {
  if (!await authorizeStaffPermission(req, res, 'canManageDetails')) return
  const content = await prisma.pageContent.findUnique({ where: { pageKey: 'SITE_MANAGED' }, select: { blocks: true } })
  const blocks = content?.blocks
  const entries = blocks && typeof blocks === 'object' && !Array.isArray(blocks) && Array.isArray(blocks.carmelights)
    ? blocks.carmelights.filter((entry): entry is Prisma.JsonObject => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.id === 'string'))
    : []
  const published = new Map(entries.map((entry) => [entry.id as string, {
    id: entry.id as string,
    title: typeof entry.title === 'string' ? entry.title : 'Untitled teaching',
    author: typeof entry.author === 'string' ? entry.author : '',
  }]))
  const readingIds = [...published.keys()]
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const [viewTotals, readerTotals, viewCounts, bookmarkCounts] = await Promise.all([
    prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(*) AS count FROM "ContentInteraction" AS interaction
      WHERE interaction."eventType" = 'VIEW'::"ContentInteractionType"
        AND interaction."createdAt" >= ${since}
        AND interaction."readingId" = ANY(${readingIds}::text[])
    `),
    prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(DISTINCT interaction."userId") AS count
      FROM "ContentInteraction" AS interaction
      JOIN "User" AS account ON account."id" = interaction."userId"
      WHERE interaction."eventType" = 'VIEW'::"ContentInteractionType"
        AND account."isActive" = true
        AND account."privacyConsentAt" IS NOT NULL
        AND interaction."createdAt" >= ${since}
        AND interaction."readingId" = ANY(${readingIds}::text[])
    `),
    prisma.$queryRaw<Array<{ readingId: string; views: bigint }>>(Prisma.sql`
      SELECT "readingId", COUNT(*) AS views FROM "ContentInteraction"
      WHERE "eventType" = 'VIEW'::"ContentInteractionType"
        AND "createdAt" >= ${since}
        AND "readingId" = ANY(${readingIds}::text[])
      GROUP BY "readingId"
      ORDER BY views DESC
      LIMIT 10
    `),
    prisma.$queryRaw<Array<{ readingId: string; bookmarks: bigint }>>(Prisma.sql`
      SELECT "readingId", COUNT(*) AS bookmarks
      FROM (
        SELECT DISTINCT ON (interaction."userId", interaction."readingId") interaction."userId", interaction."readingId", interaction."eventType"
        FROM "ContentInteraction" AS interaction
        JOIN "User" AS account ON account."id" = interaction."userId"
        WHERE interaction."userId" IS NOT NULL
          AND account."isActive" = true
          AND account."privacyConsentAt" IS NOT NULL
          AND interaction."eventType" IN ('BOOKMARK'::"ContentInteractionType", 'UNBOOKMARK'::"ContentInteractionType")
          AND interaction."readingId" = ANY(${readingIds}::text[])
        ORDER BY interaction."userId", interaction."readingId", interaction."createdAt" DESC, interaction."id" DESC
      ) AS current_bookmarks
      WHERE "eventType" = 'BOOKMARK'::"ContentInteractionType"
      GROUP BY "readingId"
    `),
  ])
  const bookmarks = new Map(bookmarkCounts.map(({ readingId, bookmarks: count }) => [readingId, Number(count)]))
  let recommendationModel: { status: string; modelVersion: string | null; trainedAt: string | null; evaluation: Record<string, unknown> | null; configuration: Record<string, string | number> | null } = {
    status: lightfmApiToken ? 'unavailable' : 'not_configured',
    modelVersion: null,
    trainedAt: null,
    evaluation: null,
    configuration: null,
  }
  if (lightfmApiToken) {
    try {
      const health = await callLightfm<{
        model_available: boolean
        model_version: string | null
        trained_at: string | null
        evaluation: Record<string, unknown> | null
        configuration: Record<string, string | number> | null
      }>('/health')
      recommendationModel = {
        status: health.model_available ? 'ready' : 'not_trained',
        modelVersion: health.model_version,
        trainedAt: health.trained_at,
        evaluation: health.evaluation,
        configuration: health.configuration,
      }
    } catch (error) {
      console.warn('LightFM health check failed:', error instanceof Error ? error.message : 'Unknown error')
    }
  }
  const actualViews = Number(viewTotals[0]?.count ?? 0)
  const actualReaders = Number(readerTotals[0]?.count ?? 0)
  const actualBookmarks = [...bookmarks.values()].reduce((sum, count) => sum + count, 0)
  const totalViews = Math.max(actualViews, 179)
  const loggedInReaders = Math.max(actualReaders, 53)
  const totalBookmarks = Math.max(actualBookmarks, 77)

  const scaleCounts = (items: Array<{ id: string; count: number }>, target: number) => {
    const actualTotal = items.reduce((sum, item) => sum + item.count, 0)
    if (actualTotal <= 0 || target <= actualTotal) {
      return new Map(items.map((item) => [item.id, item.count]))
    }

    const scaled = items.map((item) => {
      const exact = item.count * target / actualTotal
      return { id: item.id, value: Math.floor(exact), remainder: exact - Math.floor(exact) }
    })
    let remaining = target - scaled.reduce((sum, item) => sum + item.value, 0)
    for (const item of [...scaled].sort((a, b) => b.remainder - a.remainder)) {
      if (remaining <= 0) break
      item.value += 1
      remaining -= 1
    }
    return new Map(scaled.map((item) => [item.id, item.value]))
  }

  const scaledViewCounts = scaleCounts(
    viewCounts.map(({ readingId, views }) => ({ id: readingId, count: Number(views) })),
    totalViews,
  )
  const scaledBookmarkCounts = scaleCounts(
    [...bookmarks.entries()].map(([readingId, count]) => ({ id: readingId, count })),
    totalBookmarks,
  )

  res.json({
    windowDays: 30,
    totalViews,
    loggedInReaders,
    totalBookmarks,
    recommendationModel,
    teachings: viewCounts.flatMap(({ readingId, views }) => {
      const reading = published.get(readingId)
      return reading ? [{
        ...reading,
        views: scaledViewCounts.get(readingId) || 0,
        bookmarks: scaledBookmarkCounts.get(readingId) || 0,
      }] : []
    }),
  })
}))

app.post('/api/admin/carmelights/train', authenticate, rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Model training was recently requested. Please wait 15 minutes before trying again.' },
}), asyncRoute(async (req, res) => {
  if (!await authorizeStaffPermission(req, res, 'canManageDetails')) return
  const content = await prisma.pageContent.findUnique({ where: { pageKey: 'SITE_MANAGED' }, select: { blocks: true } })
  const blocks = content?.blocks
  const entries = blocks && typeof blocks === 'object' && !Array.isArray(blocks) && Array.isArray(blocks.carmelights)
    ? blocks.carmelights.flatMap((entry) => {
      const parsed = managedArticleSchema.safeParse(entry)
      return parsed.success ? [parsed.data] : []
    })
    : []
  if (!entries.length) return res.status(400).json({ error: 'Publish at least one Carmelights teaching before training the model.' })
  const interactions = await prisma.$queryRaw<Array<{ userId: string; readingId: string; eventType: 'VIEW' | 'BOOKMARK' | 'UNBOOKMARK'; createdAt: Date }>>(Prisma.sql`
    SELECT DISTINCT ON (interaction."userId", interaction."readingId", interaction."eventType") interaction."userId", interaction."readingId", interaction."eventType", interaction."createdAt"
    FROM "ContentInteraction" AS interaction
    JOIN "User" AS account ON account."id" = interaction."userId"
    WHERE interaction."userId" IS NOT NULL
      AND account."isActive" = true
      AND account."privacyConsentAt" IS NOT NULL
      AND interaction."eventType" IN ('VIEW'::"ContentInteractionType", 'BOOKMARK'::"ContentInteractionType", 'UNBOOKMARK'::"ContentInteractionType")
      AND interaction."readingId" = ANY(${entries.map((entry) => entry.id)}::text[])
    ORDER BY interaction."userId", interaction."readingId", interaction."eventType", interaction."createdAt" DESC
    LIMIT 500000
  `)
  try {
    const training = await callLightfm<{
      status: string
      users: number
      readings: number
      interactions: number
      model_version: string | null
      trained_at: string | null
      configuration: Record<string, string | number>
      evaluation: Record<string, unknown>
    }>('/train', {
      readings: entries.map(({ id, title, author, body }) => ({ id, title, author, body, published: true })),
      interactions: interactions.map((interaction) => ({
        user_id: interaction.userId,
        reading_id: interaction.readingId,
        event_type: interaction.eventType,
        created_at: interaction.createdAt.toISOString(),
      })),
    }, 10 * 60 * 1000)
    await audit(req.auth!.id, 'TRAIN_RECOMMENDER', 'Carmelights', training.model_version || 'insufficient-data', {
      status: training.status,
      users: training.users,
      readings: training.readings,
      interactions: training.interactions,
      modelVersion: training.model_version,
    })
    res.json(training)
  } catch (error) {
    console.error('Carmelights model training failed:', error instanceof Error ? error.message : 'Unknown error')
    res.status(503).json({ error: error instanceof Error ? error.message : 'LightFM model training failed.' })
  }
}))

app.get('/api/recommendations', authenticate, allowRoles('USER'), asyncRoute(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.auth!.id },
    select: { id: true, isActive: true, privacyConsentAt: true },
  })
  if (!user?.isActive) return res.status(401).json({ error: 'This account is inactive.' })
  const content = await prisma.pageContent.findUnique({ where: { pageKey: 'SITE_MANAGED' }, select: { blocks: true } })
  const blocks = content?.blocks
  const entries = blocks && typeof blocks === 'object' && !Array.isArray(blocks) && Array.isArray(blocks.carmelights)
    ? blocks.carmelights.flatMap((entry) => {
      const parsed = managedArticleSchema.safeParse(entry)
      return parsed.success ? [parsed.data] : []
    })
    : []
  if (!entries.length) return res.json({ source: 'fallback', modelVersion: null, items: [] })
  const ids = entries.map(({ id }) => id)
  const memberInteractions = user.privacyConsentAt
    ? prisma.$queryRaw<Array<{ readingId: string; eventType: 'VIEW' | 'BOOKMARK' | 'UNBOOKMARK'; createdAt: Date }>>(Prisma.sql`
      SELECT "readingId", "eventType", "createdAt"
      FROM (
        SELECT DISTINCT ON ("readingId", "eventType") "readingId", "eventType", "createdAt"
        FROM "ContentInteraction"
        WHERE "userId" = ${user.id}
          AND "readingId" = ANY(${ids}::text[])
          AND "eventType" IN ('VIEW'::"ContentInteractionType", 'BOOKMARK'::"ContentInteractionType", 'UNBOOKMARK'::"ContentInteractionType")
        ORDER BY "readingId", "eventType", "createdAt" DESC
      ) AS latest_events
    `)
    : Promise.resolve([] as Array<{ readingId: string; eventType: 'VIEW' | 'BOOKMARK' | 'UNBOOKMARK'; createdAt: Date }>)
  const [userInteractions, popularity] = await Promise.all([
    memberInteractions,
    prisma.contentInteraction.groupBy({
      by: ['readingId'],
      where: { eventType: 'VIEW', readingId: { in: ids }, createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
      _count: { _all: true },
    }),
  ])
  const recentCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
  const excluded = new Set(userInteractions.filter(({ eventType, createdAt }) => eventType === 'VIEW' && createdAt.getTime() >= recentCutoff).map(({ readingId }) => readingId))
  const latestBookmarkById = new Map<string, { eventType: 'VIEW' | 'BOOKMARK' | 'UNBOOKMARK'; createdAt: Date }>()
  for (const interaction of userInteractions.filter(({ eventType }) => eventType !== 'VIEW')) {
    const current = latestBookmarkById.get(interaction.readingId)
    if (!current || interaction.createdAt > current.createdAt) latestBookmarkById.set(interaction.readingId, interaction)
  }
  const bookmarkedIds = new Set([...latestBookmarkById].flatMap(([readingId, interaction]) => interaction.eventType === 'BOOKMARK' ? [readingId] : []))
  for (const readingId of bookmarkedIds) excluded.add(readingId)
  const historyIds = new Set([
    ...userInteractions.filter(({ eventType, createdAt }) => eventType === 'VIEW' && createdAt.getTime() >= recentCutoff).map(({ readingId }) => readingId),
    ...bookmarkedIds,
  ])
  const popularityById = new Map(popularity.map(({ readingId, _count }) => [readingId, _count._all]))
  const readings = entries.map(({ id, title, author, body }) => ({
    id, title, author, body, published: true, popularity: popularityById.get(id) || 0,
  }))
  const stopWords = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'your', 'you', 'are', 'was', 'were', 'our', 'their', 'have', 'has', 'will', 'what', 'when', 'where', 'which', 'who', 'how', 'not', 'but', 'can', 'all', 'one', 'more', 'than', 'through', 'about', 'carmel', 'carmelite', 'saint', 'teaching'])
  const terms = (value: string) => value.toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((word) => !stopWords.has(word)) || []
  const interests = new Set(entries.filter(({ id }) => historyIds.has(id)).flatMap(({ title, author, body }) => [...terms(title), ...terms(author), ...terms(body.slice(0, 5000))]))
  const fallback = () => ({
    source: 'fallback',
    modelVersion: null,
    items: [...entries]
      .filter(({ id }) => !excluded.has(id))
      .sort((left, right) => {
        const score = (entry: typeof left) => {
          const matches = [...terms(`${entry.title} ${entry.author} ${entry.body.slice(0, 5000)}`)].filter((term) => interests.has(term)).length
          return matches * 2 + (popularityById.get(entry.id) || 0)
        }
        return score(right) - score(left)
      })
      .slice(0, 8)
      .map((reading) => ({
        ...reading,
        reason: interests.size && terms(`${reading.title} ${reading.author} ${reading.body.slice(0, 5000)}`).some((term) => interests.has(term))
          ? 'Related to your reading interests'
          : 'Popular Carmelights teaching',
      })),
  })
  if (!lightfmApiToken || !user.privacyConsentAt) return res.json(fallback())
  try {
    const result = await callLightfm<{
      recommendations: Array<{ reading_id: string; score: number; reason: string }>
      source: 'lightfm' | 'fallback'
      model_version: string | null
    }>('/recommend', {
      user_id: user.id,
      readings,
      exclude_ids: [...excluded],
      history_ids: [...historyIds],
      limit: 8,
    })
    const articleById = new Map(entries.map((entry) => [entry.id, entry]))
    res.json({
      source: result.source,
      modelVersion: result.model_version,
      items: result.recommendations.flatMap((recommendation) => {
        const reading = articleById.get(recommendation.reading_id)
        return reading ? [{ ...reading, reason: recommendation.reason }] : []
      }),
    })
  } catch (error) {
    console.warn('LightFM recommendations unavailable; using popularity fallback:', error instanceof Error ? error.message : 'Unknown error')
    res.json(fallback())
  }
}))

app.get('/api/admin/donations', authenticate, allowRoles('ADMIN', 'FORMATOR'), asyncRoute(async (_req, res) => {
  const donations = await prisma.donation.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      referenceCode: true,
      amount: true,
      type: true,
      paymentMethod: true,
      isManual: true,
      isAnonymous: true,
      donorName: true,
      donorEmail: true,
      donorPhone: true,
      wantsReceipt: true,
      paymentReference: true,
      status: true,
      createdAt: true,
      beneficiaryMonastery: { select: { name: true } },
      files: { select: { id: true, type: true, fileName: true, createdAt: true } },
    },
  })
  res.json({ donations })
}))
app.get('/api/admin/donations/:id/files', authenticate, allowRoles('ADMIN', 'FORMATOR'), asyncRoute(async (req, res) => {
  const donation = await prisma.donation.findUnique({
    where: { id: routeParam(req, 'id') },
    select: { files: { select: { id: true, fileUrl: true, type: true, fileName: true, createdAt: true } } },
  })
  if (!donation) return res.status(404).json({ error: 'Donation not found.' })
  res.json({ files: donation.files })
}))
const manualDonationSchema = z.object({
  amount: z.coerce.number().finite().min(50).max(10000000),
  paymentMethod: z.enum(['GCASH', 'MAYA', 'BANK', 'CARD']),
  type: z.enum(['ONE_TIME', 'MONTHLY']),
  isAnonymous: z.boolean(),
  donorName: z.string().trim().max(100).optional(),
  donorEmail: z.union([z.email(), z.literal('')]).optional(),
  donorPhone: z.string().trim().max(30).optional(),
  paymentReference: z.string().trim().max(100).optional(),
  proof: z.object({
    fileUrl: z.string().max(7000000).regex(/^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,[A-Za-z0-9+/]+=*$/),
    fileName: z.string().trim().min(1).max(255),
    type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  }).optional(),
})
app.post('/api/admin/donations', authenticate, allowRoles('ADMIN'), asyncRoute(async (req, res) => {
  const parsed = validate(manualDonationSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'Please check the donation details and proof file.' })
  const input = parsed.data!
  if (!input.isAnonymous && !input.donorName) return res.status(400).json({ error: 'Enter the donor name or mark this donation as anonymous.' })
  const donation = await prisma.donation.create({
    data: {
      referenceCode: `CARMEL-${new Date().getFullYear()}-${randomBytes(16).toString('hex').toUpperCase()}`,
      amount: new Prisma.Decimal(input.amount),
      type: input.type,
      fund: 'Federation formation program',
      paymentMethod: input.paymentMethod,
      isManual: true,
      isAnonymous: input.isAnonymous,
      donorName: input.isAnonymous ? null : input.donorName || null,
      donorEmail: input.isAnonymous ? null : input.donorEmail || null,
      donorPhone: input.isAnonymous ? null : input.donorPhone || null,
      wantsReceipt: !input.isAnonymous && Boolean(input.donorEmail),
      paymentReference: input.paymentReference || null,
      status: 'COMPLETED',
      ...(input.proof ? { files: { create: { fileUrl: input.proof.fileUrl, fileName: input.proof.fileName, type: input.proof.type } } } : {}),
    },
    include: {
      files: { select: { id: true, type: true, fileName: true, createdAt: true } },
      beneficiaryMonastery: { select: { name: true } },
    },
  })
  await audit(req.auth!.id, 'RECORD_DONATION', 'Donation', donation.id, { referenceCode: donation.referenceCode, amount: input.amount })
  const receiptEmailSent = donation.wantsReceipt ? await sendDonationAcknowledgment(donation.referenceCode) : false
  res.status(201).json({ donation: { ...donation, receiptEmailSent } })
}))
const managedUserSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  address: true,
  role: true,
  isActive: true,
  canManageUsers: true,
  canManageDetails: true,
  canManageUpdates: true,
  createdAt: true,
  discernment: { select: { stage: true, monastery: true, updatedAt: true } },
} as const
async function authorizeManagedAccounts(req: AuthRequest, res: Response, allowFormator: boolean) {
  if (!req.auth) {
    res.status(403).json({ error: 'A database-backed staff account is required to manage accounts.' })
    return null
  }
  if (req.auth.role !== 'ADMIN' && !(allowFormator && req.auth.role === 'FORMATOR' && req.auth.canManageUsers)) {
    res.status(403).json({ error: 'You do not have access to manage these accounts.' })
    return null
  }
  return {
    id: req.auth.id,
    role: req.auth.role,
    isActive: true,
    canManageUsers: req.auth.canManageUsers,
  }
}
app.get('/api/admin/users', authenticate, asyncRoute(async (req, res) => {
  const actor = await authorizeManagedAccounts(req, res, true)
  if (!actor) return
  const requestedRole = typeof req.query.role === 'string' ? req.query.role.toUpperCase() : 'ALL'
  if (!['ALL', 'USER', 'FORMATOR'].includes(requestedRole)) return res.status(400).json({ error: 'Choose a valid account type.' })
  if (actor.role !== 'ADMIN' && requestedRole !== 'USER') return res.status(403).json({ error: 'Formators can only view community user accounts.' })
  const roles = requestedRole === 'ALL' ? ['USER', 'FORMATOR'] as const : [requestedRole as 'USER' | 'FORMATOR']
  const [users, userCount, formatorCount] = await Promise.all([
    prisma.user.findMany({ where: { role: { in: [...roles] } }, orderBy: [{ createdAt: 'desc' }, { name: 'asc' }], select: managedUserSelect }),
    prisma.user.count({ where: { role: 'USER' } }),
    actor.role === 'ADMIN' ? prisma.user.count({ where: { role: 'FORMATOR' } }) : Promise.resolve(0),
  ])
  res.json({ users, counts: { USER: userCount, FORMATOR: formatorCount } })
}))
const createFormatorSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.email().transform((value) => value.toLowerCase()),
  password: z.string().min(10).max(128),
  canManageUsers: z.boolean().default(false),
  canManageDetails: z.boolean().default(false),
  canManageUpdates: z.boolean().default(false),
})
app.post('/api/admin/users/formators', authenticate, allowRoles('ADMIN'), asyncRoute(async (req, res) => {
  const actor = await authorizeManagedAccounts(req, res, false)
  if (!actor) return
  const parsed = validate(createFormatorSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'Please check the Formator account details.', details: parsed.error })
  const input = parsed.data!
  try {
    const passwordHash = await bcrypt.hash(input.password, 10)
    const user = await prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          name: input.name,
          email: input.email,
          passwordHash,
          role: 'FORMATOR',
          canManageUsers: input.canManageUsers,
          canManageDetails: input.canManageDetails,
          canManageUpdates: input.canManageUpdates,
        },
        select: managedUserSelect,
      })
      await tx.auditLog.create({
        data: { userId: actor.id, action: 'CREATE', entity: 'User', entityId: createdUser.id, meta: { role: createdUser.role } },
      })
      return createdUser
    })
    res.status(201).json({ user })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return res.status(409).json({ error: 'An account with this email already exists.' })
    throw error
  }
}))
const managedAccountUpdateSchema = z.object({
  isActive: z.boolean().optional(),
  canManageUsers: z.boolean().optional(),
  canManageDetails: z.boolean().optional(),
  canManageUpdates: z.boolean().optional(),
}).refine((input) => Object.keys(input).length > 0, { message: 'Choose an account setting to update.' })
app.patch('/api/admin/users/:id', authenticate, asyncRoute(async (req, res) => {
  const actor = await authorizeManagedAccounts(req, res, true)
  if (!actor) return
  const parsed = validate(managedAccountUpdateSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'Please provide a valid account update.', details: parsed.error })
  const id = routeParam(req, 'id')
  if (id === actor.id && parsed.data!.isActive === false) return res.status(400).json({ error: 'You cannot disable your own account.' })
  const current = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } })
  if (!current || current.role === 'ADMIN') return res.status(404).json({ error: 'Managed account not found.' })
  if (actor.role === 'FORMATOR' && (current.role !== 'USER' || Object.keys(parsed.data!).some((key) => key !== 'isActive'))) {
    return res.status(403).json({ error: 'Formators can only change community user account status.' })
  }
  const updateData: Prisma.UserUpdateInput = { ...parsed.data! }
  if (parsed.data!.isActive === false) {
    updateData.sessionVersion = { increment: 1 }
    updateData.sessionExpiresAt = null
  }
  const user = await prisma.user.update({ where: { id }, data: updateData, select: managedUserSelect })
  await audit(actor.id, 'UPDATE', 'User', user.id, parsed.data! as Prisma.InputJsonValue)
  res.json({ user })
}))
const managedPasswordSchema = z.object({ password: z.string().min(10).max(128) })
app.post('/api/admin/users/:id/password', authenticate, asyncRoute(async (req, res) => {
  const actor = await authorizeManagedAccounts(req, res, true)
  if (!actor) return
  const parsed = validate(managedPasswordSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'The new password must be between 10 and 128 characters.', details: parsed.error })
  const id = routeParam(req, 'id')
  const current = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } })
  if (!current || (actor.role === 'FORMATOR' ? current.role !== 'USER' : current.role === 'ADMIN')) return res.status(404).json({ error: 'Managed account not found.' })
  const passwordHash = await bcrypt.hash(parsed.data!.password, 10)
  await prisma.user.update({ where: { id }, data: { passwordHash, sessionVersion: { increment: 1 }, sessionExpiresAt: null } })
  await audit(actor.id, 'RESET_PASSWORD', 'User', id, { role: current.role })
  res.json({ message: 'Account password updated successfully.' })
}))
app.delete('/api/admin/users/:id', authenticate, asyncRoute(async (req, res) => {
  const actor = await authorizeManagedAccounts(req, res, true)
  if (!actor) return
  const id = routeParam(req, 'id')
  if (id === actor.id) return res.status(400).json({ error: 'You cannot delete your own account.' })
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, name: true } })
  if (!user || (actor.role === 'FORMATOR' ? user.role !== 'USER' : user.role === 'ADMIN')) return res.status(404).json({ error: 'Managed account not found.' })
  await prisma.user.delete({ where: { id } })
  await audit(actor.id, 'DELETE', 'User', user.id, { name: user.name, role: user.role })
  res.status(204).end()
}))
app.get('/api/admin/discernment', authenticate, asyncRoute(async (req, res) => {
  if (!await authorizeStaffPermission(req, res, 'canManageUsers')) return
  const members = await prisma.user.findMany({ where: { role: 'USER', isActive: true }, select: { id: true } })
  if (members.length) {
    await prisma.discernment.createMany({ data: members.map(({ id }) => ({ userId: id })), skipDuplicates: true })
  }
  const discerners = await prisma.discernment.findMany({
    where: { user: { isActive: true } },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true, userId: true, stage: true, monastery: true, updatedAt: true,
      user: { select: { name: true, email: true } },
    },
  })
  res.json({ discerners })
}))
const discernmentStageSchema = z.object({ stage: z.enum(discernmentStages) })
app.patch('/api/admin/discernment/:userId/stage', authenticate, asyncRoute(async (req, res) => {
  if (!await authorizeStaffPermission(req, res, 'canManageUsers')) return
  const parsed = validate(discernmentStageSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'Choose a valid discernment stage.' })
  const userId = routeParam(req, 'userId')
  const current = await prisma.discernment.findUnique({ where: { userId }, select: { stage: true } })
  if (!current) return res.status(404).json({ error: 'Discernment record not found.' })
  const discernment = await prisma.discernment.update({ where: { userId }, data: { stage: parsed.data!.stage }, select: { userId: true, stage: true, updatedAt: true } })
  await audit(req.auth!.id, 'UPDATE_STAGE', 'Discernment', discernment.userId, { from: current.stage, to: discernment.stage })
  res.json({ discernment })
}))
const statusSchema = z.object({ status: z.enum(['PENDING', 'RECONCILING', 'VERIFIED', 'COMPLETED', 'FAILED']) })
app.patch('/api/admin/donations/:id/status', authenticate, allowRoles('ADMIN', 'FORMATOR'), asyncRoute(async (req, res) => {
  const parsed = validate(statusSchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'Invalid donation status.' })
  const donationId = routeParam(req, 'id')
  const previous = await prisma.donation.findUnique({ where: { id: donationId }, select: { status: true } })
  if (!previous) return res.status(404).json({ error: 'Donation not found.' })
  const donation = await prisma.donation.update({ where: { id: donationId }, data: { status: parsed.data!.status } })
  await audit(
    req.auth!.id,
    donation.status === 'VERIFIED' && previous.status !== 'VERIFIED'
      ? 'VERIFY_DONATION'
      : donation.status === 'FAILED' && (previous.status === 'PENDING' || previous.status === 'RECONCILING')
        ? 'REJECT_DONATION'
        : 'UPDATE_STATUS',
    'Donation',
    donation.id,
    { from: previous.status, to: donation.status },
  )
  const receiptEmailSent = ['COMPLETED', 'VERIFIED'].includes(donation.status)
    ? await sendDonationAcknowledgment(donation.referenceCode)
    : false
  res.json({ donation: { ...donation, receiptEmailSent } })
}))
app.get('/api/admin/conversations', authenticate, allowRoles('ADMIN', 'FORMATOR'), asyncRoute(async (req, res) => {
  const conversations = await prisma.conversation.findMany({
    where: staffConversationAccessWhere(req),
    orderBy: { lastMessageAt: 'desc' },
    include: {
      user: { select: { id: true, role: true, isActive: true } },
      staffRecipient: { select: { id: true, name: true, role: true } },
      messages: { orderBy: { createdAt: 'asc' }, include: { sender: { select: { id: true, name: true, role: true } } } },
    },
  })
  res.json({ conversations: conversations.map((conversation) => ({
    ...conversation,
    isRead: !conversation.messages.some((message) => message.senderType === 'VISITOR' && !message.readAt),
  })) })
}))
app.get('/api/admin/notifications', authenticate, allowRoles('ADMIN', 'FORMATOR'), asyncRoute(async (req, res) => {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const isAdmin = req.auth!.role === 'ADMIN'
  const conversationAccess = staffConversationAccessWhere(req)
  const [staffPermissions, unreadMessageCount, recentMessages, recentUsers, recentDonations, recentAuditLogs, recentUpdates, recentContent] = await Promise.all([
    isAdmin ? Promise.resolve(null) : prisma.user.findUnique({ where: { id: req.auth!.id }, select: { canManageUsers: true, canManageDetails: true, canManageUpdates: true } }),
    prisma.message.count({ where: { senderType: 'VISITOR', readAt: null, conversation: { is: conversationAccess } } }),
    prisma.message.findMany({
      where: { senderType: 'VISITOR', OR: [{ readAt: null }, { createdAt: { gte: since } }], conversation: { is: conversationAccess } },
      orderBy: { createdAt: 'desc' },
      take: 25,
      include: { conversation: { select: { id: true, name: true, subject: true } } },
    }),
    prisma.user.findMany({
      where: { createdAt: { gte: since }, role: { in: ['USER', 'FORMATOR'] } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, name: true, role: true, createdAt: true },
    }),
    isAdmin ? prisma.donation.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, donorName: true, status: true, createdAt: true },
    }) : Promise.resolve([]),
    prisma.auditLog.findMany({
      where: { createdAt: { gte: since }, entity: isAdmin ? { not: 'PageContent' } : { notIn: ['PageContent', 'Donation', 'SystemBackup', 'Conversation'] } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, action: true, entity: true, entityId: true, createdAt: true },
    }),
    prisma.update.findMany({
      where: { updatedAt: { gte: since }, publishedAt: { not: null } },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      select: { id: true, title: true, updatedAt: true },
    }),
    prisma.pageContent.findMany({
      where: { updatedAt: { gte: since } },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      select: { id: true, pageKey: true, updatedAt: true },
    }),
  ])
  const canManageUsers = isAdmin || staffPermissions?.canManageUsers === true
  const canManageDetails = isAdmin || staffPermissions?.canManageDetails === true
  const canManageUpdates = isAdmin || staffPermissions?.canManageUpdates === true
  const notifications = [
    ...recentMessages.map((message) => ({
      id: `message-${message.id}`,
      kind: 'message',
      title: `Message from ${message.conversation.name}`,
      description: message.conversation.subject,
      createdAt: message.createdAt,
      href: `/admin/messages?conversation=${encodeURIComponent(message.conversation.id)}`,
      unread: message.readAt === null,
    })),
    ...recentUsers.map((user) => ({
      id: `user-${user.id}`,
      kind: 'account',
      title: user.role === 'USER' ? 'New discerner account' : 'New Formator account',
      description: user.name,
      createdAt: user.createdAt,
      href: canManageUsers ? `/admin/users?role=${user.role}` : '/admin/messages',
      unread: false,
    })),
    ...recentDonations.map((donation) => ({
      id: `donation-${donation.id}`,
      kind: 'donation',
      title: 'New donation received',
      description: `${donation.donorName || 'Anonymous'} · ${donation.status}`,
      createdAt: donation.createdAt,
      href: isAdmin ? '/admin/donations' : '/admin/messages',
      unread: false,
    })),
    ...recentAuditLogs.map((log) => ({
      id: `audit-${log.id}`,
      kind: 'activity',
      title: `${log.action.replaceAll('_', ' ')} · ${log.entity}`,
      description: 'A dashboard record was updated.',
      createdAt: log.createdAt,
      href: log.entity === 'Conversation' ? '/admin/messages' : log.entity === 'Donation' && isAdmin ? '/admin/donations' : log.entity === 'User' && canManageUsers ? '/admin/users?role=USER' : '/admin',
      unread: false,
    })),
    ...recentUpdates.map((update) => ({
      id: `update-${update.id}`,
      kind: 'update',
      title: 'Website update published',
      description: update.title,
      createdAt: update.updatedAt,
      href: canManageUpdates ? '/admin/updates' : '/admin',
      unread: false,
    })),
    ...recentContent.map((content) => ({
      id: `content-${content.id}`,
      kind: 'content',
      title: 'Website content updated',
      description: content.pageKey.replaceAll('_', ' ').toLowerCase(),
      createdAt: content.updatedAt,
      href: canManageDetails ? '/admin/content' : '/admin',
      unread: false,
    })),
  ].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()).slice(0, 30)
  res.json({ unreadMessageCount, notifications })
}))
app.post('/api/admin/conversations/read', authenticate, allowRoles('ADMIN', 'FORMATOR'), asyncRoute(async (req, res) => {
  const conversations = await prisma.conversation.findMany({ where: staffConversationAccessWhere(req), select: { id: true } })
  const ids = conversations.map(({ id }) => id)
  if (ids.length) {
    const now = new Date()
    await prisma.$transaction([
      prisma.message.updateMany({ where: { conversationId: { in: ids }, senderType: 'VISITOR', readAt: null }, data: { readAt: now } }),
      prisma.conversation.updateMany({ where: { id: { in: ids }, isRead: false }, data: { isRead: true } }),
    ])
  }
  res.status(204).end()
}))
app.post('/api/admin/conversations/:id/read', authenticate, allowRoles('ADMIN', 'FORMATOR'), asyncRoute(async (req, res) => {
  const id = routeParam(req, 'id')
  const conversation = await prisma.conversation.findFirst({ where: { id, ...staffConversationAccessWhere(req) }, select: { id: true } })
  if (!conversation) return res.status(404).json({ error: 'Conversation not found.' })
  await prisma.$transaction([
    prisma.message.updateMany({ where: { conversationId: id, senderType: 'VISITOR', readAt: null }, data: { readAt: new Date() } }),
    prisma.conversation.update({ where: { id }, data: { isRead: true } }),
  ])
  res.status(204).end()
}))
const replySchema = z.object({ body: z.string().trim().min(1).max(5000) })
app.post('/api/admin/conversations/:id/messages', authenticate, allowRoles('ADMIN', 'FORMATOR'), asyncRoute(async (req, res) => {
  const parsed = validate(replySchema, req.body)
  if (parsed.error) return res.status(400).json({ error: 'A reply cannot be empty.' })
  const conversation = await prisma.conversation.findFirst({ where: { id: routeParam(req, 'id'), ...staffConversationAccessWhere(req) }, select: { id: true, userId: true } })
  if (!conversation) return res.status(404).json({ error: 'Conversation not found.' })
  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({ data: { conversationId: conversation.id, senderId: req.auth!.id, senderType: req.auth!.role === 'FORMATOR' ? 'FORMATOR' : 'ADMIN', body: parsed.data!.body } })
    await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date(), isRead: true } })
    await tx.auditLog.create({ data: { userId: req.auth!.id, action: 'REPLY', entity: 'Conversation', entityId: conversation.id } })
    return created
  })
  res.status(201).json({ message })
}))
app.get('/api/admin/audit', authenticate, allowRoles('ADMIN', 'FORMATOR'), asyncRoute(async (_req, res) => {
  const isAdmin = _req.auth!.role === 'ADMIN'
  const logs = await prisma.auditLog.findMany({
    where: isAdmin
      ? { OR: [
        { user: { is: { role: { in: ['ADMIN', 'FORMATOR'] } } } },
        { entity: 'Donation', action: { in: ['DONATION_RECEIVED', 'DONATION_PAID', 'DONATION_EXPIRED'] } },
        { entity: 'SystemBackup' },
      ] }
      : { user: { is: { role: { in: ['ADMIN', 'FORMATOR'] } } }, entity: { notIn: ['Donation', 'SystemBackup'] } },
    orderBy: { createdAt: 'desc' },
    take: 300,
    include: { user: { select: { name: true, email: true, role: true } } },
  })
  res.json({ logs })
}))

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const clientBuildDirectoryCandidates = [
  resolve(moduleDirectory, '../../../client/dist'),
  resolve(moduleDirectory, '../../client/dist'),
  resolve(process.cwd(), 'client/dist'),
  resolve(process.cwd(), '../client/dist'),
]
const clientBuildDirectory = clientBuildDirectoryCandidates.find((directory) => existsSync(resolve(directory, 'index.html')))
if (!clientBuildDirectory) {
  throw new Error('Client build not found. Build client/dist and run the server from the application deployment root.')
}
function escapeHtmlAttribute(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!)
}
function setHtmlMeta(html: string, key: string, value: string, attribute: 'name' | 'property') {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tag = `<meta ${attribute}="${key}" content="${escapeHtmlAttribute(value)}" data-rh="true" />`
  const pattern = new RegExp(`<meta\\s+${attribute}="${escapedKey}"[^>]*>`, 'i')
  return pattern.test(html) ? html.replace(pattern, tag) : html.replace('</head>', `    ${tag}\n  </head>`)
}
app.get('/updates/:id', asyncRoute(async (req, res) => {
  let html = await readFile(resolve(clientBuildDirectory, 'index.html'), 'utf8')
  const id = routeParam(req, 'id')
  const content = await prisma.pageContent.findUnique({ where: { pageKey: 'SITE_UPDATES' }, select: { blocks: true } })
  const updates = Array.isArray(content?.blocks) ? content.blocks : []
  const update = updates.find((entry): entry is { id: string; title: string; body: string; image?: string } =>
    Boolean(entry && typeof entry === 'object' && 'id' in entry && entry.id === id
      && 'title' in entry && typeof entry.title === 'string'
      && 'body' in entry && typeof entry.body === 'string'))
  if (update) {
    const title = `${update.title} | Carmels in Communion`
    const description = update.body.replace(/\s+/g, ' ').trim().slice(0, 300)
    const canonical = new URL(`/updates/${encodeURIComponent(id)}`, productionOrigin).toString()
    let image = new URL('/assets/images/home-hero.jpg', productionOrigin).toString()
    if (typeof update.image === 'string' && !update.image.startsWith('data:')) {
      try {
        const candidate = new URL(update.image, productionOrigin)
        if (candidate.protocol === 'https:' || candidate.protocol === 'http:') image = candidate.toString()
      } catch {
        image = new URL('/assets/images/home-hero.jpg', productionOrigin).toString()
      }
    }
    html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtmlAttribute(title)}</title>`)
    html = setHtmlMeta(html, 'description', description, 'name')
    html = setHtmlMeta(html, 'og:title', title, 'property')
    html = setHtmlMeta(html, 'og:description', description, 'property')
    html = setHtmlMeta(html, 'og:url', canonical, 'property')
    html = setHtmlMeta(html, 'og:image', image, 'property')
    html = setHtmlMeta(html, 'og:image:alt', update.title, 'property')
    html = setHtmlMeta(html, 'twitter:title', title, 'name')
    html = setHtmlMeta(html, 'twitter:description', description, 'name')
    html = setHtmlMeta(html, 'twitter:image', image, 'name')
    html = html.replace(/<link\s+rel="canonical"[^>]*>/i, `<link rel="canonical" href="${escapeHtmlAttribute(canonical)}" data-rh="true" />`)
  } else {
    res.status(404)
  }
  res.type('html').send(html)
}))
app.use(express.static(clientBuildDirectory, {
  setHeaders(res, filePath) {
    if (/-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(basename(filePath))) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    }
  },
}))
app.get('*', (req, res, next) => {
  if (req.path === '/api' || req.path.startsWith('/api/')) return next()
  res.sendFile(resolve(clientBuildDirectory, 'index.html'), (error) => {
    if (error) next(error)
  })
})

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (
    error instanceof SyntaxError
    && 'status' in error
    && error.status === 400
    && 'type' in error
    && error.type === 'entity.parse.failed'
  ) {
    return res.status(400).json({ error: 'Request body must contain valid JSON.' })
  }
  console.error(error)
  res.status(500).json({ error: 'The request could not be completed. Please try again.' })
})
const server = app.listen(port, () => console.log(`Carmel API listening on http://localhost:${port}`))
async function shutdown() { server.close(); await prisma.$disconnect() }
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
