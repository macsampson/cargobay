import { GET, PATCH, DELETE, OPTIONS } from './route'
import prismadb from '@/lib/prismadb'
import { isAuthenticated } from '@/lib/auth'
import axios from 'axios'

jest.mock('@/lib/auth')
jest.mock('axios', () => ({ post: jest.fn(() => Promise.resolve()) }))

const prismaMock = prismadb as any
const authMock = isAuthenticated as jest.Mock
const axiosPostMock = axios.post as jest.Mock

const baseParams = { params: Promise.resolve({ storeId: 'store-1', productId: 'p1' }) }

describe('GET /api/[storeId]/products/[productId]', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    prismaMock.sale.findMany.mockResolvedValue([])
  })

  it('returns null when the product does not exist', async () => {
    prismaMock.product.findUnique.mockResolvedValue(null)

    const response = await GET(new Request('http://localhost/x'), baseParams)
    const data = await response.json()

    expect(data).toBeNull()
  })

  it('does not apply any sale to a sold-out product, even if an active sale exists', async () => {
    prismaMock.product.findUnique.mockResolvedValue({ id: 'p1', priceInCents: 1000, quantity: 0 })
    prismaMock.sale.findMany.mockResolvedValue([
      { id: 'sale-1', isStoreWide: true, percentage: 50, products: [] }
    ])

    const response = await GET(new Request('http://localhost/x'), baseParams)
    const data = await response.json()

    expect(data.saleInfo.hasActiveSale).toBe(false)
    expect(data.saleInfo.salePriceInCents).toBeNull()
  })

  it('applies a store-wide active sale to an in-stock product', async () => {
    prismaMock.product.findUnique.mockResolvedValue({ id: 'p1', priceInCents: 1000, quantity: 5 })
    prismaMock.sale.findMany.mockResolvedValue([
      {
        id: 'sale-1',
        name: 'Storewide',
        isStoreWide: true,
        percentage: 20,
        startDate: new Date(),
        endDate: new Date(),
        isActive: true,
        products: []
      }
    ])

    const response = await GET(new Request('http://localhost/x'), baseParams)
    const data = await response.json()

    expect(data.saleInfo.hasActiveSale).toBe(true)
    expect(data.saleInfo.salePriceInCents).toBe(800)
  })

  it('applies a product-specific sale only when this product is included in it', async () => {
    prismaMock.product.findUnique.mockResolvedValue({ id: 'p1', priceInCents: 1000, quantity: 5 })
    prismaMock.sale.findMany.mockResolvedValue([
      {
        id: 'sale-1',
        name: 'Product Sale',
        isStoreWide: false,
        percentage: 30,
        startDate: new Date(),
        endDate: new Date(),
        isActive: true,
        products: [{ productId: 'someone-else' }]
      }
    ])

    const response = await GET(new Request('http://localhost/x'), baseParams)
    const data = await response.json()

    expect(data.saleInfo.hasActiveSale).toBe(false)
  })

  it('returns 500 on a database error', async () => {
    prismaMock.product.findUnique.mockRejectedValue(new Error('db down'))

    const response = await GET(new Request('http://localhost/x'), baseParams)
    expect(response.status).toBe(500)
  })
})

