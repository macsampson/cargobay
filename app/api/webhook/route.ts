import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import Stripe from 'stripe'

import { stripe } from '@/lib/stripe'
import prismadb from '@/lib/prismadb'
import { logger } from '@/lib/logger'

// Matches the compact, server-computed shape checkout/route.ts writes into
// session.metadata.cartItems. unitPriceInCents was resolved from bundle/sale
// rules at checkout time and is persisted verbatim here — never recomputed,
// since Stripe already collected payment at that price and the underlying
// bundle/sale rules may have changed by the time this webhook fires.
interface CartItemMeta {
  productId: string
  variationId: string | null
  quantity: number
  name: string
  weight: number
  unitPriceInCents: number
  discountType: 'bundle' | 'sale' | 'none'
  discountId: string | null
}

export interface Address {
  email: string
  firstName: string
  lastName: string
  street: string
  apartment?: string
  city: string
  state: string
  zip: string
  country: string
  phone?: string
}

export async function POST(req: Request) {
  const body = await req.text()
  const signature = (await headers()).get('Stripe-Signature') as string

  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    )
  } catch (error: any) {
    return new NextResponse(`Webhook Error: ${error.message}`, { status: 400 })
  }

  const session = event.data.object as Stripe.Checkout.Session

  if (event.type === 'checkout.session.completed') {
    logger.info('Processing checkout.session.completed webhook', session.id)

    if (!session?.metadata?.storeId) {
      logger.error('No store ID in session metadata')
      return new NextResponse('Store ID is required', { status: 400 })
    }

    // Stripe may redeliver the same event (e.g. on a timeout or retry), so
    // record it before doing any work and bail out if we've already processed it.
    // Otherwise a redelivered event would create a duplicate order and double-decrement inventory.
    try {
      await prismadb.processedWebhookEvent.create({
        data: { stripeEventId: event.id }
      })
    } catch (error: any) {
      if (error?.code === 'P2002') {
        logger.info('Ignoring already-processed webhook event', event.id)
        return new NextResponse(null, { status: 200 })
      }
      throw error
    }

    try {
      const storeId = session.metadata.storeId
      const shippingAddress: Address = JSON.parse(
        session.metadata.shippingAddress || '{}'
      )
      const shippingType = JSON.parse(session.metadata.shippingType || '{}')
      const currency = session.metadata.currency || 'usd'
      const cartItems: CartItemMeta[] = JSON.parse(
        session.metadata.cartItems || '[]'
      )

      logger.info('Processing order for store:', storeId)
      logger.info('Cart items:', cartItems.length)
      logger.info('Shipping method:', shippingType.title || 'None')
      logger.info('Currency:', currency.toUpperCase())

      // Calculate total price in cents from session
      const totalPriceInCents = Math.round(session.amount_total || 0)

      // Batched lookups — one round trip each, regardless of cart size — to
      // confirm each product/variation still exists before writing order items
      // and to know which rows need their inventory decremented.
      const productIds = Array.from(new Set(cartItems.map((item) => item.productId)))
      const variationIds = Array.from(
        new Set(cartItems.filter((item) => item.variationId).map((item) => item.variationId as string))
      )

      const [products, variations] = await Promise.all([
        prismadb.product.findMany({ where: { id: { in: productIds }, storeId } }),
        variationIds.length > 0
          ? prismadb.productVariation.findMany({ where: { id: { in: variationIds } } })
          : Promise.resolve([])
      ])
      const productById = new Map(products.map((p) => [p.id, p]))
      const variationById = new Map(variations.map((v) => [v.id, v]))

      const validItems = cartItems.filter((item) => {
        if (!productById.has(item.productId)) return false
        if (item.variationId && !variationById.has(item.variationId)) return false
        return true
      })

      const order = await prismadb.$transaction(async (tx) => {
        const order = await tx.order.create({
          data: {
            storeId,
            isPaid: true,
            phoneNumber: session?.customer_details?.phone || shippingAddress.phone || '',
            emailAddress: session?.customer_details?.email || shippingAddress.email || '',
            customerName: session?.customer_details?.name || `${shippingAddress.firstName || ''} ${shippingAddress.lastName || ''}`.trim(),
            billingAddress: session.customer_details?.address ?
              `${session.customer_details.address.line1 || ''} ${session.customer_details.address.line2 || ''}, ${session.customer_details.address.city || ''}, ${session.customer_details.address.state || ''} ${session.customer_details.address.postal_code || ''}, ${session.customer_details.address.country || ''}`.trim()
              : '',
            shippingAddress: `${shippingAddress.street || ''} ${
              shippingAddress.apartment || ''
            }, ${shippingAddress.city || ''}, ${shippingAddress.state || ''} ${
              shippingAddress.zip || ''
            }, ${shippingAddress.country || ''}`.trim(),
            totalPriceInCents
          }
        })

        if (validItems.length > 0) {
          await tx.orderItem.createMany({
            data: validItems.map((item) => ({
              orderId: order.id,
              productId: item.productId,
              productVariationId: item.variationId,
              quantity: item.quantity,
              priceInCents: item.unitPriceInCents,
              name: item.name,
              weight: item.weight || 0
            }))
          })
        }

        // Reduce inventory as a single atomic, clamped UPDATE per row (rather
        // than reading quantity and writing Math.max(0, ...) back) so two
        // concurrent webhook deliveries for different orders can't both read
        // the same quantity and both decrement from it, over-selling stock.
        // Quantities are aggregated per product/variation first in case a cart
        // ever contains more than one line for the same one.
        const productQuantities = new Map<string, number>()
        const variationQuantities = new Map<string, number>()
        for (const item of validItems) {
          if (item.variationId) {
            variationQuantities.set(item.variationId, (variationQuantities.get(item.variationId) || 0) + item.quantity)
          } else {
            productQuantities.set(item.productId, (productQuantities.get(item.productId) || 0) + item.quantity)
          }
        }

        for (const [productId, quantity] of Array.from(productQuantities)) {
          await tx.$executeRawUnsafe(
            'UPDATE product SET quantity = GREATEST(quantity - $1, 0) WHERE id = $2',
            quantity,
            productId
          )
        }
        for (const [variationId, quantity] of Array.from(variationQuantities)) {
          await tx.$executeRawUnsafe(
            'UPDATE product_variation SET quantity = GREATEST(quantity - $1, 0) WHERE id = $2',
            quantity,
            variationId
          )
        }

        return order
      })

      // Customer info is stored in the order itself, no separate customer table

      logger.info('Order created successfully:', order.id)
    } catch (error) {
      logger.error('Error processing webhook:', error)
      return new NextResponse('Error processing order', { status: 500 })
    }
  }

  return new NextResponse(null, { status: 200 })
}
