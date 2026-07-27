import { getConfigWarnings } from './config-check'
import prismadb from '@/lib/prismadb'
import { isDemoModeEnabled } from '@/lib/demo-mode'
import { isEncryptionConfigured } from '@/lib/secret-crypto'

jest.mock('@/lib/demo-mode', () => ({
  isDemoModeEnabled: jest.fn(() => false)
}))
jest.mock('@/lib/secret-crypto', () => ({
  isEncryptionConfigured: jest.fn(() => true)
}))

const prismaMock = prismadb as any
const isDemoModeEnabledMock = isDemoModeEnabled as jest.Mock
const isEncryptionConfiguredMock = isEncryptionConfigured as jest.Mock

describe('getConfigWarnings', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.clearAllMocks()
    isDemoModeEnabledMock.mockReturnValue(false)
    isEncryptionConfiguredMock.mockReturnValue(true)
    process.env = {
      ...originalEnv,
      ALLOWED_ORIGINS: 'https://store.example.com',
      SESSION_SECRET: 'a-session-secret',
      STRIPE_API_KEY: 'sk_test',
      STRIPE_WEBHOOK_SECRET: 'whsec_test',
      BLOB_READ_WRITE_TOKEN: 'blob_token'
    }
    delete process.env.DISABLE_AUTH_FOR_LOCAL_DEV
    prismaMock.shippingSettings.findMany.mockResolvedValue([])
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('returns no warnings when everything required is configured', async () => {
    const warnings = await getConfigWarnings('store-1')
    expect(warnings).toEqual([])
  })

  it('returns no warnings in demo mode, regardless of missing config', async () => {
    isDemoModeEnabledMock.mockReturnValue(true)
    delete process.env.ALLOWED_ORIGINS
    delete process.env.STRIPE_API_KEY

    const warnings = await getConfigWarnings('store-1')
    expect(warnings).toEqual([])
  })

  it('returns no warnings when DISABLE_AUTH_FOR_LOCAL_DEV is set, regardless of missing config', async () => {
    process.env.DISABLE_AUTH_FOR_LOCAL_DEV = 'true'
    delete process.env.STRIPE_API_KEY

    const warnings = await getConfigWarnings('store-1')
    expect(warnings).toEqual([])
  })

  it('warns when ALLOWED_ORIGINS is missing', async () => {
    delete process.env.ALLOWED_ORIGINS

    const warnings = await getConfigWarnings('store-1')
    expect(warnings.map((w) => w.key)).toContain('ALLOWED_ORIGINS')
  })

  it('warns when SESSION_SECRET is missing and no admin has generated one', async () => {
    delete process.env.SESSION_SECRET
    prismaMock.adminUser.findFirst.mockResolvedValue(null)

    const warnings = await getConfigWarnings('store-1')
    expect(warnings.map((w) => w.key)).toContain('SESSION_SECRET')
  })

  it('does not warn about SESSION_SECRET when an admin has already generated one', async () => {
    delete process.env.SESSION_SECRET
    prismaMock.adminUser.findFirst.mockResolvedValue({ sessionSecret: 'generated-secret' })

    const warnings = await getConfigWarnings('store-1')
    expect(warnings.map((w) => w.key)).not.toContain('SESSION_SECRET')
  })

  it('warns when Stripe keys are missing', async () => {
    delete process.env.STRIPE_API_KEY

    const warnings = await getConfigWarnings('store-1')
    expect(warnings.map((w) => w.key)).toContain('STRIPE')
  })

  it('warns when no image storage is configured', async () => {
    delete process.env.BLOB_READ_WRITE_TOKEN

    const warnings = await getConfigWarnings('store-1')
    expect(warnings.map((w) => w.key)).toContain('IMAGE_STORAGE')
  })

  it('warns when a shipping API key is stored but encryption is not configured', async () => {
    isEncryptionConfiguredMock.mockReturnValue(false)
    prismaMock.shippingSettings.findMany.mockResolvedValue([
      { storeId: 'store-1', shippoApiKey: 'encrypted-key', chitchatsApiKey: null, shippoEnabled: false, chitchatsEnabled: false }
    ])

    const warnings = await getConfigWarnings('store-1')
    expect(warnings.map((w) => w.key)).toContain('SECRETS_ENCRYPTION_KEY')
  })

  it('warns when Shippo is enabled but no API key resolves', async () => {
    prismaMock.shippingSettings.findMany.mockResolvedValue([
      { storeId: 'store-1', shippoApiKey: null, chitchatsApiKey: null, shippoEnabled: true, chitchatsEnabled: false }
    ])

    const warnings = await getConfigWarnings('store-1')
    expect(warnings.map((w) => w.key)).toContain('SHIPPO')
  })

  it('warns when Chit Chats is enabled but not fully configured', async () => {
    prismaMock.shippingSettings.findMany.mockResolvedValue([
      {
        storeId: 'store-1',
        shippoApiKey: null,
        chitchatsApiKey: null,
        chitchatsApiUrl: null,
        chitchatsClientId: null,
        shippoEnabled: false,
        chitchatsEnabled: true
      }
    ])

    const warnings = await getConfigWarnings('store-1')
    expect(warnings.map((w) => w.key)).toContain('CHITCHATS')
  })

  it('tags warnings with the storeId when checking across all stores (no storeId passed)', async () => {
    prismaMock.shippingSettings.findMany.mockResolvedValue([
      { storeId: 'store-2', shippoApiKey: null, chitchatsApiKey: null, shippoEnabled: true, chitchatsEnabled: false }
    ])

    const warnings = await getConfigWarnings()

    expect(prismaMock.shippingSettings.findMany).toHaveBeenCalledWith(undefined)
    expect(warnings.find((w) => w.key.startsWith('SHIPPO'))?.key).toBe('SHIPPO (store store-2)')
  })

  it('scopes the shipping settings query to a single store when storeId is passed', async () => {
    await getConfigWarnings('store-1')

    expect(prismaMock.shippingSettings.findMany).toHaveBeenCalledWith({ where: { storeId: 'store-1' } })
  })
})