describe('PATCH /api/[storeId]/products/[productId]', () => {
  const validBody = {
    name: 'Widget',
    images: [{ url: 'https://x/1.png', credit: '', ordering: 0 }],
    quantity: 5,
    description: 'desc',
    weight: 1,
    categoryId: 'cat-1',
    colorId: null,
    sizeId: null,
    price: 19.99,
    variations: [],
    bundles: [],
    isFeatured: false,
    isArchived: false
  }

  beforeEach(() => {
    jest.resetAllMocks()
    authMock.mockResolvedValue(true)
    axiosPostMock.mockResolvedValue(undefined)
    prismaMock.store.findFirst.mockResolvedValue({ id: 'store-1', userId: 'single-user' })
    prismaMock.product.findUnique.mockResolvedValue({
      id: 'p1',
      variations: [],
      bundles: [],
      images: []
    })
    prismaMock.product.update.mockResolvedValue({})
    prismaMock.productVariation.deleteMany.mockResolvedValue({ count: 0 })
    prismaMock.image.deleteMany.mockResolvedValue({ count: 0 })
    prismaMock.image.findMany.mockResolvedValue([])
    prismaMock.image.update.mockResolvedValue({})
    prismaMock.image.createMany.mockResolvedValue({ count: 0 })
    prismaMock.bundle.deleteMany.mockResolvedValue({ count: 0 })
    prismaMock.$transaction.mockImplementation((cb: any) => cb(prismaMock))
  })

  it('converts the dollar price to cents when updating', async () => {
    const response = await PATCH(
      new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify(validBody) }),
      baseParams
    )

    expect(response.status).toBe(200)
    expect(prismaMock.product.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ priceInCents: 1999 }) })
    )
  })

  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(false)

    const response = await PATCH(
      new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify(validBody) }),
      baseParams
    )
    expect(response.status).toBe(401)
  })

  it('returns 400 when name is missing', async () => {
    const response = await PATCH(
      new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify({ ...validBody, name: undefined }) }),
      baseParams
    )
    expect(response.status).toBe(400)
  })

  it('returns 400 when no images are provided (outside local-dev bypass)', async () => {
    delete process.env.DISABLE_AUTH_FOR_LOCAL_DEV
    const response = await PATCH(
      new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify({ ...validBody, images: [] }) }),
      baseParams
    )
    expect(response.status).toBe(400)
  })

  it('allows an empty images array when DISABLE_AUTH_FOR_LOCAL_DEV is set', async () => {
    process.env.DISABLE_AUTH_FOR_LOCAL_DEV = 'true'
    const response = await PATCH(
      new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify({ ...validBody, images: [] }) }),
      baseParams
    )
    expect(response.status).toBe(200)
    delete process.env.DISABLE_AUTH_FOR_LOCAL_DEV
  })

  it('returns 403 when the store is not owned by the admin', async () => {
    prismaMock.store.findFirst.mockResolvedValue(null)

    const response = await PATCH(
      new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify(validBody) }),
      baseParams
    )
    expect(response.status).toBe(403)
  })

  it('returns 404 when the product does not exist', async () => {
    prismaMock.product.findUnique.mockResolvedValue(null)

    const response = await PATCH(
      new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify(validBody) }),
      baseParams
    )
    expect(response.status).toBe(404)
  })

  it('returns 500 on a database error', async () => {
    prismaMock.product.update.mockRejectedValue(new Error('db down'))

    const response = await PATCH(
      new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify(validBody) }),
      baseParams
    )
    expect(response.status).toBe(500)
  })

  it('returns 400 when price is missing', async () => {
    const response = await PATCH(
      new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify({ ...validBody, price: undefined }) }),
      baseParams
    )
    expect(response.status).toBe(400)
  })

  it('returns 400 when categoryId is missing', async () => {
    const response = await PATCH(
      new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify({ ...validBody, categoryId: undefined }) }),
      baseParams
    )
    expect(response.status).toBe(400)
  })

  it('returns 400 when weight is missing', async () => {
    const response = await PATCH(
      new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify({ ...validBody, weight: undefined }) }),
      baseParams
    )
    expect(response.status).toBe(400)
  })

  it('updates an existing variation (has an id) and converts its dollar price to cents', async () => {
    prismaMock.productVariation.update.mockResolvedValue({})

    await PATCH(
      new Request('http://localhost/x', {
        method: 'PATCH',
        body: JSON.stringify({
          ...validBody,
          variations: [{ id: 'var-1', name: 'Red / M', price: 5.5, quantity: 3 }]
        })
      }),
      baseParams
    )

    expect(prismaMock.productVariation.update).toHaveBeenCalledWith({
      where: { id: 'var-1' },
      data: { name: 'Red / M', priceInCents: 550, quantity: 3 }
    })
    // Only the surviving variation id should be excluded from the delete-the-rest cleanup
    expect(prismaMock.productVariation.deleteMany).toHaveBeenCalledWith({
      where: { productId: 'p1', id: { notIn: ['var-1'] } }
    })
  })

  it('creates a new variation (no id) via createMany', async () => {
    prismaMock.productVariation.createMany.mockResolvedValue({ count: 1 })

    await PATCH(
      new Request('http://localhost/x', {
        method: 'PATCH',
        body: JSON.stringify({
          ...validBody,
          variations: [{ name: 'Blue / L', price: 6, quantity: 2 }]
        })
      }),
      baseParams
    )

    expect(prismaMock.productVariation.createMany).toHaveBeenCalledWith({
      data: [{ name: 'Blue / L', priceInCents: 600, productId: 'p1', quantity: 2 }]
    })
    expect(prismaMock.productVariation.update).not.toHaveBeenCalled()
  })

  it('does not call createMany for variations when there are none to create', async () => {
    await PATCH(
      new Request('http://localhost/x', {
        method: 'PATCH',
        body: JSON.stringify({ ...validBody, variations: [] })
      }),
      baseParams
    )

    expect(prismaMock.productVariation.createMany).not.toHaveBeenCalled()
  })

  it('updates an existing bundle (has an id)', async () => {
    prismaMock.bundle.update.mockResolvedValue({})

    await PATCH(
      new Request('http://localhost/x', {
        method: 'PATCH',
        body: JSON.stringify({
          ...validBody,
          bundles: [{ id: 'bundle-1', minQuantity: 3, discount: 10 }]
        })
      }),
      baseParams
    )

    expect(prismaMock.bundle.update).toHaveBeenCalledWith({
      where: { id: 'bundle-1' },
      data: { minQuantity: 3, discountPercentage: 10 }
    })
    expect(prismaMock.bundle.deleteMany).toHaveBeenCalledWith({
      where: { productId: 'p1', id: { notIn: ['bundle-1'] } }
    })
  })

  it('creates a new bundle (no id) via createMany', async () => {
    prismaMock.bundle.createMany.mockResolvedValue({ count: 1 })

    await PATCH(
      new Request('http://localhost/x', {
        method: 'PATCH',
        body: JSON.stringify({
          ...validBody,
          bundles: [{ minQuantity: 5, discount: 15 }]
        })
      }),
      baseParams
    )

    expect(prismaMock.bundle.createMany).toHaveBeenCalledWith({
      data: [{ minQuantity: 5, discountPercentage: 15, productId: 'p1' }]
    })
    expect(prismaMock.bundle.update).not.toHaveBeenCalled()
  })

  it('does not call createMany for bundles when there are none to create', async () => {
    await PATCH(
      new Request('http://localhost/x', {
        method: 'PATCH',
        body: JSON.stringify({ ...validBody, bundles: [] })
      }),
      baseParams
    )

    expect(prismaMock.bundle.createMany).not.toHaveBeenCalled()
  })

  it('performs bundle deletes/updates/creates inside a single transaction', async () => {
    prismaMock.bundle.update.mockResolvedValue({})
    prismaMock.bundle.createMany.mockResolvedValue({ count: 1 })

    await PATCH(
      new Request('http://localhost/x', {
        method: 'PATCH',
        body: JSON.stringify({
          ...validBody,
          bundles: [
            { id: 'bundle-1', minQuantity: 3, discount: 10 },
            { minQuantity: 5, discount: 15 }
          ]
        })
      }),
      baseParams
    )

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(prismaMock.bundle.update).toHaveBeenCalled()
    expect(prismaMock.bundle.createMany).toHaveBeenCalled()
  })

  it('returns 400 and writes nothing when two submitted bundles share a minQuantity', async () => {
    const response = await PATCH(
      new Request('http://localhost/x', {
        method: 'PATCH',
        body: JSON.stringify({
          ...validBody,
          bundles: [
            { id: 'bundle-1', minQuantity: 5, discount: 10 },
            { minQuantity: 5, discount: 20 }
          ]
        })
      }),
      baseParams
    )

    expect(response.status).toBe(400)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.bundle.update).not.toHaveBeenCalled()
    expect(prismaMock.bundle.createMany).not.toHaveBeenCalled()
  })

  it('rolls back bundle changes when a write partway through the transaction fails', async () => {
    prismaMock.$transaction.mockImplementation(async (cb: any) => {
      try {
        return await cb(prismaMock)
      } catch (error) {
        throw error
      }
    })
    prismaMock.bundle.update.mockRejectedValue(new Error('db error mid-transaction'))

    const response = await PATCH(
      new Request('http://localhost/x', {
        method: 'PATCH',
        body: JSON.stringify({
          ...validBody,
          bundles: [{ id: 'bundle-1', minQuantity: 3, discount: 10 }]
        })
      }),
      baseParams
    )

    expect(response.status).toBe(500)
    // The failure inside the transaction must not resolve the request as success.
    expect(prismaMock.bundle.createMany).not.toHaveBeenCalled()
  })

  it('updates metadata on an existing image (has an id) instead of recreating it', async () => {
    await PATCH(
      new Request('http://localhost/x', {
        method: 'PATCH',
        body: JSON.stringify({
          ...validBody,
          images: [{ id: 'img-1', url: 'https://x/1.png', credit: 'photographer', ordering: 2 }]
        })
      }),
      baseParams
    )

    expect(prismaMock.image.update).toHaveBeenCalledWith({
      where: { id: 'img-1' },
      data: { credit: 'photographer', ordering: 2 }
    })
    expect(prismaMock.image.createMany).not.toHaveBeenCalled()
    expect(prismaMock.image.deleteMany).toHaveBeenCalledWith({
      where: { productId: 'p1', id: { notIn: ['img-1'] } }
    })
  })

  it('creates new images (no id) via createMany, without updating existing ones', async () => {
    await PATCH(
      new Request('http://localhost/x', {
        method: 'PATCH',
        body: JSON.stringify({
          ...validBody,
          images: [{ url: 'https://x/2.png', credit: '', ordering: 0 }]
        })
      }),
      baseParams
    )

    expect(prismaMock.image.createMany).toHaveBeenCalledWith({
      data: [{ url: 'https://x/2.png', credit: '', ordering: 0, productId: 'p1' }]
    })
    expect(prismaMock.image.update).not.toHaveBeenCalled()
  })

  // NOTE: REVALIDATE_URL is built from process.env.FRONTEND_STORE_URL as a
  // module-level constant at import time, so setting the env var inside a
  // test can't retroactively change the URL this module already captured
  // (same class of issue as ALLOWED_ORIGINS in middleware.ts). This asserts
  // the payload/headers and the gating condition, not the exact captured URL.
  it('fires a fire-and-forget revalidation request when FRONTEND_STORE_URL and REVALIDATE_TOKEN are set', async () => {
    process.env.FRONTEND_STORE_URL = 'https://storefront.example.com'
    process.env.REVALIDATE_TOKEN = 'revalidate-secret'

    await PATCH(
      new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify(validBody) }),
      baseParams
    )

    expect(axiosPostMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/revalidate'),
      { tag: 'product' },
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer revalidate-secret' })
      })
    )

    delete process.env.FRONTEND_STORE_URL
    delete process.env.REVALIDATE_TOKEN
  })

  it('does not attempt revalidation when FRONTEND_STORE_URL or REVALIDATE_TOKEN is missing', async () => {
    delete process.env.FRONTEND_STORE_URL
    delete process.env.REVALIDATE_TOKEN

    await PATCH(
      new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify(validBody) }),
      baseParams
    )

    expect(axiosPostMock).not.toHaveBeenCalled()
  })

  it('returns 400 when productId is missing from params', async () => {
    const response = await PATCH(
      new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify(validBody) }),
      { params: Promise.resolve({ storeId: 'store-1', productId: '' }) }
    )
    expect(response.status).toBe(400)
  })

  it('does not let a revalidation failure fail the request (swallowed error)', async () => {
    process.env.FRONTEND_STORE_URL = 'https://storefront.example.com'
    process.env.REVALIDATE_TOKEN = 'revalidate-secret'
    axiosPostMock.mockReturnValue(Promise.reject(new Error('revalidate down')))

    const response = await PATCH(
      new Request('http://localhost/x', { method: 'PATCH', body: JSON.stringify(validBody) }),
      baseParams
    )

    expect(response.status).toBe(200)

    delete process.env.FRONTEND_STORE_URL
    delete process.env.REVALIDATE_TOKEN
  })
})

