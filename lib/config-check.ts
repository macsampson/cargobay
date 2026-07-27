import prismadb from '@/lib/prismadb'
import { isDemoModeEnabled } from '@/lib/demo-mode'
import { getShippoApiKey, getChitchatsConfig } from '@/lib/shipping-config'
import { isEncryptionConfigured } from '@/lib/secret-crypto'

export interface ConfigWarning {
  key: string
  message: string
}

/**
 * Surfaces operator-visible config gaps that fail silently otherwise: middleware
 * falls back to a placeholder CORS origin, auth falls back to a hardcoded session
 * secret, and Stripe just throws wherever it's first used. Node-only
 * (queries the database) — don't import this into middleware.ts, see lib/demo-mode.ts.
 *
 * Pass a storeId to scope the shipping-provider checks to one store (e.g. from the
 * dashboard layout); omit it to check shipping settings across every store (boot log).
 */
export async function getConfigWarnings(storeId?: string): Promise<ConfigWarning[]> {
  if (isDemoModeEnabled() || process.env.DISABLE_AUTH_FOR_LOCAL_DEV === 'true') {
    return []
  }

  const warnings: ConfigWarning[] = []

  if (!process.env.ALLOWED_ORIGINS) {
    warnings.push({
      key: 'ALLOWED_ORIGINS',
      message:
        'ALLOWED_ORIGINS is not set — CORS is falling back to a placeholder domain, so your storefront will get blocked requests to the store-scoped API.'
    })
  }

  if (!process.env.SESSION_SECRET) {
    const admin = await prismadb.adminUser.findFirst()
    if (!admin?.sessionSecret) {
      warnings.push({
        key: 'SESSION_SECRET',
        message:
          'No SESSION_SECRET is set and no admin account has generated one yet — sessions are being signed with a hardcoded fallback secret. Finish /setup, or set SESSION_SECRET yourself.'
      })
    }
  }

  if (!process.env.STRIPE_API_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    warnings.push({
      key: 'STRIPE',
      message: 'Stripe is not configured — checkout will fail. Set STRIPE_API_KEY and STRIPE_WEBHOOK_SECRET.'
    })
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    warnings.push({
      key: 'IMAGE_STORAGE',
      message: 'No image storage is configured — image uploads will fail. Add a Vercel Blob store.'
    })
  }

  const shippingSettingsList = await prismadb.shippingSettings.findMany(
    storeId ? { where: { storeId } } : undefined
  )

  const encryptionConfigured = isEncryptionConfigured()

  for (const settings of shippingSettingsList) {
    const storeTag = storeId ? '' : ` (store ${settings.storeId})`

    if (!encryptionConfigured && (settings.shippoApiKey || settings.chitchatsApiKey)) {
      warnings.push({
        key: `SECRETS_ENCRYPTION_KEY${storeTag}`,
        message: `A shipping API key is saved for this store${storeTag} but SECRETS_ENCRYPTION_KEY is not set, so it can't be decrypted — shipping rates will fail. Set SECRETS_ENCRYPTION_KEY to the value used when the key was saved.`
      })
    }

    if (settings.shippoEnabled && !getShippoApiKey(settings)) {
      warnings.push({
        key: `SHIPPO${storeTag}`,
        message: `Shippo is enabled but no API key is configured${storeTag} — shipping rates will fail. Set it on the Shipping settings page or via SHIPPO_API_KEY.`
      })
    }

    if (settings.chitchatsEnabled) {
      const chitchats = getChitchatsConfig(settings)
      if (!chitchats.apiKey || !chitchats.apiUrl || !chitchats.clientId) {
        warnings.push({
          key: `CHITCHATS${storeTag}`,
          message: `Chit Chats is enabled but not fully configured${storeTag} — shipping rates will fail. Set the API key, API URL, and client ID on the Shipping settings page or via CHITCHATS_API_KEY/CHITCHATS_API_URL/CHITCHATS_CLIENT_ID.`
        })
      }
    }
  }

  return warnings
}
