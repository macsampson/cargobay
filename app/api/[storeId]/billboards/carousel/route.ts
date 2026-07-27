import prismadb from '@/lib/prismadb'
import { NextResponse } from 'next/server'

import { isAuthenticated } from '@/lib/auth'
import { CarouselImage } from '@prisma/client'
import { logger } from '@/lib/logger'
import axios from 'axios'

const REVALIDATE_URL = process.env.FRONTEND_STORE_URL + '/api/revalidate'

// Don't await this - let it run in the background. Mirrors the same
// fire-and-forget pattern in products/[productId]/route.ts.
function revalidateCarousel() {
  if (!process.env.FRONTEND_STORE_URL || !process.env.REVALIDATE_TOKEN) return

  axios.post(
    REVALIDATE_URL,
    { tag: 'carousel' },
    {
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.REVALIDATE_TOKEN}`
      }
    }
  ).catch(() => {
    // Silently ignore revalidation failures - the frontend will eventually sync on next request
  })
}

export async function GET(req: Request, props: { params: Promise<{ storeId: string }> }) {
  const params = await props.params;
  try {
    if (!params.storeId) {
      return new NextResponse('Store ID is required', { status: 400 })
    }

    const carouselImages = await prismadb.carouselImage.findMany({
      where: {
        storeId: params.storeId
      }
    })

    return NextResponse.json(carouselImages)
  } catch (error) {
    logger.info('[CAROUSEL_IMAGES_GET]', error)
    return new NextResponse('Internal Server Error', { status: 500 })
  }
}

export async function POST(req: Request, props: { params: Promise<{ storeId: string }> }) {
  const params = await props.params;
  try {
    const authenticated = await isAuthenticated()
    const body = await req.json()

    const { images } = body
    // logger.info("image urls: ", images)

    if (!authenticated) return new NextResponse('Unauthenticated', { status: 401 })

    if (!images)
      return new NextResponse('Image URL is required', { status: 400 })

    await prismadb.carouselImage.deleteMany({
      where: {
        storeId: params.storeId
      }
    })

    // create many carousel images
    const carouselImages = await prismadb.carouselImage.createMany({
      data: images.map((image: CarouselImage) => ({
        imageUrl: image.imageUrl,
        storeId: params.storeId,
        imageCredit: image.imageCredit
      }))
    })

    revalidateCarousel()

    return NextResponse.json(carouselImages)
  } catch (error) {
    logger.info('[CAROUSEL_IMAGES_POST]', error)
    return new NextResponse('Internal Server Error', { status: 500 })
  }
}

export async function PATCH(req: Request, props: { params: Promise<{ storeId: string }> }) {
  const params = await props.params;
  try {
    const authenticated = await isAuthenticated()
    const body = await req.json()

    const { images } = body
    // logger.info("image urls: ", images)

    if (!authenticated) return new NextResponse('Unauthenticated', { status: 401 })

    if (!images)
      return new NextResponse('Image URL is required', { status: 400 })

    // delete all carousel images
    await prismadb.carouselImage.deleteMany({
      where: {
        storeId: params.storeId
      }
    })

    // create many carousel images with imageUrl and storeId
    const carouselImages = await prismadb.carouselImage.createMany({
      data: images.map((image: CarouselImage) => ({
        imageUrl: image.imageUrl,
        storeId: params.storeId,
        imageCredit: image.imageCredit
      }))
    })

    revalidateCarousel()

    return NextResponse.json(carouselImages)
  } catch (error) {
    logger.info('[CAROUSEL_IMAGES_PATCH]', error)
    return new NextResponse('Internal Server Error', { status: 500 })
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders })
}
