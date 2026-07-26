// Import necessary dependencies and types
import { NextResponse } from 'next/server'
import prismadb from '@/lib/prismadb'
import { logger } from '@/lib/logger'
import { getShippoApiKey, getChitchatsConfig } from '@/lib/shipping-config'
import { createShippoShipment, ShippoRate } from '@/lib/shippo'
import { calculateAuthoritativeUnitPrice, type BundleTier } from '@/lib/pricing'
import type { SaleInfo } from '@/lib/utils'

// Helper function to format prices from cents to dollars with 2 decimal places
const formatPrice = (priceInCents: number): string => {
  return (priceInCents / 100).toFixed(2)
}

// Define types for address and cart items
type AddressType = {
  firstName: string
  lastName: string
  street: string
  city: string
  state: string
  zip: string
  country: string
  email: string
  phone?: string
}

// Only identity + quantity are trusted from the client — price and weight
// are both resolved server-side (bundle tier / sale, and product.weight,
// same source of truth as checkout/route.ts) so a spoofed `bundlePrice` or
// `weight` can't under-declare what gets charged for shipping, the
// customs/insurance declared value, or the parcel weight used to fetch rates.
type CartItemType = {
  productId: string
  variationId?: string
  name: string
  cartQuantity: number
}

type PricedCartItem = CartItemType & { unitPriceInCents: number; weight: number }

type CustomsDeclarationInfo = {
  items: {
    description: string
    mass_unit: string
    origin_country: string
    tariff_number: string
  }[]
}

// Handle OPTIONS request
export async function OPTIONS() {
  return NextResponse.json({})
}

