/**  @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['pino', 'pino-pretty'],

  // Vercel injects BLOB_READ_WRITE_TOKEN server-side only; mirror its presence
  // into a NEXT_PUBLIC_ var at build time so the (client) image-upload component
  // can tell whether a Blob store is provisioned without exposing the token itself.
  env: {
    NEXT_PUBLIC_BLOB_ENABLED: process.env.BLOB_READ_WRITE_TOKEN ? 'true' : 'false'
  },

  async headers() {
    // Read the ALLOWED_ORIGINS environment variable and convert it to an array
    const allowedOrigins = process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',')
      : []

    // Create the Access-Control-Allow-Origin headers
    const corsHeaders = allowedOrigins.map((origin) => ({
      key: 'Access-Control-Allow-Origin',
      value: origin
    }))

    return [
      {
        // matching all API routes
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Credentials', value: 'true' },
          ...corsHeaders, // Include the dynamically created CORS headers
          {
            key: 'Access-Control-Allow-Methods',
            value: 'GET,DELETE,PATCH,POST,PUT'
          },
          {
            key: 'Access-Control-Allow-Headers',
            value:
              'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
          }
        ]
      }
    ]
  },

  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.public.blob.vercel-storage.com'
      },
      {
        // Demo seed data hotlinks these directly when no Blob store is configured
        // (see resolveDemoImageUrl in prisma/seed-demo.ts) — not used for real
        // store uploads.
        protocol: 'https',
        hostname: 'images.unsplash.com'
      }
    ]
  }
}

module.exports = nextConfig
