import 'dotenv/config'
import { z } from 'zod'

const envSchema = z.object({
	NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),
	HOST: z.string().default('0.0.0.0'),
	PORT: z.coerce.number().int().min(1).max(65535).default(8080),
	DATABASE_URL: z.string().min(1),
	NEON_AUTH_URL: z.url(),
	CORS_ORIGIN: z.string().default('http://localhost:1420'),
})

export const env = envSchema.parse(process.env)
