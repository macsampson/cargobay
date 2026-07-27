import { GET, POST, PATCH } from './route'
import prismadb from '@/lib/prismadb'
import { isAuthenticated } from '@/lib/auth'
import axios from 'axios'

jest.mock('@/lib/auth')
jest.mock('axios', () => ({ post: jest.fn(() => Promise.resolve()) }))

const prismaMock = prismadb as any
const authMock = isAuthenticated as jest.Mock
const axiosPostMock = axios.post as jest.Mock

const baseParams = { params: Promise.resolve({ storeId: 'store-1' }) }

function makeRequest(method: string, body?: any) {
  return new Request('http://localhost/api/store-1/billboards/carousel', {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
}

describe('GET /api/[storeId]/billboards/carousel', () => {
  beforeEach(() => jest.resetAllMocks())

  it('returns carousel images for the store', async () => {
    prismaMock.carouselImage.findMany.mockResolvedValue([{ id: 'c1' }])

    const response = await GET(makeRequest('GET'), baseParams)
    const data = await response.json()

    expect(data).toEqual([{ id: 'c1' }])
  })

  it('returns 400 when storeId is missing', async () => {
    const response = await GET(makeRequest('GET'), { params: Promise.resolve({ storeId: '' }) })
    expect(response.status).toBe(400)
  })

  it('returns 500 on a database error', async () => {
    prismaMock.carouselImage.findMany.mockRejectedValue(new Error('db down'))

    const response = await GET(makeRequest('GET'), baseParams)
    expect(response.status).toBe(500)
  })
})

describe('POST /api/[storeId]/billboards/carousel', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    authMock.mockResolvedValue(true)
    prismaMock.carouselImage.deleteMany.mockResolvedValue({ count: 0 })
    prismaMock.carouselImage.createMany.mockResolvedValue({ count: 1 })
  })

  it('replaces the carousel images for the store', async () => {
    const response = await POST(
      makeRequest('POST', { images: [{ imageUrl: 'https://x/1.png', imageCredit: 'me' }] }),
      baseParams
    )

    expect(response.status).toBe(200)
    expect(prismaMock.carouselImage.deleteMany).toHaveBeenCalledWith({ where: { storeId: 'store-1' } })
    expect(prismaMock.carouselImage.createMany).toHaveBeenCalledWith({
      data: [{ imageUrl: 'https://x/1.png', storeId: 'store-1', imageCredit: 'me' }]
    })
  })

  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(false)

    const response = await POST(makeRequest('POST', { images: [] }), baseParams)
    expect(response.status).toBe(401)
  })

  it('returns 400 when images is missing', async () => {
    const response = await POST(makeRequest('POST', {}), baseParams)
    expect(response.status).toBe(400)
  })

  it('returns 500 on a database error', async () => {
    prismaMock.carouselImage.deleteMany.mockRejectedValue(new Error('db down'))

    const response = await POST(makeRequest('POST', { images: [] }), baseParams)
    expect(response.status).toBe(500)
  })

  it('fires a fire-and-forget revalidation request when FRONTEND_STORE_URL and REVALIDATE_TOKEN are set', async () => {
    process.env.FRONTEND_STORE_URL = 'https://storefront.example.com'
    process.env.REVALIDATE_TOKEN = 'revalidate-secret'

    await POST(makeRequest('POST', { images: [{ imageUrl: 'https://x/1.png', imageCredit: '' }] }), baseParams)

    expect(axiosPostMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/revalidate'),
      { tag: 'carousel' },
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer revalidate-secret' })
      })
    )

    delete process.env.FRONTEND_STORE_URL
    delete process.env.REVALIDATE_TOKEN
  })
})

describe('PATCH /api/[storeId]/billboards/carousel', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    authMock.mockResolvedValue(true)
    prismaMock.carouselImage.deleteMany.mockResolvedValue({ count: 1 })
    prismaMock.carouselImage.createMany.mockResolvedValue({ count: 1 })
  })

  it('replaces the carousel images for the store', async () => {
    const response = await PATCH(
      makeRequest('PATCH', { images: [{ imageUrl: 'https://x/2.png', imageCredit: '' }] }),
      baseParams
    )
    expect(response.status).toBe(200)
  })

  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(false)

    const response = await PATCH(makeRequest('PATCH', { images: [] }), baseParams)
    expect(response.status).toBe(401)
  })

  it('returns 400 when images is missing', async () => {
    const response = await PATCH(makeRequest('PATCH', {}), baseParams)
    expect(response.status).toBe(400)
  })

  it('fires a fire-and-forget revalidation request when FRONTEND_STORE_URL and REVALIDATE_TOKEN are set', async () => {
    process.env.FRONTEND_STORE_URL = 'https://storefront.example.com'
    process.env.REVALIDATE_TOKEN = 'revalidate-secret'

    await PATCH(makeRequest('PATCH', { images: [{ imageUrl: 'https://x/2.png', imageCredit: '' }] }), baseParams)

    expect(axiosPostMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/revalidate'),
      { tag: 'carousel' },
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer revalidate-secret' })
      })
    )

    delete process.env.FRONTEND_STORE_URL
    delete process.env.REVALIDATE_TOKEN
  })
})
