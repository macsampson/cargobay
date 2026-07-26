import { applyPercentageDiscount, calculateProductSalePrice, type SaleInfo } from '@/lib/utils'

export interface BundleTier {
  id: string
  minQuantity: number
  discountPercentage: number
}

export type AppliedDiscount =
  | { type: 'bundle'; id: string; percentage: number }
  | { type: 'sale'; id: string; percentage: number }
  | { type: 'none' }

export interface AuthoritativePrice {
  baseUnitPriceInCents: number
  unitPriceInCents: number
  discountAmountInCents: number
  discount: AppliedDiscount
}

// Resolves the single authoritative unit price for a cart line, server-side.
// Bundle tiers and sales are mutually exclusive (never stacked) — whichever
// produces the larger discount amount wins; on an exact tie, bundle wins,
// since the customer already made a quantity commitment to earn that tier.
export function calculateAuthoritativeUnitPrice(
  baseUnitPriceInCents: number,
  quantity: number,
  bundleTiers: BundleTier[],
  activeSales: SaleInfo[]
): AuthoritativePrice {
  const bestTier = bundleTiers
    .filter((tier) => tier.minQuantity <= quantity)
    .reduce<BundleTier | null>((best, tier) => {
      if (!best || tier.discountPercentage > best.discountPercentage) return tier
      return best
    }, null)

  const bundleResult = bestTier
    ? applyPercentageDiscount(baseUnitPriceInCents, bestTier.discountPercentage)
    : null

  const saleInfo = calculateProductSalePrice(baseUnitPriceInCents, activeSales)
  const saleDiscountAmount =
    saleInfo.hasActiveSale && saleInfo.salePriceInCents !== null
      ? baseUnitPriceInCents - saleInfo.salePriceInCents
      : null

  const bundleDiscountAmount = bundleResult?.discountAmountInCents ?? 0
  const saleDiscountAmountOrZero = saleDiscountAmount ?? 0

  if (bundleResult && bundleDiscountAmount > 0 && bundleDiscountAmount >= saleDiscountAmountOrZero) {
    return {
      baseUnitPriceInCents,
      unitPriceInCents: bundleResult.finalPriceInCents,
      discountAmountInCents: bundleResult.discountAmountInCents,
      discount: { type: 'bundle', id: bestTier!.id, percentage: bestTier!.discountPercentage }
    }
  }

  if (saleInfo.hasActiveSale && saleInfo.salePriceInCents !== null && saleDiscountAmountOrZero > 0) {
    return {
      baseUnitPriceInCents,
      unitPriceInCents: saleInfo.salePriceInCents,
      discountAmountInCents: saleDiscountAmountOrZero,
      discount: { type: 'sale', id: saleInfo.sale!.id, percentage: saleInfo.discountPercentage! }
    }
  }

  return {
    baseUnitPriceInCents,
    unitPriceInCents: baseUnitPriceInCents,
    discountAmountInCents: 0,
    discount: { type: 'none' }
  }
}
