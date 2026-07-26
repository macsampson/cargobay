import { POST } from './route'
import prismadb from '@/lib/prismadb'
import { createShippoShipment } from '@/lib/shippo'

jest.mock('@/lib/shippo', () => ({
  createShippoShipment: jest.fn()
}))
jest.mock('@/lib/shipping-config', () => ({
  getShippoApiKey: jest.fn(() => 'shpk_test'),
  getChitchatsConfig: jest.fn(() => ({
    apiKey: 'cc_key',
    apiUrl: 'https://api.chitchats.com',
    clientId: 'client-1'
  }))
}))

const prismaMock = prismadb as any
const createShippoShipmentMock = createShippoShipment as jest.Mock

const validAddress = {
  firstName: 'Jane',
  lastName: 'Doe',
  street: '123 Main St',
  city: 'Springfield',
  state: 'IL',
  zip: '62701',
  country: 'US',
  email: 'jane@example.com'
}

const validCartItems = [
  {
    productId: 'p1',
    name: 'Widget',
    weight: '100',
    cartQuantity: 2
  }
]

function makeProduct(overrides: Partial<any> = {}) {
  return {
    id: 'p1',
    storeId: 'store-1',
    name: 'Widget',
    priceInCents: 1000,
    quantity: 10,
    bundles: [],
    variations: [],
    ...overrides
  }
}

function makeRequest(body: any) {
  return new Request('http://localhost/api/store-1/shipping', {
    method: 'POST',
    body: JSON.stringify(body)
  })
}

function baseSettings(overrides: Record<string, unknown> = {}) {
  return {
    storeId: 'store-1',
    name: 'Acme',
    company: '',
    street1: '1 Warehouse Rd',
    city: 'Toronto',
    state: 'ON',
    zip: 'M5H2N2',
    country: 'CA',
    phone: '555-0000',
    email: 'ship@acme.com',
    shippoEnabled: true,
    chitchatsEnabled: false,
    customsDeclaration: {
      items: [
        {
          description: 'Keycaps',
          mass_unit: 'g',
          origin_country: 'CA',
          tariff_number: '3926.90'
        }
      ]
    },
    ...overrides
  }
}

const shippoRate = {
  object_id: 'rate_1',
  provider: 'USPS',
  servicelevel: { name: 'priority', display_name: 'Priority Mail' },
  amount: '8.50',
  currency: 'USD',
  amount_local: '8.50',
  currency_local: 'USD',
  estimated_days: 3,
  duration_terms: '3 business days',
  attributes: [],
  provider_image_200: 'https://x/logo.png'
}

