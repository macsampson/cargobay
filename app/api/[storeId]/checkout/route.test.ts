import { POST } from './route'
import prismadb from '@/lib/prismadb'
import { stripe } from '@/lib/stripe'
import { rateLimit, getClientIp } from '@/lib/rate-limit'

jest.mock('@/lib/stripe', () => ({
  stripe: {
    checkout: {
      sessions: {
        create: jest.fn()
      }
    }
  }
}))

jest.mock('@/lib/rate-limit', () => ({
  rateLimit: jest.fn(() => ({ allowed: true })),
  getClientIp: jest.fn(() => '127.0.0.1')
}))

const prismaMock = prismadb as any
const createSessionMock = stripe.checkout.sessions.create as jest.Mock
const rateLimitMock = rateLimit as jest.Mock

function makeRequest(body: any) {
  return new Request('http://localhost/api/store-1/checkout', {
    method: 'POST',
    body: JSON.stringify(body)
  })
}

function makeProduct(overrides: Partial<any> = {}) {
  return {
    id: 'p1',
    storeId: 'store-1',
    name: 'Widget',
    priceInCents: 1000,
    quantity: 10,
    isArchived: false,
    weight: 2,
    category: { name: 'Gadgets' },
    bundles: [],
    variations: [],
    ...overrides
  }
}

const baseParams = { params: Promise.resolve({ storeId: 'store-1' }) }
const validShippingAddress = {
  street: '123 Main St',
  city: 'Springfield',
  state: 'IL',
  zipCode: '62701',
  country: 'US'
}

