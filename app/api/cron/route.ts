/**
 * Vercel cron target — vercel.json schedules a cron hitting this route.
 * Frequency: Hobby = once/day max; Pro = per-minute (set schedule in vercel.json).
 */
import { app } from "../../../src/app"

export const GET = app.fetch
export const POST = app.fetch
