import type { FastifyPluginAsync } from 'fastify'
import { usersRoutes } from '../modules/users/users.routes.js'

export const v1Routes: FastifyPluginAsync = async (app) => {
	app.get('/health/ready', async (_request, reply) => {
		try {
			await app.pgPool.query('select 1')
			return { status: 'ok' }
		} catch {
			return reply.code(503).send({ status: 'unavailable' })
		}
	})

	await app.register(usersRoutes, { prefix: '/users' })
}