// Handle POST request for shipping rate calculation
export async function POST(req: Request) {
  try {
    const {
      address,
      cartItems,
      currency
    }: { address: AddressType; cartItems: CartItemType[]; currency: string } =
      await req.json()

    // logger.info('CART ITEMS: ', cartItems)

    const url = new URL(req.url)
    const storeId = url.pathname.split('/')[2]

    // Batched lookups — one round trip regardless of cart size — to resolve
    // each line's authoritative unit price server-side instead of trusting
    // the client's bundlePrice/priceInCents.
    const productIds = Array.from(new Set(cartItems.map((item) => item.productId)))
    const now = new Date()

    const [products, activeSales] = await Promise.all([
      prismadb.product.findMany({
        where: { id: { in: productIds }, storeId },
        include: { bundles: true, variations: true }
      }),
      prismadb.sale.findMany({
        where: { storeId, isActive: true, startDate: { lte: now }, endDate: { gte: now } },
        include: { products: { select: { productId: true } } }
      })
    ])
    const productById = new Map(products.map((p) => [p.id, p]))

    const pricedCartItems: PricedCartItem[] = []
    for (const item of cartItems) {
      const product = productById.get(item.productId)
      if (!product) {
        return NextResponse.json(
          { success: false, error: `Product ${item.productId} is not available` },
          { status: 400 }
        )
      }

      let variation = null
      if (item.variationId) {
        variation = product.variations.find((v) => v.id === item.variationId) ?? null
        if (!variation) {
          return NextResponse.json(
            { success: false, error: `Variation ${item.variationId} not found for product ${item.productId}` },
            { status: 400 }
          )
        }
      }

      const baseUnitPriceInCents = variation ? variation.priceInCents : product.priceInCents
      const bundleTiers: BundleTier[] = product.bundles.map((b) => ({
        id: b.id,
        minQuantity: b.minQuantity,
        discountPercentage: b.discountPercentage
      }))

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

      const { unitPriceInCents } = calculateAuthoritativeUnitPrice(
        baseUnitPriceInCents,
        item.cartQuantity,
        bundleTiers,
        applicableSales
      )

      pricedCartItems.push({ ...item, unitPriceInCents, weight: Number(product.weight) })
    }

    // Calculate total weight and price
    const totalWeight = pricedCartItems.reduce(
      (acc, cartItem) => acc + cartItem.weight * cartItem.cartQuantity,
      0
    )

    const totalPrice = pricedCartItems.reduce(
      (acc, cartItem) => acc + cartItem.unitPriceInCents * cartItem.cartQuantity,
      0
    )

    // Create line items for Shippo
    const lineItems = pricedCartItems.map((cartItem) => ({
      title: cartItem.name,
      sku: cartItem.productId,
      quantity: cartItem.cartQuantity,
      total_price: formatPrice(cartItem.unitPriceInCents * cartItem.cartQuantity),
      currency: currency,
      weight: (cartItem.weight * cartItem.cartQuantity).toString(),
      weight_unit: 'g',
      mass_unit: 'g',
      manufacture_country: 'CA'
    }))

    // logger.info('TOTAL WEIGHT: ', totalWeight)

    // Create parcel data
    const parcelData = {
      length: '23',
      width: '16',
      height: '5',
      distance_unit: 'cm',
      weight: totalWeight.toString(),
      weight_unit: 'g',
      mass_unit: 'g'
    }

    // Get sender address from database
    const shippingSettings = await prismadb.shippingSettings.findUnique({
      where: {
        storeId: storeId
      }
    })

    if (!shippingSettings) {
      return NextResponse.json(
        {
          success: false,
          error: 'Sender address not found'
        },
        { status: 404 }
      )
    }
    // Create customs declaration for international shipping

    const customsDeclarationInfo =
      shippingSettings.customsDeclaration as CustomsDeclarationInfo

    // logger.info(customsDeclarationInfo)

    if (!customsDeclarationInfo) {
      return NextResponse.json(
        {
          success: false,
          error: 'Customs declaration not found'
        },
        { status: 404 }
      )
    }

    const customsDeclaration =
      address.country !== 'CA'
        ? {
            ...customsDeclarationInfo,
            items: customsDeclarationInfo.items.map((item: any) => ({
              ...item,
              net_weight: totalWeight.toString(),
              quantity: cartItems.reduce(
                (acc, cartItem) => acc + cartItem.cartQuantity,
                0
              ),
              value_amount: formatPrice(totalPrice),
              value_currency: currency
            }))
          }
        : undefined

    // logger.info('CUSTOMS DECLARATION: ', customsDeclaration)

    const shippoEnabled = shippingSettings.shippoEnabled
    const chitchatsEnabled = shippingSettings.chitchatsEnabled

    // Create shipment object
    const shipmentObject = {
      address_from: {
        name: shippingSettings.name,
        company: shippingSettings.company,
        street1: shippingSettings.street1,
        city: shippingSettings.city,
        state: shippingSettings.state,
        zip: shippingSettings.zip,
        country: shippingSettings.country,
        phone: shippingSettings.phone,
        email: shippingSettings.email,
        is_residential: false // or true, depending on your business
      },
      address_to: {
        name: `${address.firstName} ${address.lastName}`,
        street1: address.street,
        city: address.city,
        state: address.state,
        zip: address.zip,
        country: address.country,
        email: address.email,
        phone: address.phone,
        is_residential: true
      },
      parcels: [parcelData],
      async: false,
      customs_declaration: customsDeclaration,
      line_items: lineItems
    }

    // logger.info('shipmentObject: ', shipmentObject)

    // Create separate functions for each shipping provider
    const getShippoRates = async () => {
      try {
        const shippoData = await createShippoShipment({
          apiKey: getShippoApiKey(shippingSettings) as string,
          addressFrom: shipmentObject.address_from,
          addressTo: shipmentObject.address_to,
          parcel: parcelData,
          lineItems: lineItems,
          customsDeclaration: customsDeclaration
        })

        // logger.info('SHIPPO RATES: ', shippoData.rates)

        return shippoData.rates.map((rate: ShippoRate) => ({
          id: rate.object_id,
          provider: 'Shippo',
          title:
            rate.servicelevel.display_name ||
            `${rate.provider} ${rate.servicelevel.name}`,
          description:
            rate.duration_terms ||
            (rate.estimated_days &&
              `${rate.estimated_days} day${
                rate.estimated_days !== 1 ? 's' : ''
              } delivery`) ||
            'Exact delivery estimate not available',
          amount: rate.amount,
          currency: rate.currency,
          amount_local: rate.amount_local,
          currency_local: rate.currency_local,
          estimated_days: rate.estimated_days,
          attributes: rate.attributes,
          provider_image: rate.provider_image_200
        }))
      } catch (error) {
        logger.error('Shippo rate error:', error)
        return []
      }
    }

    const getChitChatsRates = async () => {
      try {
        const chitchatsConfig = getChitchatsConfig(shippingSettings)
        const chitchatsResponse = await fetch(
          `${chitchatsConfig.apiUrl}/api/v1/clients/${chitchatsConfig.clientId}/shipments`,
          {
            method: 'POST',
            headers: {
              Authorization: chitchatsConfig.apiKey!,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              name: `${address.firstName} ${address.lastName}`,
              address_1: address.street,
              city: address.city,
              province_code: address.state,
              postal_code: address.zip,
              country_code: address.country,
              phone: address.phone || '',
              email: address.email,
              description: cartItems
                .map((cartItem) => `${cartItem.cartQuantity}x Keycaps`) // TODO: use item category
                .join(', '),
              value: (totalPrice / 100)?.toString() || '0',
              value_currency: currency,
              package_type: 'thick_envelope', // TODO: use package type from customs declaration
              postage_type: 'unknown',
              size_unit: 'cm',
              size_x: 23,
              size_y: 16,
              size_z: 5,
              weight_unit: customsDeclarationInfo.items[0].mass_unit,
              weight: totalWeight || 0,
              is_insured: true,
              is_insurance_requested: true,
              ship_date: 'today',
              hs_tariff_code: customsDeclarationInfo.items[0].tariff_number,
              line_items: pricedCartItems.map((cartItem) => ({
                quantity: cartItem.cartQuantity || 1,
                description: cartItem.name || 'Keycap',
                currency_code: currency,
                value_amount:
                  ((cartItem.unitPriceInCents * cartItem.cartQuantity) / 100)?.toString() || '0',
                weight: cartItem.weight?.toString() || '1',
                weight_unit: customsDeclarationInfo.items[0].mass_unit,
                origin_country: customsDeclarationInfo.items[0].origin_country,
                hs_tariff_code: customsDeclarationInfo.items[0].tariff_number
              }))
            })
          }
        )
        const chitchatsData = await chitchatsResponse.json()

        // Check if the response has the expected structure
        if (
          !chitchatsData ||
          !chitchatsData.shipment ||
          !chitchatsData.shipment.rates
        ) {
          logger.error(
            'ChitChats API returned unexpected response:',
            chitchatsData
          )
          return []
        }

        // Delete shipment until customer makes purchase
        if (chitchatsData.shipment && chitchatsData.shipment.id) {
          try {
            await fetch(
              `${chitchatsConfig.apiUrl}/api/v1/clients/${chitchatsConfig.clientId}/shipments/${chitchatsData.shipment.id}`,
              {
                method: 'DELETE',
                headers: {
                  Authorization: chitchatsConfig.apiKey!
                }
              }
            )
          } catch (deleteError) {
            logger.error('Failed to delete temporary shipment:', deleteError)
            // Non-critical error, continue with returning rates
          }
        }

        const rates = chitchatsData.shipment.rates.map((rate: any) => ({
          id: `${rate.postage_type}`,
          provider: 'Chit Chats',
          title: rate.postage_description,
          description: rate.delivery_time_description,
          amount: rate.payment_amount,
          currency: currency,
          amount_local: rate.payment_amount,
          currency_local: currency,
          estimated_days: parseInt(
            rate.delivery_time_description.match(/\d+/)?.[0] || '0'
          ),
          attributes: [
            rate.tracking_type_description,
            rate.is_insured ? 'Insured' : null,
            rate.signature_confirmation_description,
            rate.delivery_duties_paid_description
          ].filter(Boolean),
          provider_image:
            'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTwF9SOKaw4zLDp3zdkLiezZRMqaHARJooA-g&s'
        }))

        // Filter out Canada Post rates
        return rates.filter((rate: any) => !rate.title.includes('Canada Post'))
      } catch (error) {
        logger.error('Chit Chats rate error:', error)
        return []
      }
    }

    // Get rates from both providers in parallel
    const [shippoRates, chitchatsRates] = await Promise.all([
      shippoEnabled ? getShippoRates() : [],
      chitchatsEnabled ? getChitChatsRates() : []
    ])

    // Combine and sort all rates by price
    const allRates = [...shippoRates, ...chitchatsRates].sort(
      (a, b) => parseFloat(a.amount) - parseFloat(b.amount)
    )

    return NextResponse.json({
      success: true,
      rates: allRates
    })
  } catch (error) {
    logger.error('Shipping rate error:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch shipping rates'
      },
      { status: 500 }
    )
  }
}
