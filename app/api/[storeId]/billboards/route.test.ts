import { POST, GET } from './route'
import prismadb from '@/lib/prismadb'
import { isAuthenticated } from '@/lib/auth'
import axios from 'axios'

jest.mock('@/lib/auth')
jest.mock('axios', () => ({ post: jest.fn(() => Promise.resolve()) }))

const prismaMock = prismadb as any
const authMock = isAuthenticated as jest.Mock
const axiosPostMock = axios.post as jest.Mock

const baseParams = { params: Promise.resolve({ storeId: 'store-1' }) }

function makeRequest(body: any) {
  return new Request('http://localhost/api/store-1/billboards', {
    method: 'POST',
    body: JSON.stringify(body)
  })
}

describe('POST /api/[storeId]/billboards', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    authMock.mockResolvedValue(true)
    prismaMock.store.findFirst.mockResolvedValue({ id: 'store-1', userId: 'single-user' })
    prismaMock.$transaction.mockImplementation((ops: Promise<any>[]) => Promise.all(ops))
  })

  it('creates a billboard', async () => {
    prismaMock.billboard.create.mockResolvedValue({ id: 'b1', label: 'Sale' })

    const response = await POST(makeRequest({ label: 'Sale', imageUrl: 'https://x/1.png' }), baseParams)
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data).toEqual([{ id: 'b1', label: 'Sale' }])
  })

  it('unsets any existing landing-page billboard first when creating a new landing-page billboard', async () => {
    prismaMock.billboard.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.billboard.create.mockResolvedValue({ id: 'b1' })

    await POST(
      makeRequest({ label: 'Sale', imageUrl: 'https://x/1.png', landingPage: true }),
      baseParams
    )

    expect(prismaMock.billboard.updateMany).toHaveBeenCalledWith({
      where: { landingPage: true },
      data: { landingPage: false }
    })
  })

  it('returns 401 when unauthenticated', async () => {
    authMock.mockResolvedValue(false)

    const response = await POST(makeRequest({ label: 'Sale', imageUrl: 'https://x/1.png' }), baseParams)
    expect(response.status).toBe(401)
  })

  it('returns 400 when label is missing', async () => {
    const response = await POST(makeRequest({ imageUrl: 'https://x/1.png' }), baseParams)
    expect(response.status).toBe(400)
  })

  it('returns 400 when imageUrl is missing', async () => {
    const response = await POST(makeRequest({ label: 'Sale' }), baseParams)
    expect(response.status).toBe(400)
  })

  it('returns 403 when the store is not owned by the admin', async () => {
    prismaMock.store.findFirst.mockResolvedValue(null)

    const response = await POST(makeRequest({ label: 'Sale', imageUrl: 'https://x/1.png' }), baseParams)
    expect(response.status).toBe(403)
  })

  it('returns 500 on a database error', async () => {
    prismaMock.$transaction.mockRejectedValue(new Error('db down'))

    const response = await POST(makeRequest({ label: 'Sale', imageUrl: 'https://x/1.png' }), baseParams)
    expect(response.status).toBe(500)
  })

  it('fires a fire-and-forget revalidation request when FRONTEND_STORE_URL and REVALIDATE_TOKEN are set', async () => {
    process.env.FRONTEND_STORE_URL = 'https://storefront.example.com'
    process.env.REVALIDATE_TOKEN = 'revalidate-secret'
    prismaMock.billboard.create.mockResolvedValue({ id: 'b1' })

    await POST(makeRequest({ label: 'Sale', imageUrl: 'https://x/1.png' }), baseParams)

    expect(axiosPostMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/revalidate'),
      { tag: 'billboards' },
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
    prismaMock.billboard.create.mockResolvedValue({ id: 'b1' })

    await POST(makeRequest({ label: 'Sale', imageUrl: 'https://x/1.png' }), baseParams)

    expect(axiosPostMock).not.toHaveBeenCalled()
  })
})

describe('GET /api/[storeId]/billboards', () => {
  beforeEach(() => jest.resetAllMocks())

  it('returns billboards for the store', async () => {
    prismaMock.billboard.findMany.mockResolvedValue([{ id: 'b1' }])

    const response = await GET(new Request('http://localhost/x'), baseParams)
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data).toEqual([{ id: 'b1' }])
  })

  it('returns 400 when storeId is missing', async () => {
    const response = await GET(new Request('http://localhost/x'), {
      params: Promise.resolve({ storeId: '' })
    })
    expect(response.status).toBe(400)
  })

  it('returns 500 on a database error', async () => {
    prismaMock.billboard.findMany.mockRejectedValue(new Error('db down'))

    const response = await GET(new Request('http://localhost/x'), baseParams)
    expect(response.status).toBe(500)
  })
})