describe('POST /api/[storeId]/shipping', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = jest.fn()
    prismaMock.shippingSettings.findUnique.mockResolvedValue(baseSettings())
    prismaMock.product.findMany.mockResolvedValue([makeProduct()])
    prismaMock.sale.findMany.mockResolvedValue([])
    createShippoShipmentMock.mockResolvedValue({ rates: [shippoRate], messages: [], httpOk: true, raw: {} })
  })

  it('returns Shippo rates when only Shippo is enabled', async () => {
    const response = await POST(
      makeRequest({ address: validAddress, cartItems: validCartItems, currency: 'usd' })
    )
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.success).toBe(true)
    expect(data.rates).toHaveLength(1)
    expect(data.rates[0]).toEqual(
      expect.objectContaining({ id: 'rate_1', provider: 'Shippo', title: 'Priority Mail' })
    )
  })

  it('prices the Shippo line item from the DB, ignoring any client-supplied bundlePrice/priceInCents (regression test)', async () => {
    prismaMock.product.findMany.mockResolvedValue([makeProduct({ priceInCents: 1000 })])

    await POST(
      makeRequest({
        address: validAddress,
        cartItems: [
          {
            productId: 'p1',
            name: 'Widget',
            weight: '100',
            cartQuantity: 2,
            // These should have zero effect now that price is DB-derived.
            bundlePrice: 1,
            priceInCents: 1
          }
        ],
        currency: 'usd'
      })
    )

    expect(createShippoShipmentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        lineItems: [expect.objectContaining({ total_price: '20.00' })]
      })
    )
  })

  it('applies a qualifying bundle tier discount to the shipping quote and customs value', async () => {
    prismaMock.product.findMany.mockResolvedValue([
      makeProduct({ priceInCents: 1000, bundles: [{ id: 'b1', minQuantity: 2, discountPercentage: 15 }] })
    ])

    await POST(
      makeRequest({
        address: { ...validAddress, country: 'US' },
        cartItems: [{ productId: 'p1', name: 'Widget', weight: '100', cartQuantity: 2 }],
        currency: 'usd'
      })
    )

    // unit price 850 * 2 = 1700 cents = $17.00
    expect(createShippoShipmentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        lineItems: [expect.objectContaining({ total_price: '17.00' })],
        customsDeclaration: expect.objectContaining({
          items: [expect.objectContaining({ value_amount: '17.00' })]
        })
      })
    )
  })

  it('returns 400 for an unknown productId', async () => {
    prismaMock.product.findMany.mockResolvedValue([])

    const response = await POST(
      makeRequest({
        address: validAddress,
        cartItems: [{ productId: 'ghost', name: 'Ghost', weight: '1', cartQuantity: 1 }],
        currency: 'usd'
      })
    )
    const data = await response.json()

    expect(response.status).toBe(400)
    expect(data.success).toBe(false)
  })

  it('returns 400 when a variationId does not belong to the specified product', async () => {
    prismaMock.product.findMany.mockResolvedValue([makeProduct({ variations: [] })])

    const response = await POST(
      makeRequest({
        address: validAddress,
        cartItems: [{ productId: 'p1', variationId: 'nope', name: 'Widget', weight: '1', cartQuantity: 1 }],
        currency: 'usd'
      })
    )

    expect(response.status).toBe(400)
  })

  it('does not call Shippo when it is disabled', async () => {
    prismaMock.shippingSettings.findUnique.mockResolvedValue(
      baseSettings({ shippoEnabled: false })
    )

    const response = await POST(
      makeRequest({ address: validAddress, cartItems: validCartItems, currency: 'usd' })
    )
    const data = await response.json()

    expect(data.rates).toEqual([])
    expect(createShippoShipmentMock).not.toHaveBeenCalled()
  })

  it('combines and sorts rates from both providers by price when both are enabled', async () => {
    prismaMock.shippingSettings.findUnique.mockResolvedValue(
      baseSettings({ shippoEnabled: true, chitchatsEnabled: true })
    )
    ;(global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        json: async () => ({
          shipment: {
            id: 'cc_ship_1',
            rates: [
              {
                postage_type: 'chit_chats_us_edge',
                postage_description: 'Chit Chats Edge',
                delivery_time_description: '5 days',
                payment_amount: '3.00',
                tracking_type_description: 'Tracked',
                is_insured: true,
                signature_confirmation_description: null,
                delivery_duties_paid_description: null
              }
            ]
          }
        })
      })
      .mockResolvedValueOnce({ json: async () => ({}) }) // DELETE cleanup call

    const response = await POST(
      makeRequest({ address: validAddress, cartItems: validCartItems, currency: 'usd' })
    )
    const data = await response.json()

    expect(data.rates).toHaveLength(2)
    // Chit Chats ($3.00) should sort before Shippo ($8.50)
    expect(data.rates[0].provider).toBe('Chit Chats')
    expect(data.rates[1].provider).toBe('Shippo')
  })

  it('filters out Canada Post rates from Chit Chats results', async () => {
    prismaMock.shippingSettings.findUnique.mockResolvedValue(
      baseSettings({ shippoEnabled: false, chitchatsEnabled: true })
    )
    ;(global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        json: async () => ({
          shipment: {
            id: 'cc_ship_1',
            rates: [
              {
                postage_type: 'canada_post_regular',
                postage_description: 'Canada Post Regular Parcel',
                delivery_time_description: '5 days',
                payment_amount: '2.00'
              },
              {
                postage_type: 'chit_chats_us_edge',
                postage_description: 'Chit Chats Edge',
                delivery_time_description: '5 days',
                payment_amount: '3.00'
              }
            ]
          }
        })
      })
      .mockResolvedValueOnce({ json: async () => ({}) })

    const response = await POST(
      makeRequest({ address: validAddress, cartItems: validCartItems, currency: 'usd' })
    )
    const data = await response.json()

    expect(data.rates).toHaveLength(1)
    expect(data.rates[0].title).toBe('Chit Chats Edge')
  })

  it('returns an empty Chit Chats result when the API response is missing shipment.rates', async () => {
    prismaMock.shippingSettings.findUnique.mockResolvedValue(
      baseSettings({ shippoEnabled: false, chitchatsEnabled: true })
    )
    ;(global.fetch as jest.Mock).mockResolvedValue({ json: async () => ({ error: 'bad request' }) })

    const response = await POST(
      makeRequest({ address: validAddress, cartItems: validCartItems, currency: 'usd' })
    )
    const data = await response.json()

    expect(data.success).toBe(true)
    expect(data.rates).toEqual([])
  })

  it('does not fail the whole request when Shippo throws (isolated per-provider error handling)', async () => {
    createShippoShipmentMock.mockRejectedValue(new Error('Shippo down'))

    const response = await POST(
      makeRequest({ address: validAddress, cartItems: validCartItems, currency: 'usd' })
    )
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.success).toBe(true)
    expect(data.rates).toEqual([])
  })

  it('does not fail the whole request when Chit Chats throws (isolated per-provider error handling)', async () => {
    prismaMock.shippingSettings.findUnique.mockResolvedValue(
      baseSettings({ shippoEnabled: false, chitchatsEnabled: true })
    )
    ;(global.fetch as jest.Mock).mockRejectedValue(new Error('network error'))

    const response = await POST(
      makeRequest({ address: validAddress, cartItems: validCartItems, currency: 'usd' })
    )
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.rates).toEqual([])
  })

  it('does not throw when deleting the temporary Chit Chats shipment fails (non-critical cleanup)', async () => {
    prismaMock.shippingSettings.findUnique.mockResolvedValue(
      baseSettings({ shippoEnabled: false, chitchatsEnabled: true })
    )
    ;(global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        json: async () => ({
          shipment: { id: 'cc_ship_1', rates: [{ postage_type: 'x', postage_description: 'Edge', delivery_time_description: '1 day', payment_amount: '1.00' }] }
        })
      })
      .mockRejectedValueOnce(new Error('delete failed'))

    const response = await POST(
      makeRequest({ address: validAddress, cartItems: validCartItems, currency: 'usd' })
    )
    const data = await response.json()

    expect(response.status).toBe(200)
    expect(data.rates).toHaveLength(1)
  })

  it('includes a customs declaration for a non-CA destination', async () => {
    await POST(
      makeRequest({
        address: { ...validAddress, country: 'US' },
        cartItems: validCartItems,
        currency: 'usd'
      })
    )

    expect(createShippoShipmentMock).toHaveBeenCalledWith(
      expect.objectContaining({ customsDeclaration: expect.objectContaining({ items: expect.any(Array) }) })
    )
  })

  it('omits the customs declaration for a CA destination', async () => {
    await POST(
      makeRequest({
        address: { ...validAddress, country: 'CA' },
        cartItems: validCartItems,
        currency: 'usd'
      })
    )

    expect(createShippoShipmentMock).toHaveBeenCalledWith(
      expect.objectContaining({ customsDeclaration: undefined })
    )
  })

  it('returns 404 when no shipping settings exist for the store', async () => {
    prismaMock.shippingSettings.findUnique.mockResolvedValue(null)

    const response = await POST(
      makeRequest({ address: validAddress, cartItems: validCartItems, currency: 'usd' })
    )
    const data = await response.json()

    expect(response.status).toBe(404)
    expect(data.error).toBe('Sender address not found')
  })

  it('returns 404 when no customs declaration is configured', async () => {
    prismaMock.shippingSettings.findUnique.mockResolvedValue(
      baseSettings({ customsDeclaration: null })
    )

    const response = await POST(
      makeRequest({ address: validAddress, cartItems: validCartItems, currency: 'usd' })
    )
    const data = await response.json()

    expect(response.status).toBe(404)
    expect(data.error).toBe('Customs declaration not found')
  })

  it('returns a JSON 500 when the shipping-settings lookup throws', async () => {
    prismaMock.shippingSettings.findUnique.mockRejectedValue(new Error('db down'))

    const response = await POST(
      makeRequest({ address: validAddress, cartItems: validCartItems, currency: 'usd' })
    )
    const data = await response.json()

    expect(response.status).toBe(500)
    expect(data.success).toBe(false)
  })
})
