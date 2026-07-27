import prismadb from "@/lib/prismadb"
import { isAuthenticated } from '@/lib/auth'
import { NextResponse } from "next/server"
import { logger } from '@/lib/logger'
import axios from 'axios'

const REVALIDATE_URL = process.env.FRONTEND_STORE_URL + '/api/revalidate'

// Don't await this - let it run in the background. Mirrors the same
// fire-and-forget pattern in products/[productId]/route.ts.
function revalidateBillboards() {
  if (!process.env.FRONTEND_STORE_URL || !process.env.REVALIDATE_TOKEN) return

  axios.post(
    REVALIDATE_URL,
    { tag: 'billboards' },
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

export async function GET(req: Request, props: { params: Promise<{ billboardId: string }> }) {
  const params = await props.params;
  try {
    const billboard = await prismadb.billboard.findUnique({
      where: {
        id: params.billboardId,
      },
    })

    return NextResponse.json(billboard)
  } catch (error) {
    logger.info("[BILLBOARD_GET]", error)
    return new NextResponse("Internal Server Error", { status: 500 })
  }
}

export async function PATCH(
  req: Request,
  props: { params: Promise<{ billboardId: string; storeId: string }> }
) {
  const params = await props.params;
  try {
    const authenticated = await isAuthenticated()
    const body = await req.json()

    const { label, imageUrl, landingPage } = body

    if (!authenticated) return new NextResponse("Unauthenticated", { status: 401 })

    // if (!label) return new NextResponse("Label is required", { status: 400 })

    if (!imageUrl)
      return new NextResponse("Image URL is required", { status: 400 })

    if (!params.billboardId)
      return new NextResponse("Store ID is required", { status: 400 })

    const storeWithUserId = await prismadb.store.findFirst({
      where: {
        id: params.storeId,
        userId: "single-user",
      },
    })

    if (!storeWithUserId) {
      return new NextResponse("Unauthorized", { status: 403 })
    }

    // const billboard = await prismadb.billboard.updateMany({
    //   where: {
    //     id: params.billboardId,
    //   },
    //   data: {
    //     label,
    //     imageUrl,
    //     landingPage,
    //   },
    // })

    const operations: any[] = []

    if (landingPage) {
      operations.push(
        prismadb.billboard.updateMany({
          where: {
            landingPage: true,
          },
          data: {
            landingPage: false,
          },
        })
      )
    }

    operations.push(
      prismadb.billboard.updateMany({
        where: {
          id: params.billboardId,
        },
        data: {
          label,
          imageUrl,
          landingPage,
        },
      })
    )

    const billboard = await prismadb.$transaction(operations)

    revalidateBillboards()

    return NextResponse.json(billboard)
  } catch (error) {
    logger.info("[BILLBOARD_PATCH]", error)
    return new NextResponse("Internal Server Error", { status: 500 })
  }
}

export async function DELETE(
  req: Request,
  props: { params: Promise<{ storeId: string; billboardId: string }> }
) {
  const params = await props.params;
  try {
    const authenticated = await isAuthenticated()

    if (!authenticated) return new NextResponse("Unauthenticated", { status: 401 })

    if (!params.billboardId)
      return new NextResponse("Billboard ID is required", { status: 400 })

    const storeWithUserId = await prismadb.store.findFirst({
      where: {
        id: params.storeId,
        userId: "single-user",
      },
    })

    if (!storeWithUserId) {
      return new NextResponse("Unauthorized", { status: 403 })
    }

    const billboard = await prismadb.billboard.deleteMany({
      where: {
        id: params.billboardId,
      },
    })

    revalidateBillboards()

    return NextResponse.json(billboard)
  } catch (error) {
    logger.info("[BILLBOARD_DELETE]", error)
    return new NextResponse("Internal Server Error", { status: 500 })
  }
}
