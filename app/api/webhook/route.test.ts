import { POST } from './route'
import prismadb from '@/lib/prismadb'
import { stripe } from '@/lib/stripe'
import { headers } from 'next/headers'
import { logger } from '@/lib/logger'

jest.mock('@/lib/stripe', () => ({
  stripe: {
    webhooks: {
      constructEvent: jest.fn()
    }
  }
}))

jest.mock('next/headers', () => ({
  headers: jest.fn()
}))

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }
}))

const constructEventMock = stripe.webhooks.constructEvent as jest.Mock
const prismaMock = prismadb as any
const loggerErrorMock = logger.error as jest.Mock

function makeRequest(body: string) {
  return new Request('http://localhost/api/webhook', { method: 'POST', body })
}

describe('POST /api/webhook', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    ;(headers as jest.Mock).mockReturnValue({
      get: jest.fn(() => 'test-signature')
    })
    prismaMock.processedWebhookEvent.create.mockResolvedValue({
      id: 'pwe-1',
      stripeEventId: 'evt_1',
      createdAt: new Date()
    })
    prismaMock.product.findMany.mockResolvedValue([])
    prismaMock.productVariation.findMany.mockResolvedValue([])
    prismaMock.$transaction.mockImplementation((cb: any) => cb(prismaMock))
  })

  it('rejects requests with an invalid Stripe signature', async () => {
    constructEventMock.mockImplementation(() => {
      throw new Error('invalid signature')
    })

    const response = await POST(makeRequest('{}'))

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Webhook Error')
  })

  it('rejects a completed checkout session with no storeId in metadata', async () => {
    constructEventMock.mockReturnValue({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: { object: { id: 'sess_1', metadata: {} } }
    })

    const response = await POST(makeRequest('{}'))

    expect(response.status).toBe(400)
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('creates an order and order items, and decrements inventory, on a completed checkout session', async () => {
    const cartItems = [
      {
        productId: 'product-1',
        variationId: null,
        quantity: 2,
        name: 'Widget',
        weight: 1,
        unitPriceInCents: 1500,
        discountType: 'none',
        discountId: null
      }
    ]

    constructEventMock.mockReturnValue({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'sess_1',
          amount_total: 3000,
          customer_details: {
            email: 'buyer@example.com',
            name: 'Buyer Name',
            phone: '555-1234',
            address: {
              line1: '123 Main St',
              city: 'Springfield',
              state: 'IL',
              postal_code: '62701',
              country: 'US'
            }
          },
          metadata: {
            storeId: 'store-1',
            shippingAddress: JSON.stringify({
              email: 'buyer@example.com',
              firstName: 'Buyer',
              lastName: 'Name',
              street: '123 Main St',
              city: 'Springfield',
              state: 'IL',
              zip: '62701',
              country: 'US'
            }),
            shippingType: JSON.stringify({ title: 'Standard' }),
            currency: 'usd',
            cartItems: JSON.stringify(cartItems)
          }
        }
      }
    })

    prismaMock.order.create.mockResolvedValue({ id: 'order-1' })
    prismaMock.product.findMany.mockResolvedValue([{ id: 'product-1', quantity: 10 }])
    prismaMock.orderItem.createMany.mockResolvedValue({ count: 1 })
    prismaMock.$executeRawUnsafe.mockResolvedValue(1)

    const response = await POST(makeRequest('{}'))

    expect(response.status).toBe(200)
    expect(prismaMock.order.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        storeId: 'store-1',
        isPaid: true,
        totalPriceInCents: 3000
      })
    })
    expect(prismaMock.orderItem.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          orderId: 'order-1',
          productId: 'product-1',
          quantity: 2,
          priceInCents: 1500
        })
      ]
    })
    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledWith(
      'UPDATE product SET quantity = quantity - $1 WHERE id = $2 AND quantity >= $1',
      2,
      'product-1'
    )
  })

  it('persists the unitPriceInCents from checkout metadata verbatim, never recomputing against live bundle/sale state', async () => {
    // Even though this simulates bundle/sale rules having since changed (irrelevant
    // here because the webhook never re-reads Bundle/Sale at all), the persisted
    // price must be exactly what checkout locked in with Stripe.
    const cartItems = [
      {
        productId: 'product-1',
        variationId: null,
        quantity: 5,
        name: 'Widget',
        weight: 1,
        unitPriceInCents: 850, // was the 15%-off bundle price at checkout time
        discountType: 'bundle',
        discountId: 'bundle-1'
      }
    ]

    constructEventMock.mockReturnValue({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'sess_1',
          amount_total: 4250,
          metadata: { storeId: 'store-1', cartItems: JSON.stringify(cartItems) }
        }
      }
    })

    prismaMock.order.create.mockResolvedValue({ id: 'order-1' })
    prismaMock.product.findMany.mockResolvedValue([{ id: 'product-1', quantity: 10 }])
    prismaMock.orderItem.createMany.mockResolvedValue({ count: 1 })
    prismaMock.$executeRawUnsafe.mockResolvedValue(1)

    const response = await POST(makeRequest('{}'))

    expect(response.status).toBe(200)
    expect(prismaMock.orderItem.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ priceInCents: 850 })]
    })
  })

  it('wraps order + order items + inventory decrement in a single transaction', async () => {
    const cartItems = [
      { productId: 'product-1', variationId: null, quantity: 1, name: 'Widget', weight: 1, unitPriceInCents: 1000, discountType: 'none', discountId: null }
    ]

    constructEventMock.mockReturnValue({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'sess_1',
          amount_total: 1000,
          metadata: { storeId: 'store-1', cartItems: JSON.stringify(cartItems) }
        }
      }
    })

    prismaMock.order.create.mockResolvedValue({ id: 'order-1' })
    prismaMock.product.findMany.mockResolvedValue([{ id: 'product-1', quantity: 10 }])
    prismaMock.orderItem.createMany.mockResolvedValue({ count: 1 })
    prismaMock.$executeRawUnsafe.mockResolvedValue(1)

    await POST(makeRequest('{}'))

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })

  it('rolls back (returns 500, order not treated as created) when a write inside the transaction fails', async () => {
    const cartItems = [
      { productId: 'product-1', variationId: null, quantity: 1, name: 'Widget', weight: 1, unitPriceInCents: 1000, discountType: 'none', discountId: null }
    ]

    constructEventMock.mockReturnValue({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'sess_1',
          amount_total: 1000,
          metadata: { storeId: 'store-1', cartItems: JSON.stringify(cartItems) }
        }
      }
    })

    prismaMock.order.create.mockResolvedValue({ id: 'order-1' })
    prismaMock.product.findMany.mockResolvedValue([{ id: 'product-1', quantity: 10 }])
    prismaMock.orderItem.createMany.mockRejectedValue(new Error('db error mid-transaction'))

    const response = await POST(makeRequest('{}'))

    expect(response.status).toBe(500)
    expect(prismaMock.$executeRawUnsafe).not.toHaveBeenCalled()
  })

  it('looks up products and variations in a single batched query each, not once per cart line', async () => {
    const cartItems = [
      { productId: 'p1', variationId: null, quantity: 1, name: 'A', weight: 1, unitPriceInCents: 100, discountType: 'none', discountId: null },
      { productId: 'p2', variationId: 'v1', quantity: 1, name: 'B', weight: 1, unitPriceInCents: 200, discountType: 'none', discountId: null },
      { productId: 'p3', variationId: null, quantity: 1, name: 'C', weight: 1, unitPriceInCents: 300, discountType: 'none', discountId: null }
    ]

    constructEventMock.mockReturnValue({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'sess_1',
          amount_total: 600,
          metadata: { storeId: 'store-1', cartItems: JSON.stringify(cartItems) }
        }
      }
    })

    prismaMock.order.create.mockResolvedValue({ id: 'order-1' })
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'p1', quantity: 10 },
      { id: 'p2', quantity: 10 },
      { id: 'p3', quantity: 10 }
    ])
    prismaMock.productVariation.findMany.mockResolvedValue([{ id: 'v1', quantity: 10 }])
    prismaMock.orderItem.createMany.mockResolvedValue({ count: 3 })
    prismaMock.$executeRawUnsafe.mockResolvedValue(1)

    await POST(makeRequest('{}'))

    expect(prismaMock.product.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.productVariation.findMany).toHaveBeenCalledTimes(1)
  })

  it('creates one order item per variation line and decrements each variation quantity independently', async () => {
    const cartItems = [
      { productId: 'product-1', variationId: 'var-1', quantity: 3, name: 'Shirt - Red / M', weight: 1, unitPriceInCents: 2000, discountType: 'none', discountId: null },
      { productId: 'product-1', variationId: 'var-2', quantity: 1, name: 'Shirt - Blue / L', weight: 1, unitPriceInCents: 2200, discountType: 'none', discountId: null }
    ]

    constructEventMock.mockReturnValue({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'sess_1',
          amount_total: 8200,
          metadata: { storeId: 'store-1', cartItems: JSON.stringify(cartItems) }
        }
      }
    })

    prismaMock.order.create.mockResolvedValue({ id: 'order-1' })
    prismaMock.product.findMany.mockResolvedValue([{ id: 'product-1', quantity: 10 }])
    prismaMock.productVariation.findMany.mockResolvedValue([
      { id: 'var-1', name: 'Red / M', quantity: 10 },
      { id: 'var-2', name: 'Blue / L', quantity: 2 }
    ])
    prismaMock.orderItem.createMany.mockResolvedValue({ count: 2 })
    prismaMock.$executeRawUnsafe.mockResolvedValue(1)

    const response = await POST(makeRequest('{}'))

    expect(response.status).toBe(200)
    expect(prismaMock.orderItem.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ productId: 'product-1', productVariationId: 'var-1', quantity: 3, priceInCents: 2000, name: 'Shirt - Red / M' }),
        expect.objectContaining({ productId: 'product-1', productVariationId: 'var-2', quantity: 1, priceInCents: 2200, name: 'Shirt - Blue / L' })
      ]
    })
    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledWith(
      'UPDATE product_variation SET quantity = quantity - $1 WHERE id = $2 AND quantity >= $1',
      3,
      'var-1'
    )
    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledWith(
      'UPDATE product_variation SET quantity = quantity - $1 WHERE id = $2 AND quantity >= $1',
      1,
      'var-2'
    )
    // main product inventory is untouched for variation items — only the two
    // product_variation updates above should have happened
    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledTimes(2)
  })

  it('guards the inventory decrement so it cannot drive stock negative, and flags the shortfall instead of clamping', async () => {
    const cartItems = [
      { productId: 'product-1', variationId: null, quantity: 5, name: 'Widget', weight: 1, unitPriceInCents: 1500, discountType: 'none', discountId: null }
    ]

    constructEventMock.mockReturnValue({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'sess_1',
          amount_total: 7500,
          metadata: { storeId: 'store-1', cartItems: JSON.stringify(cartItems) }
        }
      }
    })

    prismaMock.order.create.mockResolvedValue({ id: 'order-1' })
    prismaMock.product.findMany.mockResolvedValue([{ id: 'product-1', quantity: 2 }])
    prismaMock.orderItem.createMany.mockResolvedValue({ count: 1 })
    // Zero rows affected: only 2 units on hand but 5 were sold. The old
    // GREATEST(..., 0) clamp would have silently floored the column at 0 and
    // reported success; the guarded UPDATE leaves stock untouched instead.
    prismaMock.$executeRawUnsafe.mockResolvedValue(0)

    const response = await POST(makeRequest('{}'))

    // The customer has paid, so the order is still recorded — but the mismatch
    // is surfaced to the operator rather than absorbed.
    expect(response.status).toBe(200)
    expect(prismaMock.$executeRawUnsafe).toHaveBeenCalledWith(
      'UPDATE product SET quantity = quantity - $1 WHERE id = $2 AND quantity >= $1',
      5,
      'product-1'
    )
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.stringContaining('inventory decrement affected no rows'),
      expect.objectContaining({ skus: ['product:product-1'] })
    )
  })

  it('skips cart lines whose product no longer exists, without creating an order item for them', async () => {
    const cartItems = [
      { productId: 'missing-product', variationId: null, quantity: 1, name: 'Ghost', weight: 1, unitPriceInCents: 500, discountType: 'none', discountId: null }
    ]

    constructEventMock.mockReturnValue({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'sess_1',
          amount_total: 500,
          metadata: { storeId: 'store-1', cartItems: JSON.stringify(cartItems) }
        }
      }
    })

    prismaMock.order.create.mockResolvedValue({ id: 'order-1' })
    prismaMock.product.findMany.mockResolvedValue([])

    const response = await POST(makeRequest('{}'))

    expect(response.status).toBe(200)
    expect(prismaMock.orderItem.createMany).not.toHaveBeenCalled()
    expect(prismaMock.$executeRawUnsafe).not.toHaveBeenCalled()
  })

  it('returns 500 if order processing throws', async () => {
    constructEventMock.mockReturnValue({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'sess_1',
          metadata: {
            storeId: 'store-1',
            cartItems: JSON.stringify([])
          }
        }
      }
    })
    prismaMock.order.create.mockRejectedValue(new Error('db down'))

    const response = await POST(makeRequest('{}'))

    expect(response.status).toBe(500)
  })

  it('returns 200 without processing an order for unrelated Stripe event types', async () => {
    constructEventMock.mockReturnValue({
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      data: { object: {} }
    })

    const response = await POST(makeRequest('{}'))

    expect(response.status).toBe(200)
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    // Not "processed" as a checkout completion, so we don't record idempotency for it either
    expect(prismaMock.processedWebhookEvent.create).not.toHaveBeenCalled()
  })

  it('ignores a redelivered event it has already processed, without creating a duplicate order', async () => {
    constructEventMock.mockReturnValue({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'sess_1',
          metadata: {
            storeId: 'store-1',
            cartItems: JSON.stringify([])
          }
        }
      }
    })
    const duplicateError: any = new Error('Unique constraint failed')
    duplicateError.code = 'P2002'
    prismaMock.processedWebhookEvent.create.mockRejectedValue(duplicateError)

    const response = await POST(makeRequest('{}'))

    expect(response.status).toBe(200)
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('records the idempotency marker inside the order transaction, not before it', async () => {
    // Regression guard for the bug this integration fixed. The marker used to
    // be its own statement ahead of the transaction, so a failed order write
    // left it behind: every Stripe retry then saw a duplicate key, returned
    // 200, and the paid order was lost permanently. Both writes must now go
    // through the same transaction callback.
    constructEventMock.mockReturnValue({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'sess_1',
          amount_total: 1000,
          metadata: { storeId: 'store-1', cartItems: JSON.stringify([]) }
        }
      }
    })
    prismaMock.order.create.mockResolvedValue({ id: 'order-1' })
    prismaMock.product.findMany.mockResolvedValue([])

    let markerWrittenInsideTransaction = false
    prismaMock.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        ...prismaMock,
        processedWebhookEvent: {
          create: jest.fn(async () => {
            markerWrittenInsideTransaction = true
            return {}
          })
        }
      }
      return fn(tx)
    })

    const response = await POST(makeRequest('{}'))

    expect(response.status).toBe(200)
    expect(markerWrittenInsideTransaction).toBe(true)
    // Nothing may write the marker outside the transaction.
    expect(prismaMock.processedWebhookEvent.create).not.toHaveBeenCalled()
  })
})
