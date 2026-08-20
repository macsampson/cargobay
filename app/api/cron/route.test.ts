import { POST } from './route'
import prismadb from '@/lib/prismadb'

const prismaMock = prismadb as any

function makeRequest() {
  return new Request('http://localhost/api/cron', { method: 'POST' }) as any
}

describe('POST /api/cron', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    prismaMock.sale.findMany.mockResolvedValue([])
  })

  it('no longer touches orders or product inventory', async () => {
    // The abandoned-order sweep was removed: nothing in this app creates an
    // unpaid order, so it compensated for a state that could not occur.
    // Inventory is held and released by services/reserve now.
    const response = await POST(makeRequest())

    expect(response.status).toBe(200)
    expect(prismaMock.order.findMany).not.toHaveBeenCalled()
    expect(prismaMock.order.update).not.toHaveBeenCalled()
    expect(prismaMock.product.update).not.toHaveBeenCalled()
  })

  it('activates sales whose window has started and deactivates sales whose window has ended', async () => {
    prismaMock.sale.findMany
      .mockResolvedValueOnce([{ id: 'sale-1', name: 'Summer Sale' }]) // activate query
      .mockResolvedValueOnce([{ id: 'sale-2', name: 'Winter Sale' }]) // deactivate query
    prismaMock.sale.update.mockResolvedValue({})

    const response = await POST(makeRequest())
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(prismaMock.sale.update).toHaveBeenCalledWith({
      where: { id: 'sale-1' },
      data: { isActive: true }
    })
    expect(prismaMock.sale.update).toHaveBeenCalledWith({
      where: { id: 'sale-2' },
      data: { isActive: false }
    })
    expect(data.message).toContain('Activated 1 sales')
    expect(data.message).toContain('Deactivated 1 sales')
  })

  it('returns 500 if a database error occurs', async () => {
    prismaMock.sale.findMany.mockRejectedValue(new Error('db down'))

    const response = await POST(makeRequest())

    expect(response.status).toBe(500)
  })
})
