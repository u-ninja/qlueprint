import type { FastifyPluginAsync } from 'fastify'
import { UsersController } from './users.controller.js'
import { UsersRepository } from './users.repository.js'
import { ErrorResponseSchema, UserIdParamsSchema, UserResponseSchema } from './users.schema.js'
import { UsersService } from './users.service.js'

export const usersRoutes: FastifyPluginAsync = async (app) => {
	const controller = new UsersController(new UsersService(new UsersRepository(app.db)))

	// Users are created by Neon Auth sign-up, so every route here needs a session
	app.addHook('preHandler', app.requireAuth)

	app.get(
		'/me',
		{
			schema: {
				tags: ['Users'],
				summary: 'Get the signed-in user',
				response: {
					200: UserResponseSchema,
					401: ErrorResponseSchema,
					404: ErrorResponseSchema,
				},
			},
		},
		controller.getMe,
	)

	app.get(
		'/:id',
		{
			schema: {
				tags: ['Users'],
				summary: 'Get a user by ID',
				params: UserIdParamsSchema,
				response: {
					200: UserResponseSchema,
					401: ErrorResponseSchema,
					404: ErrorResponseSchema,
				},
			},
		},
		controller.getUserById,
	)
}
