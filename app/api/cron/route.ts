// API cron job that handles scheduled tasks
import { NextRequest, NextResponse } from 'next/server'
import prismadb from '@/lib/prismadb'
import { logger } from '@/lib/logger'

// This cron job runs globally across all stores (there's no per-store schedule).
//
// It used to also "release" inventory for unpaid orders older than an hour by
// re-incrementing product quantities. That code could never run: no path in
// this app creates an unpaid order, because inventory is only ever decremented
// after payment. It was the release half of a reservation system that did not
// exist, compensating for a state that could not occur. What remains is sales
// scheduling.
export async function POST(req: NextRequest) {
  return executeCronJob(req)
}

export async function GET(req: NextRequest) {
  return executeCronJob(req)
}

async function executeCronJob(req: NextRequest) {
  try {
    // Handle sales scheduling
    const now = new Date()
    
    // Activate sales that should be active now but aren't
    const salesToActivate = await prismadb.sale.findMany({
      where: {
        isActive: false,
        startDate: {
          lte: now
        },
        endDate: {
          gte: now
        }
      }
    })

    for (const sale of salesToActivate) {
      await prismadb.sale.update({
        where: { id: sale.id },
        data: { isActive: true }
      })
      logger.info(`Activated sale: ${sale.name}`)
    }

    // Deactivate sales that have ended
    const salesToDeactivate = await prismadb.sale.findMany({
      where: {
        isActive: true,
        endDate: {
          lt: now
        }
      }
    })

    for (const sale of salesToDeactivate) {
      await prismadb.sale.update({
        where: { id: sale.id },
        data: { isActive: false }
      })
      logger.info(`Deactivated sale: ${sale.name}`)
    }

    const messages = []
    if (salesToActivate.length > 0) {
      messages.push(`Activated ${salesToActivate.length} sales`)
    }
    if (salesToDeactivate.length > 0) {
      messages.push(`Deactivated ${salesToDeactivate.length} sales`)
    }

    return NextResponse.json(
      {
        message: messages.join(', ') || 'Cron job completed successfully',
      },
      { status: 200 }
    )
  } catch (error) {
    logger.error('Error in cron job:', error)
    return NextResponse.json(
      { error: 'Error in cron job execution' },
      { status: 500 }
    )
  }
}
