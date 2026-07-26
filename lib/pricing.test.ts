import { calculateAuthoritativeUnitPrice, type BundleTier } from './pricing'
import { applyPercentageDiscount, type SaleInfo } from './utils'

function makeTier(overrides: Partial<BundleTier> = {}): BundleTier {
  return { id: 'tier-1', minQuantity: 3, discountPercentage: 15, ...overrides }
}

function makeSale(overrides: Partial<SaleInfo> = {}): SaleInfo {
  return {
    id: 'sale-1',
    name: 'Test Sale',
    percentage: 10,
    startDate: new Date('2026-01-01'),
    endDate: new Date('2026-12-31'),
    isActive: true,
    isStoreWide: false,
    ...overrides
  }
}

describe('calculateAuthoritativeUnitPrice', () => {
  it('returns base price unchanged when there are no tiers or sales', () => {
    const result = calculateAuthoritativeUnitPrice(1000, 5, [], [])

    expect(result).toEqual({
      baseUnitPriceInCents: 1000,
      unitPriceInCents: 1000,
      discountAmountInCents: 0,
      discount: { type: 'none' }
    })
  })

  it('applies the tier when quantity is exactly at minQuantity', () => {
    const tier = makeTier({ minQuantity: 3, discountPercentage: 15 })
    const result = calculateAuthoritativeUnitPrice(1000, 3, [tier], [])

    expect(result.discount).toEqual({ type: 'bundle', id: 'tier-1', percentage: 15 })
    expect(result.unitPriceInCents).toBe(850)
  })

  it('does not apply the tier when quantity is one below minQuantity', () => {
    const tier = makeTier({ minQuantity: 3, discountPercentage: 15 })
    const result = calculateAuthoritativeUnitPrice(1000, 2, [tier], [])

    expect(result.discount).toEqual({ type: 'none' })
    expect(result.unitPriceInCents).toBe(1000)
  })

  it('picks the highest-discount qualifying tier among overlapping tiers', () => {
    const tiers = [
      makeTier({ id: 'tier-5', minQuantity: 5, discountPercentage: 10 }),
      makeTier({ id: 'tier-10', minQuantity: 10, discountPercentage: 15 })
    ]

    // qty 7: only tier-5 qualifies
    const atSeven = calculateAuthoritativeUnitPrice(1000, 7, tiers, [])
    expect(atSeven.discount).toEqual({ type: 'bundle', id: 'tier-5', percentage: 10 })

    // qty 12: both qualify, tier-10 has the higher percentage and wins
    const atTwelve = calculateAuthoritativeUnitPrice(1000, 12, tiers, [])
    expect(atTwelve.discount).toEqual({ type: 'bundle', id: 'tier-10', percentage: 15 })
  })

  it('picks the highest-discount qualifying tier when two tiers share the same minQuantity', () => {
    const tiers = [
      makeTier({ id: 'a', minQuantity: 5, discountPercentage: 10 }),
      makeTier({ id: 'b', minQuantity: 5, discountPercentage: 20 })
    ]

    const result = calculateAuthoritativeUnitPrice(1000, 5, tiers, [])
    expect(result.discount).toEqual({ type: 'bundle', id: 'b', percentage: 20 })
  })

  it('applies the sale when its discount is bigger than the qualifying bundle tier', () => {
    const tier = makeTier({ minQuantity: 3, discountPercentage: 15 })
    const sale = makeSale({ percentage: 20 })

    const result = calculateAuthoritativeUnitPrice(1000, 5, [tier], [sale])

    expect(result.discount).toEqual({ type: 'sale', id: 'sale-1', percentage: 20 })
    expect(result.unitPriceInCents).toBe(800)
  })

  it('applies the bundle tier when its discount is bigger than the sale', () => {
    const tier = makeTier({ minQuantity: 3, discountPercentage: 25 })
    const sale = makeSale({ percentage: 10 })

    const result = calculateAuthoritativeUnitPrice(1000, 5, [tier], [sale])

    expect(result.discount).toEqual({ type: 'bundle', id: 'tier-1', percentage: 25 })
    expect(result.unitPriceInCents).toBe(750)
  })

  it('bundle and sale are mutually exclusive, never stacked', () => {
    const tier = makeTier({ minQuantity: 3, discountPercentage: 15 })
    const sale = makeSale({ percentage: 15 })

    const result = calculateAuthoritativeUnitPrice(1000, 5, [tier], [sale])

    // If these stacked, the price would be 1000 * 0.85 * 0.85 = 722.5.
    // Mutually exclusive with an exact tie: bundle wins (documented tie-break).
    expect(result.unitPriceInCents).toBe(850)
    expect(result.discount).toEqual({ type: 'bundle', id: 'tier-1', percentage: 15 })
  })

  it('breaks an exact tie between equal discount amounts in favor of the bundle', () => {
    // 1000 * 15% = 150 for both the tier and the sale — exact tie.
    const tier = makeTier({ minQuantity: 3, discountPercentage: 15 })
    const sale = makeSale({ percentage: 15 })

    const result = calculateAuthoritativeUnitPrice(1000, 3, [tier], [sale])

    expect(result.discount.type).toBe('bundle')
  })

  it('does not report a bundle discount for a qualifying tier with 0% off', () => {
    const tier = makeTier({ minQuantity: 3, discountPercentage: 0 })

    const result = calculateAuthoritativeUnitPrice(1000, 5, [tier], [])

    expect(result.discount).toEqual({ type: 'none' })
    expect(result.unitPriceInCents).toBe(1000)
  })

  it('rounds identically to the shared applyPercentageDiscount helper (bundle path)', () => {
    const tier = makeTier({ minQuantity: 1, discountPercentage: 33 })
    const expected = applyPercentageDiscount(999, 33)

    const result = calculateAuthoritativeUnitPrice(999, 1, [tier], [])

    expect(result.discountAmountInCents).toBe(expected.discountAmountInCents)
    expect(result.unitPriceInCents).toBe(expected.finalPriceInCents)
    expect(expected).toEqual({ discountAmountInCents: 330, finalPriceInCents: 669 })
  })

  it('rounds identically to the shared applyPercentageDiscount helper (sale path)', () => {
    const sale = makeSale({ percentage: 33 })
    const expected = applyPercentageDiscount(999, 33)

    const result = calculateAuthoritativeUnitPrice(999, 1, [], [sale])

    expect(result.discountAmountInCents).toBe(expected.discountAmountInCents)
    expect(result.unitPriceInCents).toBe(expected.finalPriceInCents)
  })

  it('ignores tiers belonging to a different quantity range entirely (no tiers qualify)', () => {
    const tiers = [makeTier({ minQuantity: 100, discountPercentage: 50 })]

    const result = calculateAuthoritativeUnitPrice(1000, 1, tiers, [])

    expect(result.discount).toEqual({ type: 'none' })
  })
})