describe('POST /api/[storeId]/checkout', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    rateLimitMock.mockReturnValue({ allowed: true })
    ;(getClientIp as jest.Mock).mockReturnValue('127.0.0.1')
    prismaMock.store.findUnique.mockResolvedValue({ id: 'store-1', userId: 'single-user' })
    prismaMock.product.findMany.mockResolvedValue([])
    prismaMock.sale.findMany.mockResolvedValue([])
    createSessionMock.mockResolvedValue({ url: 'https://stripe.test/session' })
  })

  it('creates a Stripe checkout session, pricing the line item from the DB, not the client', async () => {
    prismaMock.product.findMany.mockResolvedValue([makeProduct({ priceInCents: 1500 })])

    const response = await POST(
      makeRequest({
        cartItems: [{ productId: 'p1', quantity: 2 }],
        shippingAddress: validShippingAddress,
        currency: 'usd'
      }),
      baseParams
    )

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.url).toBe('https://stripe.test/session')
    expect(createSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [
          expect.objectContaining({
            price_data: expect.objectContaining({ unit_amount: 1500 }),
            quantity: 2
          })
        ]
      })
    )
  })

  it('ignores a spoofed client-supplied price field entirely (regression test for the price-trust vulnerability)', async () => {
    prismaMock.product.findMany.mockResolvedValue([makeProduct({ priceInCents: 1000 })])

    const response = await POST(
      makeRequest({
        // priceInCents here should have no effect whatsoever
        cartItems: [{ productId: 'p1', quantity: 1, priceInCents: 1 }],
        shippingAddress: validShippingAddress,
        currency: 'usd'
      }),
      baseParams
    )

    expect(response.status).toBe(200)
    const call = createSessionMock.mock.calls[0][0]
    expect(call.line_items[0].price_data.unit_amount).toBe(1000)
  })

  it('applies a qualifying bundle tier discount server-side', async () => {
    prismaMock.product.findMany.mockResolvedValue([
      makeProduct({ priceInCents: 1000, bundles: [{ id: 'b1', minQuantity: 3, discountPercentage: 15 }] })
    ])

    const response = await POST(
      makeRequest({
        cartItems: [{ productId: 'p1', quantity: 3 }],
        shippingAddress: validShippingAddress,
        currency: 'usd'
      }),
      baseParams
    )

    expect(response.status).toBe(200)
    const call = createSessionMock.mock.calls[0][0]
    expect(call.line_items[0].price_data.unit_amount).toBe(850)
  })

  it('does not apply a bundle tier when quantity is one below minQuantity', async () => {
    prismaMock.product.findMany.mockResolvedValue([
      makeProduct({ priceInCents: 1000, bundles: [{ id: 'b1', minQuantity: 3, discountPercentage: 15 }] })
    ])

    const response = await POST(
      makeRequest({
        cartItems: [{ productId: 'p1', quantity: 2 }],
        shippingAddress: validShippingAddress,
        currency: 'usd'
      }),
      baseParams
    )

    expect(response.status).toBe(200)
    const call = createSessionMock.mock.calls[0][0]
    expect(call.line_items[0].price_data.unit_amount).toBe(1000)
  })

  it('mixed cart: prices each line independently from bundle, sale, and plain pricing', async () => {
    prismaMock.product.findMany.mockResolvedValue([
      makeProduct({ id: 'bundled', priceInCents: 1000, bundles: [{ id: 'b1', minQuantity: 3, discountPercentage: 15 }] }),
      makeProduct({ id: 'plain', priceInCents: 2000 })
    ])
    prismaMock.sale.findMany.mockResolvedValue([
      {
        id: 'sale-1',
        name: 'Storewide',
        isStoreWide: true,
        percentage: 30,
        startDate: new Date(),
        endDate: new Date(),
        isActive: true,
        products: []
      }
    ])

    const response = await POST(
      makeRequest({
        cartItems: [
          { productId: 'bundled', quantity: 3 }, // bundle 15% beats sale 30%? no: sale 30% > bundle 15%, sale wins
          { productId: 'plain', quantity: 1 } // no bundle, sale applies
        ],
        shippingAddress: validShippingAddress,
        currency: 'usd'
      }),
      baseParams
    )

    expect(response.status).toBe(200)
    const call = createSessionMock.mock.calls[0][0]
    expect(call.line_items[0].price_data.unit_amount).toBe(700) // 1000 * 0.70 (sale beats bundle)
    expect(call.line_items[1].price_data.unit_amount).toBe(1400) // 2000 * 0.70
  })

  it('resolves a variation price and validates it belongs to the requested product', async () => {
    prismaMock.product.findMany.mockResolvedValue([
      makeProduct({ variations: [{ id: 'v1', productId: 'p1', priceInCents: 2500, quantity: 5 }] })
    ])

    const response = await POST(
      makeRequest({
        cartItems: [{ productId: 'p1', variationId: 'v1', quantity: 1 }],
        shippingAddress: validShippingAddress,
        currency: 'usd'
      }),
      baseParams
    )

    expect(response.status).toBe(200)
    const call = createSessionMock.mock.calls[0][0]
    expect(call.line_items[0].price_data.unit_amount).toBe(2500)
  })

  it('returns 400 when a variationId does not belong to the specified product', async () => {
    prismaMock.product.findMany.mockResolvedValue([makeProduct({ variations: [] })])

    const response = await POST(
      makeRequest({
        cartItems: [{ productId: 'p1', variationId: 'nonexistent', quantity: 1 }],
        shippingAddress: validShippingAddress,
        currency: 'usd'
      }),
      baseParams
    )

    expect(response.status).toBe(400)
    expect(createSessionMock).not.toHaveBeenCalled()
  })

  it('adds a shipping line item when shippingType.rate > 0', async () => {
    prismaMock.product.findMany.mockResolvedValue([makeProduct({ priceInCents: 1500 })])

    const response = await POST(
      makeRequest({
        cartItems: [{ productId: 'p1', quantity: 1 }],
        shippingType: { id: 'ship-1', title: 'Standard', rate: 5 },
        shippingAddress: validShippingAddress,
        currency: 'usd'
      }),
      baseParams
    )

    expect(response.status).toBe(200)
    const call = createSessionMock.mock.calls[0][0]
    expect(call.line_items).toHaveLength(2)
    expect(call.line_items[1]).toEqual(
      expect.objectContaining({
        price_data: expect.objectContaining({ unit_amount: 500 }),
        quantity: 1
      })
    )
  })

  it('returns 400 for an unknown/nonexistent productId, without calling Stripe', async () => {
    prismaMock.product.findMany.mockResolvedValue([])

    const response = await POST(
      makeRequest({
        cartItems: [{ productId: 'ghost', quantity: 1 }],
        shippingAddress: validShippingAddress,
        currency: 'usd'
      }),
      baseParams
    )

    expect(response.status).toBe(400)
    expect(createSessionMock).not.toHaveBeenCalled()
  })

  it('returns 400 for an archived product', async () => {
    prismaMock.product.findMany.mockResolvedValue([makeProduct({ isArchived: true })])

    const response = await POST(
      makeRequest({
        cartItems: [{ productId: 'p1', quantity: 1 }],
        shippingAddress: validShippingAddress,
        currency: 'usd'
      }),
      baseParams
    )

    expect(response.status).toBe(400)
    expect(createSessionMock).not.toHaveBeenCalled()
  })

  it('returns 400 for an invalid (non-positive) quantity', async () => {
    prismaMock.product.findMany.mockResolvedValue([makeProduct()])

    const response = await POST(
      makeRequest({
        cartItems: [{ productId: 'p1', quantity: 0 }],
        shippingAddress: validShippingAddress,
        currency: 'usd'
      }),
      baseParams
    )

    expect(response.status).toBe(400)
    expect(createSessionMock).not.toHaveBeenCalled()
  })

  it('looks up products in a single batched query regardless of cart size (no N+1)', async () => {
    prismaMock.product.findMany.mockResolvedValue([
      makeProduct({ id: 'p1' }),
      makeProduct({ id: 'p2' }),
      makeProduct({ id: 'p3' })
    ])

    await POST(
      makeRequest({
        cartItems: [
          { productId: 'p1', quantity: 1 },
          { productId: 'p2', quantity: 1 },
          { productId: 'p3', quantity: 1 }
        ],
        shippingAddress: validShippingAddress,
        currency: 'usd'
      }),
      baseParams
    )

    expect(prismaMock.product.findMany).toHaveBeenCalledTimes(1)
  })

  it('does not apply an active sale to a sold-out product', async () => {
    prismaMock.product.findMany.mockResolvedValue([makeProduct({ priceInCents: 1000, quantity: 0 })])
    prismaMock.sale.findMany.mockResolvedValue([
      {
        id: 'sale-1',
        name: 'Storewide',
        isStoreWide: true,
        percentage: 50,
        startDate: new Date(),
        endDate: new Date(),
        isActive: true,
        products: []
      }
    ])

    const response = await POST(
      makeRequest({
        cartItems: [{ productId: 'p1', quantity: 1 }],
        shippingAddress: validShippingAddress,
        currency: 'usd'
      }),
      baseParams
    )

    expect(response.status).toBe(200)
    const call = createSessionMock.mock.calls[0][0]
    expect(call.line_items[0].price_data.unit_amount).toBe(1000)
  })

  it('returns 429 when the rate limit is exceeded', async () => {
    rateLimitMock.mockReturnValue({ allowed: false })

    const response = await POST(
      makeRequest({
        cartItems: [{ productId: 'p1', quantity: 1 }],
        shippingAddress: validShippingAddress,
        currency: 'usd'
      }),
      baseParams
    )

    expect(response.status).toBe(429)
    expect(createSessionMock).not.toHaveBeenCalled()
  })

  it('returns 400 for an empty cart', async () => {
    const response = await POST(
      makeRequest({ cartItems: [], shippingAddress: validShippingAddress, currency: 'usd' }),
      baseParams
    )
    expect(response.status).toBe(400)
  })

  it('returns 400 when shippingAddress is missing', async () => {
    const response = await POST(
      makeRequest({
        cartItems: [{ productId: 'p1', quantity: 1 }],
        currency: 'usd'
      }),
      baseParams
    )
    expect(response.status).toBe(400)
  })

  it('returns 404 when the store does not exist', async () => {
    prismaMock.store.findUnique.mockResolvedValue(null)

    const response = await POST(
      makeRequest({
        cartItems: [{ productId: 'p1', quantity: 1 }],
        shippingAddress: validShippingAddress,
        currency: 'usd'
      }),
      baseParams
    )
    expect(response.status).toBe(404)
  })

  it('returns 500 if Stripe session creation throws', async () => {
    prismaMock.product.findMany.mockResolvedValue([makeProduct()])
    createSessionMock.mockRejectedValue(new Error('stripe down'))

    const response = await POST(
      makeRequest({
        cartItems: [{ productId: 'p1', quantity: 1 }],
        shippingAddress: validShippingAddress,
        currency: 'usd'
      }),
      baseParams
    )
    expect(response.status).toBe(500)
  })
})
