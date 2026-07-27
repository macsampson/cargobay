import { PrismaClient } from '@prisma/client'
import { put } from '@vercel/blob'

const prisma = new PrismaClient()

const CLOUDINARY_PREFIX = 'https://res.cloudinary.com/'

// Defaults to a dry run — logs what would be migrated without touching Blob
// or the database. Pass --write to actually upload and update rows.
const WRITE = process.argv.includes('--write')

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

function extensionFor(contentType: string | null, sourceUrl: string): string {
  if (contentType && CONTENT_TYPE_EXTENSIONS[contentType]) {
    return CONTENT_TYPE_EXTENSIONS[contentType]
  }
  const fromUrl = sourceUrl.split('.').pop()?.split(/[?#]/)[0]
  return fromUrl && fromUrl.length <= 4 ? fromUrl : 'jpg'
}

// Re-hosts one Cloudinary URL on Vercel Blob and returns the new URL.
// addRandomSuffix: false + allowOverwrite: true keeps this idempotent —
// re-running after a partial failure reuses the same blob path instead of
// piling up duplicates (same convention as prisma/seed-demo.ts).
async function migrateOne(blobPath: string, sourceUrl: string): Promise<string> {
  const response = await fetch(sourceUrl)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${sourceUrl}: ${response.status}`)
  }
  const contentType = response.headers.get('content-type')
  const buffer = Buffer.from(await response.arrayBuffer())
  const ext = extensionFor(contentType, sourceUrl)

  const blob = await put(`${blobPath}.${ext}`, buffer, {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: contentType || undefined,
    // Force the static token instead of letting the SDK auto-prefer OIDC:
    // `vercel env pull` always writes VERCEL_ENV=development for local pulls
    // regardless of which environment's values were fetched, and if OIDC is
    // enabled for the project but not for "development", auto-detected OIDC
    // auth fails even though BLOB_READ_WRITE_TOKEN is valid and present.
    token: process.env.BLOB_READ_WRITE_TOKEN
  })

  return blob.url
}

interface MigrationTarget {
  label: string
  blobFolder: string
  findRows: () => Promise<{ id: string; url: string }[]>
  updateRow: (id: string, url: string) => Promise<unknown>
}

const targets: MigrationTarget[] = [
  {
    label: 'Image (product images)',
    blobFolder: 'migrated/image',
    findRows: async () =>
      prisma.image.findMany({
        where: { url: { startsWith: CLOUDINARY_PREFIX } },
        select: { id: true, url: true }
      }),
    updateRow: (id, url) => prisma.image.update({ where: { id }, data: { url } })
  },
  {
    label: 'Billboard',
    blobFolder: 'migrated/billboard',
    findRows: async () =>
      (
        await prisma.billboard.findMany({
          where: { imageUrl: { startsWith: CLOUDINARY_PREFIX } },
          select: { id: true, imageUrl: true }
        })
      ).map((row) => ({ id: row.id, url: row.imageUrl })),
    updateRow: (id, url) => prisma.billboard.update({ where: { id }, data: { imageUrl: url } })
  },
  {
    label: 'CarouselImage',
    blobFolder: 'migrated/carousel-image',
    findRows: async () =>
      (
        await prisma.carouselImage.findMany({
          where: { imageUrl: { startsWith: CLOUDINARY_PREFIX } },
          select: { id: true, imageUrl: true }
        })
      ).map((row) => ({ id: row.id, url: row.imageUrl })),
    updateRow: (id, url) => prisma.carouselImage.update({ where: { id }, data: { imageUrl: url } })
  }
]

async function main() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('BLOB_READ_WRITE_TOKEN is not set — nothing to migrate to. Aborting.')
    process.exitCode = 1
    return
  }

  console.log(WRITE ? 'Running in WRITE mode.' : 'Running in DRY-RUN mode (pass --write to apply changes).')
  console.log('')

  let totalFound = 0
  let totalMigrated = 0
  let totalFailed = 0

  for (const target of targets) {
    const rows = await target.findRows()
    totalFound += rows.length
    console.log(`${target.label}: ${rows.length} row(s) on Cloudinary`)

    for (const row of rows) {
      if (!WRITE) {
        console.log(`  [dry run] would migrate ${row.id} <- ${row.url}`)
        continue
      }

      try {
        const newUrl = await migrateOne(`${target.blobFolder}/${row.id}`, row.url)
        await target.updateRow(row.id, newUrl)
        totalMigrated += 1
        console.log(`  migrated ${row.id}: ${row.url} -> ${newUrl}`)
      } catch (error) {
        totalFailed += 1
        console.error(`  FAILED ${row.id} (${row.url}):`, error)
      }
    }
  }

  console.log('')
  console.log(`Done. Found ${totalFound} Cloudinary URL(s).`)
  if (WRITE) {
    console.log(`Migrated ${totalMigrated}, failed ${totalFailed}.`)
    if (totalFailed > 0) {
      console.log('Re-run the script (safe/idempotent) to retry only the rows still on Cloudinary.')
    }
  } else {
    console.log('Re-run with --write to actually migrate.')
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