describe('DELETE /api/[storeId]/products/[productId]', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    authMock.mockResolvedValue(true)
    prismaMock.store.findFirst.mockResolvedValue({ id: 'store-1', userId: 'single-user' })
  })

  it('deletes the product', async () => {
    prismaMock.product.deleteMany.mockResolvedValue({ count: 1 })

    const response = await DELETE(new Request('http://localhost/x'), baseParams)
    expect(response.status).toBe(200)
  })

  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(false)

    const response = await DELETE(new Request('http://localhost/x'), baseParams)
    expect(response.status).toBe(401)
  })

  it('returns 403 when the store is not owned by the admin', async () => {
    prismaMock.store.findFirst.mockResolvedValue(null)

    const response = await DELETE(new Request('http://localhost/x'), baseParams)
    expect(response.status).toBe(403)
  })

  it('returns 500 on a database error', async () => {
    prismaMock.product.deleteMany.mockRejectedValue(new Error('db down'))

    const response = await DELETE(new Request('http://localhost/x'), baseParams)
    expect(response.status).toBe(500)
  })

  it('returns 400 when productId is missing from params', async () => {
    const response = await DELETE(new Request('http://localhost/x'), {
      params: Promise.resolve({ storeId: 'store-1', productId: '' })
    })
    expect(response.status).toBe(400)
  })
})

describe('OPTIONS /api/[storeId]/products/[productId]', () => {
  it('returns CORS headers', async () => {
    const response = await OPTIONS()

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('PATCH')
  })
})
