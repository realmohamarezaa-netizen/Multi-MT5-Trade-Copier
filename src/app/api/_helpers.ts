// Shared helpers for API route handlers.
import { NextResponse } from 'next/server'
import { getEngine } from '@/lib/engine'

export function ok(data: unknown, init?: number): NextResponse {
  return NextResponse.json(data as Record<string, unknown>, { status: init ?? 200 })
}

export function fail(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status })
}

export async function readyEngine() {
  const engine = getEngine()
  await engine.ensureStarted()
  return engine
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
