import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import pg from 'pg'
import { env } from '../config/env.js'
import * as appSchema from '../db/schema.js'
import * as authSchema from '../db/auth-schema.js'

export const schema = { ...appSchema, ...authSchema }
export type Database = NodePgDatabase<typeof schema>

declare module 'fastify' {
	interface FastifyInstance {
		db: Database
		pgPool: pg.Pool
	}
}

const databasePlugin: FastifyPluginAsync = async (app) => {
	const pool = new pg.Pool({
		connectionString: env.DATABASE_URL,
		max: 10,
		idleTimeoutMillis: 30_000,
		connectionTimeoutMillis: 10_000,
	})

	pool.on('error', (err) => app.log.error({ err }, 'Unexpected database pool error'))

	// Fail fast on a bad DATABASE_URL
	await pool.query('select 1')

	app.decorate('pgPool', pool)
	app.decorate('db', drizzle(pool, { schema }))

	app.addHook('onClose', async () => {
		await pool.end()
	})
}

export const registerDatabase = fp(databasePlugin, { name: 'database' })
