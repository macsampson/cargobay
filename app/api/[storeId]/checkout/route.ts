import { NextResponse } from 'next/server'
import { stripe } from '@/lib/stripe'
import prismadb from '@/lib/prismadb'
import { logger } from '@/lib/logger'
import { rateLimit, getClientIp } from '@/lib/rate-limit'
import { calculateAuthoritativeUnitPrice, type AppliedDiscount, type BundleTier } from '@/lib/pricing'
import type { SaleInfo } from '@/lib/utils'

// The client sends only identity + quantity — price, name, and every other
// display field are looked up server-side so a manipulated request can't
// change what gets charged. See lib/pricing.ts for the discount resolution.
interface CartLineRequest {
  productId: string
  variationId?: string
  quantity: number
}

interface ShippingType {
  id: string
  title: string
  rate: number
}

interface ShippingAddress {
  street: string
  city: string
  state: string
  zipCode: string
  country: string
}

// CORS headers (Access-Control-Allow-*) are added by middleware.ts, which echoes
// back the request's Origin only if it's in ALLOWED_ORIGINS — do not set a
// wildcard here, it would bypass that origin restriction.
export async function OPTIONS() {
  return NextResponse.json({})
}

export async function POST(req: Request, props: { params: Promise<{ storeId: string }> }) {
  const params = await props.params;
  try {
    const ip = getClientIp(req)
    const { allowed } = rateLimit(`checkout:${ip}`, 20, 60_000)

    if (!allowed) {
      return new NextResponse('Too many requests. Please try again shortly.', {
        status: 429
      })
    }

    const { storeId } = params
    const body = await req.json()
    const {
      cartItems,
      shippingType,
      shippingAddress,
      currency
    }: {
      cartItems: CartLineRequest[]
      shippingType?: ShippingType
      shippingAddress: ShippingAddress
      currency: string
    } = body

    if (!Array.isArray(cartItems) || cartItems.length === 0) {
      return new NextResponse('Cart items are required', { status: 400 })
    }

    if (!shippingAddress) {
      return new NextResponse('Shipping address is required', { status: 400 })
    }

    // Verify store exists
    const store = await prismadb.store.findUnique({
      where: {
        id: storeId,
        userId: 'single-user'
      }
    })

    if (!store) {
      return new NextResponse('Store not found', { status: 404 })
    }

    // Batched lookups — one round trip regardless of cart size.
    const productIds = Array.from(new Set(cartItems.map((item) => item.productId)))
    const now = new Date()

    const [products, activeSales] = await Promise.all([
      prismadb.product.findMany({
        where: { id: { in: productIds }, storeId },
        include: { bundles: true, variations: true, category: true }
      }),
      prismadb.sale.findMany({
        where: { storeId, isActive: true, startDate: { lte: now }, endDate: { gte: now } },
        include: { products: { select: { productId: true } } }
      })
    ])
    const productById = new Map(products.map((p) => [p.id, p]))

    const computedLines: Array<{
      productId: string
      variationId: string | null
      quantity: number
      name: string
      category: string
      weight: number
      unitPriceInCents: number
      discount: AppliedDiscount
    }> = []

    for (const item of cartItems) {
      const quantity = typeof item.quantity === 'number' ? item.quantity : parseInt(String(item.quantity))
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return new NextResponse(`Invalid quantity for product ${item.productId}`, { status: 400 })
      }

      const product = productById.get(item.productId)
      if (!product || product.isArchived) {
        return new NextResponse(`Product ${item.productId} is not available`, { status: 400 })
      }

      let variation = null
      if (item.variationId) {
        variation = product.variations.find((v) => v.id === item.variationId) ?? null
        if (!variation) {
          return new NextResponse(`Variation ${item.variationId} not found for product ${item.productId}`, {
            status: 400
          })
        }
      }

      const baseUnitPriceInCents = variation ? variation.priceInCents : product.priceInCents

      const bundleTiers: BundleTier[] = product.bundles.map((b) => ({
        id: b.id,
        minQuantity: b.minQuantity,
        discountPercentage: b.discountPercentage
      }))

      // Sold-out products never get a sale applied, matching the display-route rule
      // in app/api/[storeId]/products/[productId]/route.ts.
      let applicableSales: SaleInfo[] = []
      if (product.quantity !== 0) {
        const productSpecificSales = activeSales.filter(
          (sale) => !sale.isStoreWide && sale.products.some((sp) => sp.productId === product.id)
        )
        const storeWideSales = activeSales.filter((sale) => sale.isStoreWide)
        applicableSales = [...productSpecificSales, ...storeWideSales].map((sale) => ({
          id: sale.id,
          name: sale.name,
          percentage: sale.percentage,
          startDate: sale.startDate,
          endDate: sale.endDate,
          isActive: sale.isActive,
          isStoreWide: sale.isStoreWide
        }))
      }

      const { unitPriceInCents, discount } = calculateAuthoritativeUnitPrice(
        baseUnitPriceInCents,
        quantity,
        bundleTiers,
        applicableSales
      )

      computedLines.push({
        productId: product.id,
        variationId: variation?.id ?? null,
        quantity,
        name: variation ? `${product.name} - ${variation.name}` : product.name,
        category: product.category?.name ?? '',
        weight: Number(product.weight),
        unitPriceInCents,
        discount
      })
    }

    // Create line items for Stripe checkout
    const line_items: Array<{
      price_data: {
        currency: string
        product_data: {
          name: string
          metadata: Record<string, string>
        }
        unit_amount: number
      }
      quantity: number
    }> = computedLines.map((line) => ({
      price_data: {
        currency: currency.toLowerCase(),
        product_data: {
          name: line.name,
          metadata: {
            productId: line.productId,
            variationId: line.variationId ?? '',
            category: line.category,
            weight: line.weight.toString()
          }
        },
        unit_amount: line.unitPriceInCents
      },
      quantity: line.quantity
    }))

    // Add shipping as a line item if there's a cost
    if (shippingType && shippingType.rate > 0) {
      const shippingRate =
        typeof shippingType.rate === 'number'
          ? shippingType.rate
          : parseFloat(shippingType.rate)

      if (!isNaN(shippingRate) && shippingRate > 0) {
        line_items.push({
          price_data: {
            currency: currency.toLowerCase(),
            product_data: {
              name: `Shipping - ${shippingType.title}`,
              metadata: {
                shippingId: shippingType.id,
                shippingTitle: shippingType.title
              }
            },
            unit_amount: Math.round(shippingRate * 100) // Convert dollars to cents
          },
          quantity: 1
        })
      }
    }

    // Ensure we have valid line items
    if (line_items.length === 0) {
      return new NextResponse('No valid items to checkout', { status: 400 })
    }

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      line_items,
      mode: 'payment',
      billing_address_collection: 'required',
      phone_number_collection: {
        enabled: true
      },
      customer_creation: 'always',
      success_url: `${process.env.FRONTEND_STORE_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_STORE_URL}/cart`,
      metadata: {
        storeId,
        shippingAddress: JSON.stringify(shippingAddress),
        shippingType: JSON.stringify(shippingType),
        currency,
        // Authoritative values computed server-side — the webhook persists these
        // verbatim rather than recomputing, since Stripe already locked in
        // payment at this price. See app/api/webhook/route.ts.
        cartItems: JSON.stringify(
          computedLines.map((line) => ({
            productId: line.productId,
            variationId: line.variationId,
            quantity: line.quantity,
            name: line.name,
            weight: line.weight,
            unitPriceInCents: line.unitPriceInCents,
            discountType: line.discount.type,
            discountId: line.discount.type === 'none' ? null : line.discount.id
          }))
        )
      }
    })

    return NextResponse.json({ url: session.url })
  } catch (error: any) {
    logger.info('[CHECKOUT_POST]', error)
    return new NextResponse('Internal error', { status: 500 })
  }
}
