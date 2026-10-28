import type { FastifyInstance } from 'fastify'
import helmet from '@fastify/helmet'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { env } from '../config/env.js'

export async function registerSecurity(app: FastifyInstance) {
	await app.register(helmet)
	await app.register(cors, {
		origin: env.CORS_ORIGIN.split(',').map((v) => v.trim()),
		credentials: false,
	})
	await app.register(rateLimit, { max: 100, timeWindow: '1 minute' })
}
